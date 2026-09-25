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
        this.shadowMap = { enabled: true };
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

    readRenderTargetPixels(target, x, y, width, height, output, _cubeFace, textureIndex = 0) {
        this.readCalls += 1;
        this.onRead?.(target, output);
        if (this.failRead) throw new Error("injected readback failure");
        if (target.userData.captureTargetKind === "beauty") {
            output.set([255, 0, 0, 255, 0, 255, 0, 255]);
            return;
        }
        if (this.mode === 10 && output instanceof Float32Array) {
            output.set([2, 1, 0, 1, 4, 1, 0, 1]);
            return;
        }
        if (this.mode === 11 && output instanceof Uint8Array) {
            const values = textureIndex === 1 ? [70, 80] : [7, 8];
            output.set([...pack(values[0]), ...pack(values[1])]);
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
    assert.throws(() => assertVisualCapturePassSet({
        kind: visualPassSet.kind,
        version: visualPassSet.version,
        family: visualPassSet.family,
        captureInput: visualPassSet.captureInput,
        products: ["validity", "beauty"],
        bindings: visualPassSet.bindings,
        catalogs: visualPassSet.catalogs,
        sourceUseHashes: visualPassSet.sourceUseHashes,
    }), /canonical/);
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

test("VIS-15a aligned capture accepts asynchronous readback without using the browser default", async () => {
    const state = scenes();
    const { visualPassSet, analyticPassSet } = passSets(state);
    const renderer = new FakeRenderer();
    let asynchronousReads = 0;
    let leaseDepth = 0;
    let leaseRuns = 0;
    const rendererLease = {
        async runAsync(operation) {
            leaseDepth += 1;
            leaseRuns += 1;
            try {
                return await operation();
            } finally {
                leaseDepth -= 1;
                assert.equal(renderer.target, null);
                assert.equal(renderer.clearColor.getHex(), 0x123456);
            }
        },
        runSync(operation) {
            leaseDepth += 1;
            try {
                return operation();
            } finally {
                leaseDepth -= 1;
            }
        },
    };
    const aligned = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: state.visualHandle,
        analyticSceneHandle: state.analyticHandle,
        authorizeSourceUse: async () => {},
        rendererLease,
        readback: async (_renderer, target, output, { signal }) => {
            signal.throwIfAborted();
            assert.equal(leaseDepth, 1);
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
    assert.ok(leaseRuns > 1);
    assert.ok(leaseRuns <= asynchronousReads);
    assert.equal(leaseDepth, 0);
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
    const failedCamera = new THREE.PerspectiveCamera();
    const failedCameraMatrix = failedCamera.matrixWorld.elements.slice();
    const failedProjection = failedCamera.projectionMatrix.elements.slice();
    const failed = new AlignedCaptureProducts({
        renderer: failedRenderer,
        camera: failedCamera,
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
    assert.equal(failedRenderer.toneMapping, 7);
    assert.equal(failedRenderer.toneMappingExposure, 2);
    assert.equal(failedRenderer.outputColorSpace, "original-space");
    assert.deepEqual([...failedCamera.matrixWorld.elements], failedCameraMatrix);
    assert.deepEqual([...failedCamera.projectionMatrix.elements], failedProjection);
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

test("a beauty composer paints color while analytic capture still uses renderer.render", async () => {
    const visualScene = new THREE.Scene();
    const surface = mesh(0x00ff00);
    visualScene.add(surface);
    const events = [];
    const renderedScenes = [];
    visualScene.userData.cevSimBeautyComposer = {
        render() { events.push("composer"); },
        outputBuffer: {
            width: 2,
            height: 1,
            texture: { type: THREE.UnsignedByteType },
            userData: { captureTargetKind: "beauty" },
        },
    };
    const analyticScene = new THREE.Scene();
    const truth = mesh(0xffffff);
    analyticScene.add(truth);
    const visualHandle = createOwnedCaptureScene({ role: "measured-appearance", scene: visualScene });
    const analyticHandle = createOwnedCaptureScene({ role: "analytic-truth", scene: analyticScene });
    const visualPassSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(visualHandle),
        products: ["beauty"],
        bindings: [],
    });
    const analyticPassSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
        captureInput: passInput(analyticHandle),
        products: ["axial-depth"],
        bindings: [{ renderableId: "truth", semanticId: 1, instanceId: 1 }],
    });
    const renderer = new FakeRenderer();
    const originalRender = renderer.render.bind(renderer);
    renderer.render = (scene) => {
        events.push("renderer");
        renderedScenes.push(scene);
        originalRender(scene);
    };
    const capture = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: visualHandle,
        analyticSceneHandle: analyticHandle,
    });
    const result = await capture.capture({
        visualPassSet,
        visualRenderables: new Map(),
        analyticPassSet,
        analyticRenderables: new Map([["truth", truth]]),
        signal: new AbortController().signal,
    });
    assert.deepEqual(events.filter((event) => event === "composer"), ["composer"]);
    assert.ok(events.includes("renderer"));
    assert.ok(events.indexOf("composer") < events.lastIndexOf("renderer"));
    assert.equal(renderedScenes.includes(visualScene), false);
    assert.equal(result.visual.products.beauty.length, 8);
    capture.dispose();
});

test("beauty readback resolves the composer's post-render output target", async () => {
    const visualScene = new THREE.Scene();
    const surface = mesh(0x00ff00);
    visualScene.add(surface);
    const resizedTarget = (width, height, kind = "beauty") => ({
        width,
        height,
        texture: { type: THREE.UnsignedByteType },
        userData: { captureTargetKind: kind },
        setSize(nextWidth, nextHeight) {
            this.width = nextWidth;
            this.height = nextHeight;
        },
    });
    const staleOutput = resizedTarget(640, 360, "stale-beauty");
    const replacementOutput = resizedTarget(2, 1);
    const composer = {
        inputBuffer: resizedTarget(640, 360),
        outputBuffer: staleOutput,
        passes: [],
        render() { this.outputBuffer = replacementOutput; },
    };
    visualScene.userData.cevSimBeautyComposer = composer;
    const visualHandle = createOwnedCaptureScene({ role: "measured-appearance", scene: visualScene });
    const visualPassSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(visualHandle),
        products: ["beauty"],
        bindings: [],
    });
    const renderer = new FakeRenderer();
    const readTargets = [];
    renderer.onRead = (target) => readTargets.push(target);
    const capture = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: visualHandle,
    });
    const result = await capture.capture({
        visualPassSet,
        visualRenderables: new Map(),
        signal: new AbortController().signal,
    });
    assert.equal(staleOutput.width, 2);
    assert.equal(staleOutput.height, 1);
    assert.equal(readTargets.at(-1), replacementOutput);
    assert.equal(result.visual.products.beauty.length, 8);
    capture.dispose();
});

