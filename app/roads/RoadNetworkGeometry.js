import { roadLaneCount } from "./RoadLaneModel.js";
import { buildRoadSurface, validateGeometry } from "./RoadGeometry.js";
import { ROAD_GEOMETRY_POLICY_V1 } from "./RoadGeometryPolicy.js";
import { resolveRoadEdge, validateRoadDomain } from "./RoadGeometryRecord.js";

const EPSILON = 1e-9;

function compareText(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function canonicalMetricValue(value, decimals) {
    if (typeof value === "number") {
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor;
    }
    if (Array.isArray(value)) return value.map((entry) => canonicalMetricValue(entry, decimals));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, canonicalMetricValue(entry, decimals)]));
    return value;
}

function lerp(left, right, t) {
    return { x: left.x + (right.x - left.x) * t, y: left.y + (right.y - left.y) * t, z: left.z + (right.z - left.z) * t };
}

function normalizeXZ(value) {
    const length = Math.hypot(value.x, value.z);
    return length <= EPSILON ? null : { x: value.x / length, y: 0, z: value.z / length };
}

function negate(value) {
    return { x: -value.x, y: -value.y, z: -value.z };
}

function rightNormal(value) {
    const tangent = normalizeXZ(value);
    return tangent ? { x: -tangent.z, y: 0, z: tangent.x } : null;
}

function addOffset(point, normal, amount) {
    return { x: point.x + normal.x * amount, y: point.y, z: point.z + normal.z * amount };
}

function sampleAtDistance(samples, distance) {
    const target = clamp(distance, 0, samples.totalLengthXZ);
    let index = samples.points.length - 2;
    for (let cursor = 0; cursor < samples.cumulativeXZ.length - 1; cursor += 1) {
        if (target <= samples.cumulativeXZ[cursor + 1] + EPSILON) {
            index = cursor;
            break;
        }
    }
    const startDistance = samples.cumulativeXZ[index];
    const segmentLength = samples.cumulativeXZ[index + 1] - startDistance;
    const t = segmentLength <= EPSILON ? 0 : (target - startDistance) / segmentLength;
    const tangent = normalizeXZ({
        x: samples.points[index + 1].x - samples.points[index].x,
        y: samples.points[index + 1].y - samples.points[index].y,
        z: samples.points[index + 1].z - samples.points[index].z,
    }) ?? samples.tangents[index];
    return {
        point: lerp(samples.points[index], samples.points[index + 1], t),
        tangent,
        parameter: t < 1 - EPSILON ? samples.parameters[index] : samples.parameters[index + 1],
        distance: target,
    };
}

function trimSamples(samples, startDistance, endDistance) {
    const start = sampleAtDistance(samples, startDistance);
    const end = sampleAtDistance(samples, endDistance);
    const points = [start.point];
    const tangents = [start.tangent];
    const parameters = [start.parameter];
    for (let index = 1; index < samples.points.length - 1; index += 1) {
        const distance = samples.cumulativeXZ[index];
        if (distance > startDistance + EPSILON && distance < endDistance - EPSILON) {
            points.push(samples.points[index]);
            tangents.push(samples.tangents[index]);
            parameters.push(samples.parameters[index]);
        }
    }
    points.push(end.point);
    tangents.push(end.tangent);
    parameters.push(end.parameter);
    const cumulativeXZ = [0];
    for (let index = 1; index < points.length; index += 1) cumulativeXZ.push(cumulativeXZ[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z));
    return { points, tangents, parameters, cumulativeXZ, totalLengthXZ: cumulativeXZ.at(-1) };
}

function resolvedCacheKey(edge, start, end, policy) {
    return JSON.stringify({ edge, start, end, policy });
}

function convexHullXZ(points) {
    const sorted = [...points]
        .sort((left, right) => left.x - right.x || left.z - right.z || left.y - right.y)
        .filter((point, index, values) => index === 0 || Math.hypot(point.x - values[index - 1].x, point.z - values[index - 1].z) > EPSILON);
    if (sorted.length < 3) return sorted;
    const cross = (origin, left, right) => (left.x - origin.x) * (right.z - origin.z) - (left.z - origin.z) * (right.x - origin.x);
    const lower = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= EPSILON) lower.pop();
        lower.push(point);
    }
    const upper = [];
    for (const point of [...sorted].reverse()) {
        while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= EPSILON) upper.pop();
        upper.push(point);
    }
    lower.pop();
    upper.pop();
    return [...lower, ...upper];
}

