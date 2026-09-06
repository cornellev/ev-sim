import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCalibrationBundle } from "../app/autonomy/CalibrationBundle.js";
import {
    createRunSensor,
    getSensorType,
    normalizeRunSensor,
} from "../app/3d/devices/SensorTypeRegistry.js";
import { createDefaultRunManifest, computeResolvedRunHash, normalizeRunManifest, validateRunManifest } from "../app/simulation/RunManifest.js";
import { HeadlessEpisode, normalizeEpisodeSpec } from "../app/simulation/headless/HeadlessEpisode.js";
import {
    GPU_SENSOR_BACKEND_CONFIG_HASH,
    GPU_SENSOR_BACKEND_V2_CONFIG_HASH,
    GPU_SENSOR_BACKEND_V2_UNAVAILABLE_REASON,
    GPU_SENSOR_BACKEND_VERSION,
    assertGpuSensorBackendSelection,
    createGpuSensorBackendSelection,
    createGpuSensorBackendV2Selection,
} from "../app/simulation/sensors/GpuSensorBackend.js";
import {
    createRenderSceneResource,
    hashRenderScene,
} from "../app/simulation/render/RenderScene.js";
import {
    DEFAULT_CAMERA_RENDER_SELECTION,
    RenderSceneProviderError,
    RenderSceneProviderRegistry,
    defaultCameraRenderSelection,
    renderSceneProviderRegistry,
    resolveEnabledCameraRenderSelection,
} from "../app/simulation/render/RenderSceneProviderRegistry.js";
import {
    computeEpisodeHash,
    computeSimulationSemanticHash,
    defaultEpisodeIdentity,
} from "../app/simulation/kernel/SimulationHashes.js";
import { StorageService } from "../server/storage/StorageService.js";
import {
    canonicalRunBundleStringify,
    verifyRunBundle,
    verifyRunBundleBytes,
    verifyRunBundleIntegrity,
} from "../server/headless/RunBundle.js";
import {
    createHeadlessImu,
    createPortableHeadlessBundle,
    rehashRunBundle,
} from "./helpers/headlessRunnerBundle.js";

const pbrRender = () => ({
    provider: { id: "pbr-mesh", version: 1 },
    productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
});

const analyticRender = () => defaultCameraRenderSelection();

function identities(resolved) {
    return {
        semantic: computeSimulationSemanticHash(resolved),
        browser: computeEpisodeHash(defaultEpisodeIdentity(resolved)),
        headless: computeEpisodeHash({
            ...normalizeEpisodeSpec(resolved),
            simulationSemanticHash: computeSimulationSemanticHash(resolved),
        }),
    };
}

function rehashDocument(bundle) {
    const next = structuredClone(bundle);
    next.resolved.definitionHash = computeResolvedRunHash(next.resolved.manifest);
    next.resolved.calibration = buildCalibrationBundle(next.resolved.manifest);
    next.resolved.dependencyHashes.calibration = next.resolved.calibration.hash;
    next.resolved.simulationSemanticHash = computeSimulationSemanticHash(next.resolved);
    next.resolved.resolvedHash = computeResolvedRunHash(next.resolved);
    next.manifest = structuredClone(next.resolved.manifest);
    next.resolvedHash = next.resolved.resolvedHash;
    next.simulationSemanticHash = next.resolved.simulationSemanticHash;
    return next;
}

async function temporaryService(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vis-02-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, service: new StorageService(root) };
}

test("render-scene registry rejects malformed and duplicate provider declarations", () => {
    const registry = new RenderSceneProviderRegistry();
    const profile = {
        id: "measured-rgba-analytic-oracle",
        version: 1,
        measured: ["rgb", "cameraInfo"],
        optionalOracle: ["depth", "semantic", "instance"],
    };
    assert.throws(() => registry.register({ id: "", version: 1, available: true, productProfiles: [profile] }), (error) => (
        error instanceof RenderSceneProviderError && error.code === "MALFORMED_RENDER_SELECTION"
    ));
    assert.throws(() => registry.register({
        id: "canonical-analytic", version: 0, available: true, productProfiles: [profile],
    }), /positive integer/);
    assert.throws(() => registry.register({
        id: "canonical-analytic", version: 1, available: true, productProfiles: [{
            ...profile, optionalOracle: ["depth", "depth"],
        }],
    }), (error) => error.code === "DUPLICATE_PRODUCT");
    registry.register({ id: "canonical-analytic", version: 1, available: true, productProfiles: [profile] });
    assert.throws(() => registry.register({
        id: "canonical-analytic", version: 1, available: false, productProfiles: [profile],
    }), (error) => error.code === "DUPLICATE_PROVIDER");
});