test("beauty readback reports the post-render target dimensions before image warping", async () => {
    const visualScene = new THREE.Scene();
    const surface = mesh(0x00ff00);
    visualScene.add(surface);
    const target = (width, height) => ({
        width,
        height,
        texture: { type: THREE.UnsignedByteType },
        userData: { captureTargetKind: "beauty" },
        setSize(nextWidth, nextHeight) {
            this.width = nextWidth;
            this.height = nextHeight;
        },
    });
    const composer = {
        inputBuffer: target(2, 1),
        outputBuffer: target(2, 1),
        passes: [],
        render() { this.outputBuffer = target(1, 1); },
    };
    visualScene.userData.cevSimBeautyComposer = composer;
    const visualHandle = createOwnedCaptureScene({ role: "measured-appearance", scene: visualScene });
    const visualPassSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(visualHandle),
        products: ["beauty"],
        bindings: [],
    });
    const capture = new AlignedCaptureProducts({
        renderer: new FakeRenderer(),
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: visualHandle,
    });
    await assert.rejects(capture.capture({
        visualPassSet,
        visualRenderables: new Map(),
        signal: new AbortController().signal,
    }), (error) => error.code === "VISUAL_CAPTURE_TARGET_SIZE_INVALID"
        && /must be 2x1 after draw; got 1x1/.test(error.message));
    capture.dispose();
});

