import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/index.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { createDefaultRunManifest, normalizeRunManifest, validateRunManifest } from "../app/simulation/RunManifest.js";
import { createRenderSceneResource, hashRenderScene } from "../app/simulation/render/RenderScene.js";
import { createPbrRenderSceneResource } from "../app/simulation/render/PbrRenderScene.js";
import { LIVE_CAMERA_OBJECT_MOTION as LIVE, assertCameraObjectMotionFields, cameraObjectMotionFields } from "../app/simulation/render/CameraObjectMotion.js";
import { cameraSceneDetections } from "../app/simulation/render/CameraObjectTruth.js";
import { computeSimulationSemanticHash } from "../app/simulation/kernel/SimulationHashes.js";
import { hashVisualLayer, hashVisualLayerAccess, normalizeVisualLayerAccess } from "../app/simulation/visual/VisualLayer.js";
import { createOwnedCaptureScene, createVisualCameraCalibration, createVisualCaptureInput, assertVisualCaptureInput } from "../app/3d/environment/visual/VisualCapturePipeline.js";
import { BrowserPbrRenderRuntime, BrowserAnalyticRenderRuntime } from "../app/3d/perception/BrowserPbrRenderRuntime.js";
import { BrowserPbrWorkerRuntime } from "../app/3d/perception/BrowserPbrWorkerRuntime.js";
import { PbrCaptureEnvironment } from "../app/3d/perception/PbrCaptureEnvironment.js";
import { ManifestCamera } from "../app/3d/devices/ManifestCamera.js";
import { StorageService } from "../server/storage/StorageService.js";
import { resolvedPbrRun } from "./helpers/pbrResolved.js";

const calibration = createVisualCameraCalibration({ width: 21, height: 21, near: 0.1, far: 100, intrinsics: { fx: 20, fy: 20, cx: 10, cy: 10 } });
const vehicle = { id: "ego", position: { x: 100, y: 100, z: 100 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } };

function worldResource() {
    const document = new EnvironmentDocument({ environmentId: "camera-yard" });
    const commands = createEnvironmentCommandService({ document });
    assert.equal(commands.run("addPrimitive", { id: "crate", shape: "box", x: 0, y: 1, z: -8, size: { x: 2, y: 1, z: 3 }, tags: ["barrel"] }).ok, true);
    assert.equal(commands.run("addRigidBody", { objectId: "crate" }).ok, true);
    return createWorldResource({ environmentId: "camera-yard", templateId: "blank", document: document.snapshot() });
}

function livePbr() {
    const resolved = resolvedPbrRun({ staticSha256: "b".repeat(64), staticSizeBytes: 16 });
    resolved.world = worldResource();
    const layer = resolved.visualLayer.description;
    layer.sourceWorldHash = resolved.world.hash;
    layer.instances[0].matrix = new THREE.Matrix4().compose(new THREE.Vector3(0, 1, -8), new THREE.Quaternion(), new THREE.Vector3(2, 1, 3)).toArray();
    layer.bindings = [{ id: "published-crate-scope", instanceId: layer.instances[0].id, truthEntityId: "crate" }];
    resolved.visualLayer.hash = hashVisualLayer(layer);
    const access = normalizeVisualLayerAccess({ ...resolved.evidence.visualAssets.access, descriptorHash: resolved.visualLayer.hash });
    resolved.evidence.visualAssets.access = access;
    resolved.evidence.visualAssets.descriptorHash = resolved.visualLayer.hash;
    resolved.evidence.visualAssets.accessHash = hashVisualLayerAccess(access);
    // The pixel recipe has no use hashes; this fixture supplies its published actor use.
    const recipe = structuredClone(resolved.renderScene.description.recipe);
    recipe.actors[0].asset = { asset: recipe.actors[0].asset, useHash: resolved.actorUseHash };
    resolved.renderScene = createPbrRenderSceneResource({
        worldResource: resolved.world, visualLayerResource: resolved.visualLayer,
        vehicleDependencies: [{ actorId: "ego", manifest: { boundingBox: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } } } }],
        selection: { productProfile: { id: "measured-rgba-analytic-oracle", version: 1 } },
        renderRecipe: recipe, assetClosure: resolved.renderScene.description.assetClosure, cameraObjectMotion: LIVE,
    });
    return resolved;
}

