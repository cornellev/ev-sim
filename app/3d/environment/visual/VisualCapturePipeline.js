import {
    cameraLinkToOpticalRotation,
    composeRep103Poses,
    eulerToQuaternion,
    quaternionMultiply,
    rep103PoseToThree,
    threeCameraLookAlongMountForwardRotation,
} from "../../../autonomy/CoordinateFrames.js";

export const VISUAL_CAMERA_CALIBRATION_KIND = "cev-sim.visual-camera-calibration";
export const VISUAL_CAMERA_CALIBRATION_VERSION = 1;
export const VISUAL_CAPTURE_INPUT_KIND = "cev-sim.visual-capture-input";
export const VISUAL_CAPTURE_INPUT_VERSION = 1;
export const VISUAL_CAPTURE_PASS_SET_KIND = "cev-sim.visual-capture-pass-set";
export const VISUAL_CAPTURE_PASS_SET_VERSION = 1;
export const CORRECTED_VISUAL_CAPTURE_MODE = "calibrated-projection@1";
export const LEGACY_VISUAL_CAPTURE_MODE = "legacy-fov@1";

export const VISUAL_CAPTURE_PASS_FAMILIES = Object.freeze({
    visual: "visual-appearance",
    analytic: "analytic-oracle",
});

export const VISUAL_CAPTURE_PRODUCTS = Object.freeze({
    [VISUAL_CAPTURE_PASS_FAMILIES.visual]: Object.freeze([
        "beauty",
        "axial-depth",
        "geometric-normal",
        "object-id",
        "material-id",
        "world-position",
        "confidence",
        "validity",
    ]),
    [VISUAL_CAPTURE_PASS_FAMILIES.analytic]: Object.freeze([
        "axial-depth",
        "semantic-id",
        "instance-id",
        "validity",
    ]),
});

export const VISUAL_CAPTURE_PRODUCT_LAYOUTS = Object.freeze({
    beauty: Object.freeze({ arrayType: "Uint8Array", channels: 4, encoding: "rgba8-srgb" }),
    "axial-depth": Object.freeze({ arrayType: "Float32Array", channels: 1, encoding: "little-endian" }),
    "geometric-normal": Object.freeze({ arrayType: "Float32Array", channels: 3, encoding: "little-endian" }),
    "object-id": Object.freeze({ arrayType: "Uint32Array", channels: 1, encoding: "little-endian" }),
    "material-id": Object.freeze({ arrayType: "Uint32Array", channels: 1, encoding: "little-endian" }),
    "world-position": Object.freeze({ arrayType: "Float32Array", channels: 3, encoding: "little-endian" }),
    confidence: Object.freeze({ arrayType: "Float32Array", channels: 1, encoding: "little-endian" }),
    validity: Object.freeze({ arrayType: "Uint8Array", channels: 1, encoding: "uint8" }),
    "semantic-id": Object.freeze({ arrayType: "Uint32Array", channels: 1, encoding: "little-endian" }),
    "instance-id": Object.freeze({ arrayType: "Uint32Array", channels: 1, encoding: "little-endian" }),
});

export const CAPTURE_SCENE_ROLES = Object.freeze([
    "measured-appearance",
    "analytic-truth",
    "bake-snapshot",
]);

const CAPTURE_SCENE_ROLE_SET = new Set(CAPTURE_SCENE_ROLES);
const MATRIX_LENGTH = 16;
const DISTORTION_DENOMINATOR_EPSILON = 1e-12;
const DISTORTION_RESIDUAL_TOLERANCE = 1e-10;
const DISTORTION_MAX_ITERATIONS = 20;
const CALIBRATION_VALIDATION_CACHE = new WeakMap();
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();

function contractError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function finiteNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw contractError("VISUAL_CALIBRATION_INVALID", `${name} must be finite.`);
    }
    return number;
}

function positiveNumber(value, name) {
    const number = finiteNumber(value, name);
    if (number <= 0) {
        throw contractError("VISUAL_CALIBRATION_INVALID", `${name} must be greater than zero.`);
    }
    return number;
}

function positiveInteger(value, name) {
    const number = finiteNumber(value, name);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw contractError("VISUAL_CALIBRATION_INVALID", `${name} must be a positive safe integer.`);
    }
    return number;
}

function integerNanoseconds(value, name = "captureTimeNs") {
    const number = finiteNumber(value, name);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw contractError("VISUAL_CAPTURE_TIME_INVALID", `${name} must be a non-negative integer number of nanoseconds.`);
    }
    return number;
}

function freezeArray(values) {
    return Object.freeze([...values]);
}

function assertExactKeys(value, expected, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw contractError("VISUAL_CONTRACT_INVALID", `${name} must be an object.`);
    }
    const actual = Object.keys(value).sort();
    const keys = [...expected].sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
        throw contractError("VISUAL_CONTRACT_INVALID", `${name} contains missing or unknown fields.`);
    }
}

function assertAllowedKeys(value, allowed, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw contractError("VISUAL_CONTRACT_INVALID", `${name} must be an object.`);
    }
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) {
        throw contractError("VISUAL_CONTRACT_INVALID", `${name}.${unknown} is not supported.`);
    }
}

function assertEqualArray(actual, expected, name) {
    if (!actual || actual.length !== expected.length
        || expected.some((value, index) => actual[index] !== value)) {
        throw contractError("VISUAL_CONTRACT_INVALID", `${name} does not match the canonical contract.`);
    }
}

function freezePoint(point) {
    return Object.freeze({
        x: finiteNumber(point?.x, "point.x"),
        y: finiteNumber(point?.y, "point.y"),
    });
}

function freezeVector3(value, name) {
    return Object.freeze({
        x: finiteNumber(value?.x ?? 0, `${name}.x`),
        y: finiteNumber(value?.y ?? 0, `${name}.y`),
        z: finiteNumber(value?.z ?? 0, `${name}.z`),
    });
}

function freezeQuaternion(value, name) {
    const result = {
        x: finiteNumber(value?.x ?? 0, `${name}.x`),
        y: finiteNumber(value?.y ?? 0, `${name}.y`),
        z: finiteNumber(value?.z ?? 0, `${name}.z`),
        w: finiteNumber(value?.w ?? 1, `${name}.w`),
    };
    const norm = Math.hypot(result.x, result.y, result.z, result.w);
    if (norm <= Number.EPSILON) {
        throw contractError("VISUAL_CAPTURE_POSE_INVALID", `${name} must not be the zero quaternion.`);
    }
    return Object.freeze({
        x: result.x / norm,
        y: result.y / norm,
        z: result.z / norm,
        w: result.w / norm,
    });
}

function quaternionFromRotation(rotation = {}, name = "rotation") {
    if (rotation?.w !== undefined) return freezeQuaternion(rotation, name);
    if (rotation?.order !== undefined && rotation.order !== "XYZ") {
        throw contractError("VISUAL_CAPTURE_POSE_INVALID", `${name}.order must be intrinsic XYZ.`);
    }
    return freezeQuaternion(eulerToQuaternion({
        x: finiteNumber(rotation?.x ?? 0, `${name}.x`),
        y: finiteNumber(rotation?.y ?? 0, `${name}.y`),
        z: finiteNumber(rotation?.z ?? 0, `${name}.z`),
        order: "XYZ",
    }), name);
}

function assertMatrix(value, name) {
    if (!value || value.length !== MATRIX_LENGTH) {
        throw contractError("VISUAL_CAPTURE_MATRIX_INVALID", `${name} must contain 16 column-major values.`);
    }
    return freezeArray(Array.from(value, (entry, index) => finiteNumber(entry, `${name}[${index}]`)));
}

