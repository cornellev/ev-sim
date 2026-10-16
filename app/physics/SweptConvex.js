/** Continuous 3D SAT for a translating yaw-oriented box against a static convex mesh. */

import { cross3a as cross, dot3a as dot, sub3a as subtract } from "../math/linalg.js";

const EPSILON = 1e-12;

function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function canonicalAxis(axis) {
    const length = Math.hypot(...axis);
    if (length <= EPSILON) return null;
    const normalized = axis.map((value) => value / length);
    const first = normalized.find((value) => Math.abs(value) > EPSILON) ?? 0;
    const directed = first < 0 ? normalized.map((value) => -value) : normalized;
    return directed.map((value) => Math.round(value * 1e12) / 1e12);
}

function axesFor(vertices, triangles, edgeAxes) {
    const axes = [...edgeAxes];
    const edges = new Map();
    for (const triangle of triangles) {
        const points = triangle.map((index) => vertices[index]);
        axes.push(cross(subtract(points[1], points[0]), subtract(points[2], points[0])));
        for (let offset = 0; offset < 3; offset += 1) {
            const a = triangle[offset];
            const b = triangle[(offset + 1) % 3];
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (!edges.has(key)) edges.set(key, subtract(vertices[b], vertices[a]));
        }
    }
    for (const edge of [...edges.entries()].sort(([a], [b]) => a.localeCompare(b)).map((entry) => entry[1])) {
        for (const boxAxis of edgeAxes) axes.push(cross(boxAxis, edge));
    }
    const unique = new Map();
    for (const value of axes) {
        const axis = canonicalAxis(value);
        if (axis) unique.set(axis.join(","), axis);
    }
    return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map((entry) => entry[1]);
}

function sweptBounds(start, end, half) {
    return {
        min: { x: Math.min(start.x, end.x) - half.x, y: Math.min(start.y, end.y) - half.y, z: Math.min(start.z, end.z) - half.z },
        max: { x: Math.max(start.x, end.x) + half.x, y: Math.max(start.y, end.y) + half.y, z: Math.max(start.z, end.z) + half.z },
    };
}

function intersects(left, right) {
    return left.min.x <= right.max.x && left.max.x >= right.min.x
        && left.min.y <= right.max.y && left.max.y >= right.min.y
        && left.min.z <= right.max.z && left.max.z >= right.min.z;
}

function normalizeBox(box) {
    const half = box?.half ?? {};
    const center = box?.center ?? {};
    return {
        half: { x: finite(half.x), y: finite(half.y), z: finite(half.z) },
        center: { x: finite(center.x), y: finite(center.y), z: finite(center.z) },
        yaw: finite(box?.yaw),
    };
}

/** Local +X is length, local +Z is width. Yaw matches `vehicleGroundFootprint`. */
function boxFrame(yaw) {
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    return {
        x: [cosine, 0, -sine],
        y: [0, 1, 0],
        z: [sine, 0, cosine],
    };
}

function orientedCenter(origin, box) {
    const frame = boxFrame(box.yaw);
    return [
        origin.x + box.center.x * frame.x[0] + box.center.y * frame.y[0] + box.center.z * frame.z[0],
        origin.y + box.center.x * frame.x[1] + box.center.y * frame.y[1] + box.center.z * frame.z[1],
        origin.z + box.center.x * frame.x[2] + box.center.y * frame.y[2] + box.center.z * frame.z[2],
    ];
}

function supportRadius(axis, box) {
    const frame = boxFrame(box.yaw);
    return Math.abs(dot(axis, frame.x)) * box.half.x
        + Math.abs(dot(axis, frame.y)) * box.half.y
        + Math.abs(dot(axis, frame.z)) * box.half.z;
}

function worldHalfExtents(box) {
    return {
        x: supportRadius([1, 0, 0], box),
        y: supportRadius([0, 1, 0], box),
        z: supportRadius([0, 0, 1], box),
    };
}

export function orientedBoxCenter(origin, box) {
    const center = orientedCenter(origin, normalizeBox(box));
    return { x: center[0], y: center[1], z: center[2] };
}

export function boxSupportRadius(axis, box) {
    return supportRadius(axis, normalizeBox(box));
}

