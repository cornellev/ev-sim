import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { buildCameraInfo } from "../app/3d/devices/SensorMessages.js";
import { CameraRenderProducts } from "../app/3d/perception/CameraRenderProducts.js";
import {
    applyProjectionToThreeCamera,
    assertVisualCameraCalibration,
    calibrationFrustum,
    CORRECTED_VISUAL_CAPTURE_MODE,
    createOwnedCaptureScene,
    createVisualCameraCalibration,
    createVisualCaptureInput,
    decodeAxialDepth,
    distortNormalizedPointStrict,
    normalizeImageRows,
    projectOpticalPoint,
    projectionMatrixFromCalibration,
    projectWorldPoint,
    rayRangeFromAxialDepth,
    recreateOwnedCaptureScene,
    snapshotRep103CameraPose,
    unprojectPixelToOptical,
    undistortNormalizedPointStrict,
    validateDistortion,
    warpCalibratedImage,
} from "../app/3d/environment/visual/VisualCapturePipeline.js";
import {
    createCalibratedHeadlessCameraRequest,
    PooledGpuRenderer,
} from "../server/headless/PooledGpuRenderer.js";

const vectors = JSON.parse(await readFile(
    new URL("./fixtures/visual-layer/camera-calibration.v1.json", import.meta.url),
    "utf8",
));

function close(actual, expected, epsilon = 1e-12) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("committed independent K vectors define exact frusta and OpenGL projection matrices", () => {
    for (const vector of vectors.cases) {
        const calibration = createVisualCameraCalibration(vector.calibration);
        const frustum = calibrationFrustum(calibration);
        for (const key of ["left", "right", "top", "bottom", "near", "far"]) {
            close(frustum[key], vector.frustum[key]);
        }
        const projection = projectionMatrixFromCalibration(calibration);
        projection.forEach((value, index) => close(value, vector.projection[index]));
        for (const sample of vector.opticalPoints) {
            const projected = projectOpticalPoint(sample.point, calibration);
            close(projected.pixel.x, sample.pixel.x);
            close(projected.pixel.y, sample.pixel.y);
            assert.equal(projected.valid, sample.valid);
        }
        const sample = vector.opticalPoints.find((entry) => entry.valid && entry.point.z > 1);
        if (sample) {
            const unprojected = unprojectPixelToOptical(sample.pixel, sample.point.z, calibration);
            close(unprojected.x, sample.point.x);
            close(unprojected.y, sample.point.y);
            close(unprojected.z, sample.point.z);
        }
    }
});

test("corrected Three projection and CameraInfo agree with independent pixel vectors", () => {
    const vector = vectors.cases[0];
    const calibration = createVisualCameraCalibration(vector.calibration);
    const camera = new THREE.PerspectiveCamera(75, 4 / 3, 0.1, 100);
    applyProjectionToThreeCamera(camera, calibration);
    camera.updateMatrixWorld(true);
    const point = new THREE.Vector3(1, -0.5, -10).project(camera);
    const pixel = {
        x: (point.x + 1) * calibration.image.width / 2 - 0.5,
        y: (1 - point.y) * calibration.image.height / 2 - 0.5,
    };
    close(pixel.x, 350.25, 1e-10);
    close(pixel.y, 236.75, 1e-10);
    assert.deepEqual([...camera.projectionMatrix.elements], [...projectionMatrixFromCalibration(calibration)]);

    const info = buildCameraInfo({
        ...vector.calibration,
        timeNs: 17,
        frameId: "camera_optical_frame",
    });
    assert.deepEqual(info.k, [500, 0, 300.25, 0, 520, 210.75, 0, 0, 1]);
});

