import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { AlignedCaptureProducts, captureRightsForRole } from "../app/3d/environment/visual/AlignedCaptureProducts.js";
import { evaluateVisualSourcePolicy } from "../app/simulation/visual/VisualLayer.js";
import {
    assertAlignedCapturePassSets,
    assertCaptureProductBuffer,
    assertVisualCapturePassSet,
    createOwnedCaptureScene,
    createVisualCameraCalibration,
    createVisualCaptureInput,
    createVisualCapturePassSet,
    deriveObjectSelectionMask,
    serializeCaptureProductLittleEndian,
    VISUAL_CAPTURE_PASS_FAMILIES,
} from "../app/3d/environment/visual/VisualCapturePipeline.js";

const USE_A = "a".repeat(64);
const USE_B = "b".repeat(64);

function calibration(width = 2, height = 1) {
    return createVisualCameraCalibration({
        width,
        height,
        intrinsics: { fx: 2, fy: 2, cx: 0.5, cy: 0 },
        near: 0.1,
        far: 100,
        distortionModel: "none",
        distortion: [],
    });
}

function passInput(sceneHandle, captureTimeNs = 99) {
    return createVisualCaptureInput({
        calibration: calibration(),
        pose: { matrixWorld: new THREE.Matrix4().elements },
        sceneHandle,
        captureTimeNs,
    });
}

function mesh(color) {
    return new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color }),
    );
}

function pack(value) {
    return [
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
    ];
}

class FakeRenderer {
    constructor() {
        this.target = null;
        this.clearColor = new THREE.Color(0x123456);
        this.clearAlpha = 0.25;
        this.autoClear = true;
        this.toneMapping = 7;
        this.toneMappingExposure = 2;
        this.outputColorSpace = "original-space";
        this.xr = { enabled: true };
        this.shadowMap = { enabled: true, type: 88, autoUpdate: false };
        this.renderCalls = 0;
        this.readCalls = 0;
        this.failRead = false;
        this.failRender = false;
        this.context = null;
        this.onRender = null;
        this.onRead = null;
        this.mode = null;
    }

    getRenderTarget() { return this.target; }
    setRenderTarget(target) { this.target = target; }
    getClearColor(output) { output.copy(this.clearColor); return output; }
    getClearAlpha() { return this.clearAlpha; }
    setClearColor(color, alpha = 1) { this.clearColor.set(color); this.clearAlpha = alpha; }
    getContext() { return this.context; }
    clear() {}
    render(scene) {
        this.renderCalls += 1;
        this.onRender?.();
        if (this.failRender) throw new Error("injected render failure");
        let mode = null;
        scene.traverse?.((object) => {
            if (mode !== null || !object.isMesh) return;
            const material = Array.isArray(object.material) ? object.material[0] : object.material;
            mode = material?.uniforms?.captureMode?.value ?? null;
        });
        this.mode = mode;
    }

    readRenderTargetPixels(target, x, y, width, height, output) {
        this.readCalls += 1;
        this.onRead?.();
        if (this.failRead) throw new Error("injected readback failure");
        if (target.userData.captureTargetKind === "beauty") {
            output.set([255, 0, 0, 255, 0, 255, 0, 255]);
            return;
        }
        if (output instanceof Uint8Array) {
            const values = {
                3: [1, 2],
                4: [1, 2],
                7: [255, 255],
                8: [7, 8],
                9: [70, 80],
            }[this.mode] ?? [0, 0];
            output.set([...pack(values[0]), ...pack(values[1])]);
            return;
        }
        const scalar = {
            1: [2, 4],
            6: [1, 1],
            7: [1, 1],
        }[this.mode];
        if (scalar) {
            output.set([scalar[0], 0, 0, 1, scalar[1], 0, 0, 1]);
            return;
        }
        const vectors = {
            2: [[0, 0, 1], [0, 1, 0]],
            5: [[1, 2, 3], [4, 5, 6]],
        }[this.mode] ?? [[0, 0, 0], [0, 0, 0]];
        output.set([...vectors[0], 1, ...vectors[1], 1]);
    }
}

function scenes() {
    const visualScene = new THREE.Scene();
    const occluder = mesh(0xff0000);
    const target = mesh(0x00ff00);
    target.position.z = -3;
    visualScene.add(occluder, target);
    const analyticScene = new THREE.Scene();
    const truthNear = mesh(0xffffff);
    const truthFar = mesh(0xffffff);
    truthFar.position.z = -5;
    analyticScene.add(truthNear, truthFar);
    const visualHandle = createOwnedCaptureScene({
        role: "bake-snapshot",
        scene: visualScene,
        generation: 3,
        descriptionHash: "visual-scene",
    });
    const analyticHandle = createOwnedCaptureScene({
        role: "analytic-truth",
        scene: analyticScene,
        generation: 4,
        descriptionHash: "truth-scene",
    });
    return { visualScene, occluder, target, analyticScene, truthNear, truthFar, visualHandle, analyticHandle };
}

