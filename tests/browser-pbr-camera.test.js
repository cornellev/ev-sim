import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { BrowserPbrRenderRuntime } from "../app/3d/perception/BrowserPbrRenderRuntime.js";
import { addPbrRoadMarkings } from "../app/3d/perception/PbrRoadMarkings.js";
import {
    createVisualCameraCalibration,
    createVisualCaptureInput,
    takeAnalyticBindingNormalizeCount,
} from "../app/3d/environment/visual/VisualCapturePipeline.js";
import { sanitizeMeasuredAppearanceObject } from "../app/3d/environment/visual/VisualLayerMaterializer.js";
import { resolvedPbrRun } from "./helpers/pbrResolved.js";

function fakeMaterializer(options) {
    const status = {
        status: "ready",
        error: null,
        residency: {
            requiredChunkIds: [], residentChunkIds: [], queuedChunkIds: [],
            requiredChunks: 0, residentChunks: 0, queuedChunks: 0,
            prefetchShed: 0, pressure: {},
        },
    };
    return {
        async replaceResolved() { return status; },
        async updateInterest() { return status; },
        residencySnapshot() { return status.residency; },
        async materializeAssetUse(useHash, { metadata }) {
            const root = new THREE.Group();
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(1, 1, 1),
                new THREE.MeshStandardMaterial(),
            );
            mesh.userData = { semanticId: 999, instanceId: 888, forged: true };
            root.add(mesh);
            sanitizeMeasuredAppearanceObject(root, metadata);
            options.previewRoot.add(root);
            return { root, useHash, release() { root.removeFromParent(); } };
        },
        dispose() {},
    };
}

test("inline PBR renderer lease exposes only the synchronous WebGL critical section", () => {
    const runtime = new BrowserPbrRenderRuntime({ renderer: {} });
    const availability = [];
    const unsubscribe = runtime.subscribePresentationAvailability((available) => {
        availability.push(available);
    });
    assert.equal(runtime.presentationBlocked, false);
    runtime.rendererLease.runSync(() => {
        assert.equal(runtime.presentationBlocked, true);
    });
    assert.equal(runtime.presentationBlocked, false);
    assert.deepEqual(availability, [true, false, true]);
    unsubscribe();
    runtime.dispose();
});

test("inline PBR renderer lease remains blocked for a genuinely asynchronous readback", async () => {
    const runtime = new BrowserPbrRenderRuntime({ renderer: {} });
    const availability = [];
    let finishReadback;
    runtime.subscribePresentationAvailability((available) => availability.push(available));
    const readback = runtime.rendererLease.runAsync(() => new Promise((resolve) => {
        finishReadback = resolve;
    }));
    assert.equal(runtime.presentationBlocked, true);
    assert.deepEqual(availability, [true, false]);
    finishReadback();
    await readback;
    assert.equal(runtime.presentationBlocked, false);
    assert.deepEqual(availability, [true, false, true]);
    runtime.dispose();
});