test("world projection covers translated/rotated camera poses and REP-103 snapshots", () => {
    const calibration = createVisualCameraCalibration(vectors.cases[0].calibration);
    for (const vector of vectors.worldPoseCases) {
        const projected = projectWorldPoint(
            vector.worldPoint,
            calibration,
            { matrixWorld: vector.matrixWorld },
        );
        close(projected.pixel.x, vector.expectedPixel.x);
        close(projected.pixel.y, vector.expectedPixel.y);
        close(projected.axialDepth, vector.expectedAxialDepth);
        assert.equal(projected.valid, true);
    }
    const pose = snapshotRep103CameraPose({
        captureTimeNs: 123_456_789,
        worldPose: {
            position: { x: 10, y: -2, z: 1 },
            rotation: { x: 0.1, y: -0.2, z: 0.3, order: "XYZ" },
        },
        mountPose: {
            position: { x: 1.5, y: 0.25, z: 0.5 },
            rotation: { x: 0.05, y: 0.02, z: -0.1, order: "XYZ" },
        },
    });
    assert.equal(pose.captureTimeNs, 123_456_789);
    assert.equal(pose.matrixWorld.length, 16);
    assert.equal(pose.opticalPoseRep103.quaternion.w !== undefined, true);
    assert.throws(() => snapshotRep103CameraPose({ captureTimeNs: 1.5 }), /integer/);
});

test("strict calibration accepts only none, five-coefficient, and rational eight-coefficient distortion", () => {
    const none = validateDistortion({ model: "none", coefficients: [] });
    const brown = validateDistortion({ model: "brown-conrady", coefficients: [0.1, -0.02, 0.001, -0.002, 0.004] });
    const rational = validateDistortion({
        model: "rational-brown-conrady",
        coefficients: [0.1, -0.02, 0.001, -0.002, 0.004, 0.01, -0.005, 0.001],
    });
    assert.equal(none.coefficients.length, 0);
    assert.equal(brown.coefficients.length, 5);
    assert.equal(rational.coefficients.length, 8);
    assert.throws(() => validateDistortion({ model: "brown-conrady", coefficients: [1, 2, 3, 4] }), /exactly 5/);
    assert.throws(() => validateDistortion({ model: "fisheye", coefficients: [] }), /Unsupported/);
    assert.throws(() => validateDistortion({ model: "brown-conrady", coefficients: [0, 0, 0, 0, NaN] }), /finite/);
});

test("strict Brown-Conrady mapping round-trips and rejects singular or non-convergent inverses", () => {
    for (const distortion of [
        { model: "brown-conrady", coefficients: [0.2, 0.05, 0.01, -0.01, 0.02] },
        { model: "rational-brown-conrady", coefficients: [0.2, 0.05, 0.01, -0.01, 0.02, 0.01, 0.005, 0.001] },
    ]) {
        const original = { x: 0.2, y: -0.15 };
        const mapped = distortNormalizedPointStrict(original, distortion);
        const restored = undistortNormalizedPointStrict(mapped, distortion);
        close(restored.x, original.x, 1e-9);
        close(restored.y, original.y, 1e-9);
    }
    assert.throws(() => distortNormalizedPointStrict(
        { x: 1, y: 0 },
        { model: "rational-brown-conrady", coefficients: [0, 0, 0, 0, 0, -1, 0, 0] },
    ), /singular/);
    assert.throws(() => undistortNormalizedPointStrict(
        { x: 0.8, y: 0.6 },
        { model: "brown-conrady", coefficients: [2, 1, 0.1, -0.1, 1] },
        { maxIterations: 1, tolerance: 1e-15 },
    ), /did not converge/);
});