function distortionFromSource(source = {}) {
    if (Array.isArray(source) || ArrayBuffer.isView(source)) {
        const coefficients = [...source];
        return {
            model: coefficients.length === 0
                ? "none"
                : coefficients.length === 8
                    ? "rational-brown-conrady"
                    : "brown-conrady",
            coefficients,
        };
    }
    if (source?.model !== undefined || source?.coefficients !== undefined) {
        return {
            model: String(source.model ?? "none"),
            coefficients: [...(source.coefficients || [])],
        };
    }
    const coefficients = [...(source?.distortion || [])];
    const authoredModel = String(source?.distortionModel || "none");
    if (authoredModel === "none" && coefficients.length === 0) {
        return { model: "none", coefficients };
    }
    if (authoredModel === "plumb_bob" || authoredModel === "brown-conrady") {
        return {
            model: coefficients.length === 8 ? "rational-brown-conrady" : "brown-conrady",
            coefficients,
        };
    }
    return { model: authoredModel, coefficients };
}

export function validateDistortion(distortion = {}) {
    const normalized = distortionFromSource(distortion);
    const expectedLength = {
        none: 0,
        "brown-conrady": 5,
        "rational-brown-conrady": 8,
    }[normalized.model];
    if (expectedLength === undefined) {
        throw contractError(
            "VISUAL_DISTORTION_MODEL_UNSUPPORTED",
            `Unsupported distortion model "${normalized.model}".`,
        );
    }
    if (normalized.coefficients.length !== expectedLength) {
        throw contractError(
            "VISUAL_DISTORTION_COEFFICIENTS_INVALID",
            `${normalized.model} requires exactly ${expectedLength} coefficients.`,
        );
    }
    const coefficients = normalized.coefficients.map((value, index) => finiteNumber(
        value,
        `distortion.coefficients[${index}]`,
    ));
    return Object.freeze({
        model: normalized.model,
        coefficients: freezeArray(coefficients),
    });
}

export function createVisualCameraCalibration(source = {}) {
    const width = positiveInteger(source.width, "width");
    const height = positiveInteger(source.height, "height");
    const intrinsics = source.intrinsics || source;
    const fx = positiveNumber(intrinsics.fx, "intrinsics.fx");
    const fy = positiveNumber(intrinsics.fy, "intrinsics.fy");
    const cx = finiteNumber(intrinsics.cx, "intrinsics.cx");
    const cy = finiteNumber(intrinsics.cy, "intrinsics.cy");
    const near = positiveNumber(source.near, "near");
    const far = positiveNumber(source.far, "far");
    if (far <= near) {
        throw contractError("VISUAL_CALIBRATION_INVALID", "far must be greater than near.");
    }
    const distortion = validateDistortion(
        source.distortionSpec
        || (source.distortion?.model ? source.distortion : {
            model: source.distortionModel,
            coefficients: source.distortion,
        }),
    );
    const calibration = Object.freeze({
        kind: VISUAL_CAMERA_CALIBRATION_KIND,
        version: VISUAL_CAMERA_CALIBRATION_VERSION,
        image: Object.freeze({
            width,
            height,
            origin: "top-left",
            pixelCenters: "integer",
        }),
        intrinsics: Object.freeze({ fx, fy, cx, cy }),
        clipping: Object.freeze({ near, far }),
        distortion,
        frames: Object.freeze({
            mount: "REP-103-camera-link",
            optical: "REP-103-camera-optical",
            mountToOptical: freezeQuaternion(cameraLinkToOpticalRotation(), "frames.mountToOptical"),
            rotationOrder: "intrinsic-XYZ",
        }),
        matrixConvention: Object.freeze({
            layout: "column-major",
            clipSpace: "OpenGL",
            cameraForward: "-Z",
        }),
    });
    CALIBRATION_VALIDATION_CACHE.set(calibration, calibration);
    return calibration;
}

export function assertVisualCameraCalibration(calibration) {
    const cached = calibration && typeof calibration === "object"
        ? CALIBRATION_VALIDATION_CACHE.get(calibration)
        : null;
    if (cached) return cached;
    if (calibration?.kind !== VISUAL_CAMERA_CALIBRATION_KIND
        || calibration?.version !== VISUAL_CAMERA_CALIBRATION_VERSION) {
        throw contractError(
            "VISUAL_CALIBRATION_KIND_UNSUPPORTED",
            `Expected ${VISUAL_CAMERA_CALIBRATION_KIND}@${VISUAL_CAMERA_CALIBRATION_VERSION}.`,
        );
    }
    assertExactKeys(calibration, [
        "kind", "version", "image", "intrinsics", "clipping", "distortion", "frames", "matrixConvention",
    ], "calibration");
    assertExactKeys(calibration.image, ["width", "height", "origin", "pixelCenters"], "calibration.image");
    assertExactKeys(calibration.intrinsics, ["fx", "fy", "cx", "cy"], "calibration.intrinsics");
    assertExactKeys(calibration.clipping, ["near", "far"], "calibration.clipping");
    assertExactKeys(calibration.distortion, ["model", "coefficients"], "calibration.distortion");
    assertExactKeys(calibration.frames, [
        "mount", "optical", "mountToOptical", "rotationOrder",
    ], "calibration.frames");
    assertExactKeys(calibration.frames.mountToOptical, ["x", "y", "z", "w"], "calibration.frames.mountToOptical");
    assertExactKeys(calibration.matrixConvention, [
        "layout", "clipSpace", "cameraForward",
    ], "calibration.matrixConvention");
    const recreated = createVisualCameraCalibration({
        width: calibration.image?.width,
        height: calibration.image?.height,
        intrinsics: calibration.intrinsics,
        near: calibration.clipping?.near,
        far: calibration.clipping?.far,
        distortionSpec: calibration.distortion,
    });
    if (calibration.image?.origin !== "top-left"
        || calibration.image?.pixelCenters !== "integer"
        || calibration.frames?.mount !== recreated.frames.mount
        || calibration.frames?.optical !== recreated.frames.optical
        || calibration.frames?.rotationOrder !== "intrinsic-XYZ"
        || calibration.matrixConvention?.layout !== "column-major"
        || calibration.matrixConvention?.clipSpace !== "OpenGL"
        || calibration.matrixConvention?.cameraForward !== "-Z") {
        throw contractError("VISUAL_CALIBRATION_INVALID", "Calibration conventions do not match version 1.");
    }
    assertEqualArray(
        ["x", "y", "z", "w"].map((key) => calibration.frames.mountToOptical[key]),
        ["x", "y", "z", "w"].map((key) => recreated.frames.mountToOptical[key]),
        "calibration.frames.mountToOptical",
    );
    CALIBRATION_VALIDATION_CACHE.set(calibration, recreated);
    return recreated;
}

export function calibrationFrustum(calibration) {
    const checked = assertVisualCameraCalibration(calibration);
    const { width, height } = checked.image;
    const { fx, fy, cx, cy } = checked.intrinsics;
    const { near, far } = checked.clipping;
    return Object.freeze({
        left: -(cx + 0.5) * near / fx,
        right: (width - cx - 0.5) * near / fx,
        top: (cy + 0.5) * near / fy,
        bottom: -(height - cy - 0.5) * near / fy,
        near,
        far,
    });
}

