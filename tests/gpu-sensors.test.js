import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import * as THREE from "three";

import { HeadlessEpisode } from "../app/simulation/headless/HeadlessEpisode.js";
import {
    measuredPerceptionProfileRef,
    measuredStateProfileRef,
} from "../app/simulation/headless/ProfileRegistry.js";
import { unpackTensor } from "../app/simulation/headless/TensorProtocol.js";
import { PooledGpuRenderer } from "../server/headless/PooledGpuRenderer.js";
import {
    createBoxLidarTwin,
    hashLidarGeometry,
    LIDAR_GEOMETRY_KIND,
    LIDAR_GEOMETRY_VERSION,
} from "../app/simulation/lidar/LidarGeometry.js";
import { CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import { HeadlessGpuSensorManager } from "../app/simulation/sensors/HeadlessGpuSensorManager.js";
import { createGpuSensorBackendV2Selection } from "../app/simulation/sensors/GpuSensorBackend.js";
import { StorageService } from "../server/storage/StorageService.js";
import { loadHeadlessGrpcSchema } from "../server/headless/GrpcSchema.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { runBundleBytes } from "../server/headless/RunBundle.js";
import { startHeadlessSupervisor } from "../server/headless/SupervisorServer.js";
import { createHeadlessSmokeBundle } from "../server/headless/SmokeBundle.js";
import { SupervisorRunner } from "../server/headless/SupervisorRunner.js";
import { validateBundleWithSupervisor } from "../server/headless/SupervisorValidation.js";
import { canonicalStringify } from "../app/simulation/RunManifest.js";
import { routeSafetyProfileRef } from "../app/simulation/headless/ProfileRegistry.js";
import {
    createOwnedCaptureScene,
    createVisualCameraCalibration,
    createVisualCaptureInput,
} from "../app/3d/environment/visual/VisualCapturePipeline.js";
import {
    createHeadlessImu,
    createPortableHeadlessBundle,
    rehashRunBundle,
} from "./helpers/headlessRunnerBundle.js";
import { makeNamedMaterialGlb, sha256Hex } from "./helpers/visual-assets.js";
import { resolvedPbrRun } from "./helpers/pbrResolved.js";

async function sensorFromDefault(type) {
    const resolved = await new StorageService().resolveRunManifest("igvc-default");
    return structuredClone(resolved.manifest.sensorRig.sensors.find((sensor) => sensor.type === type));
}

async function perceptionLidarBundle() {
    const lidar = await sensorFromDefault("lidar3d");
    lidar.rateHz = 60;
    lidar.phaseNs = 0;
    lidar.calibration.azimuth = { startDeg: -45, endDeg: 46, stepDeg: 45 };
    lidar.calibration.elevation = { startDeg: 0, endDeg: 1, stepDeg: 1 };
    lidar.calibration.products.pointCloud = true;
    lidar.noise = {
        ...lidar.noise,
        dropoutProbability: 0,
        pointDropoutProbability: 0,
        bias: 0,
        standardDeviation: 0,
    };
    return createPortableHeadlessBundle({ sensors: [createHeadlessImu(), lidar] });
}

function tensorByName(map, name) {
    return map.entries.find((entry) => entry.name === name)?.tensor;
}

async function hardwareRendererConfig() {
    const configPath = process.env.CEV_SIM_SUPERVISOR_CONFIG;
    const fallback = {
        chromiumExecutable: process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
        contextPoolSize: 1,
    };
    if (!configPath) return fallback;
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const renderer = config.renderer || {};
    return {
        chromiumExecutable: renderer.chromiumExecutable || fallback.chromiumExecutable,
        contextPoolSize: renderer.contextPoolSize ?? 1,
        angle: renderer.angle || "",
        disableSandbox: Boolean(renderer.disableSandbox),
        allowSoftwareRenderer: Boolean(renderer.allowSoftwareRenderer),
        pbrEnabled: renderer.pbrEnabled === true,
        pbrTarget: renderer.pbrTarget || "local-development",
        launchArgs: Array.isArray(renderer.launchArgs) ? renderer.launchArgs : [],
    };
}

function grpcCall(client, method, request) {
    return new Promise((resolve, reject) => {
        client[method](request, (error, response) => error ? reject(error) : resolve(response));
    });
}

test("unconfigured GPU support stays unavailable without loading a renderer adapter", async () => {
    let adapterLoaded = false;
    const pool = new PooledGpuRenderer({ chromiumExecutable: "" }, {
        adapterFactory: () => {
            adapterLoaded = true;
            throw new Error("GPU adapter must not load for CPU-only operation.");
        },
    });
    const probe = await pool.probe();
    assert.equal(probe.available, false);
    assert.match(probe.reason, /not configured/);
    assert.equal(adapterLoaded, false);
    await pool.close();
});

test("hardware renderer config copies ANGLE and launch arguments from the supervisor file", async (t) => {
    const previous = process.env.CEV_SIM_SUPERVISOR_CONFIG;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-gpu-renderer-config-"));
    t.after(async () => {
        if (previous === undefined) delete process.env.CEV_SIM_SUPERVISOR_CONFIG;
        else process.env.CEV_SIM_SUPERVISOR_CONFIG = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const configPath = path.join(root, "supervisor.json");
    await fs.writeFile(configPath, JSON.stringify({
        kind: "cev-sim.headless-supervisor-config",
        version: 1,
        renderer: {
            chromiumExecutable: "/usr/bin/chromium",
            angle: "gl-egl",
            launchArgs: ["--enable-gpu", "--use-gl=angle", "--use-angle=gl-egl"],
        },
    }));
    process.env.CEV_SIM_SUPERVISOR_CONFIG = configPath;
    const renderer = await hardwareRendererConfig();
    assert.equal(renderer.chromiumExecutable, "/usr/bin/chromium");
    assert.equal(renderer.angle, "gl-egl");
    assert.deepEqual(renderer.launchArgs, ["--enable-gpu", "--use-gl=angle", "--use-angle=gl-egl"]);
});

test("measured-perception adds delivered CPU LiDAR values without changing measured-state", async () => {
    const bundle = await perceptionLidarBundle();
    const stateEpisode = new HeadlessEpisode();
    const state = await stateEpisode.prepare(bundle.resolved, {
        observationProfile: measuredStateProfileRef(),
    });
    assert.equal(state.observationSpace.dictionary.entries.some((entry) => entry.key.includes("front-lidar")), false);
    stateEpisode.dispose();

    const episode = new HeadlessEpisode();
    const descriptor = await episode.prepare(bundle.resolved, {
        observationProfile: measuredPerceptionProfileRef(),
    });
    const valueName = "sensors/front-lidar/value";
    assert.equal(descriptor.observationSpace.dictionary.entries.some((entry) => entry.key === valueName), true);
    const reset = episode.reset();
    assert.equal(unpackTensor(tensorByName(reset.observation, "sensors/front-lidar/validity"))[0], false);
    assert.ok(unpackTensor(tensorByName(reset.observation, valueName)).every((value) => value === 0));
    const transition = episode.step([0, 0]);
    assert.equal(unpackTensor(tensorByName(transition.observation, "sensors/front-lidar/validity"))[0], true);
    assert.equal(unpackTensor(tensorByName(transition.observation, "sensors/front-lidar/is_new"))[0], true);
    assert.deepEqual(tensorByName(transition.observation, valueName).spec.shape, [1, 3, 2]);
    episode.dispose();
});

test("GPU manager submits same-time sync groups in stable sensor order and exposes only measured RGB", async () => {
    const first = await sensorFromDefault("camera");
    first.id = "camera-a";
    first.rateHz = 60;
    first.phaseNs = 0;
    first.syncGroupId = "cameras";
    first.calibration.width = 4;
    first.calibration.height = 2;
    first.calibration.distortion = [];
    first.calibration.products = {
        ...Object.fromEntries(Object.keys(first.calibration.products).map((key) => [key, false])),
        rgb: true,
    };
    const second = structuredClone(first);
    second.id = "camera-b";
    const bundle = await createPortableHeadlessBundle({
        sensors: [createHeadlessImu(), second, first],
    });
    const groups = [];
    const rendererClient = {
        async captureGroup(payload) {
            groups.push(payload.requests.map((entry) => entry.id));
            return payload.requests.map((request, index) => ({
                id: request.id,
                type: request.type,
                data: new Uint8Array(request.width * request.height * 4).fill(32 + index),
            }));
        },
        async provenance() { return { renderer: "fake-hardware" }; },
    };
    const episode = new HeadlessEpisode({ rendererClient });
    const descriptor = await episode.prepare(bundle.resolved, {
        observationProfile: measuredPerceptionProfileRef(),
    });
    assert.deepEqual(episode.episodeSpec.backendSelections.map((entry) => entry.kind), [1, 2, 4]);
    const keys = descriptor.observationSpace.dictionary.entries.map((entry) => entry.key);
    assert.ok(keys.includes("sensors/camera-a/value"));
    assert.equal(keys.some((key) => /depth|semantic|instance|detection/.test(key)), false);
    episode.reset();
    const transition = await episode.stepAsync([0, 0]);
    assert.deepEqual(groups, [["camera-a", "camera-b"]]);
    assert.equal(unpackTensor(tensorByName(transition.observation, "sensors/camera-a/validity"))[0], true);
    assert.deepEqual(tensorByName(transition.observation, "sensors/camera-a/value").spec.shape, [2, 4, 4]);
    episode.dispose();
});

test("generated GPU smoke bundles contain a verified route and pass supervisor preparation", async () => {
    const bundle = await createHeadlessSmokeBundle();
    const route = bundle.resolved.scenario.scenario.routes[0];
    const camera = bundle.resolved.manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera");
    assert.ok(route.verification.polyline.length >= 2);
    const result = await validateBundleWithSupervisor(bundle, {
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            renderer: { chromiumExecutable: "/fake/chromium" },
        },
        episodeSpec: { observationProfile: measuredPerceptionProfileRef() },
        supervisorFactory: (options) => new HeadlessSupervisor({
            ...options,
            rendererAdapterFactory: () => ({
                provenance: null,
                async start() {
                    this.provenance = {
                        renderer: "hardware-test-gpu",
                        floatColorBuffer: true,
                        floatFramebufferComplete: true,
                        readbackCheck: true,
                    };
                },
                isRunning() { return true; },
                async close() {},
            }),
        }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.validationMode, "supervisor");
    assert.ok(result.observationSpace.dictionary.entries.some(
        (entry) => entry.key === `sensors/${camera.id}/value`,
    ));
});

test("supervisor-backed runner executes GPU bundles through the configured renderer", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-gpu-runner-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const camera = await sensorFromDefault("camera");
    camera.rateHz = 60;
    camera.phaseNs = 0;
    camera.calibration.width = 4;
    camera.calibration.height = 2;
    camera.calibration.distortion = [];
    camera.calibration.products = {
        ...Object.fromEntries(Object.keys(camera.calibration.products).map((key) => [key, false])),
        rgb: true,
    };
    const bundle = await createPortableHeadlessBundle({
        sensors: [createHeadlessImu(), camera],
    });
    const events = [];
    const runner = new SupervisorRunner({
        supervisorFactory: (options) => new HeadlessSupervisor({
            ...options,
            rendererAdapterFactory: () => ({
                provenance: null,
                async start() {
                    this.provenance = {
                        renderer: "hardware-test-gpu",
                        floatColorBuffer: true,
                        floatFramebufferComplete: true,
                        readbackCheck: true,
                    };
                },
                isRunning() { return true; },
                async captureGroup(_scene, requests) {
                    return requests.map((request) => ({
                        id: request.id,
                        type: request.type,
                        data: new Uint8Array(request.width * request.height * 4).fill(64),
                    }));
                },
                async close() {},
            }),
        }),
    });
    const result = await runner.run(bundle, {
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            renderer: { chromiumExecutable: "/fake/chromium" },
        },
        episodeSpec: {
            actionRepeat: 5,
            observationProfile: measuredPerceptionProfileRef(),
        },
        actions: [{ policyStep: 1, action: [0, 0] }],
        artifactPolicy: { profile: "disabled" },
        outputUri: path.join(root, "output"),
        onEvent: (event) => events.push(event),
    });
    assert.equal(result.result.passed, true);
    assert.deepEqual(events.map((event) => event.kind), [
        "cev-sim.headless.reset",
        "cev-sim.headless.transition",
        "cev-sim.headless.result",
    ]);
    assert.ok(events.every((event) => event.executionMode === "supervisor"));
    await fs.access(path.join(result.outputDirectory, "run-results.json"));
});

test("pooled renderer launches once, fixes context count, and enforces per-environment budgets", async () => {
    let starts = 0;
    let receivedAssetReader = null;
    const adapter = {
        provenance: null,
        async start(count) {
            starts += 1;
            this.provenance = {
                renderer: "hardware-test-gpu",
                floatColorBuffer: true,
                floatFramebufferComplete: true,
                contextCount: count,
            };
        },
        async captureGroup(_scene, requests, _context, options) {
            receivedAssetReader = options.assetReader;
            return requests.map((request) => ({
                id: request.id,
                type: request.type,
                data: request.type === "camera"
                    ? new Uint8Array(request.width * request.height * 4)
                    : new Float32Array(request.width * request.height * 4),
            }));
        },
        async close() {},
    };
    const pool = new PooledGpuRenderer({
        chromiumExecutable: "/fake/chromium",
        contextPoolSize: 1,
        sceneCacheBytes: 4096,
        globalGpuBytes: 32768,
    }, { adapterFactory: () => adapter });
    const scene = { hash: "a".repeat(64), description: { materials: [] } };
    const assetReader = Object.freeze({ open: async () => null });
    assert.equal((await pool.probe()).available, true);
    await pool.captureGroup({
        environmentKey: "one",
        scene,
        assetReader,
        requests: [{ id: "camera", type: "camera", width: 2, height: 2, clearColor: [0, 0, 0, 1] }],
        maxGpuBytes: 1024,
    });
    assert.equal(receivedAssetReader, assetReader);
    assert.equal(starts, 1);
    assert.equal(pool.diagnostics().browserLaunches, 1);
    assert.equal(pool.diagnostics().contextCount, 1);
    for (const count of [1, 8, 16]) {
        const keys = Array.from({ length: count }, (_, index) => `soak-${count}-${index}`);
        await Promise.all(keys.map((environmentKey) => pool.captureGroup({
            environmentKey,
            scene,
            requests: [
                { id: "camera", type: "camera", width: 2, height: 2, clearColor: [0, 0, 0, 1] },
                { id: "lidar", type: "lidar3d", width: 2, height: 2, clearColor: [0, 0, 0, 0] },
            ],
            maxGpuBytes: 1024,
        })));
        assert.equal(pool.diagnostics().sceneCount, 1);
        for (const key of keys) pool.releaseEnvironment(key);
    }
    pool.releaseEnvironment("one");
    assert.equal(pool.diagnostics().trackedGpuBytes, 0);
    await assert.rejects(() => pool.captureGroup({
        environmentKey: "two",
        scene,
        requests: [{ id: "camera", type: "camera", width: 100, height: 100, clearColor: [0, 0, 0, 1] }],
        maxGpuBytes: 1024,
    }), /environment limit/);
    await pool.close();
});

test("VIS-15a PBR handles are generation-scoped and warm captures transfer only dynamic requests", async () => {
    const preparations = [];
    const captures = [];
    const releases = [];
    const authorizedUses = [];
    const openedUses = [];
    const adapter = {
        provenance: null,
        async start(count) {
            this.provenance = {
                renderer: "hardware-test-gpu",
                floatColorBuffer: true,
                floatFramebufferComplete: true,
                readbackCheck: true,
                pbrRuntime: true,
                pbrProbe: { material: true, decoder: true, asyncReadback: true },
                contextCount: count,
            };
        },
        async preparePbr(payload, slot) {
            preparations.push({ payload, slot });
            return {
                environmentKey: payload.environmentKey,
                generation: 1,
                renderSceneHash: payload.resolved.renderScene.hash,
                analyticSceneHash: "c".repeat(64),
                status: { state: "ready" },
            };
        },
        async capturePbr(environmentKey, requests) {
            captures.push({ environmentKey, requests });
            return requests.map((request) => ({
                id: request.id,
                type: "camera",
                captureTimeNs: request.captureTimeNs,
                aligned: true,
                products: { rgb: new Uint8Array(request.width * request.height * 4) },
            }));
        },
        async releasePbr(environmentKey) { releases.push(environmentKey); return true; },
        isRunning() { return true; },
        async close() {},
    };
    const pool = new PooledGpuRenderer({
        chromiumExecutable: "/fake/chromium",
        pbrEnabled: true,
        pbrTarget: "local-development",
        contextPoolSize: 1,
        globalGpuBytes: 4096,
    }, { adapterFactory: () => adapter, hostPlatform: "darwin", hostArch: "arm64" });
    const resolved = {
        renderScene: {
            hash: "b".repeat(64),
            description: { provider: { id: "pbr-mesh", version: 1 } },
        },
        evidence: { visualAssets: { uses: ["1".repeat(64), "2".repeat(64)].map((useHash) => ({
            useHash,
            use: {
                asset: {
                    sha256: "a".repeat(64),
                    sizeBytes: 3,
                    mediaType: "application/octet-stream",
                },
            },
        })) } },
    };
    const assetReader = {
        async authorizeUse(useHash, operations) { authorizedUses.push({ useHash, operations }); },
        async openUse(useHash) {
            openedUses.push(useHash);
            return { stream: Readable.from([Buffer.from("abc")]), async release() {} };
        },
    };
    await assert.rejects(() => pool.preparePbr({
        environmentKey: "environment-a",
        resolved,
        sensorRig: { sensors: [] },
        vehicles: [],
        maxGpuBytes: 2048,
        assetReader: { async open() {} },
    }), /exact-use access/);
    const prepared = await pool.preparePbr({
        environmentKey: "environment-a",
        resolved,
        sensorRig: { sensors: [] },
        vehicles: [],
        maxGpuBytes: 2048,
        assetReader,
    });
    const calibration = createVisualCameraCalibration({
        width: 2,
        height: 1,
        intrinsics: { fx: 2, fy: 2, cx: 0.5, cy: 0 },
        near: 0.1,
        far: 10,
        distortionModel: "none",
        distortion: [],
    });
    const sceneHandle = createOwnedCaptureScene({
        role: "measured-appearance",
        scene: {},
        generation: prepared.generation,
        descriptionHash: resolved.renderScene.hash,
    });
    const request = {
        id: "camera",
        type: "camera",
        provider: { id: "pbr-mesh", version: 1 },
        width: 2,
        height: 1,
        captureTimeNs: 7,
        captureInput: createVisualCaptureInput({
            calibration,
            pose: { matrixWorld: new THREE.Matrix4().elements },
            sceneHandle,
            captureTimeNs: 7,
        }),
        products: { rgb: true },
        vehicles: [],
    };
    assert.equal(pool.pbrCapability().available, true);
    await assert.rejects(() => pool.capturePbrGroup({
        environmentKey: "environment-a",
        handle: prepared,
        requests: [request],
        maxGpuBytes: 128,
    }), /environment limit/);
    const preparedBytes = pool.diagnostics().trackedGpuBytes;
    await pool.capturePbrGroup({
        environmentKey: "environment-a",
        handle: prepared,
        requests: [request],
        maxGpuBytes: 2048,
    });
    assert.equal(preparations.length, 1);
    assert.equal(captures.length, 1);
    for (const useHash of ["1".repeat(64), "2".repeat(64)]) {
        assert.equal(authorizedUses.filter((entry) => entry.useHash === useHash).length, 3);
    }
    assert.deepEqual(openedUses, ["1".repeat(64)]);
    assert.equal("resolved" in captures[0], false);
    assert.equal("assets" in captures[0], false);
    assert.ok(pool.diagnostics().trackedGpuBytes > preparedBytes);
    const replacement = await pool.preparePbr({
        environmentKey: "environment-a",
        resolved,
        sensorRig: { sensors: [] },
        vehicles: [],
        maxGpuBytes: 2048,
        assetReader,
    });
    assert.notEqual(replacement.generation, prepared.generation);
    await assert.rejects(() => pool.capturePbrGroup({
        environmentKey: "environment-a",
        handle: prepared,
        requests: [request],
        maxGpuBytes: 2048,
    }), /stale/);
    await assert.rejects(() => pool.capturePbrGroup({
        environmentKey: "environment-b",
        handle: replacement,
        requests: [request],
        maxGpuBytes: 2048,
    }), /another environment/);
    assert.ok(releases.includes("environment-a"));
    await pool.close();
});

test("VIS-15a advertises backend v2 only after every target-specific PBR probe succeeds", async () => {
    const disabled = new HeadlessSupervisor({
        socket: path.join(os.tmpdir(), "unused-vis15a-disabled-capability.sock"),
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            renderer: { chromiumExecutable: "", pbrEnabled: false },
        },
    });
    const disabledResponse = await disabled.getCapabilities({ clientProtocol: { major: 1, minor: 4 } });
    assert.deepEqual(
        disabledResponse.backends.filter((entry) => entry.kind === 4).map((entry) => entry.version),
        ["1"],
    );
    await disabled.close();
    const supervisor = new HeadlessSupervisor({
        socket: path.join(os.tmpdir(), "unused-vis15a-capability.sock"),
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            renderer: {
                chromiumExecutable: "/fake/chromium",
                pbrEnabled: true,
                pbrTarget: "local-development",
            },
        },
        rendererHostPlatform: "darwin",
        rendererHostArch: "arm64",
        rendererAdapterFactory: () => ({
            provenance: null,
            async start() {
                this.provenance = {
                    renderer: "hardware-test-gpu",
                    floatColorBuffer: true,
                    floatFramebufferComplete: true,
                    readbackCheck: true,
                    pbrRuntime: true,
                    pbrProbe: { material: true, decoder: true, asyncReadback: true },
                };
            },
            async close() {},
        }),
    });
    const response = await supervisor.getCapabilities({ clientProtocol: { major: 1, minor: 4 } });
    const gpu = response.backends.filter((entry) => entry.kind === 4);
    assert.deepEqual(gpu.map((entry) => entry.version), ["1", "2"]);
    assert.equal(gpu[1].available, true);
    assert.ok(gpu[1].features.includes("analytic-instance"));
    const diagnostics = JSON.parse(Buffer.from(response.diagnosticJson).toString("utf8"));
    assert.equal(diagnostics.pbrProbe.target, "local-development");
    assert.deepEqual(diagnostics.pbrProbe.products, ["rgba8", "camera-info", "32FC1", "16UC1", "32SC1"]);
    await supervisor.close();
});