/**
 * Eight-vertex convex for a yaw-oriented box. `origin` is the vehicle origin;
 * `box.center` is the local bounding-box center.
 */
export function obbAsConvex(origin, box) {
    const query = normalizeBox(box);
    const frame = boxFrame(query.yaw);
    const center = orientedCenter(origin, query);
    const vertices = [];
    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
                vertices.push([
                    center[0] + sx * query.half.x * frame.x[0] + sy * query.half.y * frame.y[0] + sz * query.half.z * frame.z[0],
                    center[1] + sx * query.half.x * frame.x[1] + sy * query.half.y * frame.y[1] + sz * query.half.z * frame.z[1],
                    center[2] + sx * query.half.x * frame.x[2] + sy * query.half.y * frame.y[2] + sz * query.half.z * frame.z[2],
                ]);
            }
        }
    }
    const triangles = [
        [0, 1, 3], [0, 3, 2],
        [4, 6, 7], [4, 7, 5],
        [0, 4, 5], [0, 5, 1],
        [2, 3, 7], [2, 7, 6],
        [0, 2, 6], [0, 6, 4],
        [1, 5, 7], [1, 7, 3],
    ];
    const half = worldHalfExtents(query);
    return {
        vertices,
        triangles,
        bounds: {
            min: { x: center[0] - half.x, y: center[1] - half.y, z: center[2] - half.z },
            max: { x: center[0] + half.x, y: center[1] + half.y, z: center[2] + half.z },
        },
    };
}

/**
 * First impact in [0, 1] of a translating oriented box, or null on a miss.
 * Yaw and center stay constant for the step. A zero-yaw, zero-center box
 * matches the historical AABB sweep.
 * @param {{ x: number, y: number, z: number }} originStart
 * @param {{ x: number, y: number, z: number }} originEnd
 * @param {{ half: { x: number, y: number, z: number }, center?: { x: number, y: number, z: number }, yaw?: number }} box
 * @param {{ vertices: number[][], triangles: number[][], bounds?: object }} convex
 */
export function sweepObbConvex(originStart, originEnd, box, convex) {
    const vertices = convex?.vertices;
    const triangles = convex?.triangles;
    if (!Array.isArray(vertices) || !Array.isArray(triangles) || vertices.length < 4 || triangles.length === 0) {
        throw new TypeError("Swept convex collision requires indexed convex geometry.");
    }
    const query = normalizeBox(box);
    const start = orientedCenter(originStart, query);
    const end = orientedCenter(originEnd, query);
    const extent = worldHalfExtents(query);
    const targetBounds = convex.bounds ?? {
        min: { x: Math.min(...vertices.map((point) => point[0])), y: Math.min(...vertices.map((point) => point[1])), z: Math.min(...vertices.map((point) => point[2])) },
        max: { x: Math.max(...vertices.map((point) => point[0])), y: Math.max(...vertices.map((point) => point[1])), z: Math.max(...vertices.map((point) => point[2])) },
    };
    if (!intersects(
        sweptBounds({ x: start[0], y: start[1], z: start[2] }, { x: end[0], y: end[1], z: end[2] }, extent),
        targetBounds,
    )) return null;
    const delta = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const frame = boxFrame(query.yaw);
    let entry = -Infinity;
    let exit = Infinity;
    for (const axis of axesFor(vertices, triangles, [frame.x, frame.y, frame.z])) {
        const projections = vertices.map((point) => dot(point, axis));
        const targetMin = Math.min(...projections);
        const targetMax = Math.max(...projections);
        const center = dot(start, axis);
        const velocity = dot(delta, axis);
        const radius = supportRadius(axis, query);
        if (Math.abs(velocity) <= EPSILON) {
            if (center + radius < targetMin || center - radius > targetMax) return null;
            continue;
        }
        const first = (targetMin - (center + radius)) / velocity;
        const second = (targetMax - (center - radius)) / velocity;
        entry = Math.max(entry, Math.min(first, second));
        exit = Math.min(exit, Math.max(first, second));
        if (entry > exit) return null;
    }
    if (exit < 0 || entry > 1) return null;
    return Math.max(0, entry);
}

export function sweepAabbConvex(start, end, half, convex) {
    return sweepObbConvex(start, end, { half, center: { x: 0, y: 0, z: 0 }, yaw: 0 }, convex);
}
