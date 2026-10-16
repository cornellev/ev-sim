/**
 * Orbit poses and axis-gizmo projection for the vehicle studio.
 * Vehicle frame: +X forward, +Y up, +Z left.
 * No DOM or WebGL.
 */

import { rotateVectorByQuaternion, quaternionInverse } from "../../autonomy/CoordinateFrames.js";
import {
    add3,
    clamp,
    clamp01,
    cross3,
    dot3,
    lerp3,
    normalize3,
    quaternionFromRotationMatrix,
    scale3,
    sub3,
} from "../../math/linalg.js";

/** Free-orbit limit already used by the studio. Bottom alignment opens this to π. */
export const ORBIT_FREE_POLAR_ANGLE = Math.PI * 0.52;

/** Duration of an axis alignment, in milliseconds. */
export const ORBIT_ALIGN_MS = 250;

/** One degree keeps a top or bottom view off the orbit pole. */
const POLE_OFFSET = Math.PI / 180;

export const AXIS_GIZMO_SIZE = 80;
export const AXIS_GIZMO_ARM = 26;
export const AXIS_GIZMO_HIT = 12;

const WORLD_UP = Object.freeze({ x: 0, y: 1, z: 0 });

export const ORBIT_ALIGN_AXES = Object.freeze([
    Object.freeze({ id: "+x", name: "front", label: "Align camera to front (+X)" }),
    Object.freeze({ id: "-x", name: "back", label: "Align camera to back (−X)" }),
    Object.freeze({ id: "+y", name: "top", label: "Align camera to top (+Y)" }),
    Object.freeze({ id: "-y", name: "bottom", label: "Align camera to bottom (−Y)" }),
    Object.freeze({ id: "+z", name: "left", label: "Align camera to left (+Z)" }),
    Object.freeze({ id: "-z", name: "right", label: "Align camera to right (−Z)" }),
]);

const AXIS_BY_ID = new Map(ORBIT_ALIGN_AXES.map((axis) => [axis.id, axis]));

export function orbitAlignAxis(id) {
    return AXIS_BY_ID.get(id) ?? null;
}

/**
 * Camera pose that looks at `target` from `axis`, keeping `distance`.
 * Top is offset one degree toward −X so +X is up the screen.
 * Bottom is offset one degree toward +X for the same reason, and opens the polar limit.
 * @returns {{ position: {x,y,z}, up: {x,y,z}, maxPolarAngle: number } | null}
 */
export function orbitPoseForAxis({ axis, target = { x: 0, y: 0, z: 0 }, distance = 1 } = {}) {
    const direction = viewDirection(axis);
    if (!direction) return null;
    const span = Number.isFinite(distance) && distance > 0 ? distance : 1;
    return {
        position: add3(target, scale3(direction, span)),
        up: { x: WORLD_UP.x, y: WORLD_UP.y, z: WORLD_UP.z },
        maxPolarAngle: axis === "-y" ? Math.PI : ORBIT_FREE_POLAR_ANGLE,
    };
}

/** Smoothstep over `ORBIT_ALIGN_MS`. `t` of 0 is the start and 1 is the end. */
export function alignProgress(elapsedMs, durationMs = ORBIT_ALIGN_MS) {
    const t = clamp01(Number(elapsedMs) / durationMs);
    return t * t * (3 - 2 * t);
}

/** Unit-direction slerp. Opposite directions turn through +Y, or +X when `from` is vertical. */
export function slerpDirection(from, to, t) {
    const start = normalize3(from, 1e-8, null);
    const end = normalize3(to, 1e-8, null);
    if (!start) return end ?? { x: 0, y: 1, z: 0 };
    if (!end) return start;
    const amount = clamp01(t);
    if (amount === 0) return start;
    if (amount === 1) return end;
    const cosine = clamp(dot3(start, end), -1, 1);
    if (cosine > 0.9995) return normalize3(lerp3(start, end, amount));
    if (cosine < -0.9995) {
        const preferred = Math.abs(start.y) < 0.9 ? WORLD_UP : { x: 1, y: 0, z: 0 };
        const perpendicular = normalize3(sub3(preferred, scale3(start, dot3(start, preferred))));
        const angle = Math.PI * amount;
        return add3(scale3(start, Math.cos(angle)), scale3(perpendicular, Math.sin(angle)));
    }
    const theta = Math.acos(cosine) * amount;
    const orthogonal = normalize3(sub3(end, scale3(start, cosine)));
    return add3(scale3(start, Math.cos(theta)), scale3(orthogonal, Math.sin(theta)));
}

/**
 * Camera quaternion matching Three.js `Object3D.lookAt` for a Y-up orbit pose.
 * Rotates camera-local vectors into world space.
 */
export function quaternionFromLookAt(eye, target, up = WORLD_UP) {
    const basis = lookAtBasis(eye, target, up);
    return quaternionFromRotationMatrix([
        basis.right.x, basis.right.y, basis.right.z, 0,
        basis.up.x, basis.up.y, basis.up.z, 0,
        basis.back.x, basis.back.y, basis.back.z, 0,
        0, 0, 0, 1,
    ]);
}

/**
 * Six axis endpoints in camera space.
 * `x` is screen right, `y` is screen up, and a larger `depth` is closer to the camera.
 * @param {{x:number,y:number,z:number,w:number}} quaternion
 */
export function projectAxisGizmo(quaternion) {
    const inverse = quaternionInverse(quaternion);
    return ORBIT_ALIGN_AXES.map((axis) => {
        const local = rotateVectorByQuaternion(axisVector(axis.id), inverse);
        return {
            id: axis.id,
            name: axis.name,
            x: local.x,
            y: local.y,
            depth: local.z,
        };
    });
}

/** Pixel position of an endpoint inside the gizmo view box. */
export function axisGizmoPixel(endpoint) {
    const center = AXIS_GIZMO_SIZE / 2;
    return {
        x: center + endpoint.x * AXIS_GIZMO_ARM,
        y: center - endpoint.y * AXIS_GIZMO_ARM,
    };
}

/** The nearest overlapping handle, preferring the one closer to the camera. */
export function pickAxisGizmo(endpoints, x, y, hitRadius = AXIS_GIZMO_HIT) {
    let best = null;
    for (const endpoint of endpoints) {
        const pixel = axisGizmoPixel(endpoint);
        if (Math.hypot(x - pixel.x, y - pixel.y) > hitRadius) continue;
        if (!best || endpoint.depth > best.depth) best = endpoint;
    }
    return best;
}

function axisVector(id) {
    switch (id) {
        case "+x": return { x: 1, y: 0, z: 0 };
        case "-x": return { x: -1, y: 0, z: 0 };
        case "+y": return { x: 0, y: 1, z: 0 };
        case "-y": return { x: 0, y: -1, z: 0 };
        case "+z": return { x: 0, y: 0, z: 1 };
        case "-z": return { x: 0, y: 0, z: -1 };
        default: return null;
    }
}

function viewDirection(id) {
    const vector = axisVector(id);
    if (!vector) return null;
    if (id === "+y") return { x: -Math.sin(POLE_OFFSET), y: Math.cos(POLE_OFFSET), z: 0 };
    if (id === "-y") return { x: Math.sin(POLE_OFFSET), y: -Math.cos(POLE_OFFSET), z: 0 };
    return vector;
}

function lookAtBasis(eye, target, up) {
    const back = normalize3(sub3(eye, target));
    const right = normalize3(cross3(up, back));
    return {
        right,
        up: normalize3(cross3(back, right)),
        back,
    };
}