test("calibrated warping shares validity while RGB is bilinear and depth/labels are nearest", () => {
    const calibration = createVisualCameraCalibration({
        width: 5,
        height: 5,
        intrinsics: { fx: 2, fy: 2, cx: 2, cy: 2 },
        near: 0.1,
        far: 20,
        distortionModel: "brown-conrady",
        distortion: [-0.01, 0, 0, 0, 0],
    });
    const rgb = new Uint8Array(5 * 5 * 4);
    const labels = new Uint16Array(5 * 5);
    for (let index = 0; index < 25; index += 1) {
        rgb[index * 4] = index * 7;
        rgb[index * 4 + 3] = 255;
        labels[index] = index;
    }
    const rgbResult = warpCalibratedImage({ data: rgb, calibration, channels: 4, interpolation: "linear" });
    const labelResult = warpCalibratedImage({ data: labels, calibration, channels: 1, interpolation: "nearest" });
    assert.deepEqual([...rgbResult.validity], [...labelResult.validity]);
    assert.ok(rgbResult.validity.some((value) => value === 0));
    assert.equal(rgbResult.data[0], 0);
    assert.equal(labelResult.data[0], 0);
    assert.notDeepEqual([...rgbResult.data.filter((_, index) => index % 4 === 0)], [...labelResult.data]);
});

test("row normalization and axial-depth decoding use top-left zero-plus-validity semantics", () => {
    const input = Uint8Array.from(vectors.bottomLeftRgba2x2);
    assert.deepEqual(
        [...normalizeImageRows(input, 2, 2, 4, { inputRows: "bottom-left" })],
        vectors.topLeftRgba2x2,
    );
    const calibration = createVisualCameraCalibration({
        width: 2,
        height: 1,
        intrinsics: { fx: 1, fy: 1, cx: 0, cy: 0 },
        near: 0.5,
        far: 10,
        distortionModel: "none",
        distortion: [],
    });
    const decoded = decodeAxialDepth({
        rgba: new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]),
        calibration,
        inputRows: "top-left",
    });
    close(decoded.data[0], 0.5);
    assert.equal(decoded.validity[0], 1);
    assert.equal(decoded.data[1], 0);
    assert.equal(decoded.validity[1], 0);
    close(rayRangeFromAxialDepth({ x: 1, y: 0 }, 2, calibration), Math.sqrt(8));
});

test("owned scene generations isolate display mutations and capture inputs are immutable snapshots", () => {
    const measured = new THREE.Scene();
    measured.userData.identity = "measured";
    measured.add(new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0x123456 }),
    ));
    const preview = new THREE.Scene();
    preview.userData.visualCaptureRole = "display-preview";
    const handle = createOwnedCaptureScene({
        role: "measured-appearance",
        scene: measured,
        generation: 4,
        descriptionHash: "scene-a",
    });
    const stable = JSON.stringify(measured.toJSON());
    preview.background = new THREE.Color(0xff0000);
    preview.environment = new THREE.Texture();
    preview.userData.exposure = 9;
    preview.add(new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshStandardMaterial()));
    preview.children[0].visible = false;
    preview.userData.activeEnvironment = "mutated";
    preview.userData.bakeOverlays = ["overlay"];
    assert.equal(JSON.stringify(measured.toJSON()), stable);
    assert.throws(() => createVisualCaptureInput({
        calibration: createVisualCameraCalibration(vectors.cases[0].calibration),
        pose: { matrixWorld: new THREE.Matrix4().elements },
        sceneHandle: createOwnedCaptureScene({ role: "measured-appearance", scene: preview }),
        captureTimeNs: 1,
    }), /Display\/preview/);
    const previewChildScene = new THREE.Scene();
    const previewChild = new THREE.Group();
    previewChild.userData.cevSimVisualPreviewOnly = true;
    previewChildScene.add(previewChild);
    assert.throws(() => createVisualCaptureInput({
        calibration: createVisualCameraCalibration(vectors.cases[0].calibration),
        pose: { matrixWorld: new THREE.Matrix4().elements },
        sceneHandle: createOwnedCaptureScene({ role: "measured-appearance", scene: previewChildScene }),
        captureTimeNs: 1,
    }), /Display\/preview/);

    const recreated = recreateOwnedCaptureScene(handle, { scene: measured.clone() });
    assert.equal(recreated.generation, 5);
    const capture = createVisualCaptureInput({
        calibration: createVisualCameraCalibration(vectors.cases[0].calibration),
        pose: { matrixWorld: new THREE.Matrix4().makeTranslation(1, 2, 3).elements },
        sceneHandle: handle,
        captureTimeNs: 99,
    });
    measured.position.x = 200;
    assert.equal(capture.scene.generation, 4);
    assert.equal(capture.pose.matrixWorld[12], 1);
    assert.equal(Object.isFrozen(capture), true);
    assert.equal(Object.isFrozen(capture.calibration), true);
    assert.throws(() => assertVisualCameraCalibration({
        ...capture.calibration,
        unknown: true,
    }), /missing or unknown/);
    assert.throws(() => createCalibratedHeadlessCameraRequest({
        id: "forged",
        captureInput: {
            ...capture,
            projectionMatrix: capture.projectionMatrix.map((value, index) => index === 0 ? value + 1 : value),
        },
    }), /projectionMatrix does not match/);
    assert.throws(() => createCalibratedHeadlessCameraRequest({
        id: "forged-pose",
        captureInput: {
            ...capture,
            pose: {
                ...capture.pose,
                quaternion: { x: 0, y: 1, z: 0, w: 0 },
            },
        },
    }), /does not match matrixWorld/);
});

