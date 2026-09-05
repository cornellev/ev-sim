import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";

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
import { StorageService } from "../server/storage/StorageService.js";
import { loadHeadlessGrpcSchema } from "../server/headless/GrpcSchema.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { startHeadlessSupervisor } from "../server/headless/SupervisorServer.js";
import { SupervisorRunner } from "../server/headless/SupervisorRunner.js";
import { validateBundleWithSupervisor } from "../server/headless/SupervisorValidation.js";
import { canonicalStringify } from "../app/simulation/RunManifest.js";
import { routeSafetyProfileRef } from "../app/simulation/headless/ProfileRegistry.js";
import {
    createHeadlessImu,
    createPortableHeadlessBundle,
} from "./helpers/headlessRunnerBundle.js";

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

test("supervisor-backed validation prepares GPU bundles with the configured renderer", async () => {
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
        async captureGroup(_scene, requests) {
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
    assert.equal((await pool.probe()).available, true);
    await pool.captureGroup({
        environmentKey: "one",
        scene,
        requests: [{ id: "camera", type: "camera", width: 2, height: 2, clearColor: [0, 0, 0, 1] }],
        maxGpuBytes: 1024,
    });
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
    const pool = new PooledGpuRenderer({
        chromiumExecutable: process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
        contextPoolSize: 1,
    });
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
            renderer: {
                chromiumExecutable: process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
                contextPoolSize: 1,
            },
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
        clientProtocol: { major: 1, minor: 2 },
    });
    assert.equal(capabilities.protocol.minor, 2);
    assert.ok(capabilities.transports.includes("grpc+unix+shared-memory-v1"));
    assert.equal(capabilities.backends.find((entry) => entry.kind === 4).available, true);
    const diagnostics = JSON.parse(Buffer.from(capabilities.diagnosticJson).toString("utf8"));
    assert.match(diagnostics.gpuRenderer.provenance.renderer, /ANGLE/);
    const profile = measuredPerceptionProfileRef();
    const reward = routeSafetyProfileRef();
    const created = await grpcCall(client, "createBatch", {
        clientProtocol: { major: 1, minor: 2 },
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
