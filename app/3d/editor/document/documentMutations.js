import * as THREE from "three";
import { buildingIdFromFootprint } from "../../city/buildingIds.js";
import {
    edgeAllowsArrivalAtNode,
    edgeAllowsDepartureFromNode,
    movementDefaultAllowed,
    movementRuleKey,
} from "../../../roads/RoadLaneModel.js";
import { createId, DEFAULT_ROAD_EDGE } from "./EnvironmentDocument.js";

export const MAX_INTERSECTION_DEGREE = 4;
export const MIN_BUILDING_DIMENSION = 2;
export const DEFAULT_INTERSECTION_INSET = 5;

function markRoadsAuthored(document) {
    document.roadsAuthored = true;
}

function sortTurnRules(turnRules) {
    turnRules.sort((left, right) => {
        const leftKey = movementRuleKey(left.nodeId, left.fromEdgeId, left.toEdgeId);
        const rightKey = movementRuleKey(right.nodeId, right.fromEdgeId, right.toEdgeId);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function pruneInfeasibleTurnRules(document) {
    const edgeById = new Map(document.roads.edges.map((edge) => [edge.id, edge]));
    document.roads.turnRules ??= [];
    document.roads.turnRules = document.roads.turnRules.filter((rule) => {
        const fromEdge = edgeById.get(rule.fromEdgeId);
        const toEdge = edgeById.get(rule.toEdgeId);
        return Boolean(
            getDocumentNode(document, rule.nodeId)
            && edgeAllowsArrivalAtNode(fromEdge, rule.nodeId)
            && edgeAllowsDepartureFromNode(toEdge, rule.nodeId)
        );
    });
    sortTurnRules(document.roads.turnRules);
}

function roadEdgeKey(startNodeId, endNodeId) {
    return startNodeId < endNodeId
        ? `${startNodeId}:${endNodeId}`
        : `${endNodeId}:${startNodeId}`;
}

export function buildRoadDegreeMap(document) {
    const degreeMap = new Map();

    for (const edge of document.roads.edges) {
        degreeMap.set(edge.startNodeId, (degreeMap.get(edge.startNodeId) ?? 0) + 1);
        degreeMap.set(edge.endNodeId, (degreeMap.get(edge.endNodeId) ?? 0) + 1);
    }

    return degreeMap;
}

export function buildRoadEdgeKeySet(document) {
    return new Set(
        document.roads.edges.map((edge) => roadEdgeKey(edge.startNodeId, edge.endNodeId)),
    );
}

/**
 * Resolve a road node from either an EnvironmentDocument instance or a plain snapshot.
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument | ReturnType<import("./EnvironmentDocument.js").EnvironmentDocument["snapshot"]>} document
 * @param {string} nodeId
 */
export function getDocumentNode(document, nodeId) {
    if (typeof document.getNode === "function") {
        return document.getNode(nodeId);
    }
    return document.roads?.nodes?.find((node) => node.id === nodeId) ?? null;
}

/**
 * @param {{ x: number, z: number }} point
 * @param {import("./EnvironmentDocument.js").RoadNode[]} nodes
 * @param {number} radiusWorld
 */
export function findNearestNode(point, nodes, radiusWorld) {
    let nearest = null;
    let nearestDistance = radiusWorld;

    for (const node of nodes) {
        const dx = node.x - point.x;
        const dz = node.z - point.z;
        const distance = Math.hypot(dx, dz);
        if (distance <= nearestDistance) {
            nearestDistance = distance;
            nearest = node;
        }
    }

    return nearest;
}

function nodeElevation(point) {
    const y = Number(point?.y);
    return Number.isFinite(y) ? y : 0;
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {{ x: number, y?: number, z: number }} point
 * @param {number} [snapRadius]
 */
export function getOrCreateNode(document, point, snapRadius = 2) {
    const existing = findNearestNode(point, document.roads.nodes, snapRadius);
    if (existing) return existing;

    let id = createId("node");
    while (getDocumentNode(document, id)) {
        id = createId("node");
    }

    const node = { id, x: point.x, y: nodeElevation(point), z: point.z };
    document.roads.nodes.push(node);
    return node;
}

/**
 * Remove duplicate node ids while preserving first occurrence.
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 */
export function dedupeRoadNodes(document) {
    const seenIds = new Set();
    document.roads.nodes = document.roads.nodes.filter((node) => {
        if (seenIds.has(node.id)) return false;
        seenIds.add(node.id);
        return true;
    });
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} nodeId
 */
export function getNodeDegree(document, nodeId) {
    return buildRoadDegreeMap(document).get(nodeId) ?? 0;
}

export function isIntersectionNode(document, node) {
    if (!node) return false;
    if (node.kind === "intersection") return true;
    if (node.kind === "endpoint") return false;
    return getNodeDegree(document, node.id) > 1;
}

export function canMoveNode(document, nodeId) {
    const node = getDocumentNode(document, nodeId);
    if (!node) return false;
    if (node.kind === "intersection") return false;
    return getNodeDegree(document, nodeId) <= 1;
}

export function refreshNodeKinds(document) {
    const degreeMap = buildRoadDegreeMap(document);

    for (const node of document.roads.nodes) {
        const degree = degreeMap.get(node.id) ?? 0;
        if (degree > 1 || node.kind === "intersection") {
            node.kind = "intersection";
        } else if (!node.kind) {
            node.kind = "endpoint";
        }
    }
}

/**
 * @param {{ x: number, y?: number, z: number }} from
 * @param {{ x: number, y?: number, z: number }} to
 * @param {number} inset
 */
export function computeArmPoint(from, to, inset = DEFAULT_INTERSECTION_INSET) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    const y = nodeElevation(from);
    if (length <= inset) {
        return { x: to.x, y, z: to.z };
    }
    const scale = inset / length;
    return { x: from.x + dx * scale, y, z: from.z + dz * scale };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {import("./EnvironmentDocument.js").RoadEdge} edge
 */
export function getEdgeRenderEndpoints(document, edge) {
    const startNode = getDocumentNode(document, edge.startNodeId);
    const endNode = getDocumentNode(document, edge.endNodeId);
    if (!startNode || !endNode) return null;

    let startPoint = { x: startNode.x, y: nodeElevation(startNode), z: startNode.z };
    let endPoint = { x: endNode.x, y: nodeElevation(endNode), z: endNode.z };

    if (edge.startArm) {
        startPoint = {
            x: edge.startArm.x,
            y: nodeElevation(edge.startArm.y !== undefined ? edge.startArm : startNode),
            z: edge.startArm.z,
        };
    } else if (isIntersectionNode(document, startNode)) {
        startPoint = computeArmPoint(startNode, endNode);
    }

    if (edge.endArm) {
        endPoint = {
            x: edge.endArm.x,
            y: nodeElevation(edge.endArm.y !== undefined ? edge.endArm : endNode),
            z: edge.endArm.z,
        };
    } else if (isIntersectionNode(document, endNode)) {
        endPoint = computeArmPoint(endNode, startNode);
    }

    return { startPoint, endPoint };
}

/**
 * Golden connector segments from inset road ends to intersection centers.
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument | ReturnType<import("./EnvironmentDocument.js").EnvironmentDocument["snapshot"]>} document
 * @param {import("./EnvironmentDocument.js").RoadEdge} edge
 */
export function getEdgeIntersectionConnectors(document, edge) {
    const endpoints = getEdgeRenderEndpoints(document, edge);
    if (!endpoints) return [];

    const connectors = [];
    const startNode = getDocumentNode(document, edge.startNodeId);
    const endNode = getDocumentNode(document, edge.endNodeId);

    const addConnector = (node, armPoint) => {
        const center = { x: node.x, y: nodeElevation(node), z: node.z };
        if (Math.hypot(armPoint.x - center.x, armPoint.z - center.z) > 0.05) {
            connectors.push({
                from: armPoint,
                to: center,
                nodeId: node.id,
            });
        }
    };

    if (isIntersectionNode(document, startNode)) {
        addConnector(startNode, endpoints.startPoint);
    }

    if (isIntersectionNode(document, endNode)) {
        addConnector(endNode, endpoints.endPoint);
    }

    return connectors;
}

export function findNearestIntersection(point, document, radiusWorld, excludeNodeIds = []) {
    const exclude = new Set(excludeNodeIds);
    const candidates = document.roads.nodes.filter(
        (node) => !exclude.has(node.id) && isIntersectionNode(document, node),
    );
    return findNearestNode(point, candidates, radiusWorld);
}

export function createIntersectionNode(document, point) {
    let id = createId("intersection");
    while (getDocumentNode(document, id)) {
        id = createId("intersection");
    }

    const node = {
        id,
        x: point.x,
        y: nodeElevation(point),
        z: point.z,
        kind: "intersection",
    };
    document.roads.nodes.push(node);
    markRoadsAuthored(document);
    document.notify();
    return node;
}

export function getOrCreateEndpointNode(document, point, snapRadius = 2) {
    const endpointCandidates = document.roads.nodes.filter(
        (node) => !isIntersectionNode(document, node),
    );
    const existing = findNearestNode(point, endpointCandidates, snapRadius);
    if (existing) return existing;

    let id = createId("endpoint");
    while (getDocumentNode(document, id)) {
        id = createId("endpoint");
    }

    const node = {
        id,
        x: point.x,
        y: nodeElevation(point),
        z: point.z,
        kind: "endpoint",
    };
    document.roads.nodes.push(node);
    return node;
}

/**
 * Set elevation (y) on a road endpoint or intersection node. XZ is unchanged.
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} nodeId
 * @param {number} y
 * @param {{ notify?: boolean, markAuthored?: boolean }} [runtime]
 */
export function setRoadNodeElevation(document, nodeId, y, runtime = {}) {
    const node = getDocumentNode(document, nodeId);
    if (!node) {
        return { ok: false, error: "Road node not found." };
    }
    if (!Number.isFinite(Number(y))) {
        return { ok: false, error: "Elevation must be a finite number." };
    }

    node.y = Number(y);

    // Keep junction arms on the plateau at the junction elevation.
    for (const edge of document.roads.edges) {
        if (edge.startNodeId === nodeId && edge.startArm) {
            edge.startArm = { ...edge.startArm, y: node.y };
        }
        if (edge.endNodeId === nodeId && edge.endArm) {
            edge.endArm = { ...edge.endArm, y: node.y };
        }
    }

    if (runtime.markAuthored !== false) {
        markRoadsAuthored(document);
    }
    if (runtime.notify !== false) {
        document.notify();
    }
    return { ok: true, node };
}

export function moveRoadNode(document, nodeId, point, options = {}) {
    if (!canMoveNode(document, nodeId)) {
        return { ok: false, error: "Only free road endpoints can be moved." };
    }

    const { snapRadius = 0 } = options;
    let targetPoint = point;

    if (snapRadius > 0) {
        const edge = document.roads.edges.find(
            (candidate) => candidate.startNodeId === nodeId || candidate.endNodeId === nodeId,
        );
        const excludeIds = [nodeId];
        if (edge) {
            excludeIds.push(
                edge.startNodeId === nodeId ? edge.endNodeId : edge.startNodeId,
            );
        }
        const intersection = findNearestIntersection(point, document, snapRadius, excludeIds);
        if (intersection) {
            targetPoint = {
                x: intersection.x,
                y: nodeElevation(intersection),
                z: intersection.z,
            };
        }
    }

    const node = getDocumentNode(document, nodeId);
    node.x = targetPoint.x;
    node.z = targetPoint.z;
    if (targetPoint.y !== undefined && Number.isFinite(Number(targetPoint.y))) {
        node.y = Number(targetPoint.y);
    } else if (!Number.isFinite(Number(node.y))) {
        node.y = 0;
    }
    node.kind = "endpoint";
    markRoadsAuthored(document);
    document.notify();
    return { ok: true, node };
}

/**
 * Connect a free road endpoint to a nearby intersection, removing the endpoint node.
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} endpointId
 * @param {{ x: number, z: number }} point
 * @param {number} snapRadius
 */
export function connectEndpointToIntersection(document, endpointId, point, snapRadius) {
    if (!canMoveNode(document, endpointId)) {
        return { ok: false, error: "Only free road endpoints can be connected." };
    }

    const edge = document.roads.edges.find(
        (candidate) => candidate.startNodeId === endpointId || candidate.endNodeId === endpointId,
    );
    if (!edge) {
        return { ok: false, error: "Endpoint has no connected road." };
    }

    const otherNodeId = edge.startNodeId === endpointId ? edge.endNodeId : edge.startNodeId;
    const intersection = findNearestIntersection(
        point,
        document,
        snapRadius,
        [endpointId, otherNodeId],
    );
    if (!intersection) {
        return { ok: true, connected: false };
    }

    if (hasEdgeBetween(document, otherNodeId, intersection.id)) {
        return { ok: false, error: "Road already connects to this intersection." };
    }

    if (getNodeDegree(document, intersection.id) >= MAX_INTERSECTION_DEGREE) {
        return {
            ok: false,
            error: `Nodes cannot exceed ${MAX_INTERSECTION_DEGREE} connected roads.`,
        };
    }

    const otherNode = getDocumentNode(document, otherNodeId);

    if (edge.endNodeId === endpointId) {
        edge.endNodeId = intersection.id;
        edge.endArm = computeArmPoint(intersection, otherNode);
    } else {
        edge.startNodeId = intersection.id;
        edge.startArm = computeArmPoint(intersection, otherNode);
    }

    document.roads.nodes = document.roads.nodes.filter((node) => node.id !== endpointId);
    refreshNodeKinds(document);
    markRoadsAuthored(document);
    document.notify();
    return { ok: true, connected: true, intersection, edge };
}

export function findNearestMovableNode(document, point, radiusWorld) {
    const candidates = document.roads.nodes.filter((node) => canMoveNode(document, node.id));
    return findNearestNode(point, candidates, radiusWorld);
}

/**
 * @param {string} nodeId
 */
export function parseGridNodePosition(nodeId) {
    const match = String(nodeId).match(/^point_(-?\d+)_(-?\d+)$/);
    if (!match) return null;
    return { x: Number(match[1]), z: Number(match[2]) };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} startNodeId
 * @param {string} endNodeId
 */
export function hasEdgeBetween(document, startNodeId, endNodeId) {
    return document.roads.edges.some(
        (edge) =>
            (edge.startNodeId === startNodeId && edge.endNodeId === endNodeId)
            || (edge.startNodeId === endNodeId && edge.endNodeId === startNodeId),
    );
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} startNodeId
 * @param {string} endNodeId
 * @param {Object} [options]
 */
export function addRoadEdge(document, startNodeId, endNodeId, options = {}, runtime = {}) {
    if (startNodeId === endNodeId) {
        return { ok: false, error: "Road edge cannot connect a node to itself." };
    }

    const edgeKey = roadEdgeKey(startNodeId, endNodeId);
    const edgeKeySet = runtime.edgeKeySet ?? null;
    if (edgeKeySet ? edgeKeySet.has(edgeKey) : hasEdgeBetween(document, startNodeId, endNodeId)) {
        return { ok: false, error: "Road edge already exists between these nodes." };
    }

    const degreeMap = runtime.degreeMap ?? null;
    const startDegree = degreeMap ? (degreeMap.get(startNodeId) ?? 0) : getNodeDegree(document, startNodeId);
    const endDegree = degreeMap ? (degreeMap.get(endNodeId) ?? 0) : getNodeDegree(document, endNodeId);

    if (startDegree >= MAX_INTERSECTION_DEGREE || endDegree >= MAX_INTERSECTION_DEGREE) {
        return {
            ok: false,
            error: `Nodes cannot exceed ${MAX_INTERSECTION_DEGREE} connected roads.`,
        };
    }

    const edge = {
        id: createId("edge"),
        startNodeId,
        endNodeId,
        bidirectional: options.bidirectional ?? DEFAULT_ROAD_EDGE.bidirectional,
        width: options.width ?? DEFAULT_ROAD_EDGE.width,
        laneCount: options.laneCount ?? DEFAULT_ROAD_EDGE.laneCount,
        shoulderWidth: options.shoulderWidth ?? null,
        tension: options.tension ?? null,
        borderLeft: options.borderLeft ?? null,
        borderRight: options.borderRight ?? null,
        startArm: options.startArm
            ? { x: options.startArm.x, y: nodeElevation(options.startArm), z: options.startArm.z }
            : null,
        endArm: options.endArm
            ? { x: options.endArm.x, y: nodeElevation(options.endArm), z: options.endArm.z }
            : null,
    };

    document.roads.edges.push(edge);
    edgeKeySet?.add(edgeKey);
    if (degreeMap) {
        degreeMap.set(startNodeId, startDegree + 1);
        degreeMap.set(endNodeId, endDegree + 1);
    }
    if (runtime.refreshKinds !== false) {
        refreshNodeKinds(document);
    }
    if (runtime.markAuthored !== false) {
        markRoadsAuthored(document);
    }
    if (runtime.notify !== false) {
        document.notify();
    }
    return { ok: true, edge };
}

/**
 * Update mutable properties on an existing road edge.
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} edgeId
 * @param {{ bidirectional?: boolean, direction?: number | string | null, width?: number, laneCount?: number, shoulderWidth?: number | null, tension?: number | null, borderLeft?: string | null, borderRight?: string | null }} patch
 * @param {{ notify?: boolean, markAuthored?: boolean }} [runtime]
 */
export function updateRoadEdge(document, edgeId, patch = {}, runtime = {}) {
    const edge = document.roads.edges.find((entry) => entry.id === edgeId);
    if (!edge) {
        return { ok: false, error: `Road edge "${edgeId}" does not exist.` };
    }

    if (patch.bidirectional !== undefined) {
        edge.bidirectional = patch.bidirectional !== false;
        if (edge.bidirectional) {
            delete edge.oneWay;
            delete edge.direction;
            delete edge.oneWayDirection;
        } else {
            edge.oneWay = true;
            if (patch.direction === undefined) {
                edge.direction = edge.direction ?? 1;
            }
        }
    }
    if (patch.direction !== undefined) {
        if (patch.direction === null) {
            delete edge.direction;
            delete edge.oneWayDirection;
        } else {
            edge.direction = patch.direction;
        }
    }
    if (patch.width !== undefined) edge.width = patch.width;
    if (patch.laneCount !== undefined) edge.laneCount = patch.laneCount;
    if (patch.shoulderWidth !== undefined) edge.shoulderWidth = patch.shoulderWidth;
    if (patch.tension !== undefined) edge.tension = patch.tension;
    if (patch.borderLeft !== undefined) edge.borderLeft = patch.borderLeft;
    if (patch.borderRight !== undefined) edge.borderRight = patch.borderRight;

    pruneInfeasibleTurnRules(document);

    if (runtime.markAuthored !== false) {
        markRoadsAuthored(document);
    }
    if (runtime.notify !== false) {
        document.notify();
    }
    return { ok: true, edge };
}

/**
 * Return deterministic incoming/outgoing movement cells for an intersection.
 * One-way-impossible movements are omitted from the feasible matrix.
 */
export function getIntersectionMovements(document, nodeId) {
    const degree = getNodeDegree(document, nodeId);
    const incident = document.roads.edges
        .filter((edge) => edge.startNodeId === nodeId || edge.endNodeId === nodeId)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const incoming = incident.filter((edge) => edgeAllowsArrivalAtNode(edge, nodeId));
    const outgoing = incident.filter((edge) => edgeAllowsDepartureFromNode(edge, nodeId));
    const ruleByKey = new Map((document.roads.turnRules ?? []).map((rule) => [
        movementRuleKey(rule.nodeId, rule.fromEdgeId, rule.toEdgeId),
        rule,
    ]));

    return {
        incident,
        incoming,
        outgoing,
        cells: incoming.flatMap((fromEdge) => outgoing.map((toEdge) => {
            const defaultAllowed = movementDefaultAllowed(degree, fromEdge.id, toEdge.id);
            const rule = ruleByKey.get(movementRuleKey(nodeId, fromEdge.id, toEdge.id));
            return {
                nodeId,
                fromEdgeId: fromEdge.id,
                toEdgeId: toEdge.id,
                defaultAllowed,
                allowed: rule ? rule.allowed === true : defaultAllowed,
                overridden: Boolean(rule),
            };
        })),
    };
}

/** Store only sparse movement overrides; choosing the default removes the rule. */
export function setTurnMovementAllowed(document, nodeId, fromEdgeId, toEdgeId, allowed, runtime = {}) {
    const node = getDocumentNode(document, nodeId);
    const fromEdge = document.roads.edges.find((edge) => edge.id === fromEdgeId);
    const toEdge = document.roads.edges.find((edge) => edge.id === toEdgeId);
    if (!node || !fromEdge || !toEdge) {
        return { ok: false, error: "Intersection movement references a missing node or road." };
    }
    if (!edgeAllowsArrivalAtNode(fromEdge, nodeId) || !edgeAllowsDepartureFromNode(toEdge, nodeId)) {
        return { ok: false, error: "The movement is impossible under the road one-way directions." };
    }

    const defaultAllowed = movementDefaultAllowed(getNodeDegree(document, nodeId), fromEdgeId, toEdgeId);
    const desiredAllowed = allowed === true;
    const key = movementRuleKey(nodeId, fromEdgeId, toEdgeId);
    document.roads.turnRules ??= [];
    document.roads.turnRules = document.roads.turnRules.filter((rule) => (
        movementRuleKey(rule.nodeId, rule.fromEdgeId, rule.toEdgeId) !== key
    ));
    if (desiredAllowed !== defaultAllowed) {
        document.roads.turnRules.push({ nodeId, fromEdgeId, toEdgeId, allowed: desiredAllowed });
    }
    sortTurnRules(document.roads.turnRules);
    if (runtime.markAuthored !== false) markRoadsAuthored(document);
    if (runtime.notify !== false) document.notify();
    return { ok: true, defaultAllowed, overridden: desiredAllowed !== defaultAllowed };
}

/**
 * @param {{ x: number, z: number }} a
 * @param {{ x: number, z: number }} b
 * @param {number} [snapSize]
 */
export function snapPoint(point, snapSize = 1) {
    if (!snapSize || snapSize <= 0) {
        return {
            x: point.x,
            ...(point.y !== undefined ? { y: point.y } : {}),
            z: point.z,
        };
    }
    return {
        x: Math.round(point.x / snapSize) * snapSize,
        ...(point.y !== undefined ? { y: point.y } : {}),
        z: Math.round(point.z / snapSize) * snapSize,
    };
}

/**
 * @param {{ x: number, z: number }} cornerA
 * @param {{ x: number, z: number }} cornerB
 * @param {number} [snapSize]
 */
export function normalizeRectangleFootprint(cornerA, cornerB, snapSize = 0) {
    const a = snapSize ? snapPoint(cornerA, snapSize) : cornerA;
    const b = snapSize ? snapPoint(cornerB, snapSize) : cornerB;

    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minZ = Math.min(a.z, b.z);
    const maxZ = Math.max(a.z, b.z);

    return [
        { x: minX, y: 0, z: minZ },
        { x: maxX, y: 0, z: minZ },
        { x: maxX, y: 0, z: maxZ },
        { x: minX, y: 0, z: maxZ },
    ];
}

/**
 * @param {{ x: number, z: number }[]} footprint
 */
export function footprintDimensions(footprint) {
    const xs = footprint.map((point) => point.x);
    const zs = footprint.map((point) => point.z);
    return {
        width: Math.max(...xs) - Math.min(...xs),
        depth: Math.max(...zs) - Math.min(...zs),
    };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {{ x: number, z: number }} cornerA
 * @param {{ x: number, z: number }} cornerB
 * @param {Object} [options]
 */
export function addBuildingRectangle(document, cornerA, cornerB, options = {}) {
    const footprint = normalizeRectangleFootprint(cornerA, cornerB, options.snapSize ?? 0);
    const { width, depth } = footprintDimensions(footprint);

    if (width < MIN_BUILDING_DIMENSION || depth < MIN_BUILDING_DIMENSION) {
        return { ok: false, error: `Building must be at least ${MIN_BUILDING_DIMENSION}m per side.` };
    }

    const buildingId = buildingIdFromFootprint(footprint, document.buildings.length);
    const record = {
        buildingId,
        footprint,
        height: options.height ?? 10,
        textureId: options.textureId ?? 0,
        tags: [...(options.tags ?? ["building"])],
        meshName: options.meshName ?? buildingId,
    };

    document.buildings.push(record);
    document.buildingsAuthored = true;
    document.notify();
    return { ok: true, record };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {Object} feature
 */
export function addFeature(document, feature) {
    const record = {
        id: feature.id ?? createId("feature"),
        type: feature.type,
        x: feature.x,
        z: feature.z,
        dir: feature.dir ?? 0,
        rotationY: feature.rotationY ?? 0,
        tags: [...(feature.tags ?? [])],
    };

    document.features.push(record);
    document.featuresAuthored = true;
    document.notify();
    return { ok: true, record };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} buildingId
 */
export function removeBuilding(document, buildingId) {
    const index = document.buildings.findIndex((building) => building.buildingId === buildingId);
    if (index === -1) {
        return { ok: false, error: "Building not found." };
    }

    document.buildings.splice(index, 1);
    document.buildingsAuthored = true;
    document.notify();
    return { ok: true };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} featureId
 */
export function removeFeature(document, featureId) {
    const index = document.features.findIndex((feature) => feature.id === featureId);
    if (index === -1) {
        return { ok: false, error: "Feature not found." };
    }

    document.features.splice(index, 1);
    document.featuresAuthored = true;
    document.notify();
    return { ok: true };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} featureId
 * @param {{ x: number, z: number }} point
 */
export function moveFeature(document, featureId, point) {
    const feature = document.features.find((record) => record.id === featureId);
    if (!feature) {
        return { ok: false, error: "Feature not found." };
    }

    feature.x = point.x;
    feature.z = point.z;
    document.featuresAuthored = true;
    document.notify();
    return { ok: true, feature };
}

/**
 * Apply the same world-space delta used by TransformTool to a building's
 * authoritative footprint. Building meshes are regenerated from these points
 * on load, so writing the delta here is what makes scene transforms persist.
 *
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} buildingId
 * @param {THREE.Matrix4} deltaMatrixWorld
 * @param {{ notify?: boolean }} [options]
 */
export function transformBuilding(document, buildingId, deltaMatrixWorld, options = {}) {
    const building = document.getBuilding(buildingId);
    if (!building || !deltaMatrixWorld?.isMatrix4) {
        return { ok: false, error: "Building not found or transform is invalid." };
    }

    building.footprint = building.footprint.map((point) => {
        const transformed = new THREE.Vector3(
            Number(point.x) || 0,
            Number(point.y) || 0,
            Number(point.z) || 0,
        ).applyMatrix4(deltaMatrixWorld);
        return { x: transformed.x, y: transformed.y, z: transformed.z };
    });

    // Extrusion height is separate from the footprint. Preserve Y-axis scale
    // from the delta while ignoring translation.
    const linear = new THREE.Matrix3().setFromMatrix4(deltaMatrixWorld);
    const heightScale = new THREE.Vector3(0, 1, 0).applyMatrix3(linear).length();
    if (Number.isFinite(heightScale) && heightScale > 0) {
        building.height *= heightScale;
    }

    document.buildingsAuthored = true;
    if (options.notify !== false) document.notify();
    return { ok: true, building };
}

/**
 * Persist a placed prop's world position and heading.
 *
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} featureId
 * @param {{ x: number, z: number, dir?: number, rotationY?: number }} transform
 * @param {{ notify?: boolean }} [options]
 */
export function transformFeature(document, featureId, transform, options = {}) {
    const feature = document.getFeature(featureId);
    if (!feature) return { ok: false, error: "Feature not found." };

    feature.x = transform.x;
    feature.z = transform.z;
    if (Number.isFinite(transform.dir)) feature.dir = transform.dir;
    if (Number.isFinite(transform.rotationY)) feature.rotationY = transform.rotationY;

    document.featuresAuthored = true;
    if (options.notify !== false) document.notify();
    return { ok: true, feature };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} edgeId
 */
export function removeRoadEdge(document, edgeId) {
    const edgeIndex = document.roads.edges.findIndex((edge) => edge.id === edgeId);
    if (edgeIndex === -1) {
        return { ok: false, error: "Road not found." };
    }

    const edge = document.roads.edges[edgeIndex];
    document.roads.edges.splice(edgeIndex, 1);
    document.roads.turnRules = (document.roads.turnRules ?? []).filter((rule) => (
        rule.fromEdgeId !== edgeId && rule.toEdgeId !== edgeId
    ));

    for (const nodeId of [edge.startNodeId, edge.endNodeId]) {
        if (getNodeDegree(document, nodeId) > 0) continue;

        const node = getDocumentNode(document, nodeId);
        if (!node || node.kind === "intersection") continue;

        document.roads.nodes = document.roads.nodes.filter((candidate) => candidate.id !== nodeId);
    }

    refreshNodeKinds(document);
    markRoadsAuthored(document);
    document.notify();
    return { ok: true };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string} nodeId
 */
export function removeIntersectionNode(document, nodeId) {
    const node = getDocumentNode(document, nodeId);
    if (!node || !isIntersectionNode(document, node)) {
        return { ok: false, error: "Intersection not found." };
    }

    const connectedEdges = document.roads.edges.filter(
        (edge) => edge.startNodeId === nodeId || edge.endNodeId === nodeId,
    );
    const farNodeIds = connectedEdges.map((edge) => (
        edge.startNodeId === nodeId ? edge.endNodeId : edge.startNodeId
    ));

    document.roads.edges = document.roads.edges.filter(
        (edge) => edge.startNodeId !== nodeId && edge.endNodeId !== nodeId,
    );
    document.roads.nodes = document.roads.nodes.filter((candidate) => candidate.id !== nodeId);
    const removedEdgeIds = new Set(connectedEdges.map((edge) => edge.id));
    document.roads.turnRules = (document.roads.turnRules ?? []).filter((rule) => (
        rule.nodeId !== nodeId
        && !removedEdgeIds.has(rule.fromEdgeId)
        && !removedEdgeIds.has(rule.toEdgeId)
    ));

    for (const farNodeId of farNodeIds) {
        if (getNodeDegree(document, farNodeId) > 0) continue;

        const farNode = getDocumentNode(document, farNodeId);
        if (farNode && farNode.kind !== "intersection") {
            document.roads.nodes = document.roads.nodes.filter((candidate) => candidate.id !== farNodeId);
        }
    }

    refreshNodeKinds(document);
    markRoadsAuthored(document);
    document.notify();
    return { ok: true, removedEdges: connectedEdges.length };
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 * @param {{ type: string, id: string }} selection
 */
export function getMapSelectionRecord(document, selection) {
    if (!selection) return null;

    if (selection.type === "building") {
        return document.buildings.find((building) => building.buildingId === selection.id) ?? null;
    }

    if (selection.type === "feature") {
        return document.features.find((feature) => feature.id === selection.id) ?? null;
    }

    if (selection.type === "road") {
        return document.roads.edges.find((edge) => edge.id === selection.id) ?? null;
    }

    if (selection.type === "intersection") {
        return document.roads.nodes.find((node) => node.id === selection.id) ?? null;
    }

    return null;
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 */
export function getIntersectionNodeIds(document) {
    const degreeMap = new Map();

    for (const edge of document.roads.edges) {
        degreeMap.set(edge.startNodeId, (degreeMap.get(edge.startNodeId) ?? 0) + 1);
        degreeMap.set(edge.endNodeId, (degreeMap.get(edge.endNodeId) ?? 0) + 1);
    }

    return [...degreeMap.entries()]
        .filter(([, degree]) => degree > 1)
        .map(([nodeId]) => nodeId);
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 */
export function getIntersectionNodes(document) {
    return document.roads.nodes.filter((node) => isIntersectionNode(document, node));
}

/**
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 */
export function getEndpointNodes(document) {
    return document.roads.nodes.filter((node) => !isIntersectionNode(document, node));
}

/**
 * Convert document road graph to buildRoadNetwork inputs.
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 */
export function documentToRoadNetworkInputs(document) {
    const vectorMap = new Map();
    for (const node of document.roads.nodes) {
        vectorMap.set(node.id, { x: node.x, y: nodeElevation(node), z: node.z });
    }

    const connections = document.roads.edges.map((edge) => [
        edge.startNodeId,
        edge.endNodeId,
        edge.bidirectional !== false,
        {
            width: edge.width,
            laneCount: edge.laneCount,
            shoulderWidth: edge.shoulderWidth,
            tension: edge.tension,
            borderLeft: edge.borderLeft,
            borderRight: edge.borderRight,
            startArm: edge.startArm,
            endArm: edge.endArm,
        },
    ]);

    return { vectorMap, connections };
}