test("VIS-15a stages PBR product tensors atomically in the environment arena", async () => {
    const values = {
        rgb: new Uint8Array(8),
        depth: new Float32Array(2),
        semantic: new Uint16Array(2),
        instance: new Uint32Array(2),
    };
    const published = [];
    const released = [];
    const rendererPool = {
        async capturePbrGroup() {
            return [{
                id: "camera",
                type: "camera",
                captureTimeNs: 1,
                aligned: true,
                products: values,
            }];
        },
        diagnostics() { return {}; },
        async close() {},
    };
    const supervisor = new HeadlessSupervisor({
        socket: path.join(os.tmpdir(), "unused-vis15a-arena.sock"),
        rendererPool,
    });
    const arena = {
        async publishTensor(bytes, spec) {
            const reference = { regionName: "arena", offsetBytes: String(published.length + 1) };
            published.push({ bytes: Uint8Array.from(bytes), spec, reference });
            return reference;
        },
        async release(reference) { released.push(reference); return true; },
    };
    const environment = {
        batch: { id: "batch", limits: { maxGpuBytesPerEnvironment: 4096, stepWallTimeoutMs: 1000 } },
        index: 0,
        sharedArena: arena,
        transportSequence: 0n,
    };
    const payload = {
        handle: { generation: 1 },
        requests: [{ id: "camera", width: 2, height: 1 }],
    };
    const [captured] = await supervisor._rendererRequest(environment, "capture-pbr", payload);
    assert.deepEqual(captured.products, {});
    assert.deepEqual(Object.keys(captured.productSharedMemory), ["rgb", "depth", "semantic", "instance"]);
    assert.deepEqual(published.map((entry) => entry.spec.dtype), [4, 1, 6, 8]);
    assert.equal(environment.transportSequence, 1n);

    published.length = 0;
    released.length = 0;
    environment.transportSequence = 1n;
    arena.publishTensor = async (bytes, spec) => {
        if (published.length === 2) throw Object.assign(new Error("arena exhausted"), { code: "RESOURCE_LIMIT" });
        const reference = { regionName: "arena", offsetBytes: String(published.length + 1) };
        published.push({ bytes: Uint8Array.from(bytes), spec, reference });
        return reference;
    };
    await assert.rejects(() => supervisor._rendererRequest(environment, "capture-pbr", payload), /arena exhausted/);
    assert.deepEqual(released, published.map((entry) => entry.reference));
    assert.equal(environment.transportSequence, 1n);
    await supervisor.close();
});

