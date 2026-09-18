import { resolveRoadEdge } from "./RoadGeometryRecord.js";
import { projectPointToRoad, sampleCenterline } from "./RoadGeometry.js";
import { sampleRoute } from "../scenarios/route/Route.js";

const EPSILON = 1e-9;
export const MAX_LINSPACE_COUNT = 4096;

function finiteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp01(value) {
    const numeric = finiteNumber(value, 0);
    if (numeric < 0) return 0;
    if (numeric > 1) return 1;
    return numeric;
}

function xzRightNormal(heading) {
    const tx = Math.sin(heading);
    const tz = Math.cos(heading);
    return { x: -tz, y: 0, z: tx };
}

function normalizeXZ(vector) {
    const length = Math.hypot(vector.x, vector.z);
    if (length <= EPSILON) return null;
    return { x: vector.x / length, y: 0, z: vector.z / length };
}

function headingFromTangent(tangent) {
    return Math.atan2(finiteNumber(tangent?.x), finiteNumber(tangent?.z, 1));
}

function pose3d(position, heading) {
    return {
        position: {
            x: finiteNumber(position?.x),
            y: finiteNumber(position?.y),
            z: finiteNumber(position?.z),
        },
        rotation: { x: 0, y: finiteNumber(heading), z: 0, order: "XYZ" },
    };
}

function zeroFrame() {
    return {
        pose: pose3d({ x: 0, y: 0, z: 0 }, 0),
        tangent: { x: 0, y: 0, z: 1 },
        normal: { x: 1, y: 0, z: 0 },
        heading: 0,
        found: false,
    };
}

function frameFromPoint(point, heading, lateral, found) {
    const normal = xzRightNormal(heading);
    const offset = finiteNumber(lateral);
    const position = {
        x: finiteNumber(point?.x) + normal.x * offset,
        y: finiteNumber(point?.y),
        z: finiteNumber(point?.z) + normal.z * offset,
    };
    return {
        pose: pose3d(position, heading),
        tangent: { x: Math.sin(heading), y: 0, z: Math.cos(heading) },
        normal,
        heading,
        found,
    };
}

/**
 * Inclusive linspace. Non-finite inputs or `count <= 0` yield `[]`.
 * `count === 1` yields `[start]`. Count is capped at 4096.
 */
export function linspace(start, end, count) {
    if (![start, end, count].every((value) => Number.isFinite(Number(value)))) {
        return [];
    }
    const n = Math.min(MAX_LINSPACE_COUNT, Math.max(0, Math.floor(Number(count))));
    if (n <= 0) return [];
    const a = Number(start);
    const b = Number(end);
    if (n === 1) return [a];
    const step = (b - a) / (n - 1);
    return Array.from({ length: n }, (_, index) => a + step * index);
}

/**
 * Sample a Frenet frame along a route polyline.
 * `percent` is normalized arc-length in [0, 1]. `lateral` is metres along
 * the XZ right-normal `{ x: -tz, z: tx }` (+lateral is to the right of travel).
 * Yaw is `heading` from `sampleRoute` (`atan2(dx, dz)`).
 */
export function sampleRouteFrame(route, percent, lateral = 0) {
    const sampled = sampleRoute(route, percent);
    if (!sampled) return zeroFrame();
    return frameFromPoint(sampled, finiteNumber(sampled.heading), lateral, true);
}

function lookupRoadEdge(world, edgeId) {
    const id = String(edgeId ?? "").trim();
    const roads = world?.roads;
    if (!id || !Array.isArray(roads?.edges) || !Array.isArray(roads?.nodes)) return null;
    const edge = roads.edges.find((candidate) => String(candidate?.id) === id);
    if (!edge) return null;
    const nodeById = new Map(roads.nodes.map((node) => [node.id, node]));
    try {
        return resolveRoadEdge(edge, nodeById);
    } catch {
        return null;
    }
}