function livePose(x = 2) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.4, 0.1));
    return { id: "crate", position: { x, y: 1, z: -8 }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } };
}

function input(runtime, poses = [], time = 10) {
    return createVisualCaptureInput({ calibration, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, sceneHandle: runtime.appearanceSceneHandle ?? runtime.captureSceneHandle, captureTimeNs: time, objectPoses: poses });
}

function fakeMaterializer(options) {
    const residency = { requiredChunkIds: ["asset-chunk"], residentChunkIds: ["asset-chunk"] };
    return {
        async replaceResolved({ descriptor }) {
            for (const instance of descriptor.instances) {
                const root = new THREE.Group();
                root.userData = { visualInstanceId: instance.id };
                root.matrix.fromArray(instance.matrix);
                root.matrixAutoUpdate = false;
                root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
                options.previewRoot.add(root);
            }
        },
        async updateInterest(interest) { assert.deepEqual(interest.requiredChunkIds, ["asset-chunk"]); return { status: "ready", residency }; },
        residencySnapshot() { return residency; },
        async materializeAssetUse() { const root = new THREE.Group(); options.previewRoot.add(root); return { root, release() {} }; },
        dispose() {},
    };
}

async function runtimeFor(resolved = livePbr()) {
    const runtime = new BrowserPbrRenderRuntime({ renderer: {}, vehicles: () => [vehicle], materializerFactory: fakeMaterializer, assetClient: { validateAccessSet: async () => ({ allowed: true }) } });
    await runtime.prepare(resolved, { vehicles: [vehicle] });
    return runtime;
}

test("new runs explicitly select live motion; legacy normalization and state-only semantics preserve absence", () => {
    const legacy = createDefaultRunManifest({ cameraObjectMotion: undefined });
    assert.equal(Object.hasOwn(legacy, "cameraObjectMotion"), false);
    assert.deepEqual(normalizeRunManifest(JSON.parse(JSON.stringify(legacy))), legacy);
    assert.equal(createDefaultRunManifest().cameraObjectMotion, LIVE);
    assert.equal(validateRunManifest({ ...legacy, cameraObjectMotion: "guessed@1" }).ok, false);
    const resolved = { kind: "cev-sim.run-manifest", version: 11, identityProfile: { id: "world-bound", version: 2 }, world: { hash: "a".repeat(64) }, manifest: legacy };
    assert.equal(computeSimulationSemanticHash(resolved), computeSimulationSemanticHash({ ...resolved, manifest: { ...legacy, cameraObjectMotion: LIVE } }));
});

test("analytic motion identity is explicit, does not change worldHash, and rejects tampered spawn bindings", () => {
    const world = worldResource();
    const legacy = createRenderSceneResource(world);
    assert.equal(Object.hasOwn(legacy.description, "objectMotion"), false);
    assert.deepEqual(legacy, createRenderSceneResource(world));
    const live = createRenderSceneResource(world, [], undefined, { cameraObjectMotion: LIVE });
    assert.notEqual(live.hash, legacy.hash);
    assert.equal(world.hash, worldResource().hash);
    const changed = structuredClone(live.description);
    changed.objectMotionBindings[0].spawnPosition.x += 1;
    assert.notEqual(hashRenderScene(changed), live.hash);
    assert.throws(() => assertCameraObjectMotionFields(changed, { world: world.description }), /trusted world/);
    assert.throws(() => createRenderSceneResource(world, [], { provider: { id: "canonical-analytic", version: 2 }, productProfile: { id: "measured-rgba-analytic-oracle", version: 1 } }), /unavailable/);
});