test("VIS-15b direct managed runs use isolated renderer scopes and release them after workers stop", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis15b-managed-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const camera = await sensorFromDefault("camera");
    camera.rateHz = 60;
    camera.phaseNs = 0;
    camera.calibration.width = 2;
    camera.calibration.height = 1;
    let bundle = await createPortableHeadlessBundle({ sensors: [camera] });
    bundle.resolved.manifest.controls.authority = "reference";
    bundle.resolved.manifest.clock.maxSteps = 10;
    bundle.resolved.scenario.scenario.routes[0].controller = {
        kind: "route-follower",
        activation: { kind: "start" },
    };
    bundle = rehashRunBundle(bundle);
    const exactBytes = runBundleBytes(bundle);
    const scopes = [];
    const released = [];
    let closedWorkers = 0;
    const rendererPool = {
        async probe() { return { available: true, reason: "" }; },
        pbrCapability() { return { available: false, reason: "disabled" }; },
        diagnostics() { return { renderer: "managed-fake" }; },
        async captureGroup({ environmentKey, requests }) {
            scopes.push(environmentKey);
            return requests.map((request) => ({
                id: request.id,
                type: request.type,
                scope: environmentKey,
                data: new Uint8Array(request.width * request.height * 4),
            }));
        },
        async releaseEnvironment(environmentKey) { released.push(environmentKey); },
        async close() {},
    };
    let nextPid = 9000;
    const workerFactory = (options) => ({
        pid: nextPid++,
        pendingBytes: 0,
        async dispatch(command, payload) {
            if (command === "initialize") {
                assert.equal(Buffer.from(payload.bundleBytes).equals(Buffer.from(exactBytes)), true);
                return { descriptor: {} };
            }
            if (command === "run-managed") {
                const [captured] = await options.rendererHandler("capture-group", {
                    scene: bundle.resolved.renderScene,
                    requests: [{ id: "camera", type: "camera", width: 2, height: 1 }],
                });
                return { finalized: { scope: captured.scope } };
            }
            throw new Error(`Unexpected command ${command}.`);
        },
        async close() { closedWorkers += 1; },
        terminate() {},
    });
    const supervisor = new HeadlessSupervisor({
        socket: path.join(root, "unused-vis15b-managed.sock"),
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            maxWorkers: 2,
        },
        rendererPool,
        workerFactory,
    });
    try {
        const results = await Promise.all(["a", "b"].map((suffix) => supervisor.runManagedExperiment({
            bundle,
            bundleBytes: exactBytes,
            bundleBytesHash: createHash("sha256").update(exactBytes).digest("hex"),
            outputUri: path.join(root, `vis15b-${suffix}`),
        })));
        assert.equal(new Set(scopes).size, 2);
        assert.deepEqual(results.map((entry) => entry.scope).sort(), [...scopes].sort());
        assert.deepEqual([...released].sort(), [...scopes].sort());
        assert.equal(closedWorkers, 2);
        assert.equal(supervisor.workers.size, 0);
        assert.equal(supervisor.reservedWorkers, 0);
    } finally {
        await supervisor.close();
    }
});

