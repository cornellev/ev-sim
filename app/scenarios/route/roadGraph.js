import {
    buildArcLengthPolyline,
    distanceXZ,
    finiteNumber,
    intersectTravelLinesXZ,
    pointFrom,
    projectPointToSegment,
} from "./geometry.js";
import { deterministicHash } from "./hash.js";
import {
    edgeAllowsArrivalAtNode,
    edgeAllowsDepartureFromNode,
    laneCenterPoint,
    laneCenterRightOffset,
    laneDirections,
    legalLaneIndices,
    movementAllowed,
    movementRuleKey,
    nearestLaneIndexForOffset,
    nearestLegalLaneIndex,
    offsetRoadPoint,
    rightmostLegalLaneIndex,
    roadLaneCount,
    roadLaneId,
    signedRightOffset,
    validateRoadLaneLayout,
} from "../../roads/RoadLaneModel.js";
import { movementConnector } from "../../roads/RoadJunctionValidation.js";
import { authorRoadsFromMetric, conformToRoadsFields, normalizeMetricRoads, roadGeometryVersionOf } from "../../roads/RoadGeometryRecord.js";
import { projectPointToRoad as projectPointToCompiledRoad } from "../../roads/RoadGeometry.js";
import { buildJunctionConnector, planRoadNetworkGeometry, sampleIndexedSurfacePoint } from "../../roads/RoadNetworkGeometry.js";
import { ROAD_GEOMETRY_POLICY_V1 } from "../../roads/RoadGeometryPolicy.js";

const EPSILON = 1e-9;
const DEFAULT_ROAD_WIDTH = 7;
const DEFAULT_INTERSECTION_RADIUS = 5;
const CENTERLINE_EPSILON = 1e-6;
const INTERSECTION_CONNECTOR_SAMPLES = 9;
const ROAD_SPATIAL_CELL_METERS = 32;

function compareText(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

export function environmentDocumentFrom(value) {
    if (!value || typeof value !== "object") return { environmentId: null, roads: { nodes: [], edges: [], turnRules: [] } };
    const source = value.document
        ?? value.manifest?.document
        ?? value.environment?.document
        ?? value;
    const nodes = source.roads?.nodes instanceof Map
        ? [...source.roads.nodes.entries()].map(([id, point]) => ({ id, ...point }))
        : source.roads?.nodes;
    return {
        ...source,
        environmentId: source.environmentId ?? value.environmentId ?? value.id ?? null,
        roads: {
            ...(source.roads?.geometryVersion !== undefined ? { geometryVersion: source.roads.geometryVersion } : {}),
            nodes: Array.isArray(nodes) ? nodes : [],
            edges: Array.isArray(source.roads?.edges) ? source.roads.edges : [],
            turnRules: Array.isArray(source.roads?.turnRules) ? source.roads.turnRules : [],
        },
    };
}

function canonicalRoadNetwork(value) {
    const document = environmentDocumentFrom(value);
    const turnRules = document.roads.turnRules
        .map((rule) => ({
            nodeId: String(rule.nodeId),
            fromEdgeId: String(rule.fromEdgeId),
            toEdgeId: String(rule.toEdgeId),
            allowed: rule.allowed === true,
        }))
        .sort((left, right) => compareText(
            movementRuleKey(left.nodeId, left.fromEdgeId, left.toEdgeId),
            movementRuleKey(right.nodeId, right.fromEdgeId, right.toEdgeId),
        ));
    return {
        environmentId: document.environmentId ?? null,
        nodes: document.roads.nodes
            .map((node) => ({
                id: String(node.id),
                x: finiteNumber(node.x),
                y: finiteNumber(node.y),
                z: finiteNumber(node.z),
                kind: node.kind ?? null,
                ...conformToRoadsFields(node),
            }))
            .sort((left, right) => compareText(left.id, right.id)),
        edges: document.roads.edges
            .map((edge) => ({
                id: String(edge.id),
                startNodeId: String(edge.startNodeId),
                endNodeId: String(edge.endNodeId),
                bidirectional: edge.bidirectional !== false && edge.oneWay !== true,
                direction: edge.direction ?? edge.oneWayDirection ?? 1,
                width: finiteNumber(edge.width, DEFAULT_ROAD_WIDTH),
                laneCount: finiteNumber(edge.laneCount, 2),
                shoulderWidth: finiteNumber(edge.shoulderWidth, 0),
                startArm: pointFrom(edge.startArm),
                endArm: pointFrom(edge.endArm),
            }))
            .sort((left, right) => compareText(left.id, right.id)),
        ...(turnRules.length > 0 ? { turnRules } : {}),
    };
}

export function canonicalRoadNetworkV2(value) {
    const document = environmentDocumentFrom(value);
    const roads = normalizeMetricRoads(authorRoadsFromMetric(document.roads));
    const turnRules = (roads.turnRules ?? []).map((rule) => ({
        nodeId: String(rule.nodeId),
        fromEdgeId: String(rule.fromEdgeId),
        toEdgeId: String(rule.toEdgeId),
        allowed: rule.allowed === true,
    })).sort((left, right) => compareText(
        movementRuleKey(left.nodeId, left.fromEdgeId, left.toEdgeId),
        movementRuleKey(right.nodeId, right.fromEdgeId, right.toEdgeId),
    ));
    return {
        environmentId: document.environmentId ?? null,
        geometryVersion: 2,
        geometryPolicy: { id: ROAD_GEOMETRY_POLICY_V1.id, version: ROAD_GEOMETRY_POLICY_V1.version },
        nodes: roads.nodes.map((node) => ({
            id: String(node.id),
            x: finiteNumber(node.x),
            y: finiteNumber(node.y),
            z: finiteNumber(node.z),
            kind: node.kind ?? null,
            ...conformToRoadsFields(node),
        })).sort((left, right) => compareText(left.id, right.id)),
        edges: roads.edges.map((edge) => ({
            id: String(edge.id),
            startNodeId: String(edge.startNodeId),
            endNodeId: String(edge.endNodeId),
            bidirectional: edge.bidirectional !== false && edge.oneWay !== true,
            direction: edge.direction ?? edge.oneWayDirection ?? 1,
            width: finiteNumber(edge.width, DEFAULT_ROAD_WIDTH),
            laneCount: finiteNumber(edge.laneCount, 2),
            // Explicit lanes are route-semantic identity (anchors and proofs
            // reference lane ids); implicit edges omit the key so their
            // historical hashes never move.
            ...(Array.isArray(edge.lanes) ? {
                lanes: edge.lanes.map((lane) => ({
                    id: String(lane.id),
                    direction: finiteNumber(lane.direction, 1),
                    width: finiteNumber(lane.width, 0),
                })),
            } : {}),
            shoulderWidth: finiteNumber(edge.shoulderWidth, 0),
            geometry: edge.geometry,
        })).sort((left, right) => compareText(left.id, right.id)),
        ...(turnRules.length > 0 ? { turnRules } : {}),
    };
}

export function hashEnvironmentRoadNetwork(value) {
    const version = roadGeometryVersionOf(environmentDocumentFrom(value));
    if (version === 2) return deterministicHash(canonicalRoadNetworkV2(value));
    if (version === 1) return deterministicHash(canonicalRoadNetwork(value));
    throw new TypeError(`Unsupported road geometry version: ${String(version)}.`);
}

export function buildDirectedRoadGraph(value) {
    const document = environmentDocumentFrom(value);
    const geometryVersion = roadGeometryVersionOf(document);
    if (![1, 2].includes(geometryVersion)) throw new TypeError(`Unsupported road geometry version: ${String(geometryVersion)}.`);
    const compiledPlan = geometryVersion === 2
        ? planRoadNetworkGeometry(authorRoadsFromMetric(document.roads))
        : null;
    const nodes = new Map();
    for (const node of document.roads.nodes) {
        const point = pointFrom(node);
        if (!node?.id || !point) continue;
        nodes.set(String(node.id), { ...node, ...point, id: String(node.id) });
    }

    const edges = new Map();
    const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
    const degree = new Map([...nodes.keys()].map((id) => [id, 0]));
    const laneIssues = [];

    const addTransition = (edge, fromNodeId, toNodeId, direction) => {
        const from = nodes.get(fromNodeId);
        const to = nodes.get(toNodeId);
        if (!from || !to) return;
        adjacency.get(fromNodeId).push({
            edgeId: edge.id,
            fromNodeId,
            toNodeId,
            direction,
            cost: edge.length ?? distanceXZ(from, to),
        });
    };

    for (const rawEdge of document.roads.edges) {
        if (!rawEdge?.id) continue;
        const edge = {
            ...rawEdge,
            id: String(rawEdge.id),
            startNodeId: String(rawEdge.startNodeId),
            endNodeId: String(rawEdge.endNodeId),
        };
        const start = nodes.get(edge.startNodeId);
        const end = nodes.get(edge.endNodeId);
        if (!start || !end || start.id === end.id) continue;
        edge.length = compiledPlan?.edgeById.get(edge.id)?.samples.totalLengthXZ ?? distanceXZ(start, end);
        if (compiledPlan) edge.compiled = compiledPlan.edgeById.get(edge.id);
        edges.set(edge.id, edge);
        const laneLayout = validateRoadLaneLayout(edge);
        if (!laneLayout.ok) laneIssues.push({ edgeId: edge.id, ...laneLayout });
        degree.set(start.id, (degree.get(start.id) ?? 0) + 1);
        degree.set(end.id, (degree.get(end.id) ?? 0) + 1);

        // Transitions follow the lanes that legally travel each way. For
        // implicit edges this is exactly the historical bidirectional/one-way
        // branch; explicit asymmetric lanes (e.g. two forward, one back) reach
        // the same result without a dedicated case.
        if (legalLaneIndices(edge, 1).length > 0) addTransition(edge, start.id, end.id, 1);
        if (legalLaneIndices(edge, -1).length > 0) addTransition(edge, end.id, start.id, -1);
    }

    for (const transitions of adjacency.values()) {
        transitions.sort((left, right) => (
            compareText(left.edgeId, right.edgeId)
            || compareText(left.toNodeId, right.toNodeId)
            || left.direction - right.direction
        ));
    }

    const turnRuleIssues = [];
    const seenTurnRules = new Set();
    const turnRules = document.roads.turnRules.map((rule, index) => {
        const normalized = {
            nodeId: String(rule?.nodeId ?? ""),
            fromEdgeId: String(rule?.fromEdgeId ?? ""),
            toEdgeId: String(rule?.toEdgeId ?? ""),
            allowed: rule?.allowed === true,
        };
        const key = movementRuleKey(normalized.nodeId, normalized.fromEdgeId, normalized.toEdgeId);
        const fromEdge = edges.get(normalized.fromEdgeId);
        const toEdge = edges.get(normalized.toEdgeId);
        let error = null;
        if (typeof rule?.allowed !== "boolean") error = "allowed must be a boolean";
        else if (!nodes.has(normalized.nodeId) || !fromEdge || !toEdge) error = "references a missing node or edge";
        else if (!edgeAllowsArrivalAtNode(fromEdge, normalized.nodeId)) error = "the incoming edge cannot arrive at the node";
        else if (!edgeAllowsDepartureFromNode(toEdge, normalized.nodeId)) error = "the outgoing edge cannot depart from the node";
        else if (seenTurnRules.has(key)) error = "duplicates another movement";
        if (error) turnRuleIssues.push({ index, key, error });
        seenTurnRules.add(key);
        return normalized;
    }).sort((left, right) => compareText(
        movementRuleKey(left.nodeId, left.fromEdgeId, left.toEdgeId),
        movementRuleKey(right.nodeId, right.fromEdgeId, right.toEdgeId),
    ));
    // Route v7: a movement whose lane connector cannot fit inside its compiled
    // junction is unusable even when no turn rule forbids it, so routing and
    // the editor's movement matrix agree.
    const infeasibleMovements = new Set();
    if (compiledPlan) {
        for (const junction of compiledPlan.junctions) {
            const nodeId = String(junction.node.id);
            for (const from of junction.incidents) {
                for (const to of junction.incidents) {
                    const fromEdge = edges.get(from.edgeId);
                    const toEdge = edges.get(to.edgeId);
                    if (!fromEdge || !toEdge) continue;
                    if (!edgeAllowsArrivalAtNode(fromEdge, nodeId) || !edgeAllowsDepartureFromNode(toEdge, nodeId)) continue;
                    if (movementConnector(compiledPlan, nodeId, fromEdge.id, toEdge.id) === null) {
                        infeasibleMovements.add(movementRuleKey(nodeId, fromEdge.id, toEdge.id));
                    }
                }
            }
        }
    }
    const graph = {
        document,
        nodes,
        edges,
        adjacency,
        degree,
        turnRules,
        laneIssues,
        turnRuleIssues,
        geometryVersion,
        compiledPlan,
        infeasibleMovements,
    };
    Object.defineProperty(graph, "spatialIndex", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: buildRoadSpatialIndex(graph),
    });
    return graph;
}