export function projectionMatrixFromCalibration(calibration) {
    const { left, right, top, bottom, near, far } = calibrationFrustum(calibration);
    const x = 2 * near / (right - left);
    const y = 2 * near / (top - bottom);
    const a = (right + left) / (right - left);
    const b = (top + bottom) / (top - bottom);
    const c = -(far + near) / (far - near);
    const d = -2 * far * near / (far - near);
    return freezeArray([
        x, 0, 0, 0,
        0, y, 0, 0,
        a, b, c, -1,
        0, 0, d, 0,
    ]);
}

export function multiplyColumnMajorMatrices(left, right) {
    const a = assertMatrix(left, "left");
    const b = assertMatrix(right, "right");
    const result = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
            for (let index = 0; index < 4; index += 1) {
                result[column * 4 + row] += a[index * 4 + row] * b[column * 4 + index];
            }
        }
    }
    return freezeArray(result);
}

export function invertRigidTransform(matrix) {
    const value = assertMatrix(matrix, "matrixWorld");
    const result = [
        value[0], value[4], value[8], 0,
        value[1], value[5], value[9], 0,
        value[2], value[6], value[10], 0,
        0, 0, 0, 1,
    ];
    const tx = value[12];
    const ty = value[13];
    const tz = value[14];
    result[12] = -(result[0] * tx + result[4] * ty + result[8] * tz);
    result[13] = -(result[1] * tx + result[5] * ty + result[9] * tz);
    result[14] = -(result[2] * tx + result[6] * ty + result[10] * tz);
    return freezeArray(result);
}

function matrixFromPose(position, quaternion) {
    const { x, y, z, w } = quaternion;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    return freezeArray([
        1 - (yy + zz), xy + wz, xz - wy, 0,
        xy - wz, 1 - (xx + zz), yz + wx, 0,
        xz + wy, yz - wx, 1 - (xx + yy), 0,
        position.x, position.y, position.z, 1,
    ]);
}

function quaternionFromMatrix(matrix) {
    const m11 = matrix[0];
    const m12 = matrix[4];
    const m13 = matrix[8];
    const m21 = matrix[1];
    const m22 = matrix[5];
    const m23 = matrix[9];
    const m31 = matrix[2];
    const m32 = matrix[6];
    const m33 = matrix[10];
    const trace = m11 + m22 + m33;
    let x;
    let y;
    let z;
    let w;
    if (trace > 0) {
        const scale = 0.5 / Math.sqrt(trace + 1);
        w = 0.25 / scale;
        x = (m32 - m23) * scale;
        y = (m13 - m31) * scale;
        z = (m21 - m12) * scale;
    } else if (m11 > m22 && m11 > m33) {
        const scale = 2 * Math.sqrt(1 + m11 - m22 - m33);
        w = (m32 - m23) / scale;
        x = 0.25 * scale;
        y = (m12 + m21) / scale;
        z = (m13 + m31) / scale;
    } else if (m22 > m33) {
        const scale = 2 * Math.sqrt(1 + m22 - m11 - m33);
        w = (m13 - m31) / scale;
        x = (m12 + m21) / scale;
        y = 0.25 * scale;
        z = (m23 + m32) / scale;
    } else {
        const scale = 2 * Math.sqrt(1 + m33 - m11 - m22);
        w = (m21 - m12) / scale;
        x = (m13 + m31) / scale;
        y = (m23 + m32) / scale;
        z = 0.25 * scale;
    }
    const quaternion = freezeQuaternion({ x, y, z, w }, "matrixWorld.quaternion");
    return quaternion.w < 0
        ? Object.freeze({
            x: -quaternion.x,
            y: -quaternion.y,
            z: -quaternion.z,
            w: -quaternion.w,
        })
        : quaternion;
}

function assertRotationMatchesMatrix(matrix, position, quaternion, name) {
    const expected = matrixFromPose(position, quaternion);
    const rotationIndices = [0, 1, 2, 4, 5, 6, 8, 9, 10];
    if (Math.abs(matrix[3]) > 1e-10
        || Math.abs(matrix[7]) > 1e-10
        || Math.abs(matrix[11]) > 1e-10
        || Math.abs(matrix[15] - 1) > 1e-10
        || rotationIndices.some((index) => Math.abs(matrix[index] - expected[index]) > 1e-10)) {
        throw contractError("VISUAL_CAPTURE_POSE_INVALID", `${name} does not match matrixWorld.`);
    }
}

export function snapshotCameraPose({ captureTimeNs, position, rotation, matrixWorld } = {}) {
    const timestamp = integerNanoseconds(captureTimeNs);
    let frozenPosition;
    let frozenQuaternion;
    let frozenMatrix;
    if (matrixWorld) {
        frozenMatrix = assertMatrix(matrixWorld, "matrixWorld");
        frozenPosition = Object.freeze({ x: frozenMatrix[12], y: frozenMatrix[13], z: frozenMatrix[14] });
        frozenQuaternion = quaternionFromMatrix(frozenMatrix);
        assertRotationMatchesMatrix(frozenMatrix, frozenPosition, frozenQuaternion, "matrixWorld rotation");
        if (rotation) {
            assertRotationMatchesMatrix(
                frozenMatrix,
                frozenPosition,
                quaternionFromRotation(rotation),
                "rotation",
            );
        }
    } else {
        frozenPosition = freezeVector3(position, "position");
        frozenQuaternion = quaternionFromRotation(rotation);
        frozenMatrix = matrixFromPose(frozenPosition, frozenQuaternion);
    }
    return Object.freeze({
        captureTimeNs: timestamp,
        position: frozenPosition,
        quaternion: frozenQuaternion,
        matrixWorld: frozenMatrix,
        viewMatrix: invertRigidTransform(frozenMatrix),
        matrixLayout: "column-major",
    });
}

export function snapshotRep103CameraPose({ captureTimeNs, worldPose = {}, mountPose = {} } = {}) {
    const world = {
        position: freezeVector3(worldPose.position, "worldPose.position"),
        rotation: quaternionFromRotation(worldPose.rotation, "worldPose.rotation"),
    };
    const mount = {
        position: freezeVector3(mountPose.position, "mountPose.position"),
        rotation: quaternionFromRotation(mountPose.rotation, "mountPose.rotation"),
    };
    const mountWorldRep103 = composeRep103Poses(world, mount);
    const opticalWorldRep103 = composeRep103Poses(mountWorldRep103, {
        position: { x: 0, y: 0, z: 0 },
        rotation: cameraLinkToOpticalRotation(),
    });
    const threeMount = rep103PoseToThree(mountWorldRep103);
    const threeMountQuaternion = eulerToQuaternion(threeMount.rotation);
    const threeCameraQuaternion = quaternionMultiply(
        threeMountQuaternion,
        threeCameraLookAlongMountForwardRotation(),
    );
    const threePosition = freezeVector3(threeMount.position, "threePosition");
    const snapshot = snapshotCameraPose({
        captureTimeNs,
        position: threePosition,
        rotation: threeCameraQuaternion,
    });
    return Object.freeze({
        ...snapshot,
        mountPoseRep103: Object.freeze({
            position: freezeVector3(mountWorldRep103.position, "mountPoseRep103.position"),
            quaternion: freezeQuaternion(mountWorldRep103.rotation, "mountPoseRep103.quaternion"),
        }),
        opticalPoseRep103: Object.freeze({
            position: freezeVector3(opticalWorldRep103.position, "opticalPoseRep103.position"),
            quaternion: freezeQuaternion(opticalWorldRep103.rotation, "opticalPoseRep103.quaternion"),
        }),
    });
}