test("VIS-15a routes PBR cameras and analytic LiDAR separately, then commits the sync group atomically", async () => {
    const camera = await sensorFromDefault("camera");
    camera.rateHz = 60;
    camera.phaseNs = 0;
    camera.syncGroupId = "perception";
    camera.calibration.width = 2;
    camera.calibration.height = 1;
    camera.calibration.intrinsics = { fx: 2, fy: 3, cx: 0.25, cy: 0 };
    camera.calibration.distortion = [];
    camera.calibration.products = {
        ...Object.fromEntries(Object.keys(camera.calibration.products).map((key) => [key, false])),
        rgb: true,
        cameraInfo: true,
        depth: true,
        semantic: true,
        instance: true,
    };
    const lidar = await sensorFromDefault("lidar3d");
    lidar.rateHz = 60;
    lidar.phaseNs = 0;
    lidar.syncGroupId = "perception";
    lidar.calibration.azimuth = { startDeg: 0, endDeg: 2, stepDeg: 1 };
    lidar.calibration.elevation = { startDeg: 0, endDeg: 1, stepDeg: 1 };
    const calls = [];
    const rendererClient = {
        async capturePbr({ requests }) {
            calls.push({ route: "pbr", requests });
            return requests.map((request) => ({
                id: request.id,
                type: "camera",
                aligned: true,
                captureTimeNs: request.captureTimeNs,
                products: {
                    rgb: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]),
                    depth: new Float32Array([2, Number.NaN]),
                    semantic: new Uint16Array([7, 0]),
                    instance: new Uint32Array([70, 0]),
                },
            }));
        },
        async captureGroup({ scene, requests }) {
            calls.push({ route: "lidar", scene, requests });
            return requests.map((request) => ({
                id: request.id,
                type: "lidar3d",
                data: new Float32Array(request.width * request.height * 4),
            }));
        },
    };
    const renderScene = {
        hash: "d".repeat(64),
        description: { provider: { id: "pbr-mesh", version: 1 } },
    };
    const lidarGeometry = { hash: "e".repeat(64), description: { staticPrimitives: [], actors: [] } };
    const vehicles = { vehicles: [{
        id: "ego",
        telemetryId: "ego",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    }] };
    const manager = new HeadlessGpuSensorManager(vehicles, { rendererClient });
    await manager.configureFromManifest({ sensors: [camera, lidar] }, {
        backendSelection: createGpuSensorBackendV2Selection(),
        renderScene,
        lidarGeometry,
        renderRuntime: { generation: 9, renderSceneHash: renderScene.hash },
        transformRuntime: {
            resolveCaptureFrames() {
                return {
                    ok: true,
                    mapPose: {
                        position: { x: 0, y: 0, z: 0 },
                        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
                    },
                };
            },
        },
        stepNs: 16_666_667,
        topics: [],
        perceptionObservations: true,
    });
    await manager.updateAsync(1 / 60, { step: 1, timeNs: 16_666_667 });
    assert.deepEqual(calls.map((entry) => entry.route).sort(), ["lidar", "pbr"]);
    assert.equal(calls.find((entry) => entry.route === "lidar").scene, lidarGeometry);
    const cameraQueue = manager.devices.find((device) => device.id === camera.id).contractPublisher.queue;
    const lidarQueue = manager.devices.find((device) => device.id === lidar.id).contractPublisher.queue;
    assert.equal(cameraQueue.length, 1);
    assert.equal(lidarQueue.length, 1);
    assert.deepEqual(cameraQueue[0].messages.map((entry) => entry.value.encoding), [
        "rgba8", undefined, "32FC1", "16UC1", "32SC1",
    ]);
    assert.equal(cameraQueue[0].observation.dtype, "uint8");
    assert.equal(cameraQueue[0].observation.shape.join(","), "1,2,4");
    manager.disposeRun();
});