test("sky meshes stay in the appearance scene and out of the material proxy", async () => {
    const scene = new THREE.Scene();
    const surface = mesh(0x00ff00);
    surface.name = "surface";
    const sky = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.ShaderMaterial({
            vertexShader: "void main() {}",
            fragmentShader: "void main() {}",
        }),
    );
    sky.name = "TakramSkyQuad";
    sky.userData.cevSimSky = true;
    scene.add(surface, sky);
    const handle = createOwnedCaptureScene({ role: "measured-appearance", scene });
    const passSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
        captureInput: passInput(handle),
        products: ["beauty"],
        bindings: [],
    });
    const renderer = new FakeRenderer();
    const capture = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        visualSceneHandle: handle,
    });
    const result = await capture.capture({
        visualPassSet: passSet,
        visualRenderables: new Map(),
        signal: new AbortController().signal,
    });
    assert.equal(result.visual.products.beauty.length, 8);
    assert.ok(renderer.renderCalls > 0);
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

test("PBO beauty readback allocates after a 320x180 composer resize and survives presentation", async () => {
    class FakeWebGL2 {}
    const previous = globalThis.WebGL2RenderingContext;
    globalThis.WebGL2RenderingContext = FakeWebGL2;
    const allocations = [];
    const reads = [];
    const gl = Object.assign(Object.create(FakeWebGL2.prototype), {
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        FLOAT: 0x1406,
        PIXEL_PACK_BUFFER: 0x88eb,
        PIXEL_PACK_BUFFER_BINDING: 0x88ed,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        TIMEOUT_EXPIRED: 0x911b,
        WAIT_FAILED: 0x911d,
        CONDITION_SATISFIED: 0x9119,
        createBuffer: () => ({ id: allocations.length }),
        bindBuffer() {},
        bufferData(_target, byteLength) { allocations.push(byteLength); },
        getParameter: () => 4,
        pixelStorei() {},
        readPixels(_x, _y, width, height) { reads.push([width, height]); },
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        clientWaitSync: () => 0x9119,
        deleteSync() {},
        deleteBuffer() {},
        getBufferSubData(_target, _offset, dest) { dest.fill(255); },
        isContextLost: () => false,
    });
    try {
        const target = (width, height) => ({
            width,
            height,
            texture: { type: THREE.UnsignedByteType },
            userData: { captureTargetKind: "beauty" },
            setSize(nextWidth, nextHeight) {
                this.width = nextWidth;
                this.height = nextHeight;
            },
        });
        const visualScene = new THREE.Scene();
        visualScene.add(mesh(0x00ff00));
        const output = target(1280, 720);
        let composerRenders = 0;
        const composer = {
            inputBuffer: target(1280, 720),
            outputBuffer: output,
            passes: [],
            render() { composerRenders += 1; },
        };
        visualScene.userData.cevSimBeautyComposer = composer;
        const visualHandle = createOwnedCaptureScene({ role: "measured-appearance", scene: visualScene });
        const cameraCalibration = calibration(320, 180);
        const captureInput = createVisualCaptureInput({
            calibration: cameraCalibration,
            pose: { matrixWorld: new THREE.Matrix4().elements },
            sceneHandle: visualHandle,
            captureTimeNs: 99,
        });
        const visualPassSet = createVisualCapturePassSet({
            family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
            captureInput,
            products: ["beauty"],
            bindings: [],
        });
        const renderer = new FakeRenderer();
        renderer.context = gl;
        let presentationInterleaved = false;
        const rendererLease = {
            runSync(operation) {
                const result = operation();
                if (!presentationInterleaved && composerRenders > 0 && result?.slot) {
                    presentationInterleaved = true;
                    output.setSize(1280, 720);
                }
                return result;
            },
        };
        const capture = new AlignedCaptureProducts({
            renderer,
            camera: new THREE.PerspectiveCamera(),
            visualSceneHandle: visualHandle,
            rendererLease,
        });
        const request = () => capture.capture({
            visualPassSet,
            visualRenderables: new Map(),
            signal: new AbortController().signal,
        });
        const first = await request();
        const second = await request();
        assert.equal(presentationInterleaved, true);
        assert.equal(composerRenders, 2);
        assert.equal(first.visual.products.beauty.length, 230400);
        assert.equal(second.visual.products.beauty.length, 230400);
        assert.ok(allocations.length >= 1);
        assert.ok(allocations.every((byteLength) => byteLength === 230400));
        assert.ok(reads.length >= 4);
        assert.ok(reads.every(([width, height]) => width === 320 && height === 180));
        capture.dispose();
    } finally {
        if (previous === undefined) delete globalThis.WebGL2RenderingContext;
        else globalThis.WebGL2RenderingContext = previous;
    }
});