function transformPoint(matrix, point) {
    const x = finiteNumber(point?.x, "point.x");
    const y = finiteNumber(point?.y, "point.y");
    const z = finiteNumber(point?.z, "point.z");
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    return {
        x: (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
        y: (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
        z: (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w,
    };
}

export function projectOpticalPoint(point, calibration, { requireInside = true } = {}) {
    const checked = assertVisualCameraCalibration(calibration);
    const x = finiteNumber(point?.x, "point.x");
    const y = finiteNumber(point?.y, "point.y");
    const z = finiteNumber(point?.z, "point.z");
    const { near, far } = checked.clipping;
    const { width, height } = checked.image;
    const { fx, fy, cx, cy } = checked.intrinsics;
    const pixel = Object.freeze({ x: fx * x / z + cx, y: fy * y / z + cy });
    const inDepth = z >= near && z <= far;
    const inside = pixel.x >= -0.5 && pixel.x <= width - 0.5
        && pixel.y >= -0.5 && pixel.y <= height - 0.5;
    return Object.freeze({
        pixel,
        axialDepth: z,
        rayRange: Math.hypot(x, y, z),
        inside,
        valid: z > 0 && inDepth && (!requireInside || inside),
    });
}

export function projectWorldPoint(point, calibration, pose, options = {}) {
    const viewMatrix = assertMatrix(pose?.viewMatrix || invertRigidTransform(pose?.matrixWorld), "pose.viewMatrix");
    const view = transformPoint(viewMatrix, point);
    return projectOpticalPoint({ x: view.x, y: -view.y, z: -view.z }, calibration, options);
}

export function unprojectPixelToOptical(point, axialDepth, calibration) {
    const checked = assertVisualCameraCalibration(calibration);
    const pixel = freezePoint(point);
    const depth = positiveNumber(axialDepth, "axialDepth");
    const { fx, fy, cx, cy } = checked.intrinsics;
    return Object.freeze({
        x: (pixel.x - cx) * depth / fx,
        y: (pixel.y - cy) * depth / fy,
        z: depth,
    });
}

export function rayRangeFromAxialDepth(point, axialDepth, calibration) {
    const optical = unprojectPixelToOptical(point, axialDepth, calibration);
    return Math.hypot(optical.x, optical.y, optical.z);
}

export function applyProjectionToThreeCamera(camera, calibration) {
    if (!camera?.projectionMatrix?.fromArray) {
        throw contractError("VISUAL_CAPTURE_CAMERA_INVALID", "A Three-compatible camera is required.");
    }
    const checked = assertVisualCameraCalibration(calibration);
    const projection = projectionMatrixFromCalibration(checked);
    camera.near = checked.clipping.near;
    camera.far = checked.clipping.far;
    camera.projectionMatrix.fromArray(projection);
    camera.projectionMatrixInverse?.copy?.(camera.projectionMatrix)?.invert?.();
    return projection;
}

export function createOwnedCaptureScene({ role, scene, generation = 1, descriptionHash = null } = {}) {
    if (!CAPTURE_SCENE_ROLE_SET.has(role)) {
        throw contractError("VISUAL_CAPTURE_SCENE_ROLE_INVALID", `Unsupported capture-scene role "${role}".`);
    }
    if (!scene || typeof scene !== "object") {
        throw contractError("VISUAL_CAPTURE_SCENE_INVALID", "An owned scene object is required.");
    }
    const normalizedGeneration = positiveInteger(generation, "generation");
    return Object.freeze({
        role,
        scene,
        generation: normalizedGeneration,
        descriptionHash: descriptionHash === null ? null : String(descriptionHash),
    });
}

export function recreateOwnedCaptureScene(handle, { scene, descriptionHash = handle?.descriptionHash } = {}) {
    const checked = assertOwnedCaptureScene(handle);
    return createOwnedCaptureScene({
        role: checked.role,
        scene,
        generation: checked.generation + 1,
        descriptionHash,
    });
}

export function assertOwnedCaptureScene(handle, { role = null } = {}) {
    if (!CAPTURE_SCENE_ROLE_SET.has(handle?.role)
        || !handle?.scene
        || !Number.isSafeInteger(handle?.generation)
        || handle.generation <= 0) {
        throw contractError("VISUAL_CAPTURE_SCENE_INVALID", "A valid owned capture-scene handle is required.");
    }
    if (role && handle.role !== role) {
        throw contractError(
            "VISUAL_CAPTURE_SCENE_ROLE_INVALID",
            `Capture requires the ${role} scene role, received ${handle.role}.`,
        );
    }
    let previewObject = false;
    const checkObject = (object) => {
        if (object?.userData?.cevSimVisualPreviewOnly === true
            || object?.userData?.visualPreview === true
            || object?.userData?.visualCaptureRole === "display-preview") {
            previewObject = true;
        }
    };
    if (typeof handle.scene.traverse === "function") handle.scene.traverse(checkObject);
    else checkObject(handle.scene);
    if (previewObject) {
        throw contractError("VISUAL_CAPTURE_SCENE_PREVIEW_REJECTED", "Display/preview scenes cannot be captured.");
    }
    return handle;
}

export function createVisualCaptureInput({ calibration, pose, sceneHandle, captureTimeNs } = {}) {
    const checkedCalibration = assertVisualCameraCalibration(calibration);
    const checkedScene = assertOwnedCaptureScene(sceneHandle);
    const timestamp = integerNanoseconds(captureTimeNs ?? pose?.captureTimeNs);
    const checkedPose = snapshotCameraPose({
        captureTimeNs: timestamp,
        position: pose?.position,
        matrixWorld: pose?.matrixWorld,
        rotation: pose?.quaternion ?? pose?.rotation,
    });
    const projectionMatrix = projectionMatrixFromCalibration(checkedCalibration);
    return Object.freeze({
        kind: VISUAL_CAPTURE_INPUT_KIND,
        version: VISUAL_CAPTURE_INPUT_VERSION,
        captureTimeNs: timestamp,
        calibration: checkedCalibration,
        pose: checkedPose,
        projectionMatrix,
        viewProjectionMatrix: multiplyColumnMajorMatrices(projectionMatrix, checkedPose.viewMatrix),
        scene: Object.freeze({
            role: checkedScene.role,
            generation: checkedScene.generation,
            descriptionHash: checkedScene.descriptionHash,
        }),
        outputRows: "top-left",
    });
}

export function assertVisualCaptureInput(input) {
    if (input?.kind !== VISUAL_CAPTURE_INPUT_KIND || input?.version !== VISUAL_CAPTURE_INPUT_VERSION) {
        throw contractError(
            "VISUAL_CAPTURE_INPUT_KIND_UNSUPPORTED",
            `Expected ${VISUAL_CAPTURE_INPUT_KIND}@${VISUAL_CAPTURE_INPUT_VERSION}.`,
        );
    }
    assertExactKeys(input, [
        "kind", "version", "captureTimeNs", "calibration", "pose", "projectionMatrix",
        "viewProjectionMatrix", "scene", "outputRows",
    ], "captureInput");
    assertExactKeys(input.pose, [
        "captureTimeNs", "position", "quaternion", "matrixWorld", "viewMatrix", "matrixLayout",
    ], "captureInput.pose");
    assertExactKeys(input.pose.position, ["x", "y", "z"], "captureInput.pose.position");
    assertExactKeys(input.pose.quaternion, ["x", "y", "z", "w"], "captureInput.pose.quaternion");
    assertExactKeys(input.scene, ["role", "generation", "descriptionHash"], "captureInput.scene");
    integerNanoseconds(input.captureTimeNs);
    if (input.pose.captureTimeNs !== input.captureTimeNs || input.pose.matrixLayout !== "column-major") {
        throw contractError("VISUAL_CAPTURE_INPUT_INVALID", "Capture pose conventions do not match the input.");
    }
    const calibration = assertVisualCameraCalibration(input.calibration);
    const matrixWorld = assertMatrix(input.pose?.matrixWorld, "pose.matrixWorld");
    const viewMatrix = assertMatrix(input.pose?.viewMatrix, "pose.viewMatrix");
    const projection = assertMatrix(input.projectionMatrix, "projectionMatrix");
    const viewProjection = assertMatrix(input.viewProjectionMatrix, "viewProjectionMatrix");
    const recreatedPose = snapshotCameraPose({
        captureTimeNs: input.captureTimeNs,
        matrixWorld,
        rotation: input.pose.quaternion,
    });
    assertEqualArray(viewMatrix, recreatedPose.viewMatrix, "captureInput.pose.viewMatrix");
    assertEqualArray(
        [input.pose.position.x, input.pose.position.y, input.pose.position.z],
        [recreatedPose.position.x, recreatedPose.position.y, recreatedPose.position.z],
        "captureInput.pose.position",
    );
    assertEqualArray(
        [input.pose.quaternion.x, input.pose.quaternion.y, input.pose.quaternion.z, input.pose.quaternion.w],
        [
            recreatedPose.quaternion.x,
            recreatedPose.quaternion.y,
            recreatedPose.quaternion.z,
            recreatedPose.quaternion.w,
        ],
        "captureInput.pose.quaternion",
    );
    assertEqualArray(projection, projectionMatrixFromCalibration(calibration), "captureInput.projectionMatrix");
    assertEqualArray(
        viewProjection,
        multiplyColumnMajorMatrices(projection, viewMatrix),
        "captureInput.viewProjectionMatrix",
    );
    if (!CAPTURE_SCENE_ROLE_SET.has(input.scene?.role)
        || !Number.isSafeInteger(input.scene?.generation)
        || input.scene.generation <= 0
        || (input.scene.descriptionHash !== null && typeof input.scene.descriptionHash !== "string")
        || input.outputRows !== "top-left") {
        throw contractError("VISUAL_CAPTURE_INPUT_INVALID", "Capture input conventions are invalid.");
    }
    return input;
}

function compareUtf8(left, right) {
    const a = textEncoder.encode(left);
    const b = textEncoder.encode(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function canonicalString(value, name, { optional = false } = {}) {
    if (optional && (value === null || value === undefined || value === "")) return null;
    if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
        throw contractError("VISUAL_CAPTURE_BINDING_INVALID", `${name} must be a non-empty NFC string.`);
    }
    return value;
}

function uint32(value, name, { allowZero = true } = {}) {
    const number = finiteNumber(value, name);
    if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1) || number > 0xffffffff) {
        throw contractError(
            "VISUAL_CAPTURE_BINDING_INVALID",
            `${name} must be ${allowZero ? "a" : "a non-zero"} Uint32 value.`,
        );
    }
    return number;
}

function uniqueCanonicalStrings(values, name) {
    if (!Array.isArray(values)) {
        throw contractError("VISUAL_CAPTURE_BINDING_INVALID", `${name} must be an array.`);
    }
    const result = values.map((value, index) => canonicalString(value, `${name}[${index}]`));
    result.sort(compareUtf8);
    if (result.some((value, index) => index > 0 && value === result[index - 1])) {
        throw contractError("VISUAL_CAPTURE_BINDING_INVALID", `${name} contains duplicate values.`);
    }
    return result;
}

function canonicalStringSequence(values, name) {
    if (!Array.isArray(values)) {
        throw contractError("VISUAL_CAPTURE_BINDING_INVALID", `${name} must be an array.`);
    }
    return values.map((value, index) => canonicalString(value, `${name}[${index}]`));
}

function catalogFromKeys(keys) {
    return Object.freeze(keys.map((key, index) => Object.freeze({ id: index + 1, key })));
}

function catalogId(catalog, key) {
    if (!key) return 0;
    return catalog.find((entry) => entry.key === key)?.id ?? 0;
}

function normalizeVisualBindings(bindings) {
    if (!Array.isArray(bindings)) {
        throw contractError("VISUAL_CAPTURE_BINDING_INVALID", "bindings must be an array.");
    }
    const staged = bindings.map((binding, index) => {
        assertAllowedKeys(binding, [
            "renderableId", "objectKey", "materialKeys", "tags", "truthEntityId",
        ], `bindings[${index}]`);
        const objectKey = canonicalString(binding.objectKey, `bindings[${index}].objectKey`);
        const materialKeys = canonicalStringSequence(binding.materialKeys, `bindings[${index}].materialKeys`);
        if (materialKeys.length === 0) {
            throw contractError(
                "VISUAL_CAPTURE_BINDING_INVALID",
                `bindings[${index}].materialKeys must bind every material slot.`,
            );
        }
        return {
            renderableId: canonicalString(binding.renderableId, `bindings[${index}].renderableId`),
            objectKey,
            materialKeys,
            tags: uniqueCanonicalStrings(binding.tags ?? [], `bindings[${index}].tags`),
            truthEntityId: canonicalString(
                binding.truthEntityId,
                `bindings[${index}].truthEntityId`,
                { optional: true },
            ),
        };
    }).sort((left, right) => compareUtf8(left.renderableId, right.renderableId));
    if (staged.some((binding, index) => index > 0 && binding.renderableId === staged[index - 1].renderableId)) {
        throw contractError("VISUAL_CAPTURE_BINDING_INVALID", "bindings contain duplicate renderableId values.");
    }
    const objectKeys = [...new Set(staged.map((binding) => binding.objectKey).filter(Boolean))].sort(compareUtf8);
    const materialKeys = [...new Set(staged.flatMap((binding) => binding.materialKeys))].sort(compareUtf8);
    const objects = catalogFromKeys(objectKeys);
    const materials = catalogFromKeys(materialKeys);
    return Object.freeze({
        bindings: Object.freeze(staged.map((binding) => Object.freeze({
            renderableId: binding.renderableId,
            objectKey: binding.objectKey,
            objectId: catalogId(objects, binding.objectKey),
            materialKeys: Object.freeze([...binding.materialKeys]),
            materialIds: Object.freeze(binding.materialKeys.map((key) => catalogId(materials, key))),
            tags: Object.freeze([...binding.tags]),
            truthEntityId: binding.truthEntityId,
            confidence: 1,
        }))),
        catalogs: Object.freeze({ objects, materials }),
    });
}

function normalizeAnalyticBindings(bindings) {
    if (!Array.isArray(bindings)) {
        throw contractError("VISUAL_CAPTURE_BINDING_INVALID", "bindings must be an array.");
    }
    const normalized = bindings.map((binding, index) => {
        assertAllowedKeys(binding, ["renderableId", "semanticId", "instanceId"], `bindings[${index}]`);
        return Object.freeze({
            renderableId: canonicalString(binding.renderableId, `bindings[${index}].renderableId`),
            semanticId: uint32(binding.semanticId ?? 0, `bindings[${index}].semanticId`),
            instanceId: uint32(binding.instanceId ?? 0, `bindings[${index}].instanceId`),
        });
    }).sort((left, right) => compareUtf8(left.renderableId, right.renderableId));
    if (normalized.some((binding, index) => index > 0 && binding.renderableId === normalized[index - 1].renderableId)) {
        throw contractError("VISUAL_CAPTURE_BINDING_INVALID", "bindings contain duplicate renderableId values.");
    }
    return Object.freeze(normalized);
}

function normalizeCaptureProducts(family, products) {
    const allowed = VISUAL_CAPTURE_PRODUCTS[family];
    if (!allowed) {
        throw contractError("VISUAL_CAPTURE_PASS_FAMILY_UNSUPPORTED", `Unsupported pass family "${family}".`);
    }
    const requested = products === undefined ? [...allowed] : uniqueCanonicalStrings(products, "products");
    if (requested.length === 0) {
        throw contractError("VISUAL_CAPTURE_PRODUCT_UNSUPPORTED", `${family} requires at least one product.`);
    }
    for (const product of requested) {
        if (!allowed.includes(product)) {
            throw contractError(
                "VISUAL_CAPTURE_PRODUCT_UNSUPPORTED",
                `Product "${product}" is not supported by ${family}.`,
            );
        }
    }
    if (requested.length > 0 && !requested.includes("validity")) requested.push("validity");
    return Object.freeze(allowed.filter((product) => requested.includes(product)));
}

function normalizeUseHashes(useHashes) {
    if (!Array.isArray(useHashes)) {
        throw contractError("VISUAL_CAPTURE_SOURCE_INVALID", "sourceUseHashes must be an array.");
    }
    const normalized = useHashes.map((value, index) => {
        if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
            throw contractError(
                "VISUAL_CAPTURE_SOURCE_INVALID",
                `sourceUseHashes[${index}] must be a lowercase SHA-256 digest.`,
            );
        }
        return value;
    }).sort(compareUtf8);
    if (normalized.some((value, index) => index > 0 && value === normalized[index - 1])) {
        throw contractError("VISUAL_CAPTURE_SOURCE_INVALID", "sourceUseHashes contains duplicates.");
    }
    return Object.freeze(normalized);
}

export function createVisualCapturePassSet({
    family,
    captureInput,
    products,
    bindings = [],
    sourceUseHashes = [],
} = {}) {
    const input = assertVisualCaptureInput(captureInput);
    const normalizedProducts = normalizeCaptureProducts(family, products);
    if (family === VISUAL_CAPTURE_PASS_FAMILIES.visual
        && input.scene.role !== "measured-appearance"
        && input.scene.role !== "bake-snapshot") {
        throw contractError(
            "VISUAL_CAPTURE_PASS_ROLE_INVALID",
            "Visual appearance passes require measured-appearance or bake-snapshot input.",
        );
    }
    if (family === VISUAL_CAPTURE_PASS_FAMILIES.analytic && input.scene.role !== "analytic-truth") {
        throw contractError(
            "VISUAL_CAPTURE_PASS_ROLE_INVALID",
            "Analytic oracle passes require analytic-truth input.",
        );
    }
    const normalizedUses = normalizeUseHashes(sourceUseHashes);
    if (family === VISUAL_CAPTURE_PASS_FAMILIES.analytic && normalizedUses.length > 0) {
        throw contractError(
            "VISUAL_CAPTURE_SOURCE_INVALID",
            "Analytic truth passes cannot carry visual source uses.",
        );
    }
    const normalizedBindings = family === VISUAL_CAPTURE_PASS_FAMILIES.visual
        ? normalizeVisualBindings(bindings)
        : Object.freeze({ bindings: normalizeAnalyticBindings(bindings), catalogs: null });
    return Object.freeze({
        kind: VISUAL_CAPTURE_PASS_SET_KIND,
        version: VISUAL_CAPTURE_PASS_SET_VERSION,
        family,
        captureInput: input,
        products: normalizedProducts,
        bindings: normalizedBindings.bindings,
        catalogs: normalizedBindings.catalogs,
        sourceUseHashes: normalizedUses,
    });
}

export function assertVisualCapturePassSet(passSet) {
    if (passSet?.kind !== VISUAL_CAPTURE_PASS_SET_KIND || passSet?.version !== VISUAL_CAPTURE_PASS_SET_VERSION) {
        throw contractError(
            "VISUAL_CAPTURE_PASS_SET_UNSUPPORTED",
            `Expected ${VISUAL_CAPTURE_PASS_SET_KIND}@${VISUAL_CAPTURE_PASS_SET_VERSION}.`,
        );
    }
    assertExactKeys(passSet, [
        "kind", "version", "family", "captureInput", "products", "bindings", "catalogs", "sourceUseHashes",
    ], "passSet");
    const recreated = createVisualCapturePassSet({
        family: passSet.family,
        captureInput: passSet.captureInput,
        products: passSet.products,
        bindings: passSet.family === VISUAL_CAPTURE_PASS_FAMILIES.visual
            ? passSet.bindings.map((binding) => ({
                renderableId: binding.renderableId,
                objectKey: binding.objectKey,
                materialKeys: binding.materialKeys,
                tags: binding.tags,
                truthEntityId: binding.truthEntityId,
            }))
            : passSet.bindings.map((binding) => ({
                renderableId: binding.renderableId,
                semanticId: binding.semanticId,
                instanceId: binding.instanceId,
            })),
        sourceUseHashes: passSet.sourceUseHashes,
    });
    const comparable = (value) => JSON.stringify(value);
    if (comparable(recreated.products) !== comparable(passSet.products)
        || comparable(recreated.bindings) !== comparable(passSet.bindings)
        || comparable(recreated.catalogs) !== comparable(passSet.catalogs)
        || comparable(recreated.sourceUseHashes) !== comparable(passSet.sourceUseHashes)) {
        throw contractError("VISUAL_CAPTURE_PASS_SET_INVALID", "Pass set is not in canonical form.");
    }
    return passSet;
}

function equalArray(left, right) {
    return left?.length === right?.length && left.every((value, index) => value === right[index]);
}

export function assertAlignedCapturePassSets(visualPassSet, analyticPassSet) {
    const visual = assertVisualCapturePassSet(visualPassSet);
    const analytic = assertVisualCapturePassSet(analyticPassSet);
    if (visual.family !== VISUAL_CAPTURE_PASS_FAMILIES.visual
        || analytic.family !== VISUAL_CAPTURE_PASS_FAMILIES.analytic) {
        throw contractError("VISUAL_CAPTURE_PASS_ALIGNMENT_INVALID", "Expected visual and analytic pass families.");
    }
    const left = visual.captureInput;
    const right = analytic.captureInput;
    if (left.captureTimeNs !== right.captureTimeNs
        || left.outputRows !== right.outputRows
        || !equalArray(left.pose.matrixWorld, right.pose.matrixWorld)
        || !equalArray(left.projectionMatrix, right.projectionMatrix)
        || JSON.stringify(left.calibration) !== JSON.stringify(right.calibration)) {
        throw contractError(
            "VISUAL_CAPTURE_PASS_ALIGNMENT_INVALID",
            "Visual and analytic pass inputs must share calibration, pose, and capture time.",
        );
    }
    return Object.freeze({ visual, analytic });
}

export function deriveObjectSelectionMask(objectIds, selectedIds, validity = null) {
    if (!(objectIds instanceof Uint32Array)) {
        throw contractError("VISUAL_CAPTURE_PRODUCT_INVALID", "objectIds must be a Uint32Array.");
    }
    const selected = new Set([...selectedIds].map((value, index) => uint32(value, `selectedIds[${index}]`, {
        allowZero: false,
    })));
    const output = new Uint8Array(objectIds.length * 4);
    for (let index = 0; index < objectIds.length; index += 1) {
        if (validity && validity[index] !== 1) continue;
        if (!selected.has(objectIds[index])) continue;
        const offset = index * 4;
        output[offset] = 255;
        output[offset + 1] = 255;
        output[offset + 2] = 255;
        output[offset + 3] = 255;
    }
    return output;
}

export function serializeCaptureProductLittleEndian(data) {
    if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
        return new Uint8Array(data);
    }
    if (!(data instanceof Float32Array) && !(data instanceof Uint32Array)) {
        throw contractError(
            "VISUAL_CAPTURE_PRODUCT_INVALID",
            "Only Uint8, Uint8Clamped, Float32, and Uint32 products are supported.",
        );
    }
    const bytes = new Uint8Array(data.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < data.length; index += 1) {
        if (data instanceof Float32Array) view.setFloat32(index * 4, data[index], true);
        else view.setUint32(index * 4, data[index], true);
    }
    return bytes;
}

