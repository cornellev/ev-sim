/**
 * Authored drive areas and the pavement queries shared by sampling, occupancy,
 * and start-pose checks. Kernel-safe: no DOM or Three.
 */

import { compareUtf8 } from "../../math/compareUtf8.js";
import { canonicalFiniteNumber } from "../kernel/SimulationHashes.js";
import { convexHullXZ } from "../occupancy/OracleOccupancyGrid.js";
import { vehicleGroundFootprint } from "../../scenarios/route/geometry.js";

export const DRIVE_AREA_VERSION = 1;
export const MIN_DRIVE_AREA_SIDE_M = 2;
const EPS = 1e-12;
const SIZE_EPS = 1e-6;

function finite(value, label) {
    const result = Number(value);
    if (!Number.isFinite(result)) throw new TypeError(`${label} must be finite.`);
    return canonicalFiniteNumber(result);
}

function identifier(value, label) {
    const result = String(value ?? "").trim();
    if (!result) throw new TypeError(`${label} is required.`);
    return result;
}

function orient(a, b, c) {
    return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function rangesOverlap(a0, a1, b0, b1) {
    return Math.max(Math.min(a0, a1), Math.min(b0, b1)) <= Math.min(Math.max(a0, a1), Math.max(b0, b1)) + EPS;
}

function segmentsCross(a, b, c, d) {
    const abC = orient(a, b, c);
    const abD = orient(a, b, d);
    const cdA = orient(c, d, a);
    const cdB = orient(c, d, b);
    if (Math.abs(abC) <= EPS && Math.abs(abD) <= EPS && Math.abs(cdA) <= EPS && Math.abs(cdB) <= EPS) {
        return rangesOverlap(a.x, b.x, c.x, d.x) && rangesOverlap(a.z, b.z, c.z, d.z);
    }
    return abC * abD < 0 && cdA * cdB < 0;
}

function pointInTriangle(point, a, b, c) {
    const cross = (left, middle, right) => (
        (middle.x - left.x) * (right.z - left.z) - (middle.z - left.z) * (right.x - left.x)
    );
    const area = cross(a, b, c);
    if (Math.abs(area) <= EPS) return false;
    const signs = [cross(a, b, point), cross(b, c, point), cross(c, a, point)];
    // Road strips are not all counter-clockwise. Either winding counts.
    return area > 0 ? signs.every((value) => value >= -EPS) : signs.every((value) => value <= EPS);
}

/** Deterministic ear clipping for counter-clockwise simple XZ polygons. */
export function triangulateFootprint(footprint) {
    if (footprint.length === 3) return [[0, 1, 2]];
    const remaining = footprint.map((_, index) => index);
    const triangles = [];
    while (remaining.length > 3) {
        let ear = -1;
        for (let offset = 0; offset < remaining.length; offset += 1) {
            const previous = remaining[(offset - 1 + remaining.length) % remaining.length];
            const current = remaining[offset];
            const next = remaining[(offset + 1) % remaining.length];
            const a = footprint[previous];
            const b = footprint[current];
            const c = footprint[next];
            const convex = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x) > EPS;
            if (!convex) continue;
            const contains = remaining.some((candidate) => (
                candidate !== previous && candidate !== current && candidate !== next
                && pointInTriangle(footprint[candidate], a, b, c)
            ));
            if (!contains) {
                ear = offset;
                triangles.push([previous, current, next]);
                break;
            }
        }
        // shortcut: collinear vertices are not ears; drop them before triangulating if authors need them.
        if (ear < 0) throw new TypeError("Building footprint must be a simple polygon.");
        remaining.splice(ear, 1);
    }
    triangles.push([remaining[0], remaining[1], remaining[2]]);
    return triangles;
}

/**
 * Finite XZ ring with at least three distinct vertices, nonzero area, and no
 * self-intersections. Winding is normalized counter-clockwise.
 */