/** Turn legality for the search: sparse turn rules plus v7 connector feasibility. */
function graphMovementAllowed(graph, { nodeId, fromEdgeId, toEdgeId, ignoreTurnRules = false }) {
    if (graph.infeasibleMovements?.has(movementRuleKey(nodeId, fromEdgeId, toEdgeId))) return false;
    if (ignoreTurnRules) return true;
    return movementAllowed({
        nodeId,
        fromEdgeId,
        toEdgeId,
        nodeDegree: graph.degree.get(nodeId) ?? 0,
        turnRules: graph.turnRules,
    });
}

function pointInTriangleXZ(point, a, b, c) {
    const cross = (left, right, target) => (right.x - left.x) * (target.z - left.z) - (right.z - left.z) * (target.x - left.x);
    const ab = cross(a, b, point);
    const bc = cross(b, c, point);
    const ca = cross(c, a, point);
    return ab >= -EPSILON && bc >= -EPSILON && ca >= -EPSILON
        || ab <= EPSILON && bc <= EPSILON && ca <= EPSILON;
}

function pointInIndexedSurface(point, surface, tolerance = 0) {
    if (point.x < surface.bounds.min.x - tolerance || point.x > surface.bounds.max.x + tolerance
        || point.z < surface.bounds.min.z - tolerance || point.z > surface.bounds.max.z + tolerance) return false;
    for (let index = 0; index < surface.indices.length; index += 3) {
        if (pointInTriangleXZ(point, surface.vertices[surface.indices[index]], surface.vertices[surface.indices[index + 1]], surface.vertices[surface.indices[index + 2]])) return true;
    }
    return false;
}

function addSpatialBounds(cells, kind, id, bounds) {
    if (!bounds) return;
    const minX = Math.floor(bounds.min.x / ROAD_SPATIAL_CELL_METERS);
    const maxX = Math.floor(bounds.max.x / ROAD_SPATIAL_CELL_METERS);
    const minZ = Math.floor(bounds.min.z / ROAD_SPATIAL_CELL_METERS);
    const maxZ = Math.floor(bounds.max.z / ROAD_SPATIAL_CELL_METERS);
    for (let x = minX; x <= maxX; x += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
            const key = `${x}:${z}`;
            const cell = cells.get(key) ?? { edges: new Set(), junctions: new Set() };
            cell[kind].add(id);
            cells.set(key, cell);
        }
    }
}

function pointsBounds(points, padding = 0) {
    if (!points?.length) return null;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const point of points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    }
    return {
        min: { x: minX - padding, z: minZ - padding },
        max: { x: maxX + padding, z: maxZ + padding },
    };
}

function buildRoadSpatialIndex(graph) {
    const cells = new Map();
    for (const edge of graph.edges.values()) {
        const halfWidth = finiteNumber(edge.width, DEFAULT_ROAD_WIDTH) * 0.5
            + finiteNumber(edge.shoulderWidth, 0);
        const bounds = edge.compiled?.fullSurface?.bounds
            ?? pointsBounds(
                edge.compiled?.samples?.points
                    ?? [graph.nodes.get(edge.startNodeId), graph.nodes.get(edge.endNodeId)].filter(Boolean),
                halfWidth,
            );
        addSpatialBounds(cells, "edges", edge.id, bounds);
    }
    if (graph.geometryVersion === 2) {
        for (const junction of graph.compiledPlan?.junctions ?? []) {
            addSpatialBounds(cells, "junctions", String(junction.node.id), junction.surface?.bounds);
        }
    } else {
        for (const node of graph.nodes.values()) {
            const isIntersection = node.kind === "intersection" || (graph.degree.get(node.id) ?? 0) > 1;
            if (!isIntersection) continue;
            const radius = intersectionRadius(node.id, graph, {});
            addSpatialBounds(cells, "junctions", node.id, {
                min: { x: node.x - radius, z: node.z - radius },
                max: { x: node.x + radius, z: node.z + radius },
            });
        }
    }
    return Object.freeze({ cellMeters: ROAD_SPATIAL_CELL_METERS, cells });
}

function spatialCandidates(graph, point, tolerance = 0) {
    const index = graph.spatialIndex;
    if (!index) return null;
    const edgeIds = new Set();
    const junctionIds = new Set();
    const minX = Math.floor((point.x - tolerance) / index.cellMeters);
    const maxX = Math.floor((point.x + tolerance) / index.cellMeters);
    const minZ = Math.floor((point.z - tolerance) / index.cellMeters);
    const maxZ = Math.floor((point.z + tolerance) / index.cellMeters);
    for (let x = minX; x <= maxX; x += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
            const cell = index.cells.get(`${x}:${z}`);
            if (!cell) continue;
            for (const id of cell.edges) edgeIds.add(id);
            for (const id of cell.junctions) junctionIds.add(id);
        }
    }
    return {
        edgeIds: [...edgeIds].sort(compareText),
        junctionIds: [...junctionIds].sort(compareText),
    };
}

function withRoadRuntimeProjection(projection, { segment = null, tangent = null } = {}) {
    if (!projection) return projection;
    Object.defineProperties(projection, {
        surfaceSegment: { configurable: false, enumerable: false, value: segment },
        surfaceTangent: { configurable: false, enumerable: false, value: tangent },
    });
    return projection;
}