export function assertCaptureProductBuffer({ family, product, data, width, height } = {}) {
    if (!VISUAL_CAPTURE_PRODUCTS[family]?.includes(product)) {
        throw contractError(
            "VISUAL_CAPTURE_PRODUCT_UNSUPPORTED",
            `Product "${product}" is not supported by ${family}.`,
        );
    }
    const layout = VISUAL_CAPTURE_PRODUCT_LAYOUTS[product];
    const constructors = { Uint8Array, Uint32Array, Float32Array };
    const ArrayType = constructors[layout.arrayType];
    const expectedLength = positiveInteger(width, "width") * positiveInteger(height, "height") * layout.channels;
    if (!(data instanceof ArrayType) || data.length !== expectedLength) {
        throw contractError(
            "VISUAL_CAPTURE_PRODUCT_INVALID",
            `${family}.${product} must be ${layout.arrayType}[${expectedLength}].`,
        );
    }
    return data;
}

export function normalizeImageRows(data, width, height, channels = 1, {
    inputRows = "bottom-left",
    output = null,
} = {}) {
    const normalizedWidth = positiveInteger(width, "width");
    const normalizedHeight = positiveInteger(height, "height");
    const normalizedChannels = positiveInteger(channels, "channels");
    const expected = normalizedWidth * normalizedHeight * normalizedChannels;
    if (!data || data.length !== expected) {
        throw contractError("VISUAL_IMAGE_BUFFER_INVALID", `Image buffer length must be ${expected}.`);
    }
    if (inputRows !== "top-left" && inputRows !== "bottom-left") {
        throw contractError("VISUAL_IMAGE_ROW_ORDER_INVALID", `Unsupported input row order "${inputRows}".`);
    }
    if (inputRows === "top-left") return data;
    const destination = output && output.length >= expected ? output : new data.constructor(expected);
    if (destination === data) {
        throw contractError("VISUAL_IMAGE_BUFFER_INVALID", "Row normalization requires a separate output buffer.");
    }
    const rowLength = normalizedWidth * normalizedChannels;
    for (let row = 0; row < normalizedHeight; row += 1) {
        destination.set(
            data.subarray((normalizedHeight - row - 1) * rowLength, (normalizedHeight - row) * rowLength),
            row * rowLength,
        );
    }
    return destination;
}

