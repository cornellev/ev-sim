/** Deterministic outward convex hull for collision proxies. Kernel-safe: no DOM or Three.js. */

import { cross3a, dot3a, sub3a } from "../../math/linalg.js";
import { canonicalFiniteNumber } from "../kernel/SimulationHashes.js";

const WINDING_LIMIT = 1e-12;
const CONVEX_LIMIT = 1e-9;
const DEGENERATE_NORMAL = 1e-12;
const OUTSIDE_DISTANCE = 1e-8;
const MIN_THICKNESS = 1e-4;
const STABLE_EXTENT = 1e-3;

function hypot3(value) {
    return Math.hypot(value[0], value[1], value[2]);
}

function average3(points) {
    const center = [0, 0, 0];
    for (const point of points) {
        center[0] += point[0];
        center[1] += point[1];
        center[2] += point[2];
    }
    const scale = 1 / points.length;
    return [center[0] * scale, center[1] * scale, center[2] * scale];
}

/**
 * Geometric checks shared with world-description proxy validation.
 * Returns a reason code, or null when the mesh passes.
 * Bounds are not part of this predicate.
 */
export function proxyMeshFailure(vertices, triangles, { convex = false } = {}) {
    if (!Array.isArray(vertices) || vertices.length < (convex ? 4 : 3)) return "insufficient-vertices";
    if (!Array.isArray(triangles) || triangles.length === 0) return "no-triangles";
    for (const point of vertices) {
        if (!Array.isArray(point) || point.length !== 3 || point.some((value) => !Number.isFinite(value))) return "invalid-vertex";
    }
    const center = average3(vertices);
    for (const triangle of triangles) {
        if (!Array.isArray(triangle) || triangle.length !== 3 || new Set(triangle).size !== 3 || triangle.some((index) => !Number.isInteger(index) || index < 0 || index >= vertices.length)) {
            return "invalid-indices";
        }
        const a = vertices[triangle[0]];
        const b = vertices[triangle[1]];
        const c = vertices[triangle[2]];
        const normal = cross3a(sub3a(b, a), sub3a(c, a));
        if (hypot3(normal) <= DEGENERATE_NORMAL) return "degenerate-face";
        if (!convex) continue;
        const faceCenter = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        if (dot3a(normal, sub3a(faceCenter, center)) <= WINDING_LIMIT) return "inconsistent-winding";
        for (const point of vertices) {
            if (dot3a(normal, sub3a(point, a)) > CONVEX_LIMIT) return "not-convex";
        }
    }
    return null;
}

function comparePoints(left, right) {
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function canonicalizePoints(vertices) {
    if (!Array.isArray(vertices) || vertices.length === 0) throw new TypeError("Convex hull requires vertices.");
    const unique = new Map();
    for (const vertex of vertices) {
        if (!Array.isArray(vertex) || vertex.length !== 3 || vertex.some((value) => !Number.isFinite(value))) {
            throw new TypeError("Convex hull requires finite xyz vertices.");
        }
        const point = [canonicalFiniteNumber(vertex[0]), canonicalFiniteNumber(vertex[1]), canonicalFiniteNumber(vertex[2])];
        unique.set(point.join(","), point);
    }
    return [...unique.values()].sort(comparePoints);
}

function extentsOf(points) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const point of points) {
        for (let axis = 0; axis < 3; axis += 1) {
            if (point[axis] < min[axis]) min[axis] = point[axis];
            if (point[axis] > max[axis]) max[axis] = point[axis];
        }
    }
    const extents = min.map((value, axis) => max[axis] - value);
    return { extents, longest: Math.max(...extents, 0) };
}

function thinnestAxis(extents) {
    const preference = [1, 0, 2];
    let axis = preference[0];
    for (const candidate of preference) {
        if (extents[candidate] < extents[axis]) axis = candidate;
    }
    return axis;
}

function thicknessFor(longest, minExtent) {
    const planned = Math.max(MIN_THICKNESS, longest * 1e-4);
    if (minExtent < STABLE_EXTENT && longest <= STABLE_EXTENT) return Math.max(planned, STABLE_EXTENT - minExtent);
    return planned;
}