function passSets(state) {
    const visualPassSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(state.visualHandle),
        bindings: [
            { renderableId: "target-mesh", objectKey: "target", materialKeys: ["brick"], tags: ["building"] },
            { renderableId: "occluder-mesh", objectKey: "occluder", materialKeys: ["steel"], tags: ["vehicle"] },
        ],
        sourceUseHashes: [USE_B, USE_A],
    });
    const analyticPassSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
        captureInput: passInput(state.analyticHandle),
        bindings: [
            { renderableId: "truth-near", semanticId: 7, instanceId: 70 },
            { renderableId: "truth-far", semanticId: 8, instanceId: 80 },
        ],
    });
    return { visualPassSet, analyticPassSet };
}

test("VIS-06b pass sets canonicalize catalogs, products, bindings, and source uses", () => {
    const state = scenes();
    const { visualPassSet, analyticPassSet } = passSets(state);
    assert.equal(assertVisualCapturePassSet(visualPassSet), visualPassSet);
    assert.deepEqual(visualPassSet.catalogs.objects, [
        { id: 1, key: "occluder" },
        { id: 2, key: "target" },
    ]);
    assert.deepEqual(visualPassSet.catalogs.materials, [
        { id: 1, key: "brick" },
        { id: 2, key: "steel" },
    ]);
    assert.deepEqual(visualPassSet.sourceUseHashes, [USE_A, USE_B]);
    assert.ok(visualPassSet.products.includes("validity"));
    assertAlignedCapturePassSets(visualPassSet, analyticPassSet);
    const multiMaterial = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(state.visualHandle),
        products: ["material-id"],
        bindings: [{
            renderableId: "multi",
            objectKey: "multi",
            materialKeys: ["zinc", "aluminum"],
        }],
    });
    assert.deepEqual(multiMaterial.catalogs.materials, [
        { id: 1, key: "aluminum" },
        { id: 2, key: "zinc" },
    ]);
    assert.deepEqual(multiMaterial.bindings[0].materialIds, [2, 1]);

    const wrongTime = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
        captureInput: passInput(state.analyticHandle, 100),
        bindings: [],
    });
    assert.throws(() => assertAlignedCapturePassSets(visualPassSet, wrongTime), /capture time/);
    assert.throws(() => createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
        captureInput: passInput(state.visualHandle),
    }), /analytic-truth/);
    assert.throws(() => createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(state.visualHandle),
        products: ["semantic-id"],
    }), /not supported/);
    assert.throws(() => createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(state.visualHandle),
        products: [],
    }), /at least one product/);
    assert.throws(() => createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(state.visualHandle),
        bindings: [{ renderableId: "partial", materialKeys: ["paint"] }],
    }), /objectKey/);
});

test("little-endian serialization and frontmost object masks preserve explicit validity", () => {
    assert.deepEqual(
        [...serializeCaptureProductLittleEndian(new Uint32Array([0x01020304]))],
        [4, 3, 2, 1],
    );
    assert.deepEqual(
        [...serializeCaptureProductLittleEndian(new Float32Array([1]))],
        [0, 0, 128, 63],
    );
    const mask = deriveObjectSelectionMask(
        new Uint32Array([1, 2, 2, 0]),
        [2],
        new Uint8Array([1, 1, 0, 1]),
    );
    assert.deepEqual([...mask], [
        0, 0, 0, 0,
        255, 255, 255, 255,
        0, 0, 0, 0,
        0, 0, 0, 0,
    ]);
    assertCaptureProductBuffer({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        product: "geometric-normal",
        data: new Float32Array(2 * 1 * 3),
        width: 2,
        height: 1,
    });
    assert.throws(() => assertCaptureProductBuffer({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        product: "object-id",
        data: new Uint8Array(2),
        width: 2,
        height: 1,
    }), /Uint32Array/);
});

