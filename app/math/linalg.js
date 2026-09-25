/**
 * Pure column-major transforms and vec3 helpers.
 * No DOM, Three.js, or simulator imports, so kernel and browser code can share it.
 * Quaternions are `{ x, y, z, w }`. Matrices are column-major `number[16]`.
 */

export function lerp(left, right, t) {
    return left + (right - left) * t;
}

export function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

export function clamp01(value) {
    return clamp(value, 0, 1);
}

export function add3(left, right) {
    return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

export function sub3(left, right) {
    return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

export function scale3(value, amount) {
    return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

export function dot3(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function cross3(left, right) {
    return {
        x: left.y * right.z - left.z * right.y,
        y: left.z * right.x - left.x * right.z,
        z: left.x * right.y - left.y * right.x,
    };
}

export function length3(value) {
    return Math.hypot(value.x, value.y, value.z);
}

/**
 * Unit vector. Returns `degenerate` when the length is not strictly greater
 * than `epsilon` (`!(length > epsilon)`), which treats 0 and NaN as degenerate.
 * Road code passes `null`. Bake clipping passes a zero vector.
 */
export function normalize3(value, epsilon = 0, degenerate = null) {
    const magnitude = length3(value);
    if (!(magnitude > epsilon)) return degenerate;
    return scale3(value, 1 / magnitude);
}

export function lerp3(left, right, t) {
    return {
        x: lerp(left.x, right.x, t),
        y: lerp(left.y, right.y, t),
        z: lerp(left.z, right.z, t),
    };
}

export function distance3(left, right) {
    return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

export function distanceXZ(left, right) {
    return Math.hypot(right.x - left.x, right.z - left.z);
}

export function sub3a(left, right) {
    return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

export function dot3a(left, right) {
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

export function cross3a(left, right) {
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ];
}

export function multiplyMat4(left, right) {
    const result = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
            for (let inner = 0; inner < 4; inner += 1) {
                result[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
            }
        }
    }
    return result;
}

/** Rigid pose, identity scale. Doubled-quaternion form used by capture poses. */
export function mat4FromQuaternionTranslation(quaternion, position) {
    const x = quaternion.x;
    const y = quaternion.y;
    const z = quaternion.z;
    const w = quaternion.w;
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
    return [
        1 - (yy + zz), xy + wz, xz - wy, 0,
        xy - wz, 1 - (xx + zz), yz + wx, 0,
        xz + wy, yz - wx, 1 - (xx + yy), 0,
        position.x, position.y, position.z, 1,
    ];
}

/**
 * glTF node matrix. Quaternion is `{x,y,z,w}` or `[x,y,z,w]`.
 * Translation and scale are objects or length-3 arrays.
 * Uses the scaled `(1 - 2*(yy+zz))` form, which is not bit-identical to
 * {@link mat4FromQuaternionTranslation} even at unit scale.
 */
export function mat4FromTrs(translation, rotation, scale) {
    const x = rotation.x ?? rotation[0];
    const y = rotation.y ?? rotation[1];
    const z = rotation.z ?? rotation[2];
    const w = rotation.w ?? rotation[3];
    const sx = scale.x ?? scale[0];
    const sy = scale.y ?? scale[1];
    const sz = scale.z ?? scale[2];
    const tx = translation.x ?? translation[0];
    const ty = translation.y ?? translation[1];
    const tz = translation.z ?? translation[2];
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    return [
        (1 - 2 * (yy + zz)) * sx, (2 * (xy + wz)) * sx, (2 * (xz - wy)) * sx, 0,
        (2 * (xy - wz)) * sy, (1 - 2 * (xx + zz)) * sy, (2 * (yz + wx)) * sy, 0,
        (2 * (xz + wy)) * sz, (2 * (yz - wx)) * sz, (1 - 2 * (xx + yy)) * sz, 0,
        tx, ty, tz, 1,
    ];
}

/** Inverse of a rigid column-major transform (transpose rotation, negated translation). */
export function invertRigidMat4(matrix) {
    const result = [
        matrix[0], matrix[4], matrix[8], 0,
        matrix[1], matrix[5], matrix[9], 0,
        matrix[2], matrix[6], matrix[10], 0,
        0, 0, 0, 1,
    ];
    const tx = matrix[12];
    const ty = matrix[13];
    const tz = matrix[14];
    result[12] = -(result[0] * tx + result[4] * ty + result[8] * tz);
    result[13] = -(result[1] * tx + result[5] * ty + result[9] * tz);
    result[14] = -(result[2] * tx + result[6] * ty + result[10] * tz);
    return result;
}

/** Point is `{x,y,z}` or `[x,y,z]`. Returns `{x,y,z}`. */
export function transformPointMat4(matrix, point) {
    const x = point.x ?? point[0];
    const y = point.y ?? point[1];
    const z = point.z ?? point[2];
    return {
        x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    };
}

/**
 * Shepperd extraction from a column-major rotation, then a `w < 0` sign flip
 * so pose snapshots pick one hemisphere.
 */
export function quaternionFromRotationMatrix(matrix) {
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
    if (w < 0) return { x: -x, y: -y, z: -z, w: -w };
    return { x, y, z, w };
}