function samplePolylineAtFraction(points, cumulative, total, fraction) {
    if (!points?.length) return null;
    const target = Math.max(0, Math.min(1, fraction)) * total;
    let index = points.length - 2;
    for (let cursor = 0; cursor < cumulative.length - 1; cursor += 1) {
        if (target <= cumulative[cursor + 1] + EPSILON) {
            index = cursor;
            break;
        }
    }
    const length = cumulative[index + 1] - cumulative[index];
    const t = length <= EPSILON ? 0 : (target - cumulative[index]) / length;
    return {
        point: {
            x: points[index].x + (points[index + 1].x - points[index].x) * t,
            y: points[index].y + (points[index + 1].y - points[index].y) * t,
            z: points[index].z + (points[index + 1].z - points[index].z) * t,
        },
        index,
        t,
    };
}

function polylineArcXZ(points) {
    const cumulative = [0];
    for (let index = 1; index < points.length; index += 1) cumulative.push(cumulative[index - 1] + distanceXZ(points[index - 1], points[index]));
    return { cumulative, total: cumulative.at(-1) ?? 0 };
}

function lanePointAtFraction(edge, laneIndex, fraction) {
    const points = edge.compiled.fullSurface.laneCenterlines[laneIndex];
    const sampleIndex = samplePolylineAtFraction(edge.compiled.samples.points, edge.compiled.samples.cumulativeXZ, edge.compiled.samples.totalLengthXZ, fraction);
    if (!sampleIndex) return null;
    const { index, t } = sampleIndex;
    return {
        x: points[index].x + (points[index + 1].x - points[index].x) * t,
        y: points[index].y + (points[index + 1].y - points[index].y) * t,
        z: points[index].z + (points[index + 1].z - points[index].z) * t,
    };
}

function projectPointToRoadNetworkV2(point, graph, tolerance) {
    const candidates = spatialCandidates(graph, point, tolerance);
    const junctionIds = candidates ? new Set(candidates.junctionIds) : null;
    const edgeIds = candidates?.edgeIds ?? [...graph.edges.keys()];
    const intersections = [];
    for (const junction of graph.compiledPlan.junctions) {
        if (junctionIds && !junctionIds.has(String(junction.node.id))) continue;
        if (!pointInIndexedSurface(point, junction.surface, tolerance)) continue;
        const node = junction.node;
        const sampled = sampleIndexedSurfacePoint(point, junction.surface);
        const y = sampled?.point.y ?? node.y;
        intersections.push({
            kind: "intersection",
            nodeId: node.id,
            edgeId: null,
            t: null,
            point: { x: node.x, y, z: node.z },
            position: { x: node.x, y, z: node.z },
            x: node.x,
            y,
            z: node.z,
            distance: distanceXZ(point, node),
            ...(sampled?.tangent ? { tangent: sampled.tangent } : {}),
            ...(sampled?.normal ? { surfaceNormal: sampled.normal } : {}),
        });
    }
    const roads = [];
    for (const edgeId of edgeIds) {
        const edge = graph.edges.get(edgeId);
        if (!edge?.compiled) continue;
        const projection = projectPointToCompiledRoad(point, edge.compiled);
        const halfWidth = finiteNumber(edge.width, DEFAULT_ROAD_WIDTH) * 0.5 + finiteNumber(edge.shoulderWidth, 0);
        if (!projection || projection.distance > halfWidth + tolerance + EPSILON) continue;
        const tangent = edge.compiled.samples.tangents[Math.min(projection.segment, edge.compiled.samples.tangents.length - 1)];
        const normal = { x: -tangent.z / Math.hypot(tangent.x, tangent.z), z: tangent.x / Math.hypot(tangent.x, tangent.z) };
        const rightOffset = (point.x - projection.point.x) * normal.x + (point.z - projection.point.z) * normal.z;
        const laneIndex = nearestLaneIndexForOffset(edge, rightOffset);
        const laneMode = roadLaneCount(edge) === 1 || Math.abs(rightOffset) > CENTERLINE_EPSILON ? "fixed" : "auto";
        const snappedPoint = laneMode === "fixed" ? lanePointAtFraction(edge, laneIndex, projection.fraction) : projection.point;
        const start = edge.compiled.samples.points[projection.segment];
        const end = edge.compiled.samples.points[projection.segment + 1] ?? start;
        roads.push(withRoadRuntimeProjection({
            kind: "road",
            nodeId: null,
            edgeId: edge.id,
            t: projection.fraction,
            laneIndex,
            ...(laneMode === "fixed" ? { laneId: roadLaneId(edge, laneIndex) } : {}),
            laneMode,
            rightOffset,
            centerlinePoint: projection.point,
            point: snappedPoint,
            position: snappedPoint,
            ...snappedPoint,
            distance: projection.distance,
            halfWidth,
        }, {
            segment: projection.segment,
            tangent: {
                dx: end.x - start.x,
                dy: finiteNumber(end.y, 0) - finiteNumber(start.y, 0),
                dz: end.z - start.z,
            },
        }));
    }
    if (intersections.length) return intersections.sort(projectionSort)[0];
    return roads.length ? roads.sort(projectionSort)[0] : null;
}

function intersectionRadius(nodeId, graph, options) {
    if (typeof options.intersectionRadius === "function") {
        return Math.max(0, finiteNumber(options.intersectionRadius(nodeId, graph), 0));
    }
    if (Number.isFinite(options.intersectionRadius)) {
        return Math.max(0, options.intersectionRadius);
    }

    let radius = 0;
    for (const edge of graph.edges.values()) {
        let arm = null;
        if (edge.startNodeId === nodeId) arm = pointFrom(edge.startArm);
        if (edge.endNodeId === nodeId) arm = pointFrom(edge.endArm);
        const node = graph.nodes.get(nodeId);
        if (arm && node) radius = Math.max(radius, distanceXZ(node, arm));
    }
    return radius > EPSILON ? radius : DEFAULT_INTERSECTION_RADIUS;
}

function projectionSort(left, right) {
    return left.distance - right.distance
        || compareText(left.edgeId ?? left.nodeId, right.edgeId ?? right.nodeId)
        || (left.t ?? 0) - (right.t ?? 0);
}

/**
 * Project a world XZ point onto a paved road/intersection footprint.
 * Returns null when the point is outside all footprints; no screen-pixel
 * tolerance is added unless the caller explicitly supplies `tolerance`.
 *
 * Pass `options.graph` (from {@link buildDirectedRoadGraph}) to avoid
 * rebuilding the directed graph on every call.
 */
export function projectPointToRoadNetwork(value, environment, options = {}) {
    const valueLooksEnvironment = Boolean(value?.roads || value?.document?.roads || value?.manifest?.document?.roads);
    const environmentLooksPoint = Boolean(pointFrom(environment));
    const pointValue = valueLooksEnvironment && environmentLooksPoint ? environment : value;
    const environmentValue = valueLooksEnvironment && environmentLooksPoint ? value : environment;
    const point = pointFrom(pointValue);
    if (!point) return null;
    const graph = options.graph?.adjacency instanceof Map
        ? options.graph
        : buildDirectedRoadGraph(environmentValue);
    const tolerance = Math.max(0, finiteNumber(options.tolerance, 0));
    if (graph.geometryVersion === 2) return projectPointToRoadNetworkV2(point, graph, tolerance);
    const candidates = spatialCandidates(graph, point, tolerance);
    const candidateJunctionIds = options.intersectionRadius === undefined && candidates
        ? new Set(candidates.junctionIds)
        : null;
    const candidateEdgeIds = candidates?.edgeIds ?? [...graph.edges.keys()];
    const intersections = [];
    const roads = [];

    for (const node of graph.nodes.values()) {
        const isIntersection = node.kind === "intersection" || (graph.degree.get(node.id) ?? 0) > 1;
        if (!isIntersection) continue;
        if (candidateJunctionIds && !candidateJunctionIds.has(node.id)) continue;
        const distance = distanceXZ(point, node);
        const radius = intersectionRadius(node.id, graph, options);
        if (distance <= radius + tolerance + EPSILON) {
            intersections.push({
                kind: "intersection",
                nodeId: node.id,
                edgeId: null,
                t: null,
                point: { x: node.x, y: node.y, z: node.z },
                position: { x: node.x, y: node.y, z: node.z },
                x: node.x,
                y: node.y,
                z: node.z,
                distance,
                radius,
            });
        }
    }

    for (const edgeId of candidateEdgeIds) {
        const edge = graph.edges.get(edgeId);
        if (!edge) continue;
        const start = graph.nodes.get(edge.startNodeId);
        const end = graph.nodes.get(edge.endNodeId);
        if (!start || !end) continue;
        const projection = projectPointToSegment(point, start, end);
        const halfWidth = finiteNumber(edge.width, DEFAULT_ROAD_WIDTH) * 0.5
            + finiteNumber(edge.shoulderWidth, 0);
        if (projection.distance <= halfWidth + tolerance + EPSILON) {
            const rightOffset = signedRightOffset(point, start, end);
            const laneIndex = nearestLaneIndexForOffset(edge, rightOffset);
            const laneMode = roadLaneCount(edge) === 1 || Math.abs(rightOffset) > CENTERLINE_EPSILON
                ? "fixed"
                : "auto";
            const snappedPoint = laneMode === "fixed"
                ? laneCenterPoint(projection.point, start, end, edge, laneIndex)
                : { ...projection.point };
            roads.push(withRoadRuntimeProjection({
                kind: "road",
                nodeId: null,
                edgeId: edge.id,
                t: projection.t,
                laneIndex,
                laneMode,
                rightOffset,
                centerlinePoint: projection.point,
                point: snappedPoint,
                position: snappedPoint,
                ...snappedPoint,
                distance: projection.distance,
                halfWidth,
            }, {
                segment: 0,
                tangent: {
                    dx: end.x - start.x,
                    dy: finiteNumber(end.y, 0) - finiteNumber(start.y, 0),
                    dz: end.z - start.z,
                },
            }));
        }
    }

    // Match the map editor: a paved intersection wins over overlapping road arms.
    if (intersections.length) return intersections.sort(projectionSort)[0];
    if (roads.length) return roads.sort(projectionSort)[0];
    return null;
}