test("v1 capture is unchanged; v2 freezes sorted known poses and fences time/generation", () => {
    const world = worldResource();
    const fields = cameraObjectMotionFields(LIVE, world.description);
    const legacyHandle = createOwnedCaptureScene({ role: "measured-appearance", scene: {}, generation: 2, descriptionHash: "test" });
    const v1 = createVisualCaptureInput({ calibration, pose: {}, sceneHandle: legacyHandle, captureTimeNs: 10 });
    assert.equal(v1.version, 1);
    assert.equal(Object.hasOwn(v1, "objectPoses"), false);
    assert.deepEqual(assertVisualCaptureInput(structuredClone(v1)), structuredClone(v1));
    const handle = createOwnedCaptureScene({ ...legacyHandle, ...fields });
    const pose = livePose();
    const v2 = createVisualCaptureInput({ calibration, pose: {}, sceneHandle: handle, captureTimeNs: 10, objectPoses: [pose] });
    pose.position.x = 99;
    assert.equal(v2.objectPoses[0].position.x, 2);
    assert.equal(Object.isFrozen(v2.objectPoses[0].rotation), true);
    assert.equal(v2.version, 2);
    assertVisualCaptureInput(structuredClone(v2), { sceneHandle: handle });
    assert.throws(() => assertVisualCaptureInput(v2, { sceneHandle: { ...handle, generation: 3 } }), /stale/);
    assert.throws(() => assertVisualCaptureInput(v2, { captureTimeNs: 11 }), /stale/);
    for (const objectPoses of [[livePose(), livePose()], [{ ...livePose(), id: "unknown" }], [{ ...livePose(), position: { x: NaN, y: 1, z: 1 } }]]) {
        assert.throws(() => createVisualCaptureInput({ calibration, pose: {}, sceneHandle: handle, captureTimeNs: 10, objectPoses }));
    }
    const forged = structuredClone(v2);
    forged.objectPoses[0].spawnPosition = { x: 99, y: 0, z: 0 };
    assert.throws(() => assertVisualCaptureInput(forged, { sceneHandle: handle }), /unknown|field/);
});

test("PBR rejects missing, shared, and unseparable published appearance scopes", () => {
    const resolved = livePbr();
    const layer = structuredClone(resolved.visualLayer.description);
    layer.bindings = [];
    assert.throws(() => cameraObjectMotionFields(LIVE, resolved.world.description, layer), /unseparable|separable/);
    layer.bindings = [...resolved.visualLayer.description.bindings, { id: "shared", instanceId: layer.instances[0].id, truthEntityId: "road" }];
    assert.throws(() => cameraObjectMotionFields(LIVE, resolved.world.description, layer), /shared/);
});

test("PBR motion and truth use one frozen sample, preserve scale/IDs, restore spawn, and advance revisions once", async () => {
    const runtime = await runtimeFor();
    try {
        const root = runtime.appearanceScene.children.find((object) => object.userData.visualInstanceId);
        const originalScale = new THREE.Vector3().setFromMatrixScale(root.matrix);
        const capture = input(runtime, [livePose()]);
        runtime.applyRigidBodyPoses([livePose(5)]);
        const captureProducts = {
            async captureAlignedProducts({ visualPassSet, analyticPassSet }) {
                assert.deepEqual(visualPassSet.captureInput.objectPoses, analyticPassSet.captureInput.objectPoses);
                const appearance = new THREE.Box3().setFromObject(root);
                const truth = new THREE.Box3().setFromObject(runtime.objectGroups.get("crate"));
                assert.ok(appearance.min.distanceTo(truth.min) < 1e-5);
                assert.ok(appearance.max.distanceTo(truth.max) < 1e-5);
                assert.ok(new THREE.Vector3().setFromMatrixScale(root.matrix).distanceTo(originalScale) < 1e-5);
                const detections = runtime.captureDetections(capture).filter((record) => record.sourceId === "crate");
                assert.equal(detections.length, 1);
                assert.ok(Math.abs(detections[0].worldBounds.center.x - 2) < 1e-5);
                assert.equal(detections[0].instanceId, runtime.renderSceneDescription.analyticTruth.description.staticPrimitives[0].instanceId);
                return {};
            },
        };
        await runtime.captureCamera({ captureInput: capture, enabled: { rgb: true, depth: true }, renderProducts: captureProducts });
        const revision = runtime.analyticScene.userData.cevSimCaptureTransformRevision;
        runtime.applyRigidBodyPoses([livePose()]);
        assert.equal(runtime.analyticScene.userData.cevSimCaptureTransformRevision, revision);
        runtime.reset();
        assert.ok(new THREE.Vector3().setFromMatrixPosition(root.matrix).distanceTo(new THREE.Vector3(0, 1, -8)) < 1e-6);
    } finally { runtime.dispose(); }
});