function thicken(points) {
    const { extents, longest } = extentsOf(points);
    const offset = canonicalFiniteNumber(thicknessFor(longest, Math.min(...extents)));
    const axis = thinnestAxis(extents);
    const shifted = points.map((point) => {
        const next = point.slice();
        next[axis] = canonicalFiniteNumber(point[axis] + offset);
        return next;
    });
    return canonicalizePoints([...points, ...shifted]);
}

function faceNormal(points, indices) {
    const a = points[indices[0]];
    const b = points[indices[1]];
    const c = points[indices[2]];
    return cross3a(sub3a(b, a), sub3a(c, a));
}

function signedDistance(points, indices, point) {
    const normal = faceNormal(points, indices);
    const length = hypot3(normal);
    if (!(length > DEGENERATE_NORMAL)) return 0;
    return dot3a(normal, sub3a(point, points[indices[0]])) / length;
}

function pointInTriangle(point, a, b, c) {
    const v0 = sub3a(c, a);
    const v1 = sub3a(b, a);
    const v2 = sub3a(point, a);
    const dot00 = dot3a(v0, v0);
    const dot01 = dot3a(v0, v1);
    const dot02 = dot3a(v0, v2);
    const dot11 = dot3a(v1, v1);
    const dot12 = dot3a(v1, v2);
    const denom = dot00 * dot11 - dot01 * dot01;
    if (Math.abs(denom) <= 1e-24) return true;
    const u = (dot11 * dot02 - dot01 * dot12) / denom;
    const v = (dot00 * dot12 - dot01 * dot02) / denom;
    return u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8;
}

function conflictScore(points, face, pointIndex) {
    const distance = signedDistance(points, face.indices, points[pointIndex]);
    if (distance > OUTSIDE_DISTANCE) return distance;
    const [a, b, c] = face.indices;
    if (Math.abs(distance) <= OUTSIDE_DISTANCE && !pointInTriangle(points[pointIndex], points[a], points[b], points[c])) return OUTSIDE_DISTANCE;
    return null;
}

function orientOutward(points, indices, interior) {
    const normal = faceNormal(points, indices);
    if (dot3a(normal, sub3a(interior, points[indices[0]])) > 0) return [indices[0], indices[2], indices[1]];
    return indices.slice();
}

function findSimplex(points) {
    if (points.length < 4) return null;
    const origin = 0;
    let farthest = -1;
    let best = 0;
    for (let index = 1; index < points.length; index += 1) {
        const delta = sub3a(points[index], points[origin]);
        const score = dot3a(delta, delta);
        if (score > best) {
            best = score;
            farthest = index;
        }
    }
    if (farthest < 0) return null;
    const line = sub3a(points[farthest], points[origin]);
    let planar = -1;
    best = 0;
    for (let index = 0; index < points.length; index += 1) {
        if (index === origin || index === farthest) continue;
        const area = cross3a(line, sub3a(points[index], points[origin]));
        const score = dot3a(area, area);
        if (score > best) {
            best = score;
            planar = index;
        }
    }
    if (planar < 0) return null;
    const normal = cross3a(sub3a(points[farthest], points[origin]), sub3a(points[planar], points[origin]));
    const normalLength = hypot3(normal);
    if (!(normalLength > DEGENERATE_NORMAL)) return null;
    let volumePoint = -1;
    best = 0;
    for (let index = 0; index < points.length; index += 1) {
        if (index === origin || index === farthest || index === planar) continue;
        const height = Math.abs(dot3a(normal, sub3a(points[index], points[origin]))) / normalLength;
        if (height > best) {
            best = height;
            volumePoint = index;
        }
    }
    const { longest } = extentsOf(points);
    if (volumePoint < 0 || !(best > Math.max(1e-8, longest * 1e-8))) return null;
    return [origin, farthest, planar, volumePoint];
}

function assignPoint(points, faces, pointIndex) {
    let bestFace = -1;
    let bestScore = 0;
    for (let index = 0; index < faces.length; index += 1) {
        const score = conflictScore(points, faces[index], pointIndex);
        if (score === null) continue;
        if (bestFace < 0 || score > bestScore) {
            bestFace = index;
            bestScore = score;
        }
    }
    if (bestFace >= 0) faces[bestFace].outside.push(pointIndex);
}

