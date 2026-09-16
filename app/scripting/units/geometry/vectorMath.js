import {
    finiteFloat,
    finiteResult,
    normalizeVec2,
    normalizeVec3,
} from "../../types/PortTypes.js";

export const ZERO_VEC2 = Object.freeze({ x: 0, y: 0 });
export const ZERO_VEC3 = Object.freeze({ x: 0, y: 0, z: 0 });

function vec2(x, y) {
    return { x: finiteResult(x), y: finiteResult(y) };
}

function vec3(x, y, z) {
    return { x: finiteResult(x), y: finiteResult(y), z: finiteResult(z) };
}

export function addVec2(a, b) {
    const left = normalizeVec2(a);
    const right = normalizeVec2(b);
    return vec2(left.x + right.x, left.y + right.y);
}

export function subtractVec2(a, b) {
    const left = normalizeVec2(a);
    const right = normalizeVec2(b);
    return vec2(left.x - right.x, left.y - right.y);
}

export function scaleVec2(value, scalar) {
    const vector = normalizeVec2(value);
    const factor = finiteFloat(scalar);
    return vec2(vector.x * factor, vector.y * factor);
}

export function dotVec2(a, b) {
    const left = normalizeVec2(a);
    const right = normalizeVec2(b);
    return finiteResult(left.x * right.x + left.y * right.y);
}

export function lengthVec2(value) {
    const vector = normalizeVec2(value);
    return finiteResult(Math.hypot(vector.x, vector.y));
}

export function unitVec2(value) {
    const vector = normalizeVec2(value);
    const length = lengthVec2(vector);
    if (length === 0) return { ...ZERO_VEC2 };
    return vec2(vector.x / length, vector.y / length);
}

export function distanceVec2(a, b) {
    return lengthVec2(subtractVec2(a, b));
}

export function addVec3(a, b) {
    const left = normalizeVec3(a);
    const right = normalizeVec3(b);
    return vec3(left.x + right.x, left.y + right.y, left.z + right.z);
}

export function subtractVec3(a, b) {
    const left = normalizeVec3(a);
    const right = normalizeVec3(b);
    return vec3(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function scaleVec3(value, scalar) {
    const vector = normalizeVec3(value);
    const factor = finiteFloat(scalar);
    return vec3(vector.x * factor, vector.y * factor, vector.z * factor);
}

export function dotVec3(a, b) {
    const left = normalizeVec3(a);
    const right = normalizeVec3(b);
    return finiteResult(left.x * right.x + left.y * right.y + left.z * right.z);
}

export function lengthVec3(value) {
    const vector = normalizeVec3(value);
    return finiteResult(Math.hypot(vector.x, vector.y, vector.z));
}

export function unitVec3(value) {
    const vector = normalizeVec3(value);
    const length = lengthVec3(vector);
    if (length === 0) return { ...ZERO_VEC3 };
    return vec3(vector.x / length, vector.y / length, vector.z / length);
}

export function distanceVec3(a, b) {
    return lengthVec3(subtractVec3(a, b));
}

export function crossVec3(a, b) {
    const left = normalizeVec3(a);
    const right = normalizeVec3(b);
    return vec3(
        left.y * right.z - left.z * right.y,
        left.z * right.x - left.x * right.z,
        left.x * right.y - left.y * right.x,
    );
}