test("explicit live analytic browser scenes follow object snapshots with detached pixel/truth roots", async () => {
    const world = worldResource();
    const renderScene = createRenderSceneResource(world, [], undefined, { cameraObjectMotion: LIVE });
    const runtime = new BrowserAnalyticRenderRuntime({ renderer: {}, vehicles: () => [] });
    try {
        await runtime.prepare({ world, renderScene });
        runtime.applyRigidBodyPoses([livePose()]);
        assert.deepEqual(runtime.objectGroups.get("crate").matrix.toArray(), new THREE.Matrix4().toArray());
        await runtime.captureCamera({ captureInput: input(runtime, runtime.objectPoses), enabled: { rgb: true, depth: true }, renderProducts: { async captureAlignedProducts() { return {}; } } });
        const a = new THREE.Box3().setFromObject(runtime.objectGroups.get("crate"));
        const b = new THREE.Box3().setFromObject(runtime.analyticAppearanceObjects.get("crate"));
        assert.ok(a.min.distanceTo(b.min) < 1e-6);
        assert.ok(Math.abs(a.getCenter(new THREE.Vector3()).x - 2) < 1e-6);
        assert.notEqual(runtime.appearanceScene, runtime.analyticScene);
        assert.equal(input(runtime, [livePose()]).version, 2);
        runtime.reset();
        assert.deepEqual(runtime.objectGroups.get("crate").matrix.toArray(), new THREE.Matrix4().toArray());
    } finally { runtime.dispose(); }
});

test("PBR pose receipt and no-op captures retain snapshots without scene scans or object transforms", async () => {
    const runtime = await runtimeFor();
    const renderProducts = { async captureAlignedProducts() { return {}; } };
    const enabled = { rgb: true, depth: true };
    try {
        await runtime.captureCamera({ captureInput: input(runtime), enabled, renderProducts });
        const capture = input(runtime, [livePose()]);
        const state = runtime.objectMotionStates.get("crate");
        const root = runtime.objectAppearanceRoots.get(state.appearances[0].id)[0];
        const counts = { scans: 0, wholeSceneTransforms: 0, delta: 0, truth: 0, appearance: 0 };
        const watch = (object, method, key) => {
            const original = object[method];
            object[method] = function (...args) { counts[key] += 1; return original.apply(this, args); };
        };
        for (const scene of [runtime.appearanceScene, runtime.analyticScene]) {
            watch(scene, "traverse", "scans");
            watch(scene, "updateMatrixWorld", "wholeSceneTransforms");
        }
        watch(state.delta, "compose", "delta");
        watch(state.group, "updateMatrixWorld", "truth");
        watch(root, "updateWorldMatrix", "appearance");
        runtime.applyRigidBodyPoses([livePose()]);
        const snapshot = runtime.objectPoses;
        runtime.applyRigidBodyPoses([livePose()]);
        assert.equal(runtime.objectPoses, snapshot);
        assert.equal(Object.isFrozen(snapshot[0].position), true);
        await runtime.prepareCapture();
        await runtime.prepareCapture();
        assert.deepEqual(counts, { scans: 0, wholeSceneTransforms: 0, delta: 0, truth: 0, appearance: 0 });
        await runtime.captureCamera({ captureInput: capture, enabled, renderProducts });
        assert.deepEqual(counts, { scans: 0, wholeSceneTransforms: 0, delta: 1, truth: 1, appearance: 1 });
        const revisions = [runtime.analyticScene, runtime.appearanceScene].map((scene) => scene.userData.cevSimCaptureTransformRevision);
        runtime.applyRigidBodyPoses([livePose(3)]);
        await runtime.prepareCapture();
        await runtime.captureCamera({ captureInput: capture, enabled, renderProducts });
        assert.deepEqual(counts, { scans: 0, wholeSceneTransforms: 0, delta: 1, truth: 1, appearance: 1 });
        assert.deepEqual([runtime.analyticScene, runtime.appearanceScene].map((scene) => scene.userData.cevSimCaptureTransformRevision), revisions);
        runtime.reset();
        assert.deepEqual(state.group.matrix.toArray(), new THREE.Matrix4().toArray());
        assert.ok(new THREE.Vector3().setFromMatrixPosition(root.matrix).distanceTo(new THREE.Vector3(0, 1, -8)) < 1e-6);
        const resetCounts = { ...counts };
        runtime.reset();
        assert.deepEqual(counts, resetCounts);
        await runtime.captureCamera({ captureInput: input(runtime, runtime.objectPoses), enabled, renderProducts });
        assert.deepEqual(counts, resetCounts);
    } finally { runtime.dispose(); }
});

