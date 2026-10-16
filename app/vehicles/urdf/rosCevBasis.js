/**
 * ROS REP-103 ↔ vehicle-frame basis.
 * Vehicle manifests are +X forward, +Y up, +Z left.
 * Sensor REP-103 conversion maps left to −Z and is not this basis.
 * M swaps Y and Z, so det(M) = −1: winding flips and a positive rotation
 * about an axis changes sign.
 */

import {
    mat4FromTrs,
    multiplyMat4,
    quaternionFromRotationMatrix,
    transformPointMat4,
} from "../../math/linalg.js";
import { rpyToQuaternion, rotateVectorByQuaternion } from "../../autonomy/CoordinateFrames.js";

export const URDF_AXIS_PARALLEL = 0.001;
export const URDF_LINK_DEPTH_MAX = 32;

const ROS_TO_CEV = Object.freeze([
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
]);

export function rosToCevPoint(point) {
    return { x: point.x, y: point.z, z: point.y };
}

export function cevToRosPoint(point) {
    return { x: point.x, y: point.z, z: point.y };
}

export function rosToCevLinear(vector) {
    return rosToCevPoint(vector);
}

export function cevToRosLinear(vector) {
    return cevToRosPoint(vector);
}

/** Positive rotation about `axisRos` becomes a positive rotation about the returned CEV axis. */
export function mapJointAxis(axisRos) {
    const mapped = rosToCevLinear(axisRos);
    return { x: 0 - mapped.x, y: 0 - mapped.y, z: 0 - mapped.z };
}

export function axisLength(axis) {
    return Math.hypot(axis.x, axis.y, axis.z);
}

export function axisParallel(axis, expected) {
    const length = axisLength(axis);
    if (!(length > 0)) return false;
    const dot = Math.abs((axis.x * expected[0] + axis.y * expected[1] + axis.z * expected[2]) / length);
    return 1 - dot <= URDF_AXIS_PARALLEL;
}

export function determinant3(matrix) {
    const a = matrix[0];
    const b = matrix[1];
    const c = matrix[2];
    const d = matrix[4];
    const e = matrix[5];
    const f = matrix[6];
    const g = matrix[8];
    const h = matrix[9];
    const i = matrix[10];
    return a * (e * i - f * h) - d * (b * i - f * c) + g * (b * f - e * c);
}

export function originMatrix(origin = {}, scale = [1, 1, 1]) {
    const rpy = origin.rpy ?? [0, 0, 0];
    const quaternion = rpyToQuaternion({ roll: rpy[0] ?? 0, pitch: rpy[1] ?? 0, yaw: rpy[2] ?? 0 });
    return mat4FromTrs(origin.xyz ?? [0, 0, 0], quaternion, scale);
}

export function composeMatrix(parent, child) {
    return multiplyMat4(parent, child);
}

export function matrixToPose(matrix) {
    return {
        position: { x: matrix[12], y: matrix[13], z: matrix[14] },
        quaternion: quaternionFromRotationMatrix(matrix),
        matrix,
    };
}

export function rotateAxis(quaternion, axis) {
    return rotateVectorByQuaternion({ x: axis[0], y: axis[1], z: axis[2] }, quaternion);
}

function invertLinear(matrix) {
    const det = determinant3(matrix);
    if (!(Math.abs(det) > 1e-18)) return null;
    const a = matrix[0];
    const b = matrix[1];
    const c = matrix[2];
    const d = matrix[4];
    const e = matrix[5];
    const f = matrix[6];
    const g = matrix[8];
    const h = matrix[9];
    const i = matrix[10];
    const inv = 1 / det;
    const c00 = e * i - f * h;
    const c01 = c * h - b * i;
    const c02 = b * f - c * e;
    const c10 = f * g - d * i;
    const c11 = a * i - c * g;
    const c12 = d * b - a * e;
    const c20 = d * h - e * g;
    const c21 = b * g - a * h;
    const c22 = a * e - b * d;
    return [
        c00 * inv, c10 * inv, c20 * inv,
        c01 * inv, c11 * inv, c21 * inv,
        c02 * inv, c12 * inv, c22 * inv,
    ];
}

export function transformNormal(matrix, normal) {
    const inverse = invertLinear(matrix);
    if (!inverse) return { x: normal[0], y: normal[1], z: normal[2] };
    const x = inverse[0] * normal[0] + inverse[1] * normal[1] + inverse[2] * normal[2];
    const y = inverse[3] * normal[0] + inverse[4] * normal[1] + inverse[5] * normal[2];
    const z = inverse[6] * normal[0] + inverse[7] * normal[1] + inverse[8] * normal[2];
    const length = Math.hypot(x, y, z);
    if (!(length > 0)) return { x: 0, y: 0, z: 0 };
    return { x: x / length, y: y / length, z: z / length };
}

export function transformPositions(points, matrix) {
    return points.map((point) => {
        const moved = transformPointMat4(matrix, point);
        return [moved.x, moved.y, moved.z];
    });
}

export function flipTriangleWinding(indices) {
    const flipped = indices.slice();
    for (let index = 0; index < flipped.length; index += 3) {
        const first = flipped[index];
        flipped[index] = flipped[index + 1];
        flipped[index + 1] = first;
    }
    return flipped;
}

/** Map a ROS-frame rigid matrix into the vehicle frame. */
export function rosFrameToCev(matrix) {
    return multiplyMat4(ROS_TO_CEV, matrix);
}

export function cevPointToRosMatrix() {
    return ROS_TO_CEV;
}