test("render-scene registry distinguishes unknown id, unknown version, and known-but-unavailable providers", () => {
    assert.equal(renderSceneProviderRegistry.lookup({ id: "canonical-analytic", version: 1 }).available, true);
    assert.equal(renderSceneProviderRegistry.lookup({ id: "canonical-analytic", version: 2 }).available, false);
    assert.equal(renderSceneProviderRegistry.lookup({ id: "pbr-mesh", version: 1 }).available, false);
    assert.throws(() => renderSceneProviderRegistry.lookup({ id: "gaussian-splat", version: 1 }), (error) => (
        error.code === "UNKNOWN_PROVIDER"
    ));
    assert.throws(() => renderSceneProviderRegistry.lookup({ id: "canonical-analytic", version: 9 }), (error) => (
        error.code === "UNKNOWN_PROVIDER_VERSION"
    ));
    assert.throws(() => renderSceneProviderRegistry.lookup({ id: "pbr-mesh", version: 1 }, { requireAvailable: true }), (error) => (
        error.code === "PROVIDER_UNAVAILABLE"
    ));
    const runtime = renderSceneProviderRegistry.runtimeCapabilities();
    assert.deepEqual(runtime.filter((entry) => entry.available).map((entry) => `${entry.id}@${entry.version}`), [
        "canonical-analytic@1",
    ]);
});

test("omitted and explicit canonical-analytic@1 selections produce the same analytic scene bytes", async (t) => {
    const { service } = await temporaryService(t);
    const resolved = await service.resolveRunManifest("igvc-default");
    const omitted = createRenderSceneResource(resolved.world, resolved.vehicles);
    const explicit = createRenderSceneResource(resolved.world, resolved.vehicles, analyticRender());
    assert.equal(omitted.hash, explicit.hash);
    assert.equal(hashRenderScene(omitted.description), omitted.hash);
    assert.deepEqual(omitted.description.provider, { id: "canonical-analytic", version: 1 });
    assert.equal(resolved.renderScene.hash, omitted.hash);
});

test("unsupported selections fail before render-scene creation and never fall back", async (t) => {
    const { service } = await temporaryService(t);
    const resolved = await service.resolveRunManifest("igvc-default");
    const analytic = createRenderSceneResource(resolved.world, resolved.vehicles);
    assert.throws(() => createRenderSceneResource(resolved.world, resolved.vehicles, pbrRender()), (error) => (
        error instanceof RenderSceneProviderError && error.code === "PROVIDER_UNAVAILABLE"
    ));
    assert.throws(() => createRenderSceneResource(resolved.world, resolved.vehicles, {
        provider: { id: "canonical-analytic", version: 2 },
        productProfile: analyticRender().productProfile,
    }), /canonical-analytic@2/);
    assert.throws(() => createRenderSceneResource(resolved.world, resolved.vehicles, {
        provider: { id: "missing-provider", version: 1 },
        productProfile: analyticRender().productProfile,
    }), (error) => error.code === "UNKNOWN_PROVIDER");
    const after = createRenderSceneResource(resolved.world, resolved.vehicles);
    assert.equal(after.hash, analytic.hash);
});

test("new cameras default to canonical-analytic@1 and legacy absence is preserved", () => {
    const created = createRunSensor("camera", { id: "front-camera" });
    assert.deepEqual(created.render, DEFAULT_CAMERA_RENDER_SELECTION);
    const fields = getSensorType("camera").run.fields.map((field) => field.path.join("."));
    assert.ok(fields.includes("render.provider.id"));
    assert.ok(fields.includes("render.provider.version"));
    assert.ok(fields.includes("render.productProfile.id"));
    assert.ok(fields.includes("render.productProfile.version"));
    assert.ok(getSensorType("camera").run.fields.filter((field) => field.path[0] === "render").every((field) => field.advanced));

    const defaults = createDefaultRunManifest();
    const defaultCamera = defaults.sensorRig.sensors.find((sensor) => sensor.type === "camera");
    assert.deepEqual(defaultCamera.render, DEFAULT_CAMERA_RENDER_SELECTION);
    assert.equal(validateRunManifest(defaults).ok, true);

    const legacy = normalizeRunSensor({ type: "camera", id: "legacy-camera" });
    assert.equal("render" in legacy, false);
    const roundTrip = normalizeRunManifest({
        ...createDefaultRunManifest(),
        sensorRig: {
            ...createDefaultRunManifest().sensorRig,
            sensors: [legacy, ...createDefaultRunManifest().sensorRig.sensors.filter((sensor) => sensor.type !== "camera")],
        },
    });
    assert.equal("render" in roundTrip.sensorRig.sensors.find((sensor) => sensor.id === "legacy-camera"), false);
});