test("PBR caches published roots, refreshes replaced scopes once, and rejects missing residency", async () => {
    const runtime = await runtimeFor();
    const renderProducts = { async captureAlignedProducts() { return {}; } };
    try {
        const capture = input(runtime, [livePose()]);
        await runtime.captureCamera({ captureInput: capture, enabled: { rgb: true }, renderProducts });
        const state = runtime.objectMotionStates.get("crate");
        const appearance = state.appearances[0];
        const root = runtime.objectAppearanceRoots.get(appearance.id)[0];
        const replacement = root.clone(true);
        replacement.matrix.copy(appearance.authored);
        runtime.appearanceScene.remove(root);
        runtime.appearanceScene.add(replacement);
        let scans = 0;
        const traverse = runtime.appearanceScene.traverse;
        runtime.appearanceScene.traverse = function (callback) { scans += 1; return traverse.call(this, callback); };
        const revision = runtime.analyticScene.userData.cevSimCaptureTransformRevision;
        await runtime.prepareCapture();
        assert.equal(scans, 0);
        await runtime.captureCamera({ captureInput: capture, enabled: { rgb: true }, renderProducts });
        assert.equal(scans, 1);
        assert.deepEqual(replacement.matrix.toArray(), root.matrix.toArray());
        assert.equal(runtime.analyticScene.userData.cevSimCaptureTransformRevision, revision);
        await runtime.captureCamera({ captureInput: capture, enabled: { rgb: true }, renderProducts });
        assert.equal(scans, 1);
        runtime.appearanceScene.remove(replacement);
        await assert.rejects(runtime.captureCamera({ captureInput: capture, enabled: { rgb: true }, renderProducts }), /not resident/);
    } finally { runtime.dispose(); }
});

test("requested detection bounds handle large geometry and revisit only changed sources", () => {
    const world = worldResource();
    const fields = cameraObjectMotionFields(LIVE, world.description);
    let dynamicReads = 0;
    let staticReads = 0;
    const points = (read) => [-1, 1].flatMap((x) => [0.5, 1.5].flatMap((y) => [-8.5, -7.5].map((z) => ({ get x() { read(); return x; }, y, z }))));
    const primitive = { sourceId: "crate", semanticId: 1, instanceId: 7, tags: ["barrel"], vertices: points(() => { dynamicReads += 1; }) };
    const staticPrimitive = { ...primitive, sourceId: "static", instanceId: 8, vertices: points(() => { staticReads += 1; }) };
    const description = { ...fields, staticPrimitives: [...Array(70_000).fill(primitive), staticPrimitive], actors: [] };
    const sceneHandle = createOwnedCaptureScene({ role: "measured-appearance", scene: {}, generation: 1, descriptionHash: "large", ...fields });
    const capture = (poses = []) => createVisualCaptureInput({ calibration, pose: {}, sceneHandle, captureTimeNs: 10, objectPoses: poses });
    const spawn = cameraSceneDetections(description, capture());
    assert.equal(spawn.length, 2);
    assert.ok(dynamicReads >= 210_000);
    dynamicReads = 0;
    staticReads = 0;
    assert.deepEqual(cameraSceneDetections(description, capture()), spawn);
    assert.equal(dynamicReads, 0);
    assert.equal(staticReads, 0);
    const moved = cameraSceneDetections(description, capture([livePose()]));
    assert.ok(dynamicReads >= 210_000);
    assert.equal(staticReads, 0);
    assert.ok(Math.abs(moved[0].worldBounds.center.x - 2) < 1e-6);
    dynamicReads = 0;
    assert.deepEqual(cameraSceneDetections(description, capture([livePose()])), moved);
    assert.equal(dynamicReads, 0);
    assert.deepEqual(cameraSceneDetections(description, capture()), spawn);
    assert.ok(dynamicReads >= 210_000);
    assert.equal(staticReads, 0);
});