test("renderer failures reject queued work, restart the sidecar, and enforce capture timeouts", async () => {
    let starts = 0;
    let captures = 0;
    let closes = 0;
    const adapterFactory = () => ({
        provenance: null,
        async start() {
            starts += 1;
            this.provenance = {
                renderer: "hardware-test-gpu",
                floatColorBuffer: true,
                floatFramebufferComplete: true,
                readbackCheck: true,
            };
        },
        async captureGroup(_scene, requests) {
            captures += 1;
            if (captures === 1) throw new Error("context lost");
            return requests.map((request) => ({
                id: request.id,
                type: request.type,
                data: new Uint8Array(request.width * request.height * 4),
            }));
        },
        async close() { closes += 1; },
    });
    const pool = new PooledGpuRenderer({
        chromiumExecutable: "/fake/chromium",
        globalGpuBytes: 4096,
        sceneCacheBytes: 4096,
    }, { adapterFactory });
    const job = {
        environmentKey: "restart",
        scene: { hash: "b".repeat(64), description: { materials: [] } },
        requests: [{ id: "camera", type: "camera", width: 1, height: 1 }],
        maxGpuBytes: 1024,
    };
    await assert.rejects(() => pool.captureGroup(job), /context lost/);
    assert.equal((await pool.captureGroup(job))[0].id, "camera");
    assert.equal(starts, 2);
    assert.equal(pool.diagnostics().browserLaunches, 2);
    await pool.close();
    assert.ok(closes >= 2);

    const hanging = new PooledGpuRenderer({
        chromiumExecutable: "/fake/chromium",
        globalGpuBytes: 4096,
        sceneCacheBytes: 4096,
    }, { adapterFactory: () => ({
        provenance: null,
        async start() {
            this.provenance = {
                renderer: "hardware-test-gpu",
                floatColorBuffer: true,
                floatFramebufferComplete: true,
                readbackCheck: true,
            };
        },
        captureGroup() { return new Promise(() => {}); },
        async close() {},
    }) });
    await assert.rejects(() => hanging.captureGroup({ ...job, timeoutMs: 10 }), /wall timeout/);
    await hanging.close();
});