export function normalizeDriveAreaFootprint(source, label = "Drive area footprint") {
    if (!Array.isArray(source) || source.length < 3) {
        throw new TypeError(`${label} must contain at least three points.`);
    }
    const points = source.map((point, index) => ({
        x: finite(point?.x, `${label} point ${index} x`),
        z: finite(point?.z, `${label} point ${index} z`),
    }));
    const seen = new Set();
    for (const point of points) {
        const key = `${point.x}:${point.z}`;
        if (seen.has(key)) throw new TypeError(`${label} repeats a vertex.`);
        seen.add(key);
    }
    if (seen.size < 3) throw new TypeError(`${label} needs at least three distinct vertices.`);
    const count = points.length;
    const onSegment = (point, start, end) => Math.abs(orient(start, end, point)) <= EPS
        && rangesOverlap(start.x, end.x, point.x, point.x)
        && rangesOverlap(start.z, end.z, point.z, point.z);
    for (let left = 0; left < count; left += 1) {
        const a = points[left];
        const b = points[(left + 1) % count];
        for (let right = left + 1; right < count; right += 1) {
            const adjacent = right === left + 1 || (left === 0 && right === count - 1);
            if (adjacent) continue;
            const c = points[right];
            const d = points[(right + 1) % count];
            if (segmentsCross(a, b, c, d)) throw new TypeError(`${label} self-intersects.`);
        }
    }
    for (let vertex = 0; vertex < count; vertex += 1) {
        for (let edge = 0; edge < count; edge += 1) {
            const next = (edge + 1) % count;
            if (edge === vertex || next === vertex) continue;
            if (onSegment(points[vertex], points[edge], points[next])) throw new TypeError(`${label} self-intersects.`);
        }
    }
    const area = points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point.x * next.z - next.x * point.z;
    }, 0) * 0.5;
    if (Math.abs(area) <= EPS) throw new TypeError(`${label} has zero area.`);
    return area > 0 ? points : [...points].reverse();
}

export function normalizeDriveAreaRecord(area, index = 0) {
    const id = identifier(area?.id, `Drive area ${index} ID`);
    const footprint = normalizeDriveAreaFootprint(area?.footprint, `Drive area "${id}" footprint`);
    return {
        id,
        y: finite(area?.y ?? 0, `Drive area "${id}" y`),
        footprint,
    };
}

export function normalizeDriveAreaList(areas) {
    if (areas === undefined || areas === null) return [];
    if (!Array.isArray(areas)) throw new TypeError("driveAreas must be an array.");
    const records = areas.map((area, index) => normalizeDriveAreaRecord(area, index));
    const seen = new Set();
    for (const record of records) {
        if (seen.has(record.id)) throw new TypeError(`Duplicate drive area ID "${record.id}".`);
        seen.add(record.id);
    }
    return records.sort((left, right) => compareUtf8(left.id, right.id));
}

function footprintExtents(footprint) {
    const bounds = footprintBounds(footprint, 0);
    return { width: bounds.max.x - bounds.min.x, depth: bounds.max.z - bounds.min.z };
}

function axisAlignedRectangle(footprint) {
    if (footprint.length !== 4) return false;
    for (let index = 0; index < footprint.length; index += 1) {
        const current = footprint[index];
        const next = footprint[(index + 1) % footprint.length];
        const dx = Math.abs(current.x - next.x);
        const dz = Math.abs(current.z - next.z);
        if ((dx <= EPS && dz <= EPS) || (dx > EPS && dz > EPS)) return false;
    }
    return true;
}

/**
 * Reject a rectangle that this edit shrinks below the draw-tool minimum.
 * Translating an already-small explicit polygon stays allowed.
 */
export function driveAreaResizeError(before, after) {
    const prior = footprintExtents(before);
    const next = footprintExtents(after);
    const changed = Math.abs(prior.width - next.width) > SIZE_EPS || Math.abs(prior.depth - next.depth) > SIZE_EPS;
    if (!changed || !axisAlignedRectangle(after)) return null;
    if (next.width < MIN_DRIVE_AREA_SIDE_M || next.depth < MIN_DRIVE_AREA_SIDE_M) {
        return `Drive area rectangles must be at least ${MIN_DRIVE_AREA_SIDE_M} m per side.`;
    }
    return null;
}

