import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { BrowserPbrRenderRuntime } from "../app/3d/perception/BrowserPbrRenderRuntime.js";
import {
    createVisualCameraCalibration,
    createVisualCaptureInput,
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
    const actorMesh = runtime.appearanceScene.getObjectByProperty("type", "Mesh");
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

    await runtime.cameraOptions().authorizeSourceUse({
        useHash: resolved.actorUseHash,
        operations: ["display", "machine-interpretation"],
    });
    assert.deepEqual(rights.at(-1).operations, ["display", "machine-interpretation"]);
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