test("WebGL2 aligned capture reads through a pixel-pack slot after the fence is consumed", async () => {
    class FakeWebGL2 {}
    const previous = globalThis.WebGL2RenderingContext;
    globalThis.WebGL2RenderingContext = FakeWebGL2;
    const events = [];
    let waits = 0;
    const gl = Object.assign(Object.create(FakeWebGL2.prototype), {
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        FLOAT: 0x1406,
        PIXEL_PACK_BUFFER: 0x88eb,
        PIXEL_PACK_BUFFER_BINDING: 0x88ed,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        TIMEOUT_EXPIRED: 0x911b,
        WAIT_FAILED: 0x911d,
        createBuffer: () => ({ id: "pbo" }),
        bindBuffer() {},
        bufferData() {},
        getParameter: () => 4,
        pixelStorei() {},
        readPixels() { events.push("write"); },
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        clientWaitSync(_sync, _flags, timeout) {
            assert.equal(timeout, 0);
            waits += 1;
            if (waits % 2 === 1) return 0x911b;
            events.push("wait-ready");
            return 0x9119;
        },
        deleteSync() { events.push("delete"); },
        deleteBuffer() {},
        getBufferSubData(_target, _offset, dest) {
            assert.equal(events.at(-1), "wait-ready");
            events.push("read");
            dest.fill(255);
        },
        isContextLost: () => false,
    });
    try {
        const state = scenes();
        const renderer = new FakeRenderer();
        renderer.context = gl;
        const visualPassSet = createVisualCapturePassSet({
            family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
            captureInput: passInput(state.visualHandle),
            products: ["validity"],
            bindings: [
                { renderableId: "target-mesh", objectKey: "target", materialKeys: ["brick"] },
            ],
        });
        const aligned = new AlignedCaptureProducts({
            renderer,
            camera: new THREE.PerspectiveCamera(),
            visualSceneHandle: state.visualHandle,
            authorizeSourceUse: async () => {},
        });
        const result = await aligned.capture({
            visualPassSet,
            visualRenderables: new Map([["target-mesh", state.target]]),
            signal: new AbortController().signal,
        });
        assert.equal(renderer.readCalls, 0);
        assert.ok(events.includes("write"));
        assert.ok(events.includes("read"));
        assert.ok(events.indexOf("read") > events.indexOf("write"));
        assert.equal(events.filter((event) => event === "write").length, events.filter((event) => event === "read").length);
        assert.ok(result.visual.products.validity.length > 0);
        aligned.dispose();
    } finally {
        if (previous === undefined) delete globalThis.WebGL2RenderingContext;
        else globalThis.WebGL2RenderingContext = previous;
    }
});