export function flipRows(data, width, height, channels = 1, output = new data.constructor(data.length)) {
    return normalizeImageRows(data, width, height, channels, {
        inputRows: "bottom-left",
        output,
    });
}

function coefficientsArray(distortion) {
    return Array.isArray(distortion) || ArrayBuffer.isView(distortion)
        ? [...distortion]
        : [...(distortion?.coefficients || [])];
}

function distortionTerms(point, coefficients, { strict = true } = {}) {
    const x = finiteNumber(point?.x, "point.x");
    const y = finiteNumber(point?.y, "point.y");
    const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0, k4 = 0, k5 = 0, k6 = 0] = coefficients;
    const r2 = x * x + y * y;
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    const numerator = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    const denominator = 1 + k4 * r2 + k5 * r4 + k6 * r6;
    if (strict && (!Number.isFinite(denominator) || Math.abs(denominator) <= DISTORTION_DENOMINATOR_EPSILON)) {
        throw contractError("VISUAL_DISTORTION_SINGULAR", "Rational Brown-Conrady denominator is singular.");
    }
    const radial = Math.abs(denominator) > Number.EPSILON ? numerator / denominator : numerator;
    const result = {
        x: x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x),
        y: y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y,
    };
    if (strict && (!Number.isFinite(result.x) || !Number.isFinite(result.y))) {
        throw contractError("VISUAL_DISTORTION_SINGULAR", "Brown-Conrady mapping produced a non-finite point.");
    }
    return result;
}

