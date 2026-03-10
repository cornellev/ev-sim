import * as THREE from "three";
import Unit from "@/app/util/Unit";
import { Road } from "./Road";
import { Intersection } from "./Intersection";

const DEFAULT_ROAD_OPTIONS = {
    laneWidth: 3.5,
    bidirectionalLaneCount: 2,
    oneWayLaneCount: 1,
    shoulderWidth: 0.2,
    laneMarkingWidth: 0.2,
    dashLength: 3.5,
    dashGap: 2.5,
    elevation: 0.015,
    shoulderElevation: 0.008,
    markingElevation: 0.02,
    surfaceColor: 0x2d3034,
    shoulderColor: 0x4d5055,
    centerLineType: Road.BorderType.DASHED_YELLOW,
    oneWayDividerType: Road.BorderType.DASHED_WHITE,
    borderLeft: Road.BorderType.SOLID_WHITE,
    borderRight: Road.BorderType.SOLID_WHITE,
};

const DEFAULT_NETWORK_OPTIONS = {
    roadOptions: DEFAULT_ROAD_OPTIONS,
    intersectionOptions: {},
    maxIntersectionDegree: 4,
    intersectionInset: null,
    intersectionInsetFactor: 0.75,
    minIntersectionInset: 2.5,
    maxIntersectionInset: 10,
    straightAngleThreshold: -0.965,
    minRoadLength: 3,
    tension: 0.15,
};

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getNodeAdjacency(edges) {
    const adjacency = new Map();

    for (const edge of edges) {
        if (!adjacency.has(edge.startName)) adjacency.set(edge.startName, []);
        if (!adjacency.has(edge.endName)) adjacency.set(edge.endName, []);
        adjacency.get(edge.startName).push(edge);
        adjacency.get(edge.endName).push(edge);
    }

    return adjacency;
}

function validateIntersectionDegrees(adjacency, networkOptions) {
    const violations = [];

    for (const [nodeName, edges] of adjacency.entries()) {
        if (edges.length > networkOptions.maxIntersectionDegree) {
            violations.push({
                nodeName,
                degree: edges.length,
            });
        }
    }

    if (!violations.length) {
        return;
    }

    const summary = violations
        .map(({ nodeName, degree }) => `${nodeName} (${degree})`)
        .join(", ");

    throw new Error(
        `Road network nodes cannot exceed ${networkOptions.maxIntersectionDegree} connected roads. Violations: ${summary}`,
    );
}

function getOtherEndpoint(edge, nodeName) {
    return nodeName === edge.startName ? edge.endVec : edge.startVec;
}

function getOutboundDirection(edge, nodeName) {
    return getOtherEndpoint(edge, nodeName).clone().sub(edge.nodeVectors[nodeName]).setY(0).normalize();
}

function shouldCreateIntersection(nodeName, adjacency, options) {
    const edges = adjacency.get(nodeName) ?? [];
    if (edges.length < 2) return false;
    if (edges.length > 2) return true;

    const [a, b] = edges;
    const dirA = getOutboundDirection(a, nodeName);
    const dirB = getOutboundDirection(b, nodeName);

    if (!Number.isFinite(dirA.x) || !Number.isFinite(dirB.x)) {
        return false;
    }

    return dirA.dot(dirB) > options.straightAngleThreshold;
}

function computeIntersectionInset(nodeName, adjacency, networkOptions) {
    const connectedEdges = adjacency.get(nodeName) ?? [];
    if (connectedEdges.length < 2) return 0;

    let shortestEdge = Infinity;
    for (const edge of connectedEdges) {
        shortestEdge = Math.min(shortestEdge, edge.startVec.distanceTo(edge.endVec));
    }

    const roadOptions = networkOptions.roadOptions;
    const widestRoad = roadOptions.laneWidth * Math.max(roadOptions.bidirectionalLaneCount, roadOptions.oneWayLaneCount);
    const desiredInset = networkOptions.intersectionInset
        ?? widestRoad * networkOptions.intersectionInsetFactor;
    const maxFromEdgeLength = shortestEdge * 0.35;

    return clamp(
        Math.min(desiredInset, maxFromEdgeLength),
        networkOptions.minIntersectionInset,
        networkOptions.maxIntersectionInset,
    );
}

function computeTrimmedEndpoints(edge, trimStart, trimEnd, minRoadLength) {
    const startVec = edge.startVec.clone();
    const endVec = edge.endVec.clone();
    const axis = endVec.clone().sub(startVec);
    const length = axis.length();

    if (length === 0) {
        return {
            startPoint: startVec,
            endPoint: endVec,
        };
    }

    let safeTrimStart = Math.max(0, trimStart);
    let safeTrimEnd = Math.max(0, trimEnd);
    const maxTrim = Math.max(0, length - minRoadLength);
    const totalTrim = safeTrimStart + safeTrimEnd;

    if (totalTrim > maxTrim && totalTrim > 0) {
        const scale = maxTrim / totalTrim;
        safeTrimStart *= scale;
        safeTrimEnd *= scale;
    }

    const direction = axis.normalize();

    return {
        startPoint: startVec.addScaledVector(direction, safeTrimStart),
        endPoint: endVec.addScaledVector(direction, -safeTrimEnd),
    };
}