function fixedLaneIndex(projection, edge) {
    if (projection?.kind !== "road" || projection?.laneMode !== "fixed") return null;
    const laneIndex = Number(projection.laneIndex);
    if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= roadLaneCount(edge)) return null;
    return laneIndex;
}

function projectionAllowsDirection(projection, edge, direction) {
    const laneIndex = fixedLaneIndex(projection, edge);
    return laneIndex === null || laneDirections(edge, laneIndex).includes(direction);
}

function projectionLaneForDirection(projection, edge, direction, fallbackLaneIndex = null) {
    const fixed = fixedLaneIndex(projection, edge);
    if (fixed !== null) return fixed;
    const legal = legalLaneIndices(edge, direction);
    if (Number.isInteger(fallbackLaneIndex) && legal.includes(fallbackLaneIndex)) return fallbackLaneIndex;
    return rightmostLegalLaneIndex(edge, direction);
}

/** True when every supplied XZ point lies on a paved road or intersection. */
export function arePointsOnRoadNetwork(points, environment, options = {}) {
    const list = Array.isArray(points) ? points : [];
    if (list.length === 0) return false;
    const graph = options.graph?.adjacency instanceof Map
        ? options.graph
        : buildDirectedRoadGraph(environment);
    return list.every((point) => Boolean(projectPointToRoadNetwork(point, environment, { ...options, graph })));
}

export const projectWaypointToRoadNetwork = projectPointToRoadNetwork;
export const projectToRoadNetwork = projectPointToRoadNetwork;

function heuristic(graph, nodeId, goalNodeId) {
    const node = graph.nodes.get(nodeId);
    const goal = graph.nodes.get(goalNodeId);
    return node && goal ? distanceXZ(node, goal) : 0;
}

/** Deterministic directed A* whose state retains the incoming edge for legal turn evaluation. */
export function deterministicDirectedAStar(environmentOrGraph, startNodeId, goalNodeId, options = {}) {
    const graph = environmentOrGraph?.adjacency instanceof Map
        ? environmentOrGraph
        : buildDirectedRoadGraph(environmentOrGraph);
    const start = String(startNodeId);
    const goal = String(goalNodeId);
    if (!graph.nodes.has(start) || !graph.nodes.has(goal)) {
        return { ok: false, error: "Start or goal road node does not exist.", nodeIds: [], edgeIds: [], steps: [], cost: Infinity };
    }
    const startIncomingEdgeId = options.incomingEdgeId ? String(options.incomingEdgeId) : null;
    const goalOutgoingEdgeId = options.outgoingEdgeId ? String(options.outgoingEdgeId) : null;
    const constrainGoalIncoming = Object.prototype.hasOwnProperty.call(options, "goalIncomingEdgeId");
    const goalIncomingEdgeId = options.goalIncomingEdgeId === null || options.goalIncomingEdgeId === undefined
        ? null
        : String(options.goalIncomingEdgeId);
    const stateKey = (nodeId, incomingEdgeId) => `${nodeId}\u0000${incomingEdgeId ?? ""}`;
    const parseState = (key) => {
        const separator = key.indexOf("\u0000");
        return {
            nodeId: key.slice(0, separator),
            incomingEdgeId: key.slice(separator + 1) || null,
        };
    };
    const startKey = stateKey(start, startIncomingEdgeId);
    const open = new Set([startKey]);
    const closed = new Set();
    const gScore = new Map([[startKey, 0]]);
    const cameFrom = new Map();

    while (open.size > 0) {
        const current = [...open].sort((left, right) => {
            const leftH = heuristic(graph, parseState(left).nodeId, goal);
            const rightH = heuristic(graph, parseState(right).nodeId, goal);
            const leftF = (gScore.get(left) ?? Infinity) + leftH;
            const rightF = (gScore.get(right) ?? Infinity) + rightH;
            return leftF - rightF || leftH - rightH || compareText(left, right);
        })[0];
        const currentState = parseState(current);

        const exitAllowed = graphMovementAllowed(graph, {
            nodeId: currentState.nodeId,
            fromEdgeId: currentState.incomingEdgeId,
            toEdgeId: goalOutgoingEdgeId,
            ignoreTurnRules: options.ignoreTurnRules === true,
        });
        const arrivalAllowed = !constrainGoalIncoming
            || currentState.incomingEdgeId === goalIncomingEdgeId;
        if (currentState.nodeId === goal && arrivalAllowed && exitAllowed) {
            const steps = [];
            let cursor = current;
            while (cursor !== startKey) {
                const record = cameFrom.get(cursor);
                if (!record) break;
                steps.push(record.transition);
                cursor = record.previousKey;
            }
            steps.reverse();
            return {
                ok: true,
                nodeIds: [start, ...steps.map((step) => step.toNodeId)],
                edgeIds: steps.map((step) => step.edgeId),
                steps,
                cost: gScore.get(current),
            };
        }

        open.delete(current);
        closed.add(current);

        for (const transition of graph.adjacency.get(currentState.nodeId) ?? []) {
            const turnAllowed = graphMovementAllowed(graph, {
                nodeId: currentState.nodeId,
                fromEdgeId: currentState.incomingEdgeId,
                toEdgeId: transition.edgeId,
                ignoreTurnRules: options.ignoreTurnRules === true,
            });
            if (!turnAllowed) continue;
            const next = stateKey(transition.toNodeId, transition.edgeId);
            const tentative = (gScore.get(current) ?? Infinity) + transition.cost;
            const previous = gScore.get(next) ?? Infinity;
            const previousStep = cameFrom.get(next);
            const signature = `${transition.edgeId}:${transition.fromNodeId}:${transition.toNodeId}`;
            const previousSignature = previousStep
                ? `${previousStep.transition.edgeId}:${previousStep.transition.fromNodeId}:${previousStep.transition.toNodeId}`
                : "\uffff";
            const better = tentative < previous - EPSILON
                || (Math.abs(tentative - previous) <= EPSILON && signature < previousSignature);
            if (!better) continue;
            cameFrom.set(next, { previousKey: current, transition });
            gScore.set(next, tentative);
            if (closed.has(next)) closed.delete(next);
            open.add(next);
        }
    }

    return { ok: false, error: "No directed road path exists.", nodeIds: [], edgeIds: [], steps: [], cost: Infinity };
}

export const deterministicAStar = deterministicDirectedAStar;

function edgeTransitions(graph, edgeId) {
    const result = [];
    for (const transitions of graph.adjacency.values()) {
        for (const transition of transitions) {
            if (transition.edgeId === edgeId) result.push(transition);
        }
    }
    return result.sort((left, right) => left.direction - right.direction);
}

function startCandidates(projection, graph, options = {}) {
    if (projection.nodeId) return [{ nodeId: projection.nodeId, cost: 0, traversal: null }];
    const edge = graph.edges.get(projection.edgeId);
    if (!edge) return [];
    return edgeTransitions(graph, edge.id).filter((transition) => (
        projectionAllowsDirection(projection, edge, transition.direction)
    )).map((transition) => {
        const forward = transition.fromNodeId === edge.startNodeId;
        const fraction = forward ? 1 - projection.t : projection.t;
        const laneIndex = projectionLaneForDirection(
            projection,
            edge,
            transition.direction,
            options.incomingEdgeId === edge.id && options.incomingDirection === transition.direction
                ? options.incomingLaneIndex
                : null,
        );
        return {
            nodeId: transition.toNodeId,
            cost: fraction * edge.length,
            laneIndex,
            traversal: fraction <= EPSILON ? null : {
                ...transition,
                fromT: projection.t,
                toT: forward ? 1 : 0,
                partial: true,
                fromLaneIndex: laneIndex,
            },
        };
    });
}

function goalCandidates(projection, graph) {
    if (projection.nodeId) return [{ nodeId: projection.nodeId, cost: 0, traversal: null }];
    const edge = graph.edges.get(projection.edgeId);
    if (!edge) return [];
    return edgeTransitions(graph, edge.id).filter((transition) => (
        projectionAllowsDirection(projection, edge, transition.direction)
    )).map((transition) => {
        const forward = transition.fromNodeId === edge.startNodeId;
        const fraction = forward ? projection.t : 1 - projection.t;
        const laneIndex = projectionLaneForDirection(projection, edge, transition.direction);
        return {
            nodeId: transition.fromNodeId,
            cost: fraction * edge.length,
            laneIndex,
            traversal: fraction <= EPSILON ? null : {
                ...transition,
                fromT: forward ? 0 : 1,
                toT: projection.t,
                partial: true,
                toLaneIndex: laneIndex,
            },
        };
    });
}