test("hardware WebGL2 LiDAR matches CPU range/incidence on the canonical scene", {
    skip: !process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
}, async () => {
    const fixture = JSON.parse(await fs.readFile(
        new URL("./fixtures/headless/lidar-gpu-reference.v1.json", import.meta.url),
        "utf8",
    ));
    const primitive = createBoxLidarTwin({ ...fixture.box, tags: ["building"] });
    const description = {
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
        staticPrimitives: [primitive],
        actors: [],
    };
    const scene = { description, hash: hashLidarGeometry(description) };
    const sensor = {
        id: "lidar",
        type: "lidar3d",
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
        calibration: fixture.sensor,
    };
    const vehicles = [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }];
    const cpuScene = new CpuLidarScene(scene);
    const cpu = cpuScene.capture(sensor, vehicles);
    const width = Math.ceil(
        (sensor.calibration.azimuth.endDeg - sensor.calibration.azimuth.startDeg)
        / sensor.calibration.azimuth.stepDeg,
    );
    const height = Math.ceil(
        (sensor.calibration.elevation.endDeg - sensor.calibration.elevation.startDeg)
        / sensor.calibration.elevation.stepDeg,
    );
    const pool = new PooledGpuRenderer(await hardwareRendererConfig());
    try {
        const [captured] = await pool.captureGroup({
            environmentKey: "parity",
            scene,
            requests: [{ id: "lidar", type: "lidar3d", width, height, sensor, vehicles }],
            maxGpuBytes: 64 * 1024 * 1024,
        });
        for (let offset = 0; offset < cpu.length; offset += 4) {
            const ray = offset / 4;
            const distanceDelta = Math.abs(captured.data[offset] - cpu[offset]);
            const incidenceDelta = Math.abs(captured.data[offset + 1] - cpu[offset + 1]);
            assert.ok(distanceDelta <= 1e-4, JSON.stringify({
                ray,
                gpuRange: captured.data[offset],
                cpuRange: cpu[offset],
                distanceDelta,
                gpuIncidence: captured.data[offset + 1],
                cpuIncidence: cpu[offset + 1],
                semantic: captured.data[offset + 2],
                instance: captured.data[offset + 3],
            }));
            assert.ok(incidenceDelta <= 1e-4, `ray ${ray}: incidence delta ${incidenceDelta}`);
            assert.equal(captured.data[offset + 2], cpu[offset + 2]);
            assert.equal(captured.data[offset + 3], cpu[offset + 3]);
        }
    } finally {
        cpuScene.dispose();
        await pool.close();
    }
});