export function distortNormalizedPointStrict(point, distortion) {
    const checked = validateDistortion(distortion);
    if (checked.model === "none") return freezePoint(point);
    return Object.freeze(distortionTerms(point, checked.coefficients));
}

function undistortWithCheckedDistortion(point, checked, {
    maxIterations = DISTORTION_MAX_ITERATIONS,
    tolerance = DISTORTION_RESIDUAL_TOLERANCE,
} = {}) {
    const target = {
        x: finiteNumber(point?.x, "point.x"),
        y: finiteNumber(point?.y, "point.y"),
    };
    if (checked.model === "none") return target;
    const iterations = positiveInteger(maxIterations, "maxIterations");
    const residualTolerance = positiveNumber(tolerance, "tolerance");
    let estimate = { ...target };
    for (let index = 0; index < iterations; index += 1) {
        const projected = distortionTerms(estimate, checked.coefficients);
        const rx = projected.x - target.x;
        const ry = projected.y - target.y;
        if (Math.hypot(rx, ry) <= residualTolerance) return estimate;
        const step = 1e-7 * Math.max(1, Math.abs(estimate.x), Math.abs(estimate.y));
        const px = distortionTerms({ x: estimate.x + step, y: estimate.y }, checked.coefficients);
        const py = distortionTerms({ x: estimate.x, y: estimate.y + step }, checked.coefficients);
        const j00 = (px.x - projected.x) / step;
        const j10 = (px.y - projected.y) / step;
        const j01 = (py.x - projected.x) / step;
        const j11 = (py.y - projected.y) / step;
        const determinant = j00 * j11 - j01 * j10;
        if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-14) {
            throw contractError("VISUAL_DISTORTION_NON_CONVERGENT", "Brown-Conrady inverse Jacobian is singular.");
        }
        estimate = {
            x: estimate.x - (j11 * rx - j01 * ry) / determinant,
            y: estimate.y - (-j10 * rx + j00 * ry) / determinant,
        };
        if (!Number.isFinite(estimate.x) || !Number.isFinite(estimate.y)) break;
    }
    throw contractError("VISUAL_DISTORTION_NON_CONVERGENT", "Brown-Conrady inverse did not converge.");
}

export function undistortNormalizedPointStrict(point, distortion, options = {}) {
    const checked = validateDistortion(distortion);
    return Object.freeze(undistortWithCheckedDistortion(point, checked, options));
}