function boundsOf(points) {
    return {
        min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)), z: Math.min(...points.map((point) => point.z)) },
        max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)), z: Math.max(...points.map((point) => point.z)) },
    };
}

function segmentIntersectionXZ(a, b, c, d) {
    const r = { x: b.x - a.x, z: b.z - a.z };
    const s = { x: d.x - c.x, z: d.z - c.z };
    const denominator = r.x * s.z - r.z * s.x;
    if (Math.abs(denominator) <= EPSILON) return null;
    const q = { x: c.x - a.x, z: c.z - a.z };
    const t = (q.x * s.z - q.z * s.x) / denominator;
    const u = (q.x * r.z - q.z * r.x) / denominator;
    if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
    return { t: clamp(t, 0, 1), u: clamp(u, 0, 1) };
}

function closestSegmentsXZ(a, b, c, d) {
    const crossing = segmentIntersectionXZ(a, b, c, d);
    if (crossing) return { ...crossing, distance: 0 };
    const project = (point, start, end) => {
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const lengthSquared = dx * dx + dz * dz;
        const t = lengthSquared <= EPSILON ? 0 : clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, 0, 1);
        const x = start.x + dx * t;
        const z = start.z + dz * t;
        return { t, distance: Math.hypot(point.x - x, point.z - z) };
    };
    const candidates = [
        { t: 0, u: project(a, c, d).t, distance: project(a, c, d).distance },
        { t: 1, u: project(b, c, d).t, distance: project(b, c, d).distance },
        { t: project(c, a, b).t, u: 0, distance: project(c, a, b).distance },
        { t: project(d, a, b).t, u: 1, distance: project(d, a, b).distance },
    ];
    return candidates.sort((left, right) => left.distance - right.distance || left.t - right.t || left.u - right.u)[0];
}

function withinSharedMouth(left, right, leftIndex, rightIndex, hit, shared, incidentByNode) {
    const contactClearance = (Number(left.edge.width ?? 7) + 2 * Number(left.edge.shoulderWidth ?? 0)
        + Number(right.edge.width ?? 7) + 2 * Number(right.edge.shoulderWidth ?? 0)) * 0.5;
    for (const nodeId of shared) {
        const leftIncident = incidentByNode.get(String(nodeId))?.find((entry) => entry.edgeId === left.edge.id);
        const rightIncident = incidentByNode.get(String(nodeId))?.find((entry) => entry.edgeId === right.edge.id);
        if (!leftIncident || !rightIncident) continue;
        const leftDistance = left.samples.cumulativeXZ[leftIndex]
            + (left.samples.cumulativeXZ[leftIndex + 1] - left.samples.cumulativeXZ[leftIndex]) * hit.t;
        const rightDistance = right.samples.cumulativeXZ[rightIndex]
            + (right.samples.cumulativeXZ[rightIndex + 1] - right.samples.cumulativeXZ[rightIndex]) * hit.u;
        const leftFromNode = leftIncident.end === "start" ? leftDistance : left.samples.totalLengthXZ - leftDistance;
        const rightFromNode = rightIncident.end === "start" ? rightDistance : right.samples.totalLengthXZ - rightDistance;
        if (leftFromNode <= (leftIncident.inset ?? 0) + contactClearance + EPSILON
            && rightFromNode <= (rightIncident.inset ?? 0) + contactClearance + EPSILON) return true;
    }
    return false;
}

function roadConflicts(entries, incidentByNode, elevationTolerance = 0.5) {
    const conflicts = [];
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
        const left = entries[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
            const right = entries[rightIndex];
            const shared = new Set([left.edge.startNodeId, left.edge.endNodeId].filter((id) => id === right.edge.startNodeId || id === right.edge.endNodeId));
            let found = null;
            for (let i = 0; !found && i < left.samples.points.length - 1; i += 1) {
                for (let j = 0; j < right.samples.points.length - 1; j += 1) {
                    const hit = closestSegmentsXZ(left.samples.points[i], left.samples.points[i + 1], right.samples.points[j], right.samples.points[j + 1]);
                    const pavedDistance = (Number(left.edge.width ?? 7) + 2 * Number(left.edge.shoulderWidth ?? 0)
                        + Number(right.edge.width ?? 7) + 2 * Number(right.edge.shoulderWidth ?? 0)) * 0.5;
                    if (hit.distance > pavedDistance + EPSILON) continue;
                    if (withinSharedMouth(left, right, i, j, hit, shared, incidentByNode)) continue;
                    const leftY = [left.samples.points[i].y, left.samples.points[i + 1].y].sort((a, b) => a - b);
                    const rightY = [right.samples.points[j].y, right.samples.points[j + 1].y].sort((a, b) => a - b);
                    const elevationsOverlap = leftY[0] <= rightY[1] + elevationTolerance && rightY[0] <= leftY[1] + elevationTolerance;
                    if (elevationsOverlap) found = { leftEdgeId: left.edge.id, rightEdgeId: right.edge.id, code: "road.geometry.overlap", leftSegment: i, rightSegment: j, distance: hit.distance };
                }
            }
            if (found) conflicts.push(found);
        }
    }
    return conflicts;
}

function isDirectJoin(incidents) {
    if (incidents.length !== 2) return false;
    if (Math.abs(incidents[0].pavedWidth - incidents[1].pavedWidth) > 1e-6) return false;
    const dot = incidents[0].outwardTangent.x * incidents[1].outwardTangent.x
        + incidents[0].outwardTangent.z * incidents[1].outwardTangent.z;
    return dot <= -0.999;
}

function junctionSurface(node, incidents) {
    const vertices = convexHullXZ(incidents.flatMap((incident) => {
        const normal = rightNormal(incident.edgeTangent);
        return [
            addOffset(incident.mouth, normal, -incident.pavedWidth * 0.5),
            addOffset(incident.mouth, normal, incident.pavedWidth * 0.5),
        ].map((point) => ({ ...point, y: node.y }));
    })).reverse();
    if (vertices.length < 3) throw new TypeError(`Junction "${node.id}" cannot form a paved polygon.`);
    const indices = [];
    for (let index = 1; index < vertices.length - 1; index += 1) indices.push(0, index, index + 1);
    return { id: String(node.id), vertices, indices, bounds: boundsOf(vertices) };
}

/**
 * Resolve, sample, trim, and compile an entire road graph. The returned plan
 * owns the only sampling result downstream consumers should use.
 */