test("aligned renderer publishes visual and separate analytic products atomically", async () => {
    const state = scenes();
    const { visualPassSet, analyticPassSet } = passSets(state);
    const renderer = new FakeRenderer();
    const camera = new THREE.PerspectiveCamera();
    const rights = [];
    const aligned = new AlignedCaptureProducts({
        renderer,
        camera,
        visualSceneHandle: state.visualHandle,
        analyticSceneHandle: state.analyticHandle,
        authorizeSourceUse: async (request) => rights.push(request),
    });
    const originalScene = JSON.stringify(state.visualScene.toJSON());
    const controller = new AbortController();
    const result = await aligned.capture({
        visualPassSet,
        visualRenderables: new Map([
            ["occluder-mesh", state.occluder],
            ["target-mesh", state.target],
        ]),
        analyticPassSet,
        analyticRenderables: new Map([
            ["truth-near", state.truthNear],
            ["truth-far", state.truthFar],
        ]),
        signal: controller.signal,
    });
    assert.equal(result.captureTimeNs, 99);
    assert.deepEqual([...result.visual.products.objectId], [1, 2]);
    assert.deepEqual([...result.visual.products.materialId], [1, 2]);
    assert.deepEqual([...result.visual.products.axialDepth], [2, 4]);
    assert.deepEqual([...result.visual.products.geometricNormal], [0, 0, 1, 0, 1, 0]);
    assert.deepEqual([...result.visual.products.worldPosition], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual([...result.visual.products.confidence], [1, 1]);
    assert.deepEqual([...result.visual.products.validity], [1, 1]);
    assert.deepEqual([...result.analytic.products.semanticId], [7, 8]);
    assert.deepEqual([...result.analytic.products.instanceId], [70, 80]);
    assert.deepEqual(rights, [
        { useHash: USE_A, operations: ["display", "machine-interpretation", "derivatives"] },
        { useHash: USE_B, operations: ["display", "machine-interpretation", "derivatives"] },
    ]);
    assert.equal(JSON.stringify(state.visualScene.toJSON()), originalScene);
    assert.equal(renderer.target, null);
    assert.equal(renderer.clearColor.getHex(), 0x123456);
    assert.equal(renderer.clearAlpha, 0.25);
    assert.equal(renderer.autoClear, true);
    assert.equal(renderer.xr.enabled, true);
    assert.equal(renderer.shadowMap.enabled, true);
    aligned.dispose();
});

test("pbr-mesh v2 beauty uses an explicit output pass and restores renderer shadow state", async () => {
    const state = scenes();
    const renderer = new FakeRenderer();
    const visualPassSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(state.visualHandle),
        products: ["beauty", "validity"],
        bindings: [],
    });
    let linearRender = false;
    let outputRender = false;
    renderer.onRender = () => {
        linearRender ||= renderer.target?.userData?.captureTargetKind === "beauty-linear";
        outputRender ||= renderer.target?.userData?.captureTargetKind === "beauty";
    };
    const aligned = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: state.visualHandle,
        renderPolicy: {
            recipeVersion: 2,
            exposure: 0.9,
            toneMapping: "AgX",
            threeToneMapping: THREE.AgXToneMapping,
            shadows: { enabled: true },
            backgroundColorRgba: [0.08, 0.09, 0.1, 1],
        },
    });
    const result = await aligned.capture({
        visualPassSet,
        visualRenderables: new Map(),
        signal: new AbortController().signal,
    });
    assert.equal(linearRender, true);
    assert.equal(outputRender, true);
    assert.deepEqual([...result.visual.products.beauty], [255, 0, 0, 255, 0, 255, 0, 255]);
    assert.equal(renderer.shadowMap.enabled, true);
    assert.equal(renderer.shadowMap.type, 88);
    assert.equal(renderer.shadowMap.autoUpdate, false);
    aligned.dispose();
});

test("VIS-15a aligned capture accepts asynchronous readback without using the browser default", async () => {
    const state = scenes();
    const { visualPassSet, analyticPassSet } = passSets(state);
    const renderer = new FakeRenderer();
    let asynchronousReads = 0;
    const aligned = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: state.visualHandle,
        analyticSceneHandle: state.analyticHandle,
        authorizeSourceUse: async () => {},
        readback: async (_renderer, target, output, { signal }) => {
            signal.throwIfAborted();
            await Promise.resolve();
            renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, output);
            asynchronousReads += 1;
        },
    });
    const result = await aligned.capture({
        visualPassSet,
        visualRenderables: new Map([
            ["occluder-mesh", state.occluder],
            ["target-mesh", state.target],
        ]),
        analyticPassSet,
        analyticRenderables: new Map([
            ["truth-near", state.truthNear],
            ["truth-far", state.truthFar],
        ]),
        signal: new AbortController().signal,
    });
    assert.ok(asynchronousReads > 1);
    assert.equal(renderer.readCalls, asynchronousReads);
    assert.deepEqual([...result.analytic.products.semanticId], [7, 8]);
    aligned.dispose();
});