/**
 * Scale a ring about its bounds center to the requested axis-aligned size.
 * shortcut: bounds-center scale can move a concave centroid, upgrade when a vertex editor pins the start pose.
 */
export function resizeDriveAreaFootprint(footprint, size = {}) {
    const normalized = normalizeDriveAreaFootprint(footprint);
    const current = footprintExtents(normalized);
    if (!(current.width > EPS) || !(current.depth > EPS)) {
        throw new TypeError("Drive area has no extent to resize.");
    }
    const width = finite(size.width, "Drive area width");
    const depth = finite(size.depth, "Drive area depth");
    if (!(width > 0) || !(depth > 0)) throw new TypeError("Drive area size must be positive.");
    if (Math.abs(width - current.width) <= SIZE_EPS && Math.abs(depth - current.depth) <= SIZE_EPS) return normalized;
    const bounds = footprintBounds(normalized, 0);
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    const scaled = normalized.map((point) => ({
        x: cx + (point.x - cx) * (width / current.width),
        z: cz + (point.z - cz) * (depth / current.depth),
    }));
    const next = normalizeDriveAreaFootprint(scaled);
    const error = driveAreaResizeError(normalized, next);
    if (error) throw new TypeError(error);
    return next;
}

export function rectangleDriveAreaFootprint(cornerA, cornerB) {
    const a = { x: finite(cornerA?.x, "Rectangle x"), z: finite(cornerA?.z, "Rectangle z") };
    const b = { x: finite(cornerB?.x, "Rectangle x"), z: finite(cornerB?.z, "Rectangle z") };
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minZ = Math.min(a.z, b.z);
    const maxZ = Math.max(a.z, b.z);
    if (maxX - minX < MIN_DRIVE_AREA_SIDE_M || maxZ - minZ < MIN_DRIVE_AREA_SIDE_M) {
        throw new TypeError(`Drive area rectangles must be at least ${MIN_DRIVE_AREA_SIDE_M} m per side.`);
    }
    return normalizeDriveAreaFootprint([
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
    ]);
}

function footprintBounds(footprint, y) {
    return {
        min: {
            x: Math.min(...footprint.map((point) => point.x)),
            y,
            z: Math.min(...footprint.map((point) => point.z)),
        },
        max: {
            x: Math.max(...footprint.map((point) => point.x)),
            y,
            z: Math.max(...footprint.map((point) => point.z)),
        },
    };
}

export function compileDriveAreaSurface(area, index = 0) {
    const record = area?.kind === "area-polygon" ? {
        id: identifier(area.sourceId ?? area.id, `Drive area ${index} ID`),
        y: finite(area.minY ?? area.y ?? 0, `Drive area ${index} y`),
        footprint: normalizeDriveAreaFootprint(area.footprint, `Drive area ${index} footprint`),
    } : normalizeDriveAreaRecord(area, index);
    let triangles;
    try {
        triangles = triangulateFootprint(record.footprint);
    } catch (error) {
        throw new TypeError(`Drive area "${record.id}" footprint must be a simple polygon.`, { cause: error });
    }
    return {
        id: `drive-area:${record.id}`,
        sourceId: record.id,
        kind: "area-polygon",
        footprint: record.footprint.map((point) => ({ x: point.x, z: point.z })),
        triangles,
        minY: record.y,
        maxY: record.y,
        bounds: footprintBounds(record.footprint, record.y),
    };
}

export function compileDriveAreaSurfaces(areas) {
    return normalizeDriveAreaList(areas).map((area, index) => compileDriveAreaSurface(area, index));
}

export function polygonCentroidXZ(footprint) {
    let twice = 0;
    let cx = 0;
    let cz = 0;
    for (let index = 0; index < footprint.length; index += 1) {
        const current = footprint[index];
        const next = footprint[(index + 1) % footprint.length];
        const cross = current.x * next.z - next.x * current.z;
        twice += cross;
        cx += (current.x + next.x) * cross;
        cz += (current.z + next.z) * cross;
    }
    return { x: cx / (3 * twice), z: cz / (3 * twice) };
}