export function planRoadNetworkGeometry(roads, options = {}) {
    const validation = validateRoadDomain(roads, options);
    if (!validation.ok) {
        const error = new TypeError(validation.issues[0].message);
        error.issues = validation.issues;
        throw error;
    }
    const policy = options.policy ?? ROAD_GEOMETRY_POLICY_V1;
    const cache = options.cache ?? null;
    const nodes = [...(roads?.nodes ?? [])].map((node) => ({ ...node, y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0 })).sort((left, right) => compareText(left.id, right.id));
    const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
    const edges = [];
    for (const authorEdge of [...(roads?.edges ?? [])].sort((left, right) => compareText(left.id, right.id))) {
        const key = resolvedCacheKey(authorEdge, nodeById.get(String(authorEdge.startNodeId)), nodeById.get(String(authorEdge.endNodeId)), policy);
        const cached = cache?.get?.(key);
        if (cached) {
            edges.push({ edge: cached.edge, samples: cached.samples, cacheKey: key });
            continue;
        }
        const edge = canonicalMetricValue(resolveRoadEdge(authorEdge, nodeById), policy.canonicalDecimals);
        const geometryValidation = validateGeometry(edge, { policy });
        if (!geometryValidation.ok) throw new TypeError(geometryValidation.issues[0].message);
        const samples = geometryValidation.samples;
        cache?.set?.(key, { edge, samples });
        edges.push({ edge, samples, cacheKey: key });
    }
    const edgeById = new Map(edges.map((entry) => [entry.edge.id, entry]));
    const incidentByNode = new Map(nodes.map((node) => [String(node.id), []]));
    for (const entry of edges) {
        const { edge, samples } = entry;
        incidentByNode.get(edge.startNodeId).push({
            id: edge.id,
            edgeId: edge.id,
            end: "start",
            pavedWidth: Number(edge.width ?? 7) + 2 * Math.max(0, Number(edge.shoulderWidth ?? 0)),
            outwardTangent: normalizeXZ(samples.tangents[0]),
            edgeTangent: normalizeXZ(samples.tangents[0]),
            length: samples.totalLengthXZ,
        });
        incidentByNode.get(edge.endNodeId).push({
            id: edge.id,
            edgeId: edge.id,
            end: "end",
            pavedWidth: Number(edge.width ?? 7) + 2 * Math.max(0, Number(edge.shoulderWidth ?? 0)),
            outwardTangent: negate(normalizeXZ(samples.tangents.at(-1))),
            edgeTangent: normalizeXZ(samples.tangents.at(-1)),
            length: samples.totalLengthXZ,
        });
    }
    const junctions = [];
    for (const node of nodes) {
        const incidents = incidentByNode.get(String(node.id)).sort((left, right) => compareText(left.edgeId, right.edgeId));
        const explicit = node.kind === "intersection";
        if (incidents.length > 4) throw new TypeError(`Junction "${node.id}" exceeds four roads.`);
        const requiresPatch = incidents.length >= 2 && !isDirectJoin(incidents);
        const widest = Math.max(0, ...incidents.map((entry) => entry.pavedWidth));
        for (const incident of incidents) {
            const desired = requiresPatch ? clamp(0.75 * widest, 2.5, 10) : 0;
            incident.inset = Math.min(desired, incident.length * 0.35);
            const entry = edgeById.get(incident.edgeId);
            const distance = incident.end === "start" ? incident.inset : entry.samples.totalLengthXZ - incident.inset;
            const mouth = sampleAtDistance(entry.samples, distance);
            incident.mouth = { ...mouth.point, y: node.y };
            incident.mouthDistance = distance;
        }
        if (requiresPatch) {
            junctions.push({
                node,
                explicit,
                incidents,
                surface: junctionSurface(node, incidents),
            });
        }
    }
    const junctionByNode = new Map(junctions.map((junction) => [String(junction.node.id), junction]));
    for (const entry of edges) {
        const startIncident = junctionByNode.get(entry.edge.startNodeId)?.incidents.find((incident) => incident.edgeId === entry.edge.id) ?? null;
        const endIncident = junctionByNode.get(entry.edge.endNodeId)?.incidents.find((incident) => incident.edgeId === entry.edge.id) ?? null;
        const startDistance = startIncident?.inset ?? 0;
        const endDistance = entry.samples.totalLengthXZ - (endIncident?.inset ?? 0);
        entry.startMouthFraction = startDistance / entry.samples.totalLengthXZ;
        entry.endMouthFraction = endDistance / entry.samples.totalLengthXZ;
        const compiledKey = `${entry.cacheKey}:mouth:${startDistance}:${endDistance}`;
        const cached = cache?.get?.(compiledKey);
        if (cached) {
            entry.fullSurface = cached.fullSurface;
            entry.trimmedSamples = cached.trimmedSamples;
            entry.surface = cached.surface;
        } else {
            entry.fullSurface = buildRoadSurface(entry.edge, { policy, samples: entry.samples });
            entry.trimmedSamples = trimSamples(entry.samples, startDistance, endDistance);
            entry.surface = buildRoadSurface(entry.edge, { policy, samples: entry.trimmedSamples });
            cache?.set?.(compiledKey, { fullSurface: entry.fullSurface, trimmedSamples: entry.trimmedSamples, surface: entry.surface });
        }
    }
    const conflicts = roadConflicts(edges, incidentByNode, Number(options.elevationTolerance ?? 0.5));
    if (options.strict === true && conflicts.length > 0) {
        const error = new TypeError(`Roads "${conflicts[0].leftEdgeId}" and "${conflicts[0].rightEdgeId}" overlap outside a junction.`);
        error.conflicts = conflicts;
        throw error;
    }
    return {
        version: 1,
        policy,
        nodes,
        nodeById,
        edges,
        edgeById,
        junctions,
        junctionByNode,
        intersectionNodes: new Set(junctions.map((junction) => String(junction.node.id))),
        adjacency: incidentByNode,
        conflicts,
    };
}