test("corrected bake, browser camera, and headless adapters use the same immutable projection", async () => {
    const calibration = createVisualCameraCalibration(vectors.cases[0].calibration);
    const scene = new THREE.Scene();
    const handle = createOwnedCaptureScene({
        role: "measured-appearance",
        scene,
        descriptionHash: "scene-a",
    });
    const camera = new THREE.PerspectiveCamera();
    const products = new CameraRenderProducts({
        renderer: {},
        camera,
        captureMode: CORRECTED_VISUAL_CAPTURE_MODE,
        calibration,
        sceneHandle: handle,
    });
    assert.deepEqual([...camera.projectionMatrix.elements], [...projectionMatrixFromCalibration(calibration)]);
    products.dispose();

    const captureInput = createVisualCaptureInput({
        calibration,
        pose: { matrixWorld: new THREE.Matrix4().elements },
        sceneHandle: handle,
        captureTimeNs: 101,
    });
    const request = createCalibratedHeadlessCameraRequest({ id: "front-camera", captureInput });
    assert.equal(request.width, 640);
    assert.equal(request.sensor, undefined);
    assert.deepEqual(request.captureInput.projectionMatrix, projectionMatrixFromCalibration(calibration));
    assertVisualCameraCalibration(request.captureInput.calibration);

    const pool = new PooledGpuRenderer({ chromiumExecutable: "" });
    await assert.rejects(pool.captureGroup({
        environmentKey: "test",
        scene: { hash: "scene-b", description: {} },
        requests: [request],
        maxGpuBytes: 1024 * 1024,
    }), /scene hash/);
    await pool.close();
});

test("BakeView keeps legacy FOV behavior and exposes only an explicit corrected adapter", async () => {
    const source = await readFile(new URL(
        "../app/3d/environment/visualization/BakeView.js",
        import.meta.url,
    ), "utf8");
    assert.match(source, /captureMode = LEGACY_VISUAL_CAPTURE_MODE/);
    assert.match(source, /applyProjectionToThreeCamera\(this\.sensorCamera, this\.visualCalibration\)/);
    assert.match(source, /role: "bake-snapshot"/);
    assert.match(source, /inputRows: "bottom-left"/);
    assert.match(source, /this\.cameraSettings\.width \/ 2/);
});

test("the calibration core imports without DOM or browser globals", async () => {
    const source = await readFile(new URL(
        "../app/3d/environment/visual/VisualCapturePipeline.js",
        import.meta.url,
    ), "utf8");
    assert.doesNotMatch(source, /\b(window|document|navigator|OffscreenCanvas|WebGL|THREE)\b/);
});