test("VIS-14 prepares isolated browser scenes and routes measured and analytic products atomically", async () => {
    const resolved = resolvedPbrRun();
    const rights = [];
    let initialInterest = null;
    const vehicle = {
        telemetryId: "ego",
        position: new THREE.Vector3(4, 0, 2),
        rotation: new THREE.Euler(0, 0.25, 0),
    };
    const runtime = new BrowserPbrRenderRuntime({
        renderer: {},
        assetClient: {
            async validateClosure(request) { rights.push(request); },
        },
        materializerFactory(options) {
            const materializer = fakeMaterializer(options);
            materializer.replaceResolved = async (_visualLayer, _world, runtimeOptions) => {
                initialInterest = runtimeOptions.interest;
                return {
                    status: "ready",
                    error: null,
                    residency: materializer.residencySnapshot(),
                };
            };
            return materializer;
        },
        vehicles: () => [vehicle],
    });
    await runtime.prepare(resolved, {
        vehicles: [vehicle],
        sensorRig: {
            sensors: [
                { id: "left", type: "camera", parentId: "ego", pose: { position: { x: 1, y: 2, z: 3 } } },
                { id: "right", type: "camera", parentId: "ego", pose: { position: { x: -1, y: -2, z: 1 } } },
            ],
        },
    });

    assert.equal(runtime.status.state, "ready");
    assert.equal(initialInterest.positions.length, 2);
    assert.notDeepEqual(initialInterest.positions[0], initialInterest.positions[1]);
    assert.notEqual(runtime.appearanceScene, runtime.analyticScene);
    assert.equal(runtime.appearanceScene.parent, null);
    assert.equal(runtime.analyticScene.parent, null);
    const actorGroup = runtime.appearanceScene.getObjectByName("cev-sim.appearance-actor:ego");
    const actorMesh = actorGroup.getObjectByProperty("type", "Mesh");
    assert.equal(runtime.appearanceScene.getObjectByName("TakramSkyQuad"), undefined);
    assert.equal(actorMesh.userData.forged, undefined);
    assert.equal(actorMesh.userData.semanticId, undefined);

    const calibration = createVisualCameraCalibration({
        width: 3,
        height: 2,
        intrinsics: { fx: 4, fy: 5, cx: 1.25, cy: 0.75 },
        near: 0.1,
        far: 50,
        distortionModel: "brown-conrady",
        distortion: [0.01, -0.001, 0.0005, -0.00025, 0],
    });
    const captureInput = createVisualCaptureInput({
        calibration,
        pose: { matrixWorld: new THREE.Matrix4().elements },
        sceneHandle: runtime.appearanceSceneHandle,
        captureTimeNs: 123456789,
    });
    let request;
    const renderProducts = {
        async captureAlignedProducts(value) {
            request = value;
            return {
                captureTimeNs: 123456789,
                visual: { products: { beauty: new Uint8Array(24).fill(7), validity: new Uint8Array(6).fill(1) } },
                analytic: {
                    products: {
                        axialDepth: Float32Array.from([1, 2, 3, 4, 5, 6]),
                        semanticId: Uint32Array.from([1, 2, 3, 4, 5, 6]),
                        instanceId: Uint32Array.from([10, 20, 30, 40, 50, 60]),
                        validity: Uint8Array.from([1, 1, 0, 1, 1, 1]),
                    },
                },
            };
        },
    };
    takeAnalyticBindingNormalizeCount();
    const captured = await runtime.captureCamera({
        captureInput,
        enabled: { rgb: true, depth: true, semantic: true, instance: true },
        renderProducts,
        signal: new AbortController().signal,
    });
    assert.equal(request.visualPassSet.family, "visual-appearance");
    assert.deepEqual(request.visualPassSet.sourceUseHashes, [resolved.actorUseHash]);
    assert.equal(request.analyticPassSet.family, "analytic-oracle");
    assert.equal(request.visualPassSet.captureInput.captureTimeNs, request.analyticPassSet.captureInput.captureTimeNs);
    assert.ok(request.analyticPassSet.bindings.length > 0);
    assert.equal(Number.isNaN(captured.depth[2]), true);
    assert.ok(captured.semantic instanceof Uint16Array);
    assert.ok(captured.instance instanceof Uint32Array);
    await runtime.captureCamera({
        captureInput,
        enabled: { rgb: true, depth: true, semantic: true, instance: true },
        renderProducts,
        signal: new AbortController().signal,
    });
    assert.equal(takeAnalyticBindingNormalizeCount(), 0);
    const child = actorMesh;
    let childUpdates = 0;
    const originalUpdate = child.updateMatrixWorld.bind(child);
    child.updateMatrixWorld = (force) => {
        childUpdates += 1;
        return originalUpdate(force);
    };
    runtime._updateActors([vehicle]);
    assert.equal(childUpdates, 0);

    const actorClosures = () => rights.filter((request) => request.useHash === resolved.actorUseHash);
    assert.equal(actorClosures().length, 1);
    assert.deepEqual(actorClosures()[0].operations, ["display", "machine-interpretation"]);
    await runtime.cameraOptions().authorizeSourceUse({
        useHash: resolved.actorUseHash,
        operations: ["display", "machine-interpretation"],
    });
    await runtime.cameraOptions().authorizeSourceUse({
        useHash: resolved.actorUseHash,
        operations: ["display", "machine-interpretation"],
    });
    assert.equal(actorClosures().length, 1);
    assert.deepEqual(rights.at(-1).operations, ["display", "machine-interpretation"]);
    runtime.dispose();
});

test("prepared browser capture rights are one access-set check reused by later samples", async () => {
    const resolved = resolvedPbrRun();
    const closures = [];
    const accessSets = [];
    const vehicle = {
        telemetryId: "ego",
        position: new THREE.Vector3(0, 0, 0),
        rotation: new THREE.Euler(0, 0, 0),
    };
    const runtime = new BrowserPbrRenderRuntime({
        renderer: {},
        assetClient: {
            async validateClosure(request) { closures.push(request); },
            async validateAccessSet(request) { accessSets.push(request); return { ok: true, operations: request.operations }; },
        },
        materializerFactory: fakeMaterializer,
        vehicles: () => [vehicle],
    });
    await runtime.prepare(resolved, { vehicles: [vehicle] });
    assert.equal(accessSets.length, 1);
    assert.deepEqual(accessSets[0].useHashes, [resolved.actorUseHash]);
    assert.deepEqual(accessSets[0].operations, ["display", "machine-interpretation"]);
    assert.equal(closures.length, 0);
    await runtime.cameraOptions().authorizeSourceUse({
        useHash: resolved.actorUseHash,
        operations: ["display", "machine-interpretation"],
    });
    await runtime.cameraOptions().authorizeSourceUse({
        useHash: resolved.actorUseHash,
        operations: ["display", "machine-interpretation"],
    });
    assert.equal(accessSets.length, 1);
    assert.equal(closures.length, 0);
    runtime.dispose();
});