function polygonArea(footprint) {
    const signed = footprint.reduce((sum, point, index) => {
        const next = footprint[(index + 1) % footprint.length];
        return sum + point.x * next.z - next.x * point.z;
    }, 0) * 0.5;
    return Math.abs(signed);
}

/** Centroid, axis-aligned size, and polygon area. Invalid records fail closed. */
export function measureDriveArea(area) {
    try {
        const record = normalizeDriveAreaRecord(area);
        const centroid = polygonCentroidXZ(record.footprint);
        const bounds = footprintBounds(record.footprint, record.y);
        return {
            ok: true,
            position: { x: centroid.x, y: record.y, z: centroid.z },
            width: bounds.max.x - bounds.min.x,
            depth: bounds.max.z - bounds.min.z,
            area: polygonArea(record.footprint),
        };
    } catch {
        return {
            ok: false,
            position: { x: 0, y: 0, z: 0 },
            width: 0,
            depth: 0,
            area: 0,
        };
    }
}

export function pointInDriveAreaSurface(point, surface) {
    const x = Number(point?.x);
    const z = Number(point?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const footprint = surface?.footprint;
    const triangles = surface?.triangles;
    if (!Array.isArray(footprint) || !Array.isArray(triangles)) return false;
    const sample = { x, z };
    return triangles.some((face) => {
        const [a, b, c] = face;
        return footprint[a] && footprint[b] && footprint[c]
            && pointInTriangle(sample, footprint[a], footprint[b], footprint[c]);
    });
}

function areaSource(environment) {
    if (Array.isArray(environment?.driveAreas) || Array.isArray(environment?.drivableSurfaces)) return environment;
    if (environment?.document) return areaSource(environment.document);
    if (environment?.description) return areaSource(environment.description);
    return environment;
}

function authoredAreas(environment) {
    const source = areaSource(environment);
    if (Array.isArray(source?.driveAreas)) return source.driveAreas;
    return (source?.drivableSurfaces ?? []).filter((surface) => surface?.kind === "area-polygon");
}

export function driveAreaSurfacesFrom(environment) {
    return authoredAreas(environment).map((area, index) => (
        area?.kind === "area-polygon" && Array.isArray(area.triangles) ? area : compileDriveAreaSurface(area, index)
    ));
}

/** Mutable authoring records use a content key; resolved world surfaces are immutable. */
export function createDriveAreaSurfaceCache() {
    let key;
    let prepared = { drivableSurfaces: [] };
    let builds = 0;
    return {
        get builds() { return builds; },
        get(environment) {
            const source = areaSource(environment);
            const compiled = !Array.isArray(source?.driveAreas) && Array.isArray(source?.drivableSurfaces);
            const nextKey = compiled ? source.drivableSurfaces : JSON.stringify(authoredAreas(source), (_name, value) => (
                typeof value === "number" && !Number.isFinite(value) ? String(value) : value
            ));
            if (nextKey !== key) {
                const surfaces = driveAreaSurfacesFrom(source);
                prepared = { drivableSurfaces: surfaces };
                key = nextKey;
                builds += 1;
            }
            return prepared;
        },
    };
}

/** Lowest UTF-8 area id that contains the point, or null. Roads are not consulted. */
export function sampleContainingDriveArea(environment, x, z) {
    const hits = driveAreaSurfacesFrom(environment)
        .filter((surface) => pointInDriveAreaSurface({ x, z }, surface))
        .sort((left, right) => compareUtf8(String(left.sourceId), String(right.sourceId)));
    const surface = hits[0];
    if (!surface) return null;
    return {
        y: finite(surface.minY ?? 0, "Drive area y"),
        pitch: 0,
        normal: { x: 0, y: 1, z: 0 },
        kind: "area",
        id: String(surface.sourceId),
        edgeId: null,
        nodeId: null,
    };
}

export function pointOnDriveAreas(point, environment) {
    return driveAreaSurfacesFrom(environment).some((surface) => pointInDriveAreaSurface(point, surface));
}

export function worldHasDriveAreas(description) {
    return (description?.drivableSurfaces ?? []).some((surface) => surface?.kind === "area-polygon");
}

export function areaOnlyWorld(description) {
    const nodes = description?.roads?.nodes ?? [];
    const edges = description?.roads?.edges ?? [];
    return nodes.length === 0 && edges.length === 0 && worldHasDriveAreas(description);
}

function ring(points) {
    return (points || []).map((point) => ({ x: Number(point.x) || 0, z: Number(point.z) || 0 }));
}

function hullRing(vertices) {
    const hull = convexHullXZ(vertices);
    if (!hull || hull.length < 3) return null;
    return hull.map(([x, z]) => ({ x, z }));
}

export function planningObstacleRings(description) {
    const rings = [];
    for (const obstacle of description?.obstacles ?? []) {
        if (Array.isArray(obstacle.footprint) && obstacle.footprint.length >= 3) rings.push(ring(obstacle.footprint));
        else if (obstacle?.bounds?.min && obstacle?.bounds?.max) {
            const { min, max } = obstacle.bounds;
            rings.push([
                { x: min.x, z: min.z },
                { x: max.x, z: min.z },
                { x: max.x, z: max.z },
                { x: min.x, z: max.z },
            ]);
        }
    }
    for (const proxy of description?.assetProxies ?? []) {
        for (const mesh of proxy?.collision ?? []) {
            const footprint = hullRing(mesh?.vertices);
            if (footprint) rings.push(footprint);
        }
    }
    for (const solid of description?.primitives ?? []) {
        const footprint = hullRing(solid?.vertices);
        if (footprint) rings.push(footprint);
    }
    return rings.filter((polygon) => polygon.length >= 3);
}

function pointInRing(point, polygon) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const current = polygon[index];
        const prior = polygon[previous];
        const crosses = (current.z > point.z) !== (prior.z > point.z)
            && point.x < ((prior.x - current.x) * (point.z - current.z)) / ((prior.z - current.z) || Number.EPSILON) + current.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

function polygonsOverlap(left, right) {
    if (left.some((point) => pointInRing(point, right)) || right.some((point) => pointInRing(point, left))) return true;
    const side = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    const segments = (ringPoints) => ringPoints.map((point, index) => [point, ringPoints[(index + 1) % ringPoints.length]]);
    return segments(left).some(([a, b]) => segments(right).some(([c, d]) => (
        side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
    )));
}

function drivableTriangles(description) {
    const triangles = [];
    for (const surface of description?.drivableSurfaces || []) {
        const vertices = ring(surface.vertices || surface.footprint);
        const raw = surface.indices || surface.triangles || [];
        const faces = Array.isArray(raw[0]) ? raw : [];
        if (!faces.length && raw.length >= 3 && Number.isInteger(raw[0])) {
            for (let index = 0; index + 2 < raw.length; index += 3) faces.push([raw[index], raw[index + 1], raw[index + 2]]);
        }
        if (!faces.length && vertices.length >= 3 && surface.kind !== "area-polygon") {
            for (let index = 1; index < vertices.length - 1; index += 1) faces.push([0, index, index + 1]);
        }
        for (const face of faces) {
            const [a, b, c] = face;
            if (vertices[a] && vertices[b] && vertices[c]) triangles.push([vertices[a], vertices[b], vertices[c]]);
        }
    }
    return triangles;
}

/** Null when the footprint is on pavement and clear of obstacles. */
export function pavementPoseIssue(description, pose, size, center = {}) {
    if (!size?.x || !size?.z) return "A start pose requires the ego footprint.";
    const corners = vehicleGroundFootprint(pose, size, center);
    if (!corners) return "The start pose is invalid.";
    if (planningObstacleRings(description).some((polygon) => polygonsOverlap(corners, polygon))) {
        return "The start pose overlaps an obstacle.";
    }
    const triangles = drivableTriangles(description);
    if (triangles.length === 0) return "The start pose is outside the drivable surface.";
    const inside = corners.every((corner) => triangles.some(([a, b, c]) => pointInTriangle(corner, a, b, c)));
    if (!inside) return "The start pose leaves the drivable surface.";
    return null;
}

export function firstDriveArea(areas) {
    const records = normalizeDriveAreaList(areas);
    return records[0] ?? null;
}
