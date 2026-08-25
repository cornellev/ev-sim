import {
    distanceXZ,
    finiteNumber,
    pointFrom,
    projectPointToSegment,
} from "./geometry.js";
import { deterministicHash } from "./hash.js";

const EPSILON = 1e-9;
const DEFAULT_ROAD_WIDTH = 7;
const DEFAULT_INTERSECTION_RADIUS = 5;

function compareText(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

export function environmentDocumentFrom(value) {
    if (!value || typeof value !== "object") return { environmentId: null, roads: { nodes: [], edges: [] } };
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
            nodes: Array.isArray(nodes) ? nodes : [],
            edges: Array.isArray(source.roads?.edges) ? source.roads.edges : [],
        },
    };
}

function canonicalRoadNetwork(value) {
    const document = environmentDocumentFrom(value);
    return {
        environmentId: document.environmentId ?? null,
        nodes: document.roads.nodes
            .map((node) => ({
                id: String(node.id),
                x: finiteNumber(node.x),
                y: finiteNumber(node.y),
                z: finiteNumber(node.z),
                kind: node.kind ?? null,
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
    };
}

export function hashEnvironmentRoadNetwork(value) {
    return deterministicHash(canonicalRoadNetwork(value));
}

function edgeIsBidirectional(edge) {
    return edge.bidirectional !== false && edge.oneWay !== true;
}

function edgeIsReversed(edge) {
    return edge.direction === -1
        || edge.direction === "reverse"
        || edge.oneWayDirection === -1
        || edge.oneWayDirection === "reverse";
}

export function buildDirectedRoadGraph(value) {
    const document = environmentDocumentFrom(value);
    const nodes = new Map();
    for (const node of document.roads.nodes) {
        const point = pointFrom(node);
        if (!node?.id || !point) continue;
        nodes.set(String(node.id), { ...node, ...point, id: String(node.id) });
    }

    const edges = new Map();
    const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
    const degree = new Map([...nodes.keys()].map((id) => [id, 0]));

    const addTransition = (edge, fromNodeId, toNodeId, direction) => {
        const from = nodes.get(fromNodeId);
        const to = nodes.get(toNodeId);
        if (!from || !to) return;
        adjacency.get(fromNodeId).push({
            edgeId: edge.id,
            fromNodeId,
            toNodeId,
            direction,
            cost: distanceXZ(from, to),
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
        edge.length = distanceXZ(start, end);
        edges.set(edge.id, edge);
        degree.set(start.id, (degree.get(start.id) ?? 0) + 1);
        degree.set(end.id, (degree.get(end.id) ?? 0) + 1);

        if (edgeIsBidirectional(edge)) {
            addTransition(edge, start.id, end.id, 1);
            addTransition(edge, end.id, start.id, -1);
        } else if (edgeIsReversed(edge)) {
            addTransition(edge, end.id, start.id, -1);
        } else {
            addTransition(edge, start.id, end.id, 1);
        }
    }

    for (const transitions of adjacency.values()) {
        transitions.sort((left, right) => (
            compareText(left.edgeId, right.edgeId)
            || compareText(left.toNodeId, right.toNodeId)
            || left.direction - right.direction
        ));
    }

    return { document, nodes, edges, adjacency, degree };
}

function intersectionRadius(nodeId, graph, options) {
    if (typeof options.intersectionRadius === "function") {
        return Math.max(0, finiteNumber(options.intersectionRadius(nodeId, graph), 0));
    }
    if (Number.isFinite(options.intersectionRadius)) {
        return Math.max(0, options.intersectionRadius);
    }

    let radius = DEFAULT_INTERSECTION_RADIUS;
    for (const edge of graph.edges.values()) {
        let arm = null;
        if (edge.startNodeId === nodeId) arm = pointFrom(edge.startArm);
        if (edge.endNodeId === nodeId) arm = pointFrom(edge.endArm);
        const node = graph.nodes.get(nodeId);
        if (arm && node) radius = Math.max(radius, distanceXZ(node, arm));
        if (edge.startNodeId === nodeId || edge.endNodeId === nodeId) {
            radius = Math.max(
                radius,
                finiteNumber(edge.width, DEFAULT_ROAD_WIDTH) * 0.5 + finiteNumber(edge.shoulderWidth, 0),
            );
        }
    }
    return radius;
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
    const intersections = [];
    const roads = [];

    for (const node of graph.nodes.values()) {
        const isIntersection = node.kind === "intersection" || (graph.degree.get(node.id) ?? 0) > 1;
        if (!isIntersection) continue;
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

    for (const edge of graph.edges.values()) {
        const start = graph.nodes.get(edge.startNodeId);
        const end = graph.nodes.get(edge.endNodeId);
        if (!start || !end) continue;
        const projection = projectPointToSegment(point, start, end);
        const halfWidth = finiteNumber(edge.width, DEFAULT_ROAD_WIDTH) * 0.5
            + finiteNumber(edge.shoulderWidth, 0);
        if (projection.distance <= halfWidth + tolerance + EPSILON) {
            roads.push({
                kind: "road",
                nodeId: null,
                edgeId: edge.id,
                t: projection.t,
                point: projection.point,
                position: projection.point,
                ...projection.point,
                distance: projection.distance,
                halfWidth,
            });
        }
    }

    // Match the map editor: a paved intersection wins over overlapping road arms.
    if (intersections.length) return intersections.sort(projectionSort)[0];
    if (roads.length) return roads.sort(projectionSort)[0];
    return null;
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

/** Deterministic directed A* over environment-document nodes. */
export function deterministicDirectedAStar(environmentOrGraph, startNodeId, goalNodeId) {
    const graph = environmentOrGraph?.adjacency instanceof Map
        ? environmentOrGraph
        : buildDirectedRoadGraph(environmentOrGraph);
    const start = String(startNodeId);
    const goal = String(goalNodeId);
    if (!graph.nodes.has(start) || !graph.nodes.has(goal)) {
        return { ok: false, error: "Start or goal road node does not exist.", nodeIds: [], edgeIds: [], steps: [], cost: Infinity };
    }
    if (start === goal) {
        return { ok: true, nodeIds: [start], edgeIds: [], steps: [], cost: 0 };
    }

    const open = new Set([start]);
    const closed = new Set();
    const gScore = new Map([[start, 0]]);
    const cameFrom = new Map();

    while (open.size > 0) {
        const current = [...open].sort((left, right) => {
            const leftH = heuristic(graph, left, goal);
            const rightH = heuristic(graph, right, goal);
            const leftF = (gScore.get(left) ?? Infinity) + leftH;
            const rightF = (gScore.get(right) ?? Infinity) + rightH;
            return leftF - rightF || leftH - rightH || compareText(left, right);
        })[0];

        if (current === goal) {
            const steps = [];
            let cursor = goal;
            while (cursor !== start) {
                const step = cameFrom.get(cursor);
                if (!step) break;
                steps.push(step);
                cursor = step.fromNodeId;
            }
            steps.reverse();
            return {
                ok: true,
                nodeIds: [start, ...steps.map((step) => step.toNodeId)],
                edgeIds: steps.map((step) => step.edgeId),
                steps,
                cost: gScore.get(goal),
            };
        }

        open.delete(current);
        closed.add(current);

        for (const transition of graph.adjacency.get(current) ?? []) {
            const next = transition.toNodeId;
            const tentative = (gScore.get(current) ?? Infinity) + transition.cost;
            const previous = gScore.get(next) ?? Infinity;
            const previousStep = cameFrom.get(next);
            const signature = `${transition.edgeId}:${transition.fromNodeId}:${transition.toNodeId}`;
            const previousSignature = previousStep
                ? `${previousStep.edgeId}:${previousStep.fromNodeId}:${previousStep.toNodeId}`
                : "\uffff";
            const better = tentative < previous - EPSILON
                || (Math.abs(tentative - previous) <= EPSILON && signature < previousSignature);
            if (!better) continue;
            cameFrom.set(next, transition);
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

function endpointProjection(nodeId, graph) {
    const node = graph.nodes.get(nodeId);
    return node ? { x: node.x, y: node.y, z: node.z } : null;
}

function startCandidates(projection, graph) {
    if (projection.nodeId) return [{ nodeId: projection.nodeId, cost: 0, traversal: null }];
    const edge = graph.edges.get(projection.edgeId);
    if (!edge) return [];
    return edgeTransitions(graph, edge.id).map((transition) => {
        const forward = transition.fromNodeId === edge.startNodeId;
        const fraction = forward ? 1 - projection.t : projection.t;
        return {
            nodeId: transition.toNodeId,
            cost: fraction * edge.length,
            traversal: fraction <= EPSILON ? null : {
                ...transition,
                fromT: projection.t,
                toT: forward ? 1 : 0,
                partial: true,
            },
        };
    });
}

function goalCandidates(projection, graph) {
    if (projection.nodeId) return [{ nodeId: projection.nodeId, cost: 0, traversal: null }];
    const edge = graph.edges.get(projection.edgeId);
    if (!edge) return [];
    return edgeTransitions(graph, edge.id).map((transition) => {
        const forward = transition.fromNodeId === edge.startNodeId;
        const fraction = forward ? projection.t : 1 - projection.t;
        return {
            nodeId: transition.fromNodeId,
            cost: fraction * edge.length,
            traversal: fraction <= EPSILON ? null : {
                ...transition,
                fromT: forward ? 0 : 1,
                toT: projection.t,
                partial: true,
            },
        };
    });
}

function directCandidate(start, goal, graph) {
    if (!start.edgeId || start.edgeId !== goal.edgeId) return null;
    const edge = graph.edges.get(start.edgeId);
    if (!edge) return null;
    const candidates = [];
    for (const transition of edgeTransitions(graph, edge.id)) {
        const forward = transition.fromNodeId === edge.startNodeId;
        const allowed = forward ? goal.t >= start.t - EPSILON : goal.t <= start.t + EPSILON;
        if (!allowed) continue;
        const cost = Math.abs(goal.t - start.t) * edge.length;
        candidates.push({
            cost,
            traversal: cost <= EPSILON ? [] : [{
                ...transition,
                fromT: start.t,
                toT: goal.t,
                partial: start.t !== 0 || goal.t !== 1,
            }],
            nodeIds: [],
            signature: `direct:${edge.id}:${transition.direction}`,
        });
    }
    return candidates.sort((left, right) => left.cost - right.cost || compareText(left.signature, right.signature))[0] ?? null;
}

function candidatePolyline(start, goal, candidate, graph) {
    const points = [start.point];
    for (const nodeId of candidate.nodeIds) {
        const point = endpointProjection(nodeId, graph);
        if (point) points.push(point);
    }
    points.push(goal.point);
    return points;
}

/** Route between two already-projected road/intersection positions. */
export function routeBetweenProjections(start, goal, environmentOrGraph) {
    const graph = environmentOrGraph?.adjacency instanceof Map
        ? environmentOrGraph
        : buildDirectedRoadGraph(environmentOrGraph);
    if (!start || !goal) return { ok: false, error: "Both route endpoints must be projected onto the road network." };

    const candidates = [];
    const direct = directCandidate(start, goal, graph);
    if (direct) candidates.push(direct);

    for (const from of startCandidates(start, graph)) {
        for (const to of goalCandidates(goal, graph)) {
            const path = deterministicDirectedAStar(graph, from.nodeId, to.nodeId);
            if (!path.ok) continue;
            const traversal = [from.traversal, ...path.steps, to.traversal].filter(Boolean);
            candidates.push({
                cost: from.cost + path.cost + to.cost,
                traversal,
                nodeIds: path.nodeIds,
                signature: traversal.map((step) => `${step.edgeId}:${step.direction}:${step.fromT ?? "f"}:${step.toT ?? "f"}`).join("|"),
            });
        }
    }

    if (start.nodeId && goal.nodeId && start.nodeId === goal.nodeId) {
        candidates.push({ cost: 0, traversal: [], nodeIds: [start.nodeId], signature: `node:${start.nodeId}` });
    }

    const best = candidates.sort((left, right) => (
        left.cost - right.cost || compareText(left.signature, right.signature)
    ))[0];
    if (!best) return { ok: false, error: "No directed road path exists between waypoints." };
    return {
        ok: true,
        cost: best.cost,
        nodeIds: best.nodeIds,
        edgeIds: best.traversal.map((step) => step.edgeId),
        edgeTraversal: best.traversal,
        polyline: candidatePolyline(start, goal, best, graph),
    };
}