test("road-tagged analytic surfaces are drawn into the measured appearance scene", async () => {
    const resolved = resolvedPbrRun();
    const runtime = new BrowserPbrRenderRuntime({
        renderer: {},
        assetClient: { async validateClosure() {} },
        materializerFactory: fakeMaterializer,
        vehicles: () => [{ telemetryId: "ego", position: new THREE.Vector3(), rotation: new THREE.Euler() }],
    });
    await runtime.prepare(resolved);
    const roads = [];
    runtime.appearanceScene.traverse((object) => {
        if (object.userData?.cevSimRoadAppearance === true) roads.push(object);
    });
    assert.ok(roads.length > 0);
    assert.equal(roads[0].material.color.getHex(), 0x2d3034);
    assert.equal(roads[0].material.roughness, 0.9);
    assert.equal(roads[0].material.metalness, 0);
    assert.equal(roads[0].position.y, 0.015);
    const analyticRoad = runtime.analyticScene.getObjectByName(roads[0].name);
    assert.ok(analyticRoad);
    assert.equal(analyticRoad.userData.cevSimRoadAppearance, undefined);
    assert.equal(runtime.analyticRenderables.get(roads[0].name), analyticRoad);
    assert.equal([...runtime.analyticRenderables.values()].includes(roads[0]), false);
    const markings = [];
    runtime.appearanceScene.traverse((object) => {
        if (object.name === "RoadMarking") markings.push(object);
    });
    assert.ok(markings.length > 0);
    for (const marking of markings) {
        assert.equal(marking.material.polygonOffset, false);
        assert.equal(marking.userData.cevSimRoadMarking, true);
        assert.equal([...runtime.analyticRenderables.values()].includes(marking), false);
        const positions = marking.geometry.getAttribute("position");
        assert.ok(positions.getY(0) >= 0.02 - 1e-6);
    }
    runtime.dispose();
});

test("implicit two-lane roads paint a dashed yellow center line and empty roads add nothing", () => {
    const scene = new THREE.Scene();
    const meshes = addPbrRoadMarkings(scene, {
        nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 40, z: 0 }],
        edges: [{
            id: "road",
            startNodeId: "a",
            endNodeId: "b",
            bidirectional: true,
            width: 7,
            laneCount: 2,
        }],
    });
    assert.ok(meshes.length >= 3);
    assert.ok(meshes.some((mesh) => mesh.material.color.getHex() === 0xf0d25c));
    assert.ok(meshes.every((mesh) => (
        mesh.material.polygonOffset === false && mesh.userData.cevSimRoadMarking === true
    )));
    assert.equal(addPbrRoadMarkings(new THREE.Scene(), null).length, 0);
    assert.equal(addPbrRoadMarkings(new THREE.Scene(), { edges: [] }).length, 0);
});

test("a resolved Takram sky is installed behind measured appearance", async () => {
    const resolved = resolvedPbrRun({
        sky: { mode: "takram", takram: { timeOfDay: 14.4, date: "2026-06-28" } },
    });
    let installed = null;
    const runtime = new BrowserPbrRenderRuntime({
        renderer: {},
        assetClient: { async validateClosure() {} },
        materializerFactory: fakeMaterializer,
        vehicles: () => [{ telemetryId: "ego", position: new THREE.Vector3(), rotation: new THREE.Euler() }],
        installTakramSky: async ({ scene, sky }) => {
            installed = sky;
            const group = new THREE.Group();
            group.name = "TakramEnvironmentSky";
            group.userData.cevSimSky = true;
            const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
            quad.name = "TakramSkyQuad";
            quad.frustumCulled = false;
            quad.renderOrder = -1;
            quad.userData.cevSimSky = true;
            quad.userData.cevSimRenderRuntimeOwned = true;
            group.add(quad);
            scene.add(group);
        },
    });
    await runtime.prepare(resolved);
    assert.equal(installed.mode, "takram");
    assert.equal(installed.takram.timeOfDay, 14.4);
    assert.equal(installed.takram.date, "2026-06-28");
    const quad = runtime.appearanceScene.getObjectByName("TakramSkyQuad");
    assert.equal(quad.userData.cevSimSky, true);
    assert.equal(quad.frustumCulled, false);
    runtime.dispose();
});

test("VIS-14 preparation fails closed on rehashed render evidence", async () => {
    const resolved = resolvedPbrRun();
    resolved.evidence.visualAssets.permissions.operations = ["display"];
    const runtime = new BrowserPbrRenderRuntime({
        renderer: {},
        assetClient: { async validateClosure() {} },
        materializerFactory: fakeMaterializer,
        vehicles: () => [],
    });
    await assert.rejects(runtime.prepare(resolved), (error) => (
        error.infrastructureFailure === true && runtime.status.state === "error"
    ));
});