test("WebGL2 aligned capture queues the next draw before the previous read finishes", async () => {
    class FakeWebGL2 {}
    const previous = globalThis.WebGL2RenderingContext;
    globalThis.WebGL2RenderingContext = FakeWebGL2;
    const events = [];
    const gl = Object.assign(Object.create(FakeWebGL2.prototype), {
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        FLOAT: 0x1406,
        PIXEL_PACK_BUFFER: 0x88eb,
        PIXEL_PACK_BUFFER_BINDING: 0x88ed,
        STREAM_READ: 0x88e1,
        PACK_ALIGNMENT: 0x0d05,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        TIMEOUT_EXPIRED: 0x911b,
        WAIT_FAILED: 0x911d,
        createBuffer: () => ({ id: events.length }),
        bindBuffer() {},
        bufferData() {},
        getParameter: () => 4,
        pixelStorei() {},
        readPixels() { events.push("write"); },
        fenceSync: () => ({ id: "sync" }),
        flush() {},
        clientWaitSync(_sync, _flags, timeout) {
            assert.equal(timeout, 0);
            if (events.filter((event) => event === "write").length < 2) return 0x911b;
            events.push("wait-ready");
            return 0x9119;
        },
        deleteSync() { events.push("delete"); },
        deleteBuffer() {},
        getBufferSubData(_target, _offset, dest) {
            events.push("read");
            dest.fill(255);
        },
        isContextLost: () => false,
    });
    try {
        const state = scenes();
        const renderer = new FakeRenderer();
        renderer.context = gl;
        renderer.onRender = () => events.push("draw");
        const visualPassSet = createVisualCapturePassSet({
            family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
            captureInput: passInput(state.visualHandle),
            products: ["validity", "object-id"],
            bindings: [
                { renderableId: "target-mesh", objectKey: "target", materialKeys: ["brick"] },
            ],
        });
        const aligned = new AlignedCaptureProducts({
            renderer,
            camera: new THREE.PerspectiveCamera(),
            visualSceneHandle: state.visualHandle,
            authorizeSourceUse: async () => {},
        });
        await aligned.capture({
            visualPassSet,
            visualRenderables: new Map([["target-mesh", state.target]]),
            signal: new AbortController().signal,
        });
        const writes = events.map((event, index) => event === "write" ? index : -1).filter((index) => index >= 0);
        const draws = events.map((event, index) => event === "draw" ? index : -1).filter((index) => index >= 0);
        assert.equal(writes.length, 2);
        assert.equal(draws.length, 2);
        assert.ok(writes[0] < draws[1]);
        const reads = events.map((event, index) => event === "read" ? index : -1).filter((index) => index >= 0);
        const deletes = events.map((event, index) => event === "delete" ? index : -1).filter((index) => index >= 0);
        assert.equal(reads.length, deletes.length);
        reads.forEach((index, offset) => assert.ok(index < deletes[offset]));
        aligned.dispose();
    } finally {
        if (previous === undefined) delete globalThis.WebGL2RenderingContext;
        else globalThis.WebGL2RenderingContext = previous;
    }
});

test("browser analytic products render the truth scene twice", async () => {
    const state = scenes();
    const renderer = new FakeRenderer();
    const analyticPassSet = createVisualCapturePassSet({
        family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
        captureInput: passInput(state.analyticHandle),
        products: ["axial-depth", "semantic-id", "instance-id"],
        bindings: [
            { renderableId: "truth-near", semanticId: 7, instanceId: 70 },
            { renderableId: "truth-far", semanticId: 8, instanceId: 80 },
        ],
    });
    const aligned = new AlignedCaptureProducts({
        renderer,
        camera: new THREE.PerspectiveCamera(),
        analyticSceneHandle: state.analyticHandle,
    });
    const result = await aligned.capture({
        analyticPassSet,
        analyticRenderables: new Map([
            ["truth-near", state.truthNear],
            ["truth-far", state.truthFar],
        ]),
        signal: new AbortController().signal,
    });
    assert.equal(renderer.renderCalls, 2);
    assert.deepEqual([...result.analytic.products.axialDepth], [2, 4]);
    assert.deepEqual([...result.analytic.products.semanticId], [7, 8]);
    assert.deepEqual([...result.analytic.products.instanceId], [70, 80]);
    assert.deepEqual([...result.analytic.products.validity], [1, 1]);
    const allocated = aligned.bufferAllocations;
    await aligned.capture({
        analyticPassSet,
        analyticRenderables: new Map([
            ["truth-near", state.truthNear],
            ["truth-far", state.truthFar],
        ]),
        signal: new AbortController().signal,
    });
    assert.equal(aligned.bufferAllocations, allocated);
    aligned.dispose();
});