test("live manifest cameras skip preview truth and derive only requested detections while publishing requested topics", async () => {
    const runtime = await runtimeFor();
    let detections = 0;
    const trustedDetections = runtime.captureDetections.bind(runtime);
    runtime.captureDetections = (captureInput) => { detections += 1; return trustedDetections(captureInput); };
    const camera = new ManifestCamera({
        id: "front-camera", type: "camera", frameId: "optical", pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        noise: {}, latency: {}, health: {}, outputs: { lanesTopicId: "lanes", trafficControlsTopicId: "controls" },
        calibration: { width: 21, height: 21, verticalFovDeg: 60, near: 0.1, far: 100, intrinsics: { fx: 20, fy: 20, cx: 10, cy: 10 }, products: { lanes: true, trafficControls: true, detections2d: true } },
    }, { captureMode: "calibrated-projection@1", captureSceneHandle: runtime.appearanceSceneHandle, analyticSceneHandle: runtime.analyticSceneHandle, renderRuntime: runtime, runtimeOwnsProducts: true });
    const scene = new THREE.Scene();
    const data = { renderer: {}, scene, vehicles: () => ({ vehicles: [vehicle] }) };
    camera.getParent = () => ({ getParent: () => data });
    camera._refreshTruth = () => { throw new Error("Live camera scanned preview truth."); };
    runtime.captureCamera = async () => ({ aligned: true });
    try {
        camera.setup(scene);
        const stamp = { captureTimeNs: 10, sampleIndex: 0, rng: { next: () => 0.5 } };
        const messages = await camera.captureAt(stamp);
        assert.equal(detections, 0);
        assert.deepEqual(messages.map((message) => message.topicId), ["lanes", "controls"]);
        camera.config.outputs.detections2dTopicId = "detections";
        await camera.captureAt(stamp);
        assert.equal(detections, 1);
        camera.config.calibration.products.detections2d = false;
        await camera.captureAt(stamp);
        assert.equal(detections, 1);
    } finally { camera.dispose(); runtime.dispose(); }
});

test("software raycast pixels and depth align for translated and rotated PBR truth/appearance samples", async () => {
    const runtime = await runtimeFor();
    const raster = (root, captureInput) => {
        const camera = new THREE.PerspectiveCamera();
        camera.matrixWorld.fromArray(captureInput.pose.matrixWorld);
        camera.projectionMatrix.fromArray(captureInput.projectionMatrix);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        const ray = new THREE.Raycaster();
        const values = [];
        for (let y = 0; y < 21; y += 1) for (let x = 0; x < 21; x += 1) {
            ray.setFromCamera(new THREE.Vector2((x + 0.5) / 21 * 2 - 1, 1 - (y + 0.5) / 21 * 2), camera);
            values.push(ray.intersectObject(root, true)[0]?.distance ?? 0);
        }
        return values;
    };
    try {
        const appearance = runtime.appearanceScene.children.find((object) => object.userData.visualInstanceId);
        const truth = runtime.objectGroups.get("crate");
        const spawnPixels = raster(appearance, input(runtime));
        const snapshot = input(runtime, [livePose()]);
        await runtime.captureCamera({ captureInput: snapshot, enabled: { rgb: true, depth: true }, renderProducts: {
            async captureAlignedProducts() {
                const visual = raster(appearance, snapshot);
                const analytic = raster(truth, snapshot);
                assert.ok(visual.some((depth) => depth > 0));
                assert.notDeepEqual(visual.map(Boolean), spawnPixels.map(Boolean));
                visual.forEach((depth, index) => assert.ok(Math.abs(depth - analytic[index]) < 1e-5));
                return {};
            },
        } });
    } finally { runtime.dispose(); }
});

test("inline reset fences an in-flight capture without poisoning the ready runtime", async () => {
    const runtime = await runtimeFor();
    let release;
    try {
        const pending = runtime.captureCamera({ captureInput: input(runtime), enabled: { rgb: true }, renderProducts: { captureAlignedProducts: () => new Promise((resolve) => { release = resolve; }) } });
        runtime.reset();
        release({});
        await assert.rejects(pending, /reset/);
        assert.equal(runtime.ready, true);
    } finally { runtime.dispose(); }
});

test("headless/worker capture environments reject split snapshots before rendering", async () => {
    const runtime = await runtimeFor();
    const environment = new PbrCaptureEnvironment({ environmentKey: "live", runtime, renderer: {} });
    const first = { id: "a", products: {}, captureInput: input(runtime, [livePose()]) };
    const second = { id: "b", products: {}, captureInput: input(runtime, [livePose(3)]) };
    const v1 = structuredClone(first.captureInput);
    v1.version = 1;
    delete v1.objectMotion;
    delete v1.objectPoses;
    environment.camera = () => { throw new Error("Invalid capture allocated camera products."); };
    try {
        await assert.rejects(environment.capture([first, second]), /same frozen/);
        await assert.rejects(environment.capture([{ ...first, products: { rgb: true }, captureInput: v1 }]), /stale/);
    }
    finally { environment.dispose(); }
});