function createRoadPoints(startPoint, endPoint) {
    const midVec1 = new THREE.Vector3(
        (2 * startPoint.x + endPoint.x) / 3,
        (2 * startPoint.y + endPoint.y) / 3,
        (2 * startPoint.z + endPoint.z) / 3,
    );
    const midVec2 = new THREE.Vector3(
        (startPoint.x + 2 * endPoint.x) / 3,
        (startPoint.y + 2 * endPoint.y) / 3,
        (startPoint.z + 2 * endPoint.z) / 3,
    );

    return [startPoint, midVec1, midVec2, endPoint];
}

function createRoadFromEdge(edge, trimmedEndpoints, networkOptions) {
    const roadOptions = networkOptions.roadOptions;
    const laneCount = edge.bidirectional ? roadOptions.bidirectionalLaneCount : roadOptions.oneWayLaneCount;
    const centerLineType = edge.bidirectional
        ? roadOptions.centerLineType
        : laneCount > 1
            ? roadOptions.oneWayDividerType
            : Road.BorderType.NONE;

    const road = new Road(
        createRoadPoints(trimmedEndpoints.startPoint, trimmedEndpoints.endPoint),
        new Unit(roadOptions.laneWidth * laneCount, Unit.Type.METER),
        roadOptions.borderLeft,
        roadOptions.borderRight,
        {
            ...roadOptions,
            laneCount,
            centerLineType,
            direction: edge.bidirectional ? 0 : 1,
            tension: networkOptions.tension,
        },
    );

    road.oneWay = !edge.bidirectional;
    road.direction = edge.bidirectional ? 0 : 1;
    road.network = {
        startName: edge.startName,
        endName: edge.endName,
        bidirectional: edge.bidirectional,
    };

    return road;
}

/**
 * 
 * @param {THREE.Scene} scene 
 * @param {Map<string, THREE.Vector3>} vectorMap A map to store named vectors (e.g. "center", "leftBoundary", etc.) for use in road generation.
 * @param {Array<Array>} connections A list of connections/tuples between roads, where first element is the start vector name, second element is the end vector name, and third is whether the relation is bidirectional (e.g. [["center", "leftBoundary", true], ...])
 * @param {Object} options
 * @returns {{roads: Road[], intersections: Intersection[], graph: {nodes: Map<string, THREE.Vector3>, edges: Array<Object>, adjacency: Map<string, Array<Object>>}}}
 */
export function buildRoadNetwork(scene, vectorMap, connections, options = {}) {
    const networkOptions = {
        ...DEFAULT_NETWORK_OPTIONS,
        ...options,
        roadOptions: {
            ...DEFAULT_ROAD_OPTIONS,
            ...(options.roadOptions ?? {}),
        },
        intersectionOptions: {
            ...(options.intersectionOptions ?? {}),
        },
    };

    const edges = [];

    for (const [startName, endName, bidirectional = true] of connections) {
        const startVec = vectorMap.get(startName)?.clone();
        const endVec = vectorMap.get(endName)?.clone();

        if (!startVec || !endVec) {
            console.warn(`Missing vector for road connection: ${startName} to ${endName}`);
            continue;
        }

        edges.push({
            startName,
            endName,
            startVec,
            endVec,
            bidirectional,
            nodeVectors: {
                [startName]: startVec,
                [endName]: endVec,
            },
        });
    }

    const adjacency = getNodeAdjacency(edges);
    validateIntersectionDegrees(adjacency, networkOptions);
    const intersectionNodes = new Set(
        [...adjacency.keys()].filter((nodeName) => shouldCreateIntersection(nodeName, adjacency, networkOptions)),
    );

    const nodeInsetMap = new Map();
    for (const nodeName of adjacency.keys()) {
        nodeInsetMap.set(
            nodeName,
            intersectionNodes.has(nodeName)
                ? computeIntersectionInset(nodeName, adjacency, networkOptions)
                : 0,
        );
    }

    const roads = [];

    for (const edge of edges) {
        const trimmedEndpoints = computeTrimmedEndpoints(
            edge,
            nodeInsetMap.get(edge.startName) ?? 0,
            nodeInsetMap.get(edge.endName) ?? 0,
            networkOptions.minRoadLength,
        );
        const road = createRoadFromEdge(edge, trimmedEndpoints, networkOptions);
        edge.road = road;
        edge.trimmedEndpoints = trimmedEndpoints;
        roads.push(road);

        if (scene) {
            road.setup(scene);
        }
    }

    const intersections = [];

    for (const nodeName of intersectionNodes) {
        const nodeEdges = adjacency.get(nodeName) ?? [];
        const intersectionRoads = nodeEdges
            .map((edge) => edge.road)
            .filter(Boolean);

        if (intersectionRoads.length < 2) continue;

        const intersection = new Intersection(intersectionRoads, networkOptions.intersectionOptions);
        intersections.push(intersection);

        if (scene) {
            intersection.setup(scene);
        }
    }

    return {
        roads,
        intersections,
        graph: {
            nodes: vectorMap,
            edges,
            adjacency,
        },
    };
}

export default buildRoadNetwork;