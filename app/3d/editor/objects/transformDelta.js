/**
 * World-space transform deltas for editor gestures and commands.
 *
 * A delta is a column-major 4×4 affine matrix (the same layout as
 * `THREE.Matrix4.elements`) wrapped as `{ matrix: number[16] }`. Transform
 * bindings plan document changes from a delta without importing Three, so the
 * math here is plain arrays and stays kernel-safe. Frames are the group pivot
 * component `{ position, rotationY, scale }`: translation, yaw in radians, and
 * a uniform scale.
 */

import { finite, isPlainObject } from "./ObjectOptions.js";

export const TRANSFORM_ISSUE_CODES = Object.freeze({
    NOT_TRANSFORMABLE: "transform.not-transformable",
    LOCKED: "transform.locked",
    SCALE_UNSUPPORTED: "transform.scale.unsupported",
    NON_UNIFORM_SCALE: "transform.scale.non-uniform",
    ROTATION_UNSUPPORTED: "transform.rotation.unsupported",
    MISSING: "transform.object.missing",
});

export const DELTA_EPSILON = 1e-9;

const IDENTITY_ELEMENTS = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export const IDENTITY_DELTA = Object.freeze({ matrix: IDENTITY_ELEMENTS });

export const IDENTITY_FRAME = Object.freeze({
    position: Object.freeze({ x: 0, y: 0, z: 0 }),
    rotationY: 0,
    scale: 1,
});

/**
 * Accept `{ matrix }`, a bare 16-element array, or anything exposing a
 * 16-element `elements` array (a `THREE.Matrix4`). Returns a frozen delta.
 */
export function normalizeDelta(input) {
    let elements = null;
    if (Array.isArray(input) && input.length === 16) elements = input;
    else if (isPlainObject(input) && Array.isArray(input.matrix) && input.matrix.length === 16) elements = input.matrix;
    else if (input && Array.isArray(input.elements) && input.elements.length === 16) elements = input.elements;
    else if (input && input.matrix && Array.isArray(input.matrix.elements) && input.matrix.elements.length === 16) {
        elements = input.matrix.elements;
    }
    if (!elements) throw new TypeError("A transform delta requires a 16-element column-major matrix.");
    const matrix = elements.map((value) => {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new TypeError("Transform delta matrices must contain finite numbers.");
        return number;
    });
    return Object.freeze({ matrix: Object.freeze(matrix) });
}

export function isDelta(value) {
    return isPlainObject(value) && Array.isArray(value.matrix) && value.matrix.length === 16;
}

export function isIdentityDelta(delta, epsilon = DELTA_EPSILON) {
    const { matrix } = normalizeDelta(delta);
    return matrix.every((value, index) => Math.abs(value - IDENTITY_ELEMENTS[index]) <= epsilon);
}

export function deltaFromTranslation({ x = 0, y = 0, z = 0 } = {}) {
    return normalizeDelta([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, finite(x, 0), finite(y, 0), finite(z, 0), 1]);
}

/** Yaw about the +Y axis through `pivot`. */
export function deltaFromYaw(rotationY, pivot = { x: 0, y: 0, z: 0 }) {
    const c = Math.cos(finite(rotationY, 0));
    const s = Math.sin(finite(rotationY, 0));
    const px = finite(pivot?.x, 0);
    const pz = finite(pivot?.z, 0);
    // R = [ c 0 s ; 0 1 0 ; -s 0 c ] (row-major), translation = p - R·p.
    const tx = px - (c * px + s * pz);
    const tz = pz - (-s * px + c * pz);
    return normalizeDelta([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, 0, tz, 1]);
}

/** Uniform or per-axis scale about `pivot`. */
export function deltaFromScale(scale, pivot = { x: 0, y: 0, z: 0 }) {
    const sx = finite(isPlainObject(scale) ? scale.x : scale, 1);
    const sy = finite(isPlainObject(scale) ? scale.y : scale, 1);
    const sz = finite(isPlainObject(scale) ? scale.z : scale, 1);
    const px = finite(pivot?.x, 0);
    const py = finite(pivot?.y, 0);
    const pz = finite(pivot?.z, 0);
    return normalizeDelta([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, px - sx * px, py - sy * py, pz - sz * pz, 1]);
}

export function multiplyDeltas(outer, inner) {
    const a = normalizeDelta(outer).matrix;
    const b = normalizeDelta(inner).matrix;
    const out = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
            let sum = 0;
            for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
            out[column * 4 + row] = sum;
        }
    }
    return normalizeDelta(out);
}

/** Apply `inner` first, then `outer`: the composed delta is outer · inner. */
export function composeDeltas(outer, inner) {
    return multiplyDeltas(outer, inner);
}