function directCandidate(start, goal, graph, options = {}) {
    if (!start.edgeId || start.edgeId !== goal.edgeId) return null;
    const edge = graph.edges.get(start.edgeId);
    if (!edge) return null;
    const candidates = [];
    for (const transition of edgeTransitions(graph, edge.id)) {
        if (!projectionAllowsDirection(start, edge, transition.direction)
            || !projectionAllowsDirection(goal, edge, transition.direction)) {
            continue;
        }
        if (options.incomingEdgeId === edge.id
            && (options.incomingDirection === 1 || options.incomingDirection === -1)
            && transition.direction !== options.incomingDirection) {
            continue;
        }
        const forward = transition.fromNodeId === edge.startNodeId;
        const allowed = forward ? goal.t >= start.t - EPSILON : goal.t <= start.t + EPSILON;
        if (!allowed) continue;
        const cost = Math.abs(goal.t - start.t) * edge.length;
        const fromLaneIndex = projectionLaneForDirection(
            start,
            edge,
            transition.direction,
            options.incomingEdgeId === edge.id && options.incomingDirection === transition.direction
                ? options.incomingLaneIndex
                : null,
        );
        const toLaneIndex = projectionLaneForDirection(goal, edge, transition.direction, fromLaneIndex);
        candidates.push({
            cost,
            traversal: cost <= EPSILON ? [] : [{
                ...transition,
                fromT: start.t,
                toT: goal.t,
                partial: start.t !== 0 || goal.t !== 1,
                fromLaneIndex,
                toLaneIndex,
            }],
            nodeIds: [],
            signature: `direct:${edge.id}:${transition.direction}`,
        });
    }
    return candidates.sort((left, right) => left.cost - right.cost || compareText(left.signature, right.signature))[0] ?? null;
}

function goalArrivalEdgeIds(goal, graph) {
    if (!goal?.nodeId) return [undefined];
    const arrivals = new Set([null]);
    for (const transitions of graph.adjacency.values()) {
        for (const transition of transitions) {
            if (transition.toNodeId === goal.nodeId) arrivals.add(transition.edgeId);
        }
    }
    return [...arrivals].sort((left, right) => compareText(left ?? "", right ?? ""));
}

function resultingIncomingState(candidate, options = {}) {
    const finalStep = candidate.traversal?.at(-1);
    return {
        edgeId: finalStep?.edgeId ?? options.incomingEdgeId ?? null,
        direction: finalStep?.direction ?? options.incomingDirection ?? null,
        laneIndex: finalStep?.toLaneIndex ?? finalStep?.fromLaneIndex ?? options.incomingLaneIndex ?? null,
    };
}

function incomingStateKey(edgeId, direction, laneIndex = null) {
    return `${edgeId ?? ""}\u0000${direction ?? ""}\u0000${laneIndex ?? ""}`;
}

function routeCandidatesBetweenProjections(start, goal, graph, options = {}) {
    const candidates = [];
    const direct = directCandidate(start, goal, graph, options);
    if (direct) candidates.push(direct);

    const goalArrivals = goalArrivalEdgeIds(goal, graph);
    const fromCandidates = startCandidates(start, graph, options).filter((candidate) => (
        !candidate.traversal
        || options.incomingEdgeId !== candidate.traversal.edgeId
        || (options.incomingDirection !== 1 && options.incomingDirection !== -1)
        || (candidate.traversal.direction === options.incomingDirection
            && (!Number.isInteger(options.incomingLaneIndex)
                || candidate.laneIndex === options.incomingLaneIndex))
    ));
    for (const from of fromCandidates) {
        for (const to of goalCandidates(goal, graph)) {
            for (const goalIncomingEdgeId of goalArrivals) {
                const path = deterministicDirectedAStar(graph, from.nodeId, to.nodeId, {
                    incomingEdgeId: from.traversal?.edgeId ?? options.incomingEdgeId,
                    outgoingEdgeId: to.traversal?.edgeId,
                    ...(goalIncomingEdgeId === undefined ? {} : { goalIncomingEdgeId }),
                    ignoreTurnRules: options.ignoreTurnRules === true,
                });
                if (!path.ok) continue;
                const traversal = assignTraversalLanes(
                    start,
                    goal,
                    [from.traversal, ...path.steps, to.traversal].filter(Boolean),
                    graph,
                    options,
                );
                const lateralCost = traversal.reduce((sum, step) => {
                    if (!Number.isInteger(step.fromLaneIndex) || !Number.isInteger(step.toLaneIndex)) return sum;
                    const edge = graph.edges.get(step.edgeId);
                    return edge
                        ? sum + Math.abs(laneCenterRightOffset(edge, step.toLaneIndex) - laneCenterRightOffset(edge, step.fromLaneIndex))
                        : sum;
                }, 0);
                candidates.push({
                    cost: from.cost + path.cost + to.cost + lateralCost,
                    traversal,
                    nodeIds: path.nodeIds,
                    signature: traversal.map((step) => `${step.edgeId}:${step.direction}:${step.fromT ?? "f"}:${step.toT ?? "f"}:${step.fromLaneIndex}:${step.toLaneIndex}`).join("|"),
                });
            }
        }
    }

    if (start.nodeId && goal.nodeId && start.nodeId === goal.nodeId && movementAllowed({
        nodeId: start.nodeId,
        fromEdgeId: options.incomingEdgeId,
        toEdgeId: null,
        nodeDegree: graph.degree.get(start.nodeId) ?? 0,
        turnRules: graph.turnRules,
    })) {
        candidates.push({ cost: 0, traversal: [], nodeIds: [start.nodeId], signature: `node:${start.nodeId}` });
    }

    const bestByArrival = new Map();
    for (const candidate of candidates) {
        const arrival = resultingIncomingState(candidate, options);
        const key = incomingStateKey(arrival.edgeId, arrival.direction, arrival.laneIndex);
        const previous = bestByArrival.get(key);
        if (!previous
            || candidate.cost < previous.cost - EPSILON
            || (Math.abs(candidate.cost - previous.cost) <= EPSILON
                && compareText(candidate.signature, previous.signature) < 0)) {
            bestByArrival.set(key, {
                ...candidate,
                resultingIncomingEdgeId: arrival.edgeId,
                resultingIncomingDirection: arrival.direction,
                resultingIncomingLaneIndex: arrival.laneIndex,
            });
        }
    }
    return [...bestByArrival.values()].sort((left, right) => (
        left.cost - right.cost
        || compareText(left.signature, right.signature)
        || compareText(left.resultingIncomingEdgeId ?? "", right.resultingIncomingEdgeId ?? "")
        || (left.resultingIncomingDirection ?? 0) - (right.resultingIncomingDirection ?? 0)
        || (left.resultingIncomingLaneIndex ?? 0) - (right.resultingIncomingLaneIndex ?? 0)
    ));
}

/**
 * Lateral offset from the road centerline onto the legal right-hand travel
 * lane. Two-way roads use the right half for the selected direction; one-way
 * roads use the rightmost physical lane in their authored direction.
 */
export function rightTravelOffsetMeters(edge, direction = 1) {
    if (!edge) return 0;
    const laneIndex = rightmostLegalLaneIndex(edge, direction);
    return laneIndex === null ? 0 : laneCenterRightOffset(edge, laneIndex);
}

export function pointOnEdgeCenterline(edge, t, graph) {
    if (graph.geometryVersion === 2 && edge.compiled) {
        return samplePolylineAtFraction(
            edge.compiled.samples.points,
            edge.compiled.samples.cumulativeXZ,
            edge.compiled.samples.totalLengthXZ,
            Math.max(0, Math.min(1, finiteNumber(t, 0))),
        )?.point ?? null;
    }
    const start = graph.nodes.get(edge.startNodeId);
    const end = graph.nodes.get(edge.endNodeId);
    if (!start || !end) return null;
    const fraction = Math.max(0, Math.min(1, finiteNumber(t, 0)));
    return {
        x: start.x + ((end.x - start.x) * fraction),
        y: finiteNumber(start.y, 0) + ((finiteNumber(end.y, 0) - finiteNumber(start.y, 0)) * fraction),
        z: start.z + ((end.z - start.z) * fraction),
    };
}

export function edgeBoundaryFractions(edge, graph) {
    if (graph.geometryVersion === 2 && edge.compiled) {
        return { startT: edge.compiled.startMouthFraction, endT: edge.compiled.endMouthFraction };
    }
    const start = graph.nodes.get(edge.startNodeId);
    const end = graph.nodes.get(edge.endNodeId);
    if (!start || !end || !(edge.length > EPSILON)) return { startT: 0, endT: 1 };
    const boundaryT = (node, arm, fallback, fromStart) => {
        const intersection = node.kind === "intersection" || (graph.degree.get(node.id) ?? 0) > 1;
        if (!intersection) return fromStart ? 0 : 1;
        const armPoint = pointFrom(arm);
        const inset = armPoint
            ? distanceXZ(node, armPoint)
            : Math.min(DEFAULT_INTERSECTION_RADIUS, edge.length * 0.5);
        const fraction = Math.max(0, Math.min(0.5, inset / edge.length));
        return fromStart ? fraction : 1 - fraction;
    };
    return {
        startT: boundaryT(start, edge.startArm, 0, true),
        endT: boundaryT(end, edge.endArm, 1, false),
    };
}