export function compileRoadNetworkGeometry(plan) {
    return {
        version: plan.version,
        policy: plan.policy,
        edges: plan.edges.map((entry) => ({
            id: entry.edge.id,
            edge: entry.edge,
            samples: entry.samples,
            trimmedSamples: entry.trimmedSamples,
            startMouthFraction: entry.startMouthFraction,
            endMouthFraction: entry.endMouthFraction,
            fullLaneCenterlines: entry.fullSurface.laneCenterlines,
            ...entry.surface,
        })),
        junctions: plan.junctions.map((junction) => ({
            id: junction.node.id,
            node: junction.node,
            incidents: junction.incidents,
            ...junction.surface,
        })),
    };
}

function pointInConvex(point, polygon, linearTolerance = 0) {
    let sign = 0;
    for (let index = 0; index < polygon.length; index += 1) {
        const left = polygon[index];
        const right = polygon[(index + 1) % polygon.length];
        const cross = (right.x - left.x) * (point.z - left.z) - (right.z - left.z) * (point.x - left.x);
        const edgeLength = Math.hypot(right.x - left.x, right.z - left.z);
        const crossTolerance = Math.max(EPSILON, linearTolerance * edgeLength);
        if (Math.abs(cross) <= crossTolerance) continue;
        const nextSign = Math.sign(cross);
        if (sign && nextSign !== sign) return false;
        sign = nextSign;
    }
    return true;
}

function cubic(p0, p1, p2, p3, u) {
    const a = lerp(p0, p1, u);
    const b = lerp(p1, p2, u);
    const c = lerp(p2, p3, u);
    return lerp(lerp(a, b, u), lerp(b, c, u), u);
}

export function buildJunctionConnector(plan, movement) {
    const junction = plan.junctionByNode.get(String(movement?.nodeId));
    if (!junction) return null;
    const from = junction.incidents.find((entry) => entry.edgeId === String(movement.fromEdgeId));
    const to = junction.incidents.find((entry) => entry.edgeId === String(movement.toEdgeId));
    if (!from || !to) throw new TypeError("Junction movement references a non-incident road.");
    const fromEdge = plan.edgeById.get(from.edgeId);
    const toEdge = plan.edgeById.get(to.edgeId);
    const fromLane = clamp(Number(movement.fromLaneIndex ?? 0), 0, roadLaneCount(fromEdge.edge) - 1);
    const toLane = clamp(Number(movement.toLaneIndex ?? 0), 0, roadLaneCount(toEdge.edge) - 1);
    const fromCenterline = fromEdge.surface.laneCenterlines[fromLane];
    const toCenterline = toEdge.surface.laneCenterlines[toLane];
    const p0 = from.end === "start" ? fromCenterline[0] : fromCenterline.at(-1);
    const p3 = to.end === "start" ? toCenterline[0] : toCenterline.at(-1);
    const travelFrom = from.end === "start" ? negate(from.outwardTangent) : from.outwardTangent;
    const travelTo = to.end === "start" ? to.outwardTangent : negate(to.outwardTangent);
    const handleLength = Math.min(from.inset, to.inset, Math.hypot(p3.x - p0.x, p3.z - p0.z) / 3);
    const canonicalDecimals = Number(plan.policy?.canonicalDecimals);
    const containmentTolerance = Number.isInteger(canonicalDecimals) && canonicalDecimals >= 0
        ? 10 ** -canonicalDecimals
        : EPSILON;
    const center = junction.node;
    let p1 = addOffset(p0, travelFrom, handleLength);
    let p2 = addOffset(p3, travelTo, -handleLength);
    if (!pointInConvex(p1, junction.surface.vertices, containmentTolerance)) p1 = lerp(p0, center, 0.5);
    if (!pointInConvex(p2, junction.surface.vertices, containmentTolerance)) p2 = lerp(p3, center, 0.5);
    const points = Array.from({ length: 9 }, (_, index) => cubic(p0, p1, p2, p3, index / 8));
    if (points.some((point) => !pointInConvex(point, junction.surface.vertices, containmentTolerance))) throw new TypeError("Junction connector leaves the paved surface.");
    return { nodeId: junction.node.id, fromEdgeId: from.edgeId, toEdgeId: to.edgeId, fromLaneIndex: fromLane, toLaneIndex: toLane, points };
}