export function distortPixelStrict(point, calibration) {
    const checked = assertVisualCameraCalibration(calibration);
    const { fx, fy, cx, cy } = checked.intrinsics;
    const normalized = distortNormalizedPointStrict({
        x: (finiteNumber(point?.x, "point.x") - cx) / fx,
        y: (finiteNumber(point?.y, "point.y") - cy) / fy,
    }, checked.distortion);
    return Object.freeze({ x: normalized.x * fx + cx, y: normalized.y * fy + cy });
}

function isIntegerTypedArray(value) {
    return value instanceof Uint8Array
        || value instanceof Uint8ClampedArray
        || value instanceof Uint16Array
        || value instanceof Uint32Array
        || value instanceof Int8Array
        || value instanceof Int16Array
        || value instanceof Int32Array;
}

function sampleNearest(data, width, channels, x, y, channel) {
    const sx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const offset = (Math.round(y) * width + sx) * channels + channel;
    return data[offset];
}

function sampleLinear(data, width, height, channels, x, y, channel) {
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = x - Math.floor(x);
    const ty = y - Math.floor(y);
    const a = data[(y0 * width + x0) * channels + channel];
    const b = data[(y0 * width + x1) * channels + channel];
    const c = data[(y1 * width + x0) * channels + channel];
    const d = data[(y1 * width + x1) * channels + channel];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export function warpCalibratedImage({
    data,
    calibration,
    channels = 1,
    interpolation = "nearest",
    output = null,
    validity = null,
} = {}) {
    const checked = assertVisualCameraCalibration(calibration);
    const { width, height } = checked.image;
    const count = width * height * positiveInteger(channels, "channels");
    if (!data || data.length !== count) {
        throw contractError("VISUAL_IMAGE_BUFFER_INVALID", `Image buffer length must be ${count}.`);
    }
    if (interpolation !== "nearest" && interpolation !== "linear") {
        throw contractError("VISUAL_IMAGE_INTERPOLATION_INVALID", `Unsupported interpolation "${interpolation}".`);
    }
    const destination = output && output.length >= count ? output : new data.constructor(count);
    if (destination === data) {
        throw contractError("VISUAL_IMAGE_BUFFER_INVALID", "Warping requires a separate output buffer.");
    }
    destination.fill(0);
    const mask = validity && validity.length >= width * height ? validity : new Uint8Array(width * height);
    mask.fill(0);
    const { fx, fy, cx, cy } = checked.intrinsics;
    const integerOutput = isIntegerTypedArray(destination);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const source = undistortWithCheckedDistortion(
                { x: (x - cx) / fx, y: (y - cy) / fy },
                checked.distortion,
            );
            const sourceX = source.x * fx + cx;
            const sourceY = source.y * fy + cy;
            if (sourceX < 0 || sourceX > width - 1 || sourceY < 0 || sourceY > height - 1) continue;
            const pixelIndex = y * width + x;
            mask[pixelIndex] = 1;
            for (let channel = 0; channel < channels; channel += 1) {
                const value = interpolation === "linear"
                    ? sampleLinear(data, width, height, channels, sourceX, sourceY, channel)
                    : sampleNearest(data, width, channels, sourceX, sourceY, channel);
                destination[pixelIndex * channels + channel] = interpolation === "linear" && integerOutput
                    ? Math.round(value)
                    : value;
            }
        }
    }
    return Object.freeze({ data: destination, validity: mask });
}

export function unpackRgbDepth(r, g, b, a) {
    const downscale = 255 / 256;
    return r * downscale / (256 ** 3)
        + g * downscale / (256 ** 2)
        + b * downscale / 256
        + a * downscale;
}

export function decodeAxialDepth({ rgba, calibration, inputRows = "bottom-left", output = null, validity = null } = {}) {
    const checked = assertVisualCameraCalibration(calibration);
    const { width, height } = checked.image;
    const pixels = normalizeImageRows(rgba, width, height, 4, { inputRows });
    const destination = output && output.length >= width * height ? output : new Float32Array(width * height);
    const mask = validity && validity.length >= width * height ? validity : new Uint8Array(width * height);
    destination.fill(0);
    mask.fill(0);
    const { near, far } = checked.clipping;
    for (let index = 0; index < destination.length; index += 1) {
        const offset = index * 4;
        const depth = unpackRgbDepth(
            pixels[offset] / 255,
            pixels[offset + 1] / 255,
            pixels[offset + 2] / 255,
            pixels[offset + 3] / 255,
        );
        if (!Number.isFinite(depth) || depth < 0 || depth >= 1 - 1e-7) continue;
        const viewZ = near * far / ((far - near) * depth - far);
        const axial = -viewZ;
        if (!Number.isFinite(axial) || axial < near || axial > far) continue;
        destination[index] = axial;
        mask[index] = 1;
    }
    return Object.freeze({ data: destination, validity: mask });
}

// Compatibility exports. Corrected callers use the strict contract functions above.
function legacyFinite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function distortNormalizedPoint(point, distortion = []) {
    const coefficients = coefficientsArray(distortion).map((value) => legacyFinite(value));
    return distortionTerms({ x: legacyFinite(point?.x), y: legacyFinite(point?.y) }, coefficients, { strict: false });
}

export function undistortNormalizedPoint(point, distortion = [], iterations = 8) {
    const target = { x: legacyFinite(point?.x), y: legacyFinite(point?.y) };
    let estimate = { ...target };
    for (let index = 0; index < iterations; index += 1) {
        const projected = distortNormalizedPoint(estimate, distortion);
        estimate.x += target.x - projected.x;
        estimate.y += target.y - projected.y;
    }
    return estimate;
}

export function distortPixel(point, intrinsics, distortion = []) {
    const fx = legacyFinite(intrinsics?.fx, 1);
    const fy = legacyFinite(intrinsics?.fy, 1);
    const cx = legacyFinite(intrinsics?.cx);
    const cy = legacyFinite(intrinsics?.cy);
    const normalized = distortNormalizedPoint({
        x: (legacyFinite(point?.x) - cx) / fx,
        y: (legacyFinite(point?.y) - cy) / fy,
    }, distortion);
    return { x: normalized.x * fx + cx, y: normalized.y * fy + cy };
}

export function warpBrownConrady({
    data,
    width,
    height,
    intrinsics,
    distortion = [],
    channels = 1,
    interpolation = "nearest",
    output = null,
}) {
    if (!data || distortion.every((value) => Number(value) === 0)) return data;
    const destination = output && output.length >= data.length ? output : new data.constructor(data.length);
    if (destination === data) throw new Error("warpBrownConrady requires a separate output buffer.");
    destination.fill?.(0);
    const fx = legacyFinite(intrinsics?.fx, 1);
    const fy = legacyFinite(intrinsics?.fy, 1);
    const cx = legacyFinite(intrinsics?.cx);
    const cy = legacyFinite(intrinsics?.cy);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const source = undistortNormalizedPoint({ x: (x - cx) / fx, y: (y - cy) / fy }, distortion);
            const sourceX = source.x * fx + cx;
            const sourceY = source.y * fy + cy;
            if (sourceX < 0 || sourceX > width - 1 || sourceY < 0 || sourceY > height - 1) continue;
            for (let channel = 0; channel < channels; channel += 1) {
                const value = interpolation === "linear"
                    ? sampleLinear(data, width, height, channels, sourceX, sourceY, channel)
                    : sampleNearest(data, width, channels, sourceX, sourceY, channel);
                destination[(y * width + x) * channels + channel] = interpolation === "linear"
                    ? Math.round(value)
                    : value;
            }
        }
    }
    return destination;
}