function geometryFraction(edge, t, graph) {
    const fraction = Math.max(0, Math.min(1, finiteNumber(t, 0)));
    const bounds = edgeBoundaryFractions(edge, graph);
    if (fraction <= EPSILON) return bounds.startT;
    if (fraction >= 1 - EPSILON) return bounds.endT;
    return fraction;
}

function traversalSubnode(edge, fraction, laneIndex, graph) {
    const position = offsetEdgeSample(edge, fraction, laneIndex, graph);
    return position ? {
        edgeId: edge.id,
        fraction,
        laneIndex,
        // Route v7 (geometry v2) binds the stable lane id; v5 proofs stay byte-identical.
        ...(graph.geometryVersion === 2 ? { laneId: roadLaneId(edge, laneIndex) } : {}),
        position,
    } : null;
}

function travelEndpoints(edge, direction, graph) {
    const start = graph.nodes.get(edge.startNodeId);
    const end = graph.nodes.get(edge.endNodeId);
    if (!start || !end) return null;
    const forward = direction === 1 || direction === undefined || direction === null;
    return forward
        ? { from: { x: start.x, y: start.y, z: start.z }, to: { x: end.x, y: end.y, z: end.z } }
        : { from: { x: end.x, y: end.y, z: end.z }, to: { x: start.x, y: start.y, z: start.z } };
}

export function offsetEdgeSample(edge, t, laneIndex, graph) {
    if (graph.geometryVersion === 2 && edge.compiled) return lanePointAtFraction(edge, laneIndex, t);
    const center = pointOnEdgeCenterline(edge, t, graph);
    const start = graph.nodes.get(edge.startNodeId);
    const end = graph.nodes.get(edge.endNodeId);
    if (!center || !start || !end) return null;
    return offsetRoadPoint(center, start, end, laneCenterRightOffset(edge, laneIndex));
}

/** Offset travel line for an edge: origin at the travel-start offset, unit tangent along travel. */
function offsetTravelLine(edge, direction, laneIndex, graph) {
    const endpoints = travelEndpoints(edge, direction, graph);
    const start = graph.nodes.get(edge.startNodeId);
    const end = graph.nodes.get(edge.endNodeId);
    if (!endpoints || !start || !end) return null;
    const dx = endpoints.to.x - endpoints.from.x;
    const dz = endpoints.to.z - endpoints.from.z;
    const length = Math.hypot(dx, dz);
    if (length <= EPSILON) return null;
    const offset = laneCenterRightOffset(edge, laneIndex);
    const origin = offsetRoadPoint(endpoints.from, start, end, offset);
    if (!origin) return null;
    return {
        origin,
        tangent: { x: dx / length, z: dz / length },
        length,
        offset,
    };
}

/** Map a centerline fraction onto distance along the travel-direction offset line. */
function centerlineTToTravelAlong(t, direction, length) {
    const fraction = Math.max(0, Math.min(1, finiteNumber(t, 0)));
    return direction === -1 ? (1 - fraction) * length : fraction * length;
}

/**
 * Corner where two consecutive offset travel lines meet. Falls back to null when
 * parallel, too far from the shared node, or outside the usable segment span.
 */
function offsetCornerBetween(prev, next, graph) {
    const lineA = offsetTravelLine(prev.edge, prev.direction, prev.toLaneIndex, graph);
    const lineB = offsetTravelLine(next.edge, next.direction, next.fromLaneIndex, graph);
    if (!lineA || !lineB) return null;
    const hit = intersectTravelLinesXZ(lineA.origin, lineA.tangent, lineB.origin, lineB.tangent);
    if (!hit) return null;

    const sinTheta = Math.abs(lineA.tangent.x * lineB.tangent.z - lineA.tangent.z * lineB.tangent.x);
    const maxDistance = (Math.abs(lineA.offset) + Math.abs(lineB.offset) + 1) / Math.max(sinTheta, 0.2);
    const nodeId = prev.step.toNodeId && next.step.fromNodeId && prev.step.toNodeId === next.step.fromNodeId
        ? prev.step.toNodeId
        : (prev.direction === -1 ? prev.edge.startNodeId : prev.edge.endNodeId);
    const node = graph.nodes.get(nodeId);
    if (node && distanceXZ(hit, node) > maxDistance + EPSILON) return null;

    const fromAlongA = centerlineTToTravelAlong(prev.fromT, prev.direction, lineA.length);
    const toAlongB = centerlineTToTravelAlong(next.toT, next.direction, lineB.length);
    // Allow right-turn corners past the inbound node / before the outbound origin
    // (intersection box). Only reject when the corner is behind the section start
    // or past the section goal (waypoint inside the setback).
    if (hit.tAlongA < fromAlongA - EPSILON) return null;
    if (hit.tAlongB > toAlongB + EPSILON) return null;

    return { x: hit.x, y: hit.y, z: hit.z };
}

function stepDirection(step, edge) {
    if (step.direction === 1 || step.direction === -1) return step.direction;
    if (step.fromNodeId === edge.startNodeId) return 1;
    if (step.fromNodeId === edge.endNodeId) return -1;
    if (Number.isFinite(step.fromT) && Number.isFinite(step.toT)) {
        return step.toT >= step.fromT - EPSILON ? 1 : -1;
    }
    return 1;
}

function segmentFromTraversalStep(step, graph) {
    if (!step?.edgeId) return null;
    const edge = graph.edges.get(step.edgeId);
    if (!edge) return null;
    const direction = stepDirection(step, edge);
    const defaultFromT = direction === 1 ? 0 : 1;
    const defaultToT = direction === 1 ? 1 : 0;
    const fromT = Number.isFinite(step.fromSubnode?.fraction)
        ? step.fromSubnode.fraction
        : geometryFraction(edge, Number.isFinite(step.fromT) ? step.fromT : defaultFromT, graph);
    const toT = Number.isFinite(step.toSubnode?.fraction)
        ? step.toSubnode.fraction
        : geometryFraction(edge, Number.isFinite(step.toT) ? step.toT : defaultToT, graph);
    const defaultLaneIndex = rightmostLegalLaneIndex(edge, direction);
    return {
        step,
        edge,
        direction,
        fromT,
        toT,
        fromLaneIndex: step.fromLaneIndex ?? defaultLaneIndex,
        toLaneIndex: step.toLaneIndex ?? step.fromLaneIndex ?? defaultLaneIndex,
    };
}

export function connectorSamples(prev, next, graph) {
    if (graph.geometryVersion === 2 && graph.compiledPlan) {
        const nodeId = prev.step.toNodeId === next.step.fromNodeId ? prev.step.toNodeId : null;
        if (nodeId) {
            const connector = buildJunctionConnector(graph.compiledPlan, {
                nodeId,
                fromEdgeId: prev.edge.id,
                toEdgeId: next.edge.id,
                fromLaneIndex: prev.toLaneIndex,
                toLaneIndex: next.fromLaneIndex,
            });
            if (connector) return connector.points;
        }
    }
    const from = prev.step.toSubnode?.position
        ?? offsetEdgeSample(prev.edge, prev.toT, prev.toLaneIndex, graph);
    const to = next.step.fromSubnode?.position
        ?? offsetEdgeSample(next.edge, next.fromT, next.fromLaneIndex, graph);
    if (!from || !to) return [];
    const lineA = offsetTravelLine(prev.edge, prev.direction, prev.toLaneIndex, graph);
    const lineB = offsetTravelLine(next.edge, next.direction, next.fromLaneIndex, graph);
    const dot = lineA && lineB
        ? lineA.tangent.x * lineB.tangent.x + lineA.tangent.z * lineB.tangent.z
        : 1;
    if (!lineA || !lineB || Math.abs(1 - dot) <= 1e-7) {
        return [
            { ...from },
            {
                x: (from.x + to.x) * 0.5,
                y: (finiteNumber(from.y, 0) + finiteNumber(to.y, 0)) * 0.5,
                z: (from.z + to.z) * 0.5,
            },
            { ...to },
        ];
    }
    const corner = offsetCornerBetween(prev, next, graph);
    if (!corner) {
        const nodeId = prev.step.toNodeId === next.step.fromNodeId ? prev.step.toNodeId : null;
        const node = nodeId ? graph.nodes.get(nodeId) : null;
        return node ? [{ ...from }, { x: node.x, y: node.y, z: node.z }, { ...to }] : [{ ...from }, { ...to }];
    }
    const samples = [];
    for (let index = 0; index < INTERSECTION_CONNECTOR_SAMPLES; index += 1) {
        const t = index / (INTERSECTION_CONNECTOR_SAMPLES - 1);
        const inverse = 1 - t;
        samples.push({
            x: inverse * inverse * from.x + 2 * inverse * t * corner.x + t * t * to.x,
            y: inverse * inverse * finiteNumber(from.y, 0) + 2 * inverse * t * finiteNumber(corner.y, 0) + t * t * finiteNumber(to.y, 0),
            z: inverse * inverse * from.z + 2 * inverse * t * corner.z + t * t * to.z,
        });
    }
    return samples;
}