function tryHull(points) {
    const simplex = findSimplex(points);
    if (!simplex) return null;
    const interior = average3(simplex.map((index) => points[index]));
    const claimed = new Set(simplex);
    let faces = [
        [simplex[0], simplex[1], simplex[2]],
        [simplex[0], simplex[1], simplex[3]],
        [simplex[0], simplex[2], simplex[3]],
        [simplex[1], simplex[2], simplex[3]],
    ].map((indices) => ({ indices: orientOutward(points, indices, interior), outside: [] }));
    for (let index = 0; index < points.length; index += 1) {
        if (!claimed.has(index)) assignPoint(points, faces, index);
    }
    let guard = points.length + 1;
    while (guard > 0) {
        guard -= 1;
        const faceIndex = faces.findIndex((face) => face.outside.length > 0);
        if (faceIndex < 0) break;
        const pool = faces[faceIndex].outside;
        let pointIndex = pool[0];
        let bestDistance = -Infinity;
        for (const candidate of pool) {
            const distance = signedDistance(points, faces[faceIndex].indices, points[candidate]);
            if (distance > bestDistance || (distance === bestDistance && candidate < pointIndex)) {
                bestDistance = distance;
                pointIndex = candidate;
            }
        }
        for (const face of faces) face.outside = face.outside.filter((index) => index !== pointIndex);
        if (claimed.has(pointIndex)) continue;
        const visible = [];
        for (let index = 0; index < faces.length; index += 1) {
            if (conflictScore(points, faces[index], pointIndex) !== null) visible.push(index);
        }
        if (!visible.includes(faceIndex)) visible.push(faceIndex);
        const visibleSet = new Set(visible);
        const edgeCount = new Map();
        for (const index of visible) {
            const [a, b, c] = faces[index].indices;
            for (const [u, v] of [[a, b], [b, c], [c, a]]) {
                const key = u < v ? `${u},${v}` : `${v},${u}`;
                edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
            }
        }
        const horizon = [...edgeCount.entries()].filter((entry) => entry[1] === 1).map(([key]) => key.split(",").map(Number));
        if (horizon.length === 0) {
            claimed.add(pointIndex);
            continue;
        }
        const orphans = [...new Set(visible.flatMap((index) => faces[index].outside))];
        faces = faces.filter((_, index) => !visibleSet.has(index));
        claimed.add(pointIndex);
        for (const [a, b] of horizon) {
            const area = faceNormal(points, [a, b, pointIndex]);
            if (dot3a(area, area) <= 1e-24) continue;
            faces.push({ indices: orientOutward(points, [a, b, pointIndex], interior), outside: [] });
        }
        for (const orphan of orphans) {
            if (!claimed.has(orphan)) assignPoint(points, faces, orphan);
        }
    }
    if (faces.some((face) => face.outside.length > 0)) throw new TypeError("Convex hull did not converge.");
    return meshFromFaces(points, faces.map((face) => face.indices));
}

function meshFromFaces(points, faces) {
    const used = [...new Set(faces.flat())].sort((left, right) => comparePoints(points[left], points[right]));
    const remap = new Map(used.map((index, order) => [index, order]));
    const vertices = used.map((index) => points[index].slice());
    const seen = new Set();
    const triangles = [];
    for (const face of faces) {
        const tri = face.map((index) => remap.get(index));
        if (new Set(tri).size !== 3) continue;
        const minAt = tri.indexOf(Math.min(...tri));
        const ordered = [tri[minAt], tri[(minAt + 1) % 3], tri[(minAt + 2) % 3]];
        const key = ordered.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        triangles.push(ordered);
    }
    triangles.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
    if (triangles.length === 0) return null;
    return { vertices, triangles };
}

function canThicken(points) {
    const { extents, longest } = extentsOf(points);
    return Math.min(...extents) < STABLE_EXTENT && longest <= STABLE_EXTENT;
}

export function buildOutwardConvexMesh(vertices) {
    let points = canonicalizePoints(vertices);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const mesh = tryHull(points);
        if (mesh && proxyMeshFailure(mesh.vertices, mesh.triangles, { convex: true }) === null) return mesh;
        if (mesh && !canThicken(points)) {
            const failure = proxyMeshFailure(mesh.vertices, mesh.triangles, { convex: true });
            throw new TypeError(`Convex hull produced a mesh that is ${failure}.`);
        }
        points = thicken(points);
    }
    throw new TypeError("Convex hull could not produce an outward convex mesh.");
}