test("rights denial, cancellation, and readback errors restore state and publish no partial result", async () => {
    const state = scenes();
    const { visualPassSet } = passSets(state);
    const renderables = new Map([
        ["occluder-mesh", state.occluder],
        ["target-mesh", state.target],
    ]);

    const deniedRenderer = new FakeRenderer();
    const denied = new AlignedCaptureProducts({
        renderer: deniedRenderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: state.visualHandle,
        authorizeSourceUse: async () => { throw new Error("restricted source"); },
    });
    await assert.rejects(denied.capture({
        visualPassSet,
        visualRenderables: renderables,
        signal: new AbortController().signal,
    }), /restricted source/);
    assert.equal(deniedRenderer.renderCalls, 0);
    denied.dispose();

    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    const cancelledRenderer = new FakeRenderer();
    const cancelledCapture = new AlignedCaptureProducts({
        renderer: cancelledRenderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: state.visualHandle,
        authorizeSourceUse: async () => {},
    });
    await assert.rejects(cancelledCapture.capture({
        visualPassSet,
        visualRenderables: renderables,
        signal: cancelled.signal,
    }), /cancelled/);
    assert.equal(cancelledRenderer.renderCalls, 0);
    cancelledCapture.dispose();

    const failedRenderer = new FakeRenderer();
    failedRenderer.failRead = true;
    const failed = new AlignedCaptureProducts({
        renderer: failedRenderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: state.visualHandle,
        authorizeSourceUse: async () => {},
    });
    await assert.rejects(failed.capture({
        visualPassSet,
        visualRenderables: renderables,
        signal: new AbortController().signal,
    }), /readback failure/);
    assert.equal(failedRenderer.target, null);
    assert.equal(failedRenderer.clearColor.getHex(), 0x123456);
    assert.equal(failedRenderer.clearAlpha, 0.25);
    assert.equal(failedRenderer.autoClear, true);
    assert.equal(failedRenderer.xr.enabled, true);
    assert.equal(failedRenderer.shadowMap.enabled, true);
    failed.dispose();
});

test("allocation, render, cancellation, and context-loss faults restore all capture state", async () => {
    const cases = ["allocation", "render", "cancel-after-render", "context-loss"];
    for (const fault of cases) {
        const state = scenes();
        const { visualPassSet } = passSets(state);
        const renderables = new Map([
            ["occluder-mesh", state.occluder],
            ["target-mesh", state.target],
        ]);
        const renderer = new FakeRenderer();
        const foreignTarget = { name: "foreign-target" };
        renderer.target = foreignTarget;
        const camera = new THREE.PerspectiveCamera(37, 1.3, 0.3, 17);
        camera.position.set(9, 8, 7);
        camera.updateMatrixWorld(true);
        const cameraBefore = {
            near: camera.near,
            far: camera.far,
            matrix: [...camera.matrix.elements],
            matrixWorld: [...camera.matrixWorld.elements],
            projection: [...camera.projectionMatrix.elements],
        };
        const sceneBefore = JSON.stringify(state.visualScene.toJSON());
        const controller = new AbortController();
        if (fault === "render") renderer.failRender = true;
        if (fault === "cancel-after-render") renderer.onRender = () => controller.abort(new Error("cancel after render"));
        if (fault === "context-loss") {
            renderer.context = { isContextLost: () => true, getExtension: () => ({}) };
        }
        let disposedTargets = 0;
        const createRenderTarget = fault === "allocation"
            ? () => { throw new Error("injected allocation failure"); }
            : (width, height, options) => {
                const target = new THREE.WebGLRenderTarget(width, height, options);
                const dispose = target.dispose.bind(target);
                target.dispose = () => { disposedTargets += 1; dispose(); };
                return target;
            };
        const capture = new AlignedCaptureProducts({
            renderer,
            camera,
            visualSceneHandle: state.visualHandle,
            authorizeSourceUse: async () => {},
            createRenderTarget,
        });
        await assert.rejects(capture.capture({
            visualPassSet,
            visualRenderables: renderables,
            signal: controller.signal,
        }), /allocation failure|render failure|cancel after render|context was lost/);
        assert.equal(renderer.target, foreignTarget, fault);
        assert.equal(renderer.clearColor.getHex(), 0x123456, fault);
        assert.equal(renderer.clearAlpha, 0.25, fault);
        assert.equal(renderer.autoClear, true, fault);
        assert.equal(renderer.toneMapping, 7, fault);
        assert.equal(renderer.toneMappingExposure, 2, fault);
        assert.equal(renderer.outputColorSpace, "original-space", fault);
        assert.equal(renderer.xr.enabled, true, fault);
        assert.equal(renderer.shadowMap.enabled, true, fault);
        assert.deepEqual({
            near: camera.near,
            far: camera.far,
            matrix: [...camera.matrix.elements],
            matrixWorld: [...camera.matrixWorld.elements],
            projection: [...camera.projectionMatrix.elements],
        }, cameraBefore, fault);
        assert.equal(JSON.stringify(state.visualScene.toJSON()), sceneBefore, fault);
        if (fault !== "allocation") assert.ok(disposedTargets > 0, fault);
        capture.dispose();
    }
});