/** Add deterministic physical-lane assignments to a legal edge traversal. */
export function assignTraversalLanes(start, goal, traversal, graph, options = {}) {
    const steps = (Array.isArray(traversal) ? traversal : []).map((step) => ({ ...step }));
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const edge = graph.edges.get(step.edgeId);
        if (!edge) continue;
        const direction = stepDirection(step, edge);
        const defaultLaneIndex = rightmostLegalLaneIndex(edge, direction);
        step.fromLaneIndex = Number.isInteger(step.fromLaneIndex) ? step.fromLaneIndex : defaultLaneIndex;
        step.toLaneIndex = Number.isInteger(step.toLaneIndex) ? step.toLaneIndex : step.fromLaneIndex;

        if (index === 0 && start?.kind === "road" && start.edgeId === edge.id) {
            step.fromLaneIndex = projectionLaneForDirection(
                start,
                edge,
                direction,
                options.incomingEdgeId === edge.id && options.incomingDirection === direction
                    ? options.incomingLaneIndex
                    : step.fromLaneIndex,
            );
        }
        if (index === steps.length - 1 && goal?.kind === "road" && goal.edgeId === edge.id) {
            step.toLaneIndex = projectionLaneForDirection(goal, edge, direction, step.fromLaneIndex);
        }
        const defaultFromT = direction === 1 ? 0 : 1;
        const defaultToT = direction === 1 ? 1 : 0;
        const fromT = Number.isFinite(step.fromT) ? step.fromT : defaultFromT;
        const toT = Number.isFinite(step.toT) ? step.toT : defaultToT;
        const geometryFromT = geometryFraction(edge, fromT, graph);
        const geometryToT = geometryFraction(edge, toT, graph);
        if (graph.geometryVersion === 2) {
            step.fromLaneId = roadLaneId(edge, step.fromLaneIndex);
            step.toLaneId = roadLaneId(edge, step.toLaneIndex);
        }
        step.fromSubnode = traversalSubnode(edge, geometryFromT, step.fromLaneIndex, graph);
        step.toSubnode = traversalSubnode(edge, geometryToT, step.toLaneIndex, graph);
    }
    return steps;
}

function smoothstep(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
}

export function samplesForSegment(segment, graph) {
    if (graph.geometryVersion === 2 && segment.edge.compiled) {
        const samples = segment.edge.compiled.samples;
        const minimum = Math.min(segment.fromT, segment.toT);
        const maximum = Math.max(segment.fromT, segment.toT);
        const fractions = [segment.fromT];
        for (const distance of samples.cumulativeXZ.slice(1, -1)) {
            const fraction = distance / samples.totalLengthXZ;
            if (fraction > minimum + EPSILON && fraction < maximum - EPSILON) fractions.push(fraction);
        }
        fractions.push(segment.toT);
        if (segment.toT < segment.fromT) fractions.sort((left, right) => right - left);
        else fractions.sort((left, right) => left - right);
        return fractions.map((fraction, index) => {
            const progress = fractions.length <= 1 ? 0 : index / (fractions.length - 1);
            const fromOffset = laneCenterRightOffset(segment.edge, segment.fromLaneIndex);
            const toOffset = laneCenterRightOffset(segment.edge, segment.toLaneIndex);
            const offset = fromOffset + (toOffset - fromOffset) * smoothstep(progress);
            const sampled = samplePolylineAtFraction(samples.points, samples.cumulativeXZ, samples.totalLengthXZ, fraction);
            const tangent = samples.tangents[Math.min(sampled.index, samples.tangents.length - 1)];
            const normalLength = Math.hypot(tangent.x, tangent.z);
            return {
                x: sampled.point.x - tangent.z / normalLength * offset,
                y: sampled.point.y,
                z: sampled.point.z + tangent.x / normalLength * offset,
            };
        });
    }
    const sampleCount = segment.fromLaneIndex === segment.toLaneIndex ? 2 : 8;
    const fromOffset = laneCenterRightOffset(segment.edge, segment.fromLaneIndex);
    const toOffset = laneCenterRightOffset(segment.edge, segment.toLaneIndex);
    const start = graph.nodes.get(segment.edge.startNodeId);
    const end = graph.nodes.get(segment.edge.endNodeId);
    if (!start || !end) return [];
    const points = [];
    for (let index = 0; index < sampleCount; index += 1) {
        const fraction = index / (sampleCount - 1);
        const t = segment.fromT + (segment.toT - segment.fromT) * fraction;
        const center = pointOnEdgeCenterline(segment.edge, t, graph);
        if (!center) continue;
        const rightOffset = fromOffset + (toOffset - fromOffset) * smoothstep(fraction);
        points.push(offsetRoadPoint(center, start, end, rightOffset));
    }
    return points;
}

function rebuildSectionArc(section) {
    const arc = buildArcLengthPolyline(section.polyline);
    return {
        ...section,
        polyline: arc.polyline,
        cumulativeDistances: arc.cumulativeDistances,
        length: arc.totalLength,
    };
}

/**
 * Stitch consecutive verified-route sections that meet at a shared node
 * (typically an intermediate intersection waypoint). Replaces the duplicated
 * inbound/outbound node-offset samples with the same offset-line corner used
 * within a single offsetTravelPolyline call. Parallel / far joins keep the
 * original endpoints (flatten+dedupe later).
 */
export function stitchTravelSectionPolylines(sections, graph) {
    if (!Array.isArray(sections) || sections.length < 2 || !graph?.edges) {
        return Array.isArray(sections) ? sections.map((section) => ({ ...section, polyline: [...(section.polyline || [])] })) : [];
    }

    const next = sections.map((section) => ({
        ...section,
        polyline: (section.polyline || []).map((point) => ({ ...point })),
        edgeTraversal: Array.isArray(section.edgeTraversal)
            ? section.edgeTraversal.map((step) => ({ ...step }))
            : [],
    }));

    for (let index = 0; index < next.length - 1; index += 1) {
        const left = next[index];
        const right = next[index + 1];
        const prevStep = left.edgeTraversal.at(-1);
        const nextStep = right.edgeTraversal[0];
        if (!prevStep || !nextStep) continue;

        const shared = prevStep.toNodeId
            && nextStep.fromNodeId
            && prevStep.toNodeId === nextStep.fromNodeId;
        if (!shared) continue;

        const prev = segmentFromTraversalStep(prevStep, graph);
        const following = segmentFromTraversalStep(nextStep, graph);
        if (!prev || !following) continue;

        const connector = connectorSamples(prev, following, graph);
        if (connector.length < 2) continue;
        const midpointIndex = Math.floor((connector.length - 1) * 0.5);
        const leftConnector = connector.slice(1, midpointIndex + 1);
        const rightConnector = connector.slice(midpointIndex, -1);
        left.polyline.push(...leftConnector.map((point) => ({ ...point })));
        right.polyline.unshift(...rightConnector.map((point) => ({ ...point })));

        next[index] = rebuildSectionArc(left);
        next[index + 1] = rebuildSectionArc(right);
    }

    return next;
}

/**
 * Build the canonical travel polyline for a directed path: samples sit on the
 * right-hand travel side of each edge. Intersection node centers are omitted;
 * consecutive edges meet at the intersection of their offset travel lines so
 * fillets can round a true corner (not a node-overshoot jog).
 */
export function offsetTravelPolyline(start, goal, candidate, graph) {
    const traversal = assignTraversalLanes(start, goal, candidate?.traversal, graph);
    const points = [];
    const push = (point) => {
        if (!point) return;
        const previous = points[points.length - 1];
        if (previous && distanceXZ(previous, point) <= EPSILON) return;
        points.push({ ...point });
    };

    if (traversal.length === 0) {
        // Same-edge zero-length or same-intersection: keep endpoints, offset if on a road.
        if (start?.edgeId && start.edgeId === goal?.edgeId) {
            const edge = graph.edges.get(start.edgeId);
            if (edge) {
                const direction = (goal.t ?? 0) >= (start.t ?? 0) - EPSILON ? 1 : -1;
                const laneIndex = nearestLegalLaneIndex(
                    edge,
                    direction,
                    goal.laneIndex ?? start.laneIndex,
                    goal.rightOffset ?? start.rightOffset,
                );
                push(offsetEdgeSample(edge, start.t ?? 0, laneIndex, graph));
                push(offsetEdgeSample(edge, goal.t ?? start.t ?? 0, laneIndex, graph));
                return points;
            }
        }
        if (start?.point) push(start.point);
        if (goal?.point) push(goal.point);
        return points;
    }

    const segments = [];
    for (let index = 0; index < traversal.length; index += 1) {
        const step = traversal[index];
        const edge = graph.edges.get(step.edgeId);
        if (!edge) continue;
        const direction = stepDirection(step, edge);
        const defaultFromT = direction === 1 ? 0 : 1;
        const defaultToT = direction === 1 ? 1 : 0;
        let fromT = Number.isFinite(step.fromSubnode?.fraction)
            ? step.fromSubnode.fraction
            : geometryFraction(edge, Number.isFinite(step.fromT) ? step.fromT : defaultFromT, graph);
        let toT = Number.isFinite(step.toSubnode?.fraction)
            ? step.toSubnode.fraction
            : geometryFraction(edge, Number.isFinite(step.toT) ? step.toT : defaultToT, graph);

        if (index === 0 && start?.kind === "road" && start.edgeId === edge.id && Number.isFinite(start.t)) {
            fromT = geometryFraction(edge, start.t, graph);
        }
        if (index === traversal.length - 1 && goal?.kind === "road" && goal.edgeId === edge.id && Number.isFinite(goal.t)) {
            toT = geometryFraction(edge, goal.t, graph);
        }

        segments.push({
            step,
            edge,
            direction,
            fromT,
            toT,
            fromLaneIndex: step.fromLaneIndex,
            toLaneIndex: step.toLaneIndex,
        });
    }

    if (segments.length === 0) {
        if (start?.point) push(start.point);
        return points;
    }

    const chunks = segments.map((segment) => samplesForSegment(segment, graph));
    for (let index = 0; index < chunks.length; index += 1) {
        for (const point of chunks[index]) push(point);
        if (index < chunks.length - 1) {
            for (const point of connectorSamples(segments[index], segments[index + 1], graph)) push(point);
        }
    }

    if (points.length === 0 && start?.point) push(start.point);
    return points;
}