test("camera authoring rejects malformed profiles, non-booleans, unknown products, and mixed enabled providers", () => {
    const manifest = createDefaultRunManifest();
    const camera = manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera");
    camera.calibration.products.depth = 1;
    assert.equal(validateRunManifest(manifest).ok, false);
    assert.match(validateRunManifest(manifest).issues.map((issue) => issue.message).join(" "), /boolean/);

    const unknownProduct = createDefaultRunManifest();
    unknownProduct.sensorRig.sensors.find((sensor) => sensor.type === "camera").calibration.products.normal = true;
    assert.match(validateRunManifest(unknownProduct).issues.map((issue) => issue.message).join(" "), /unknown camera product/);

    const malformed = createDefaultRunManifest();
    malformed.sensorRig.sensors.find((sensor) => sensor.type === "camera").render = { provider: { id: "canonical-analytic", version: 1 } };
    assert.match(validateRunManifest(malformed).issues.map((issue) => issue.message).join(" "), /productProfile|expected an object/);

    const mixed = createDefaultRunManifest();
    mixed.sensorRig.sensors.push(createRunSensor("camera", {
        id: "second-camera",
        parentId: "ego",
        enabled: true,
        render: pbrRender(),
        outputs: {},
    }));
    assert.match(validateRunManifest(mixed).issues.map((issue) => issue.message).join(" "), /share one render provider/);

    const disabledMixed = createDefaultRunManifest();
    disabledMixed.sensorRig.sensors.push(createRunSensor("camera", {
        id: "preview-camera",
        parentId: "ego",
        enabled: false,
        render: pbrRender(),
        outputs: {},
    }));
    assert.equal(validateRunManifest(disabledMixed).ok, true);
    const selection = resolveEnabledCameraRenderSelection(disabledMixed.sensorRig.sensors);
    assert.deepEqual(selection.provider, DEFAULT_CAMERA_RENDER_SELECTION.provider);
});

test("known-but-unavailable selections can be stored but cannot resolve or prepare", async (t) => {
    const { service } = await temporaryService(t);
    const manifest = createDefaultRunManifest({ id: "pbr-authored" });
    const camera = manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera");
    camera.render = pbrRender();
    const stored = await service.createRunManifest(manifest);
    assert.deepEqual(stored.sensorRig.sensors.find((sensor) => sensor.type === "camera").render, pbrRender());
    await assert.rejects(service.resolveRunManifest(stored.id), /pbr-mesh@1 is known but unavailable/);
});

test("matching explicit analytic bundles verify; mismatches and unavailable providers fail without rewriting bytes", async (t) => {
    const { service } = await temporaryService(t);
    const analytic = await service.exportRunManifest("igvc-default");
    verifyRunBundle(analytic);
    const explicit = structuredClone(analytic);
    for (const sensor of explicit.resolved.manifest.sensorRig.sensors) {
        if (sensor.type === "camera") sensor.render = analyticRender();
    }
    explicit.manifest = structuredClone(explicit.resolved.manifest);
    const rehashed = rehashRunBundle(explicit);
    verifyRunBundle(rehashed);
    assert.equal(rehashed.resolved.renderScene.hash, analytic.resolved.renderScene.hash);

    const mismatched = rehashDocument(analytic);
    mismatched.resolved.renderScene.description.provider = { id: "pbr-mesh", version: 1 };
    const mismatchHashed = rehashDocument(mismatched);
    verifyRunBundleIntegrity(mismatchHashed);
    assert.throws(() => verifyRunBundle(mismatchHashed), (error) => (
        error.code === "BUNDLE_INVALID" && /does not match persisted render-scene provider/.test(error.message)
    ));

    const unavailable = structuredClone(rehashed);
    for (const sensor of unavailable.resolved.manifest.sensorRig.sensors) {
        if (sensor.type === "camera" && sensor.enabled !== false) sensor.render = pbrRender();
    }
    const unavailableHashed = rehashDocument(unavailable);
    verifyRunBundleIntegrity(unavailableHashed);
    assert.throws(() => verifyRunBundle(unavailableHashed), (error) => (
        error.code === "UNSUPPORTED_CAPABILITY" && /pbr-mesh@1 is known but unavailable/.test(error.message)
    ));

    const bytes = Buffer.from(canonicalRunBundleStringify(analytic));
    const verified = verifyRunBundleBytes(bytes);
    assert.deepEqual(Buffer.from(verified.bundleBytes), bytes);
});