test("unsupported appearance content is rejected before the first render", async () => {
    const scene = new THREE.Scene();
    const unsupported = mesh(0xffffff);
    unsupported.material.transparent = true;
    scene.add(unsupported);
    const handle = createOwnedCaptureScene({ role: "measured-appearance", scene });
    const passSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(handle),
        bindings: [{ renderableId: "unsupported", objectKey: "object", materialKeys: ["material"] }],
    });
    const renderer = new FakeRenderer();
    const capture = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: handle,
    });
    await assert.rejects(capture.capture({
        visualPassSet: passSet,
        visualRenderables: new Map([["unsupported", unsupported]]),
        signal: new AbortController().signal,
    }), /OPAQUE and MASK/);
    assert.equal(renderer.renderCalls, 0);
    assert.equal(renderer.readCalls, 0);
    capture.dispose();
});

test("capture rights are role-specific and analytic truth has no visual source operations", () => {
    assert.deepEqual(captureRightsForRole("measured-appearance"), ["display", "machine-interpretation"]);
    assert.deepEqual(captureRightsForRole("bake-snapshot"), ["display", "machine-interpretation", "derivatives"]);
    assert.deepEqual(captureRightsForRole("analytic-truth"), []);
});

test("capture rights fail closed for every restricted source closure before rendering", async () => {
    const grant = (id, overrides = {}) => ({
        id,
        kind: "owned",
        status: "active",
        ancestorIds: [],
        permissions: { display: true, "machine-interpretation": true, derivatives: true },
        obligations: { attribution: [], requirements: [] },
        ...overrides,
    });
    const registry = {
        owned: grant("owned"),
        restricted: grant("restricted", { permissions: { display: true, "machine-interpretation": false } }),
        expired: grant("expired", { expiresAt: "2026-01-01T00:00:00.000Z" }),
        revoked: grant("revoked", { status: "revoked" }),
        derived: grant("derived", { ancestorIds: ["restricted"] }),
        deduplicated: grant("deduplicated", { ancestorIds: ["restricted"] }),
    };
    const state = scenes();
    const visualPassSet = passSets(state).visualPassSet;
    const renderables = new Map([
        ["occluder-mesh", state.occluder],
        ["target-mesh", state.target],
    ]);
    for (const sourceId of ["unknown", "restricted", "expired", "revoked", "derived", "deduplicated"]) {
        const renderer = new FakeRenderer();
        const capture = new AlignedCaptureProducts({
            renderer,
            camera: new THREE.PerspectiveCamera(),
            visualSceneHandle: state.visualHandle,
            authorizeSourceUse: async ({ operations }) => {
                const decision = evaluateVisualSourcePolicy({
                    sourceIds: [sourceId],
                    operations,
                    registry,
                    atTime: "2026-09-07T00:00:00.000Z",
                });
                if (!decision.allowed) throw new Error(`rights denied: ${sourceId}`);
            },
        });
        await assert.rejects(capture.capture({
            visualPassSet,
            visualRenderables: renderables,
            signal: new AbortController().signal,
        }), new RegExp(sourceId));
        assert.equal(renderer.renderCalls, 0, sourceId);
        capture.dispose();
    }

    const renderer = new FakeRenderer();
    const owned = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: state.visualHandle,
        authorizeSourceUse: async ({ operations }) => {
            const decision = evaluateVisualSourcePolicy({
                sourceIds: ["owned"], operations, registry, atTime: "2026-09-07T00:00:00.000Z",
            });
            if (!decision.allowed) throw new Error("owned source denied");
        },
    });
    await owned.capture({
        visualPassSet,
        visualRenderables: renderables,
        signal: new AbortController().signal,
    });
    assert.ok(renderer.renderCalls > 0);
    owned.dispose();
});