function buildBidirectionalShadowGraph(graph) {
    const document = {
        environmentId: graph.document?.environmentId ?? null,
        roads: {
            ...(graph.geometryVersion === 2 ? { geometryVersion: 2 } : {}),
            nodes: [...graph.nodes.values()],
            edges: [...graph.edges.values()].map((edge) => ({
                ...edge,
                bidirectional: true,
                oneWay: false,
                direction: 1,
                oneWayDirection: 1,
            })),
            turnRules: [],
        },
    };
    return buildDirectedRoadGraph(document);
}

/** Internal undirected connectivity check (no offset geometry needed). */
function routeBetweenProjectionsExists(start, goal, graph, options = {}) {
    if (!start || !goal) return { ok: false };
    const candidates = routeCandidatesBetweenProjections(start, goal, graph, options);
    return candidates.length > 0 ? { ok: true } : { ok: false };
}

function classifyRouteFailure(start, goal, graph, options = {}) {
    const laneConstrained = start?.laneMode === "fixed" || goal?.laneMode === "fixed";
    if (laneConstrained) {
        const flexibleStart = start?.kind === "road" ? { ...start, laneMode: "auto" } : start;
        const flexibleGoal = goal?.kind === "road" ? { ...goal, laneMode: "auto" } : goal;
        const laneAgnostic = routeBetweenProjectionsExists(flexibleStart, flexibleGoal, graph, options);
        if (laneAgnostic.ok) {
            return {
                ok: false,
                code: "route.section.lane-unreachable",
                error: "No legal route can reach the selected waypoint lane from the current approach.",
            };
        }
    }
    const unrestricted = routeBetweenProjectionsExists(start, goal, graph, {
        ...options,
        ignoreTurnRules: true,
    });
    if (unrestricted.ok) {
        return {
            ok: false,
            code: "route.section.turn-restricted",
            error: "Every directed road path between these waypoints violates an intersection turn rule.",
        };
    }
    const shadow = buildBidirectionalShadowGraph(graph);
    const undirected = routeBetweenProjectionsExists(start, goal, shadow, { ignoreTurnRules: true });
    if (undirected.ok) {
        return {
            ok: false,
            code: "route.section.illegal-direction",
            error: "Traveling this section would go the wrong way on a one-way road.",
        };
    }
    return {
        ok: false,
        code: "route.section.disconnected",
        error: "No directed road path exists between waypoints.",
    };
}

/** Route between two already-projected road/intersection positions. */
export function routeBetweenProjections(start, goal, environmentOrGraph, options = {}) {
    const graph = environmentOrGraph?.adjacency instanceof Map
        ? environmentOrGraph
        : buildDirectedRoadGraph(environmentOrGraph);
    if (!start || !goal) {
        return {
            ok: false,
            code: "route.section.disconnected",
            error: "Both route endpoints must be projected onto the road network.",
        };
    }
    if (graph.laneIssues?.length > 0) {
        const issue = graph.laneIssues[0];
        return {
            ok: false,
            code: "route.environment.lane-layout-invalid",
            error: `Road "${issue.edgeId}" has an invalid lane layout: ${issue.error}`,
        };
    }
    if (graph.turnRuleIssues?.length > 0) {
        const issue = graph.turnRuleIssues[0];
        return {
            ok: false,
            code: "route.environment.turn-rules-invalid",
            error: `Turn rule ${issue.index} is invalid: ${issue.error}.`,
        };
    }

    const best = routeCandidatesBetweenProjections(start, goal, graph, options)[0];
    if (!best) return classifyRouteFailure(start, goal, graph, options);
    return finalizeRouteCandidate(start, goal, best, graph);
}

function finalizeRouteCandidate(start, goal, candidate, graph) {
    const edgeTraversal = assignTraversalLanes(start, goal, candidate.traversal, graph, candidate.options);
    return {
        ok: true,
        cost: candidate.cost,
        nodeIds: candidate.nodeIds,
        edgeIds: edgeTraversal.map((step) => step.edgeId),
        edgeTraversal,
        polyline: offsetTravelPolyline(start, goal, { ...candidate, traversal: edgeTraversal }, graph),
        incomingEdgeId: candidate.resultingIncomingEdgeId ?? edgeTraversal.at(-1)?.edgeId ?? null,
        incomingDirection: candidate.resultingIncomingDirection ?? edgeTraversal.at(-1)?.direction ?? null,
        incomingLaneIndex: candidate.resultingIncomingLaneIndex
            ?? edgeTraversal.at(-1)?.toLaneIndex
            ?? edgeTraversal.at(-1)?.fromLaneIndex
            ?? null,
        signature: candidate.signature,
    };
}

/**
 * Route every ordered projection as one deterministic staged itinerary.
 * Arrival-edge states are retained at waypoint boundaries so a longer legal
 * approach can win when the locally shortest approach would make the next
 * authored movement illegal.
 */
export function routeOrderedProjections(projections, environmentOrGraph) {
    const graph = environmentOrGraph?.adjacency instanceof Map
        ? environmentOrGraph
        : buildDirectedRoadGraph(environmentOrGraph);
    const points = Array.isArray(projections) ? projections : [];
    if (points.length < 2) {
        return { ok: false, code: "route.section.disconnected", error: "A staged itinerary requires at least two projected waypoints.", section: 0 };
    }
    if (graph.laneIssues?.length > 0 || graph.turnRuleIssues?.length > 0) {
        return routeBetweenProjections(points[0], points[1], graph);
    }

    let states = [{ incomingEdgeId: null, incomingDirection: null, incomingLaneIndex: null, cost: 0, paths: [], signature: "" }];
    for (let section = 0; section < points.length - 1; section += 1) {
        const start = points[section];
        const goal = points[section + 1];
        const incomingStates = states.map((state) => ({
            incomingEdgeId: state.incomingEdgeId,
            incomingDirection: state.incomingDirection,
            incomingLaneIndex: state.incomingLaneIndex,
        }));
        const nextByArrival = new Map();
        for (const state of states) {
            const candidates = routeCandidatesBetweenProjections(start, goal, graph, {
                incomingEdgeId: state.incomingEdgeId,
                incomingDirection: state.incomingDirection,
                incomingLaneIndex: state.incomingLaneIndex,
            });
            for (const candidate of candidates) {
                const candidateWithOptions = {
                    ...candidate,
                    options: {
                        incomingEdgeId: state.incomingEdgeId,
                        incomingDirection: state.incomingDirection,
                        incomingLaneIndex: state.incomingLaneIndex,
                    },
                };
                const path = finalizeRouteCandidate(start, goal, candidateWithOptions, graph);
                const incomingEdgeId = candidate.resultingIncomingEdgeId ?? state.incomingEdgeId;
                const incomingDirection = candidate.resultingIncomingDirection ?? state.incomingDirection;
                const incomingLaneIndex = candidate.resultingIncomingLaneIndex ?? state.incomingLaneIndex;
                const arrivalKey = incomingStateKey(incomingEdgeId, incomingDirection, incomingLaneIndex);
                const cost = state.cost + candidate.cost;
                const signature = `${state.signature}\u0001${candidate.signature}`;
                const previous = nextByArrival.get(arrivalKey);
                if (!previous
                    || cost < previous.cost - EPSILON
                    || (Math.abs(cost - previous.cost) <= EPSILON && compareText(signature, previous.signature) < 0)) {
                    nextByArrival.set(arrivalKey, {
                        incomingEdgeId,
                        incomingDirection,
                        incomingLaneIndex,
                        cost,
                        paths: [...state.paths, path],
                        signature,
                    });
                }
            }
        }
        states = [...nextByArrival.values()];
        if (states.length === 0) {
            const failures = routeItineraryFailures(start, goal, graph, incomingStates);
            const failure = failures[0] ?? classifyRouteFailure(start, goal, graph);
            return { ...failure, section };
        }
    }

    const best = states.sort((left, right) => (
        left.cost - right.cost || compareText(left.signature, right.signature)
    ))[0];
    return { ok: true, cost: best.cost, paths: best.paths };
}

function routeItineraryFailures(start, goal, graph, incomingStates) {
    const priority = new Map([
        ["route.environment.lane-layout-invalid", 0],
        ["route.environment.turn-rules-invalid", 1],
        ["route.section.lane-unreachable", 2],
        ["route.section.turn-restricted", 3],
        ["route.section.illegal-direction", 4],
        ["route.section.disconnected", 5],
    ]);
    return incomingStates.map((incoming) => (
        routeBetweenProjections(start, goal, graph, incoming)
    )).filter((result) => !result.ok).sort((left, right) => (
        (priority.get(left.code) ?? 99) - (priority.get(right.code) ?? 99)
    ));
}