function interpolateCenterline(samples, percent) {
    const t = clamp01(percent);
    const target = t * samples.totalLengthXZ;
    if (!Array.isArray(samples.points) || samples.points.length === 0) return null;
    if (samples.points.length === 1) {
        return {
            point: samples.points[0],
            tangent: normalizeXZ(samples.tangents[0]) ?? { x: 0, y: 0, z: 1 },
        };
    }
    let segment = samples.points.length - 2;
    for (let index = 0; index < samples.cumulativeXZ.length - 1; index += 1) {
        if (target <= samples.cumulativeXZ[index + 1] + EPSILON) {
            segment = index;
            break;
        }
    }
    const startDistance = samples.cumulativeXZ[segment];
    const span = samples.cumulativeXZ[segment + 1] - startDistance;
    const u = span <= EPSILON ? 0 : (target - startDistance) / span;
    const start = samples.points[segment];
    const end = samples.points[segment + 1];
    const startTangent = samples.tangents[segment];
    const endTangent = samples.tangents[segment + 1];
    return {
        point: {
            x: start.x + (end.x - start.x) * u,
            y: start.y + (end.y - start.y) * u,
            z: start.z + (end.z - start.z) * u,
        },
        tangent: normalizeXZ({
            x: startTangent.x + (endTangent.x - startTangent.x) * u,
            z: startTangent.z + (endTangent.z - startTangent.z) * u,
        }) ?? { x: 0, y: 0, z: 1 },
    };
}

/**
 * Sample a Frenet frame along a world-description road edge.
 * `percent` is normalized [0, 1] along XZ centerline length. `lateral` is
 * metres from the centerline along `rightNormal` (+ = right of travel).
 * Unknown edge / missing world → `found: false`, no throw.
 */
export function sampleRoadFrame(world, edgeId, percent, lateral = 0) {
    const resolved = lookupRoadEdge(world, edgeId);
    if (!resolved) return zeroFrame();
    let samples;
    try {
        samples = sampleCenterline(resolved);
    } catch {
        return zeroFrame();
    }
    const interpolated = interpolateCenterline(samples, percent);
    if (!interpolated) return zeroFrame();
    return frameFromPoint(interpolated.point, headingFromTangent(interpolated.tangent), lateral, true);
}

function missedRoad() {
    return { edgeId: "", found: false, distance: 0, percent: 0 };
}

function pointFromPose(pose) {
    const source = pose?.position && typeof pose.position === "object" ? pose.position : pose;
    return {
        x: finiteNumber(source?.x),
        z: finiteNumber(source?.z),
    };
}

/**
 * Closest world-description road centerline to a pose, with no paved-footprint
 * gate. Missing world / no usable edges → `found: false`, empty `edgeId`.
 */
export function nearestRoadEdge(world, pose) {
    const roads = world?.roads;
    if (!Array.isArray(roads?.edges) || roads.edges.length === 0) return missedRoad();
    const point = pointFromPose(pose);
    let best = null;
    for (const edge of roads.edges) {
        const resolved = lookupRoadEdge(world, edge?.id);
        if (!resolved) continue;
        let samples;
        try {
            samples = sampleCenterline(resolved);
        } catch {
            continue;
        }
        const projection = projectPointToRoad(point, { samples });
        if (!projection) continue;
        const closer = !best
            || projection.distance < best.distance - EPSILON
            || (
                Math.abs(projection.distance - best.distance) <= EPSILON
                && projection.distanceAlong < best.distanceAlong
            );
        if (!closer) continue;
        best = {
            edgeId: String(edge.id),
            found: true,
            distance: projection.distance,
            percent: Number.isFinite(projection.fraction) ? projection.fraction : 0,
            distanceAlong: projection.distanceAlong,
        };
    }
    if (!best) return missedRoad();
    return {
        edgeId: best.edgeId,
        found: true,
        distance: best.distance,
        percent: best.percent,
    };
}