test("calibration, duplication, and import/export preserve camera render selection", async (t) => {
    const { service } = await temporaryService(t);
    const manifest = createDefaultRunManifest({ id: "render-round-trip" });
    const camera = manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera");
    camera.render = analyticRender();
    const created = await service.createRunManifest(manifest);
    const calibration = buildCalibrationBundle(created);
    assert.deepEqual(calibration.sensors.find((sensor) => sensor.id === camera.id).render, analyticRender());
    const duplicate = await service.duplicateRunManifest(created.id, { id: "render-round-trip-copy" });
    assert.deepEqual(duplicate.sensorRig.sensors.find((sensor) => sensor.type === "camera").render, analyticRender());
    const exported = await service.exportRunManifest(created.id);
    assert.deepEqual(exported.manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera").render, analyticRender());
    const imported = await service.importRunBundle(exported);
    assert.deepEqual(imported.sensorRig.sensors.find((sensor) => sensor.type === "camera").render, analyticRender());
});

test("GPU backend v1 identity stays locked while v2 is exported and rejected", () => {
    assert.equal(GPU_SENSOR_BACKEND_VERSION, "1");
    assert.equal(GPU_SENSOR_BACKEND_CONFIG_HASH, "cdbfea7d5698356687ca5820a6d54c932a815f199eb8a2b405b94fbe8183a5c1");
    assert.notEqual(GPU_SENSOR_BACKEND_V2_CONFIG_HASH, GPU_SENSOR_BACKEND_CONFIG_HASH);
    assert.deepEqual(createGpuSensorBackendSelection().version, "1");
    assert.equal(createGpuSensorBackendV2Selection().available, false);
    assert.throws(() => assertGpuSensorBackendSelection(createGpuSensorBackendV2Selection()), (error) => (
        error.message === GPU_SENSOR_BACKEND_V2_UNAVAILABLE_REASON
    ));
    assert.deepEqual(assertGpuSensorBackendSelection(createGpuSensorBackendSelection()).configHash, GPU_SENSOR_BACKEND_CONFIG_HASH);
});

test("headless preparation rejects unavailable camera providers", async () => {
    const camera = createRunSensor("camera", { id: "pbr-camera", parentId: "ego" });
    const bundle = await createPortableHeadlessBundle({ sensors: [createHeadlessImu(), camera] });
    bundle.resolved.manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera").render = pbrRender();
    const episode = new HeadlessEpisode();
    await assert.rejects(episode.prepare(bundle.resolved), /pbr-mesh@1 is known but unavailable/);
});

test("VIS-02 explicit-camera v11 identity vectors are independent of legacy and VIS-12a goldens", async (t) => {
    const expected = JSON.parse(await fs.readFile(new URL("./fixtures/visual-layer/explicit-camera.v2.json", import.meta.url), "utf8"));
    const legacy = JSON.parse(await fs.readFile(new URL("./fixtures/visual-layer/world-bound-state.v2.json", import.meta.url), "utf8"));
    const { service } = await temporaryService(t);
    const resolved = await service.resolveRunManifest("igvc-default");
    const camera = resolved.manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera");
    assert.deepEqual(camera.render, DEFAULT_CAMERA_RENDER_SELECTION);
    assert.equal(resolved.renderScene.hash, expected.renderSceneHash);
    assert.equal(resolved.resolvedHash, expected.resolvedHash);
    assert.equal(computeSimulationSemanticHash(resolved), expected.simulationSemanticHash);
    const actual = identities(resolved);
    assert.deepEqual(actual, {
        semantic: expected.simulationSemanticHash,
        browser: expected.browserEpisodeHash,
        headless: expected.headlessEpisodeHash,
    });
    assert.notEqual(expected.simulationSemanticHash, legacy.simulationSemanticHash);
    assert.notEqual(expected.resolvedHash, legacy.resolvedHash);
});

test("enabled provider, profile, and product changes are semantic; disabled render is not", async (t) => {
    const { service } = await temporaryService(t);
    const resolved = await service.resolveRunManifest("igvc-default");
    const original = identities(resolved);
    const disabled = structuredClone(resolved);
    const camera = disabled.manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera");
    camera.enabled = false;
    const disabledBase = identities(disabled);
    camera.render = pbrRender();
    assert.deepEqual(identities(disabled), disabledBase);

    const enabled = structuredClone(resolved);
    const enabledCamera = enabled.manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera");
    enabledCamera.render.provider.version = 2;
    assert.notEqual(identities(enabled).semantic, original.semantic);
    enabledCamera.render.provider.version = 1;
    enabledCamera.render.productProfile.version = 2;
    assert.notEqual(identities(enabled).semantic, original.semantic);
    enabledCamera.render.productProfile.version = 1;
    enabledCamera.calibration.products.depth = false;
    assert.notEqual(identities(enabled).semantic, original.semantic);
});