test("shared headless/worker environments fence reset preparation and disposed capture replies", async () => {
    const runtime = await runtimeFor();
    const environment = new PbrCaptureEnvironment({ environmentKey: "live-reset", runtime, renderer: {} });
    let release;
    const request = { id: "camera", products: { rgb: true }, captureInput: input(runtime, [livePose()]) };
    try {
        runtime.prepareCapture = () => new Promise((resolve) => { release = resolve; });
        const preparing = environment.capture([request]);
        environment.reset();
        release();
        await assert.rejects(preparing, /environment was reset/);
        environment.camera = () => ({ products: {} });
        runtime.captureCamera = () => new Promise((resolve) => { release = resolve; });
        const capturing = environment.capture([request], { prepare: false });
        environment.dispose();
        release({});
        await assert.rejects(capturing, /environment was reset/);
    } finally { environment.dispose(); }
});

test("PBR worker requests carry immutable snapshots and reset fences stale replies", async () => {
    const resolved = livePbr();
    const calls = [];
    let listener;
    let replyCapture;
    const worker = {
        addEventListener(type, callback) { if (type === "message") listener = callback; },
        postMessage(message) {
            calls.push(message);
            const reply = (result) => listener({ data: { id: message.id, ok: true, result } });
            if (message.method === "capture") { replyCapture = () => reply({ aligned: true }); return; }
            queueMicrotask(() => reply(message.method === "prepare" ? {
                status: { state: "ready" },
                appearance: { role: "measured-appearance", generation: 2, descriptionHash: resolved.renderScene.hash },
                analytic: { role: "analytic-truth", generation: 2, descriptionHash: resolved.renderScene.description.analyticTruth.hash },
            } : {}));
        }, terminate() {},
    };
    const runtime = new BrowserPbrWorkerRuntime({ workerFactory: () => worker, vehicles: () => [vehicle] });
    try {
        await runtime.prepare(resolved);
        const poses = [livePose()];
        runtime.applyRigidBodyPoses(poses);
        const snapshot = runtime.objectPoses;
        runtime.applyRigidBodyPoses([livePose()]);
        assert.equal(runtime.objectPoses, snapshot);
        await runtime.prepareCapture();
        poses[0].position.x = 90;
        assert.equal(calls.find((call) => call.method === "prepareCapture").payload.objectPoses[0].position.x, 2);
        const invalid = structuredClone(input(runtime, runtime.objectPoses));
        invalid.version = 1;
        delete invalid.objectMotion;
        delete invalid.objectPoses;
        const priorCalls = calls.length;
        await assert.rejects(runtime.captureCamera({ captureInput: invalid, enabled: { rgb: true } }), /stale/);
        assert.equal(calls.length, priorCalls);
        const pending = runtime.captureCamera({ captureInput: input(runtime, runtime.objectPoses), enabled: {} });
        runtime.reset();
        replyCapture();
        await assert.rejects(pending, /superseded/);
    } finally { runtime.dispose({ immediate: true }); }
});

test("storage preserves absent legacy policy and preserves explicit stored policy on omitted writes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "camera-motion-"));
    const service = new StorageService(directory);
    try {
        const legacy = await service.createRunManifest(createDefaultRunManifest({ id: "legacy", cameraObjectMotion: undefined }));
        const duplicate = await service.duplicateRunManifest(legacy.id, { id: "legacy-copy" });
        assert.equal(Object.hasOwn(duplicate, "cameraObjectMotion"), false);
        const live = await service.createRunManifest(createDefaultRunManifest({ id: "live" }));
        const omitted = { ...live };
        delete omitted.cameraObjectMotion;
        const stored = await service.putRunManifest(live.id, { manifest: omitted, expectedRevision: live.revision });
        assert.equal(stored.cameraObjectMotion, LIVE);
        const exported = await service.exportRunManifest(legacy.id);
        assert.equal(Object.hasOwn(exported.resolved.manifest, "cameraObjectMotion"), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