test("VIS-15a hardware PBR fixture executes RGBA and analytic products on the selected stack", {
    skip: process.env.CEV_SIM_PBR_HARDWARE !== "1",
    timeout: 60_000,
}, async () => {
    const glb = makeNamedMaterialGlb("actor-material", {
        extras: { semanticId: 65000, instanceId: 4_000_000_000, forged: true },
    });
    const ktx2 = await fs.readFile(new URL(
        "./fixtures/visual-layer/sample_uastc_zstd.ktx2",
        import.meta.url,
    ));
    const resolved = resolvedPbrRun({
        actorSha256: sha256Hex(glb),
        actorSizeBytes: glb.byteLength,
        environmentMapSha256: sha256Hex(ktx2),
        environmentMapSizeBytes: ktx2.byteLength,
    });
    const config = await hardwareRendererConfig();
    config.pbrEnabled = true;
    config.pbrTarget = process.env.CEV_SIM_PBR_TARGET || (process.platform === "darwin"
        ? "local-development"
        : "jetson-agx-orin");
    const pool = new PooledGpuRenderer(config);
    const rssBefore = process.memoryUsage().rss;
    let report = null;
    const vehicle = {
        id: "ego",
        telemetryId: "ego",
        position: { x: 0, y: 0, z: -5 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    };
    const assets = new Map([
        [resolved.actorUseHash, glb],
        [resolved.environmentMapUseHash, ktx2],
    ]);
    const assetReader = {
        async authorizeUse(useHash, operations) {
            assert.equal(assets.has(useHash), true);
            assert.deepEqual(operations, ["display", "machine-interpretation"]);
        },
        async openUse(useHash) {
            assert.equal(assets.has(useHash), true);
            return { stream: Readable.from([assets.get(useHash)]), async release() {} };
        },
    };
    const authoredCalibration = {
        width: 5,
        height: 4,
        intrinsics: { fx: 4.5, fy: 5.25, cx: 1.75, cy: 1.25 },
        near: 0.1,
        far: 100,
        distortionModel: "plumb_bob",
        distortion: [0.01, -0.001, 0.0005, -0.00025, 0],
    };
    const calibration = createVisualCameraCalibration({
        ...authoredCalibration,
        distortionModel: "brown-conrady",
    });
    try {
        const probe = await pool.probe();
        assert.equal(probe.available, true, probe.reason);
        assert.equal(pool.pbrCapability().available, true, pool.pbrCapability().reason);
        const originIsolation = await pool.adapter.page.evaluate(async () => {
            let externalBlocked = false;
            try { await fetch("https://example.invalid/denied"); } catch { externalBlocked = true; }
            return {
                externalBlocked,
                unallowlistedStatus: (await fetch("/runtime/app/client/Client.js")).status,
            };
        });
        assert.deepEqual(originIsolation, { externalBlocked: true, unallowlistedStatus: 404 });
        const preparationStarted = performance.now();
        const handle = await pool.preparePbr({
            environmentKey: "hardware-pbr",
            resolved,
            sensorRig: {
                sensors: [{
                    id: "camera",
                    type: "camera",
                    parentId: "ego",
                    calibration: authoredCalibration,
                    pose: {
                        position: { x: 0, y: 0, z: 0 },
                        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
                    },
                }],
            },
            vehicles: [vehicle],
            maxGpuBytes: 128 * 1024 * 1024,
            assetReader,
        });
        const preparationMs = performance.now() - preparationStarted;
        const sceneHandle = createOwnedCaptureScene({
            role: "measured-appearance",
            scene: {},
            generation: handle.generation,
            descriptionHash: resolved.renderScene.hash,
        });
        const captureInput = createVisualCaptureInput({
            calibration,
            pose: { matrixWorld: new THREE.Matrix4().elements },
            sceneHandle,
            captureTimeNs: 1_000_000,
        });
        const request = {
                id: "camera",
                type: "camera",
                provider: { id: "pbr-mesh", version: 1 },
                width: 5,
                height: 4,
                captureTimeNs: 1_000_000,
                captureInput,
                products: { rgb: true, depth: true, semantic: true, instance: true },
                vehicles: [vehicle],
        };
        const capture = async () => pool.capturePbrGroup({
            environmentKey: "hardware-pbr",
            handle,
            requests: [request],
            maxGpuBytes: 128 * 1024 * 1024,
        });
        const coldStarted = performance.now();
        const [captured] = await capture();
        const coldCaptureMs = performance.now() - coldStarted;
        vehicle.position.x = 0.25;
        const warmStarted = performance.now();
        const [warm] = await capture();
        const warmCaptureMs = performance.now() - warmStarted;
        assert.equal(captured.aligned, true);
        assert.equal(captured.products.rgb.length, 5 * 4 * 4);
        assert.equal(captured.products.depth.length, 5 * 4);
        assert.equal(captured.products.semantic.length, 5 * 4);
        assert.equal(captured.products.instance.length, 5 * 4);
        assert.equal(warm.products.rgb.length, captured.products.rgb.length);
        assert.equal(pool.diagnostics().preparedPbrEnvironments, 1);
        report = {
            kind: "cev-sim.pbr-hardware-report",
            version: 1,
            target: config.pbrTarget,
            platform: process.platform,
            architecture: process.arch,
            probe: pool.diagnostics().provenance,
            measurements: {
                preparationMs,
                coldCaptureMs,
                warmCaptureMs,
                staticTransferBytes: glb.byteLength + ktx2.byteLength + Buffer.byteLength(JSON.stringify(resolved)),
                captureTransferBytes: 5 * 4 * (4 + 4 + 2 + 4),
                rssBefore,
                rssAfterWarmCapture: process.memoryUsage().rss,
            },
        };
    } finally {
        await pool.close();
        if (report && process.env.CEV_SIM_PBR_REPORT) {
            report.cleanup = pool.diagnostics();
            await fs.mkdir(path.dirname(process.env.CEV_SIM_PBR_REPORT), { recursive: true });
            await fs.writeFile(process.env.CEV_SIM_PBR_REPORT, `${JSON.stringify(report, null, 2)}\n`);
        }
    }
});

test("protocol 1.2 UDS returns large GPU observations through shared memory", {
    skip: !process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
    timeout: 60_000,
}, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-gpu-supervisor-"));
    const socket = path.join(root, "supervisor.sock");
    const camera = await sensorFromDefault("camera");
    camera.rateHz = 60;
    camera.phaseNs = 0;
    camera.calibration.width = 256;
    camera.calibration.height = 128;
    camera.calibration.distortion = [];
    camera.calibration.products = {
        ...Object.fromEntries(Object.keys(camera.calibration.products).map((key) => [key, false])),
        rgb: true,
    };
    const bundle = await createPortableHeadlessBundle({ sensors: [createHeadlessImu(), camera] });
    const running = await startHeadlessSupervisor({
        socket,
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            renderer: await hardwareRendererConfig(),
        },
    });
    const { grpc, service } = loadHeadlessGrpcSchema();
    const client = new service(`unix:${socket}`, grpc.credentials.createInsecure(), {
        "grpc.max_receive_message_length": running.config.maxRpcMessageBytes,
        "grpc.max_send_message_length": running.config.maxRpcMessageBytes,
    });
    t.after(async () => {
        client.close();
        await running.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    const capabilities = await grpcCall(client, "getCapabilities", {
        clientProtocol: { major: 1, minor: 3 },
    });
    assert.equal(capabilities.protocol.minor, 4);
    assert.ok(capabilities.transports.includes("grpc+unix+shared-memory-v1"));
    assert.equal(capabilities.backends.find((entry) => entry.kind === 4).available, true);
    const diagnostics = JSON.parse(Buffer.from(capabilities.diagnosticJson).toString("utf8"));
    assert.match(diagnostics.gpuRenderer.provenance.renderer, /ANGLE/);
    const profile = measuredPerceptionProfileRef();
    const reward = routeSafetyProfileRef();
    const created = await grpcCall(client, "createBatch", {
        clientProtocol: { major: 1, minor: 3 },
        runBundles: [{
            bundleId: "gpu",
            resolvedHash: bundle.resolvedHash,
            simulationSemanticHash: bundle.simulationSemanticHash,
            canonicalJson: Buffer.from(canonicalStringify(bundle)),
        }],
        episodes: [{
            environmentIndex: 0,
            environmentId: "gpu-0",
            runBundleId: "gpu",
            resetSeed: "1",
            actionRepeat: 1,
            maxEpisodeSteps: "4",
            observationProfile: profile,
            rewardProfile: reward,
        }],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "output") },
    });
    assert.equal(created.error.code, 0, created.error.message);
    const reset = await grpcCall(client, "resetBatch", {
        batchId: created.batch.batchId,
        episodes: [{
            environmentIndex: 0,
            environmentId: "gpu-0",
            runBundleId: "gpu",
            resetSeed: "1",
            actionRepeat: 1,
            maxEpisodeSteps: "4",
            observationProfile: profile,
            rewardProfile: reward,
        }],
    });
    assert.equal(reset.results[0].error.code, 0, reset.results[0].error.message);
    const resetCamera = reset.results[0].observation.entries
        .find((entry) => entry.name === `sensors/${camera.id}/value`);
    assert.ok(resetCamera.tensor.payload.sharedMemory);
    const region = resetCamera.tensor.payload.sharedMemory.regionName;
    assert.equal((await fs.stat(region)).isFile(), true);
    const step = await grpcCall(client, "stepBatch", {
        batchId: created.batch.batchId,
        actions: [{
            environmentIndex: 0,
            action: {
                entries: [{
                    name: "action",
                    tensor: {
                        spec: { dtype: 1, shape: [2], byteOrder: 1 },
                        payload: { packedData: Buffer.alloc(8) },
                    },
                }],
            },
        }],
    });
    assert.equal(step.results[0].error.code, 0, step.results[0].error.message);
    const stepCamera = step.results[0].observation.entries
        .find((entry) => entry.name === `sensors/${camera.id}/value`);
    assert.ok(stepCamera.tensor.payload.sharedMemory);
    assert.notEqual(stepCamera.tensor.payload.sharedMemory.sequence, resetCamera.tensor.payload.sharedMemory.sequence);
    assert.equal(running.supervisor.rendererPool.diagnostics().browserLaunches, 1);
    const closed = await grpcCall(client, "closeBatch", {
        batchId: created.batch.batchId,
        finalizeActiveEpisodes: false,
    });
    assert.equal(closed.error.code, 0);
    await assert.rejects(() => fs.stat(region), { code: "ENOENT" });
});