export function invertDelta(delta) {
    const m = normalizeDelta(delta).matrix;
    const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = m;
    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if (Math.abs(det) <= DELTA_EPSILON) throw new RangeError("Transform delta is singular and cannot be inverted.");
    const d = 1 / det;
    const out = new Array(16);
    out[0] = t11 * d;
    out[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d;
    out[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d;
    out[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d;
    out[4] = t12 * d;
    out[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d;
    out[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d;
    out[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d;
    out[8] = t13 * d;
    out[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d;
    out[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d;
    out[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d;
    out[12] = t14 * d;
    out[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d;
    out[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d;
    out[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d;
    return normalizeDelta(out);
}

export function applyDeltaToPoint(delta, point) {
    const m = normalizeDelta(delta).matrix;
    const x = finite(point?.x, 0);
    const y = finite(point?.y, 0);
    const z = finite(point?.z, 0);
    return {
        x: m[0] * x + m[4] * y + m[8] * z + m[12],
        y: m[1] * x + m[5] * y + m[9] * z + m[13],
        z: m[2] * x + m[6] * y + m[10] * z + m[14],
    };
}

/**
 * Decompose a delta into translation, yaw, and per-axis scale. `yawOnly`
 * means the rotation leaves the Y axis fixed (no pitch or roll);
 * `uniformScale` means all three scale factors agree within `epsilon`.
 */
export function decomposeDelta(delta, epsilon = 1e-6) {
    const m = normalizeDelta(delta).matrix;
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const safe = (value) => (value > DELTA_EPSILON ? value : 1);
    // Rotation columns with scale removed.
    const r00 = m[0] / safe(sx);
    const r10 = m[1] / safe(sx);
    const r01 = m[4] / safe(sy);
    const r11 = m[5] / safe(sy);
    const r21 = m[6] / safe(sy);
    const r02 = m[8] / safe(sz);
    const r12 = m[9] / safe(sz);
    const yawOnly = Math.abs(r11 - 1) <= epsilon
        && Math.abs(r01) <= epsilon && Math.abs(r21) <= epsilon
        && Math.abs(r10) <= epsilon && Math.abs(r12) <= epsilon;
    // Yaw about +Y: R = [ c 0 s ; 0 1 0 ; -s 0 c ] so m[8] holds sin and m[0] cos.
    const rotationY = Math.atan2(r02, r00);
    const uniformScale = Math.abs(sx - sy) <= epsilon && Math.abs(sy - sz) <= epsilon;
    return {
        translation: { x: m[12], y: m[13], z: m[14] },
        rotationY,
        scale: { x: sx, y: sy, z: sz },
        uniformScale,
        yawOnly,
        hasRotation: Math.abs(rotationY) > epsilon || !yawOnly,
        hasScale: Math.abs(sx - 1) > epsilon || Math.abs(sy - 1) > epsilon || Math.abs(sz - 1) > epsilon,
        hasTranslation: Math.abs(m[12]) > epsilon || Math.abs(m[13]) > epsilon || Math.abs(m[14]) > epsilon,
    };
}

export function normalizeFrame(frame) {
    const source = isPlainObject(frame) ? frame : {};
    const position = isPlainObject(source.position) ? source.position : {};
    return {
        position: { x: finite(position.x, 0), y: finite(position.y, 0), z: finite(position.z, 0) },
        rotationY: finite(source.rotationY, 0),
        scale: finite(source.scale, 1),
    };
}

/** Matrix of a frame: T(position) · R_y(rotationY) · S(scale). */
export function deltaFromFrame(frame) {
    const { position, rotationY, scale } = normalizeFrame(frame);
    const c = Math.cos(rotationY);
    const s = Math.sin(rotationY);
    return normalizeDelta([
        c * scale, 0, -s * scale, 0,
        0, scale, 0, 0,
        s * scale, 0, c * scale, 0,
        position.x, position.y, position.z, 1,
    ]);
}

/** World delta that carries `fromFrame` onto `toFrame`. */
export function deltaBetweenFrames(fromFrame, toFrame) {
    return multiplyDeltas(deltaFromFrame(toFrame), invertDelta(deltaFromFrame(fromFrame)));
}

/**
 * Compose a world delta into a frame. The result is exact for yaw-only,
 * uniform deltas; other deltas project onto the nearest yaw + uniform scale.
 */
export function applyDeltaToFrame(delta, frame) {
    const composed = multiplyDeltas(delta, deltaFromFrame(frame));
    const parts = decomposeDelta(composed);
    return {
        position: { ...parts.translation },
        rotationY: parts.rotationY,
        scale: parts.scale.x,
    };
}

export function framesEqual(left, right, epsilon = 1e-9) {
    const a = normalizeFrame(left);
    const b = normalizeFrame(right);
    return Math.abs(a.position.x - b.position.x) <= epsilon
        && Math.abs(a.position.y - b.position.y) <= epsilon
        && Math.abs(a.position.z - b.position.z) <= epsilon
        && Math.abs(a.rotationY - b.rotationY) <= epsilon
        && Math.abs(a.scale - b.scale) <= epsilon;
}
