import {
    addRoadEdge,
    buildRoadDegreeMap,
    buildRoadEdgeKeySet,
    dedupeRoadNodes,
    refreshNodeKinds,
} from "../../editor/document/documentMutations.js";
import { createId } from "../../editor/document/EnvironmentDocument.js";
import { DEFAULT_EARTH_IMPORT_CONFIG } from "../EarthImportConfig.js";
import { latLngToLocal, simplifyLatLngPolyline } from "../GeospatialTransform.js";
import { createRoadNetworkProvider } from "./OverpassRoadProvider.js";

/**
 * @typedef {import("./RoadNetworkProvider.js").NormalizedRoadNetwork} NormalizedRoadNetwork
 */

const HIGHWAY_WIDTHS = Object.freeze({
    motorway: 14,
    trunk: 12,
    primary: 10,
    secondary: 9,
    tertiary: 8,
    residential: 7,
    unclassified: 7,
    service: 5,
    living_street: 6,
});

const ROAD_SNAP_RADIUS_METERS = 3;
const STRAIGHT_CHAIN_DOT_THRESHOLD = 0.9945; // roughly six degrees from perfectly straight

/**
 * @param {Record<string, string>|undefined} tags
 */
function roadWidthFromTags(tags = {}) {
    const highway = tags.highway ?? "residential";
    return HIGHWAY_WIDTHS[highway] ?? 7;
}

/**
 * @param {Record<string, string>|undefined} tags
 */
function laneCountFromTags(tags = {}) {
    const lanes = Number(tags.lanes);
    if (Number.isFinite(lanes) && lanes > 0) return lanes;
    const highway = tags.highway ?? "residential";
    if (highway === "motorway" || highway === "trunk") return 4;
    if (highway === "primary" || highway === "secondary") return 2;
    return 2;
}

function pointChunkKey(point, cellSize) {
    return `${Math.floor(point.x / cellSize)},${Math.floor(point.z / cellSize)}`;
}

class NodeSnapIndex {
    constructor(nodes, snapRadius) {
        this.snapRadius = snapRadius;
        this.cellSize = Math.max(0.001, snapRadius);
        this.cells = new Map();
        this.nodeIds = new Set();

        nodes.forEach((node) => this.insert(node));
    }

    insert(node) {
        this.nodeIds.add(node.id);
        const key = pointChunkKey(node, this.cellSize);
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(node);
    }

    findNearest(point) {
        let nearest = null;
        let nearestDistance = this.snapRadius;
        const originX = Math.floor(point.x / this.cellSize);
        const originZ = Math.floor(point.z / this.cellSize);
        const range = Math.ceil(this.snapRadius / this.cellSize);

        for (let cx = originX - range; cx <= originX + range; cx += 1) {
            for (let cz = originZ - range; cz <= originZ + range; cz += 1) {
                const candidates = this.cells.get(`${cx},${cz}`) ?? [];
                for (const node of candidates) {
                    const distance = Math.hypot(node.x - point.x, node.z - point.z);
                    if (distance <= nearestDistance) {
                        nearestDistance = distance;
                        nearest = node;
                    }
                }
            }
        }

        return nearest;
    }

    getOrCreate(document, point) {
        const existing = this.findNearest(point);
        if (existing) return existing;

        let id = createId("node");
        while (this.nodeIds.has(id)) {
            id = createId("node");
        }

        const node = { id, x: point.x, z: point.z };
        document.roads.nodes.push(node);
        this.insert(node);
        return node;
    }
}

function edgeKey(startNodeId, endNodeId) {
    return startNodeId < endNodeId
        ? `${startNodeId}:${endNodeId}`
        : `${endNodeId}:${startNodeId}`;
}

function buildNodeMap(document) {
    return new Map(document.roads.nodes.map((node) => [node.id, node]));
}

function buildAdjacency(document) {
    const adjacency = new Map();
    for (const edge of document.roads.edges) {
        if (!adjacency.has(edge.startNodeId)) adjacency.set(edge.startNodeId, []);
        if (!adjacency.has(edge.endNodeId)) adjacency.set(edge.endNodeId, []);
        adjacency.get(edge.startNodeId).push(edge);
        adjacency.get(edge.endNodeId).push(edge);
    }
    return adjacency;
}

function getOtherNodeId(edge, nodeId) {
    return edge.startNodeId === nodeId ? edge.endNodeId : edge.startNodeId;
}

function edgesHaveCompatibleShape(a, b) {
    return (a.bidirectional ?? true) === (b.bidirectional ?? true)
        && (a.width ?? 7) === (b.width ?? 7)
        && (a.laneCount ?? 2) === (b.laneCount ?? 2)
        && !a.startArm
        && !a.endArm
        && !b.startArm
        && !b.endArm;
}

function getMergedEndpointIds(a, b, nodeId) {
    if ((a.bidirectional ?? true) && (b.bidirectional ?? true)) {
        return {
            startNodeId: getOtherNodeId(a, nodeId),
            endNodeId: getOtherNodeId(b, nodeId),
        };
    }

    const aEntersNode = a.endNodeId === nodeId;
    const aExitsNode = a.startNodeId === nodeId;
    const bEntersNode = b.endNodeId === nodeId;
    const bExitsNode = b.startNodeId === nodeId;

    if (aEntersNode && bExitsNode) {
        return { startNodeId: a.startNodeId, endNodeId: b.endNodeId };
    }
    if (bEntersNode && aExitsNode) {
        return { startNodeId: b.startNodeId, endNodeId: a.endNodeId };
    }

    return null;
}

function isStraightThrough(node, aNode, bNode) {
    const ax = aNode.x - node.x;
    const az = aNode.z - node.z;
    const bx = bNode.x - node.x;
    const bz = bNode.z - node.z;
    const aLength = Math.hypot(ax, az);
    const bLength = Math.hypot(bx, bz);

    if (aLength === 0 || bLength === 0) return false;
    const dot = (ax * bx + az * bz) / (aLength * bLength);
    return dot <= -STRAIGHT_CHAIN_DOT_THRESHOLD;
}

function hasOtherEdgeBetween(document, startNodeId, endNodeId, ignoredEdgeIds) {
    const candidateKey = edgeKey(startNodeId, endNodeId);
    return document.roads.edges.some((edge) => (
        !ignoredEdgeIds.has(edge.id)
        && edgeKey(edge.startNodeId, edge.endNodeId) === candidateKey
    ));
}

/**
 * Collapse imported degree-2 pass-through nodes that only split the same straight road.
 * This keeps real intersections and visible bends in the graph while reducing road objects.
 * @param {import("../../editor/document/EnvironmentDocument.js").EnvironmentDocument} document
 */
export function collapseStraightRoadChains(document) {
    let collapsedNodes = 0;
    let changed = true;

    while (changed) {
        changed = false;
        const nodesById = buildNodeMap(document);
        const adjacency = buildAdjacency(document);

        for (const node of document.roads.nodes) {
            const connectedEdges = adjacency.get(node.id) ?? [];
            if (connectedEdges.length !== 2 || node.kind === "intersection") continue;

            const [a, b] = connectedEdges;
            if (!edgesHaveCompatibleShape(a, b)) continue;

            const endpoints = getMergedEndpointIds(a, b, node.id);
            if (!endpoints || endpoints.startNodeId === endpoints.endNodeId) continue;

            const aNode = nodesById.get(getOtherNodeId(a, node.id));
            const bNode = nodesById.get(getOtherNodeId(b, node.id));
            if (!aNode || !bNode || !isStraightThrough(node, aNode, bNode)) continue;

            const ignoredEdgeIds = new Set([a.id, b.id]);
            if (hasOtherEdgeBetween(document, endpoints.startNodeId, endpoints.endNodeId, ignoredEdgeIds)) {
                continue;
            }

            document.roads.edges = document.roads.edges.filter((edge) => !ignoredEdgeIds.has(edge.id));
            document.roads.edges.push({
                id: createId("edge"),
                startNodeId: endpoints.startNodeId,
                endNodeId: endpoints.endNodeId,
                bidirectional: a.bidirectional ?? true,
                width: a.width ?? 7,
                laneCount: a.laneCount ?? 2,
                startArm: null,
                endArm: null,
            });
            document.roads.nodes = document.roads.nodes.filter((candidate) => candidate.id !== node.id);

            collapsedNodes += 1;
            changed = true;
            break;
        }
    }

    return collapsedNodes;
}

/**
 * Import normalized road ways into an EnvironmentDocument.
 * @param {import("../../editor/document/EnvironmentDocument.js").EnvironmentDocument} document
 * @param {NormalizedRoadNetwork} network
 * @param {{ anchor: { lat: number, lng: number }, replaceExisting?: boolean, simplifyToleranceMeters?: number }} options
 */
export function importRoadNetworkToDocument(document, network, options) {
    const anchor = options.anchor;
    const simplifyTolerance = options.simplifyToleranceMeters
        ?? DEFAULT_EARTH_IMPORT_CONFIG.roadSimplifyToleranceMeters;

    if (options.replaceExisting) {
        document.roads.nodes = [];
        document.roads.edges = [];
    }

    let importedEdges = 0;
    let skippedEdges = 0;
    const snapIndex = new NodeSnapIndex(document.roads.nodes, ROAD_SNAP_RADIUS_METERS);
    const degreeMap = buildRoadDegreeMap(document);
    const edgeKeySet = buildRoadEdgeKeySet(document);

    for (const way of network.ways) {
        const simplified = simplifyLatLngPolyline(way.points, anchor, simplifyTolerance);
        if (simplified.length < 2) continue;

        let previousNode = null;
        for (const point of simplified) {
            const local = latLngToLocal(point.lat, point.lng, anchor);
            const node = snapIndex.getOrCreate(document, local);
            if (previousNode && previousNode.id !== node.id) {
                const result = addRoadEdge(document, previousNode.id, node.id, {
                    width: roadWidthFromTags(way.tags),
                    laneCount: laneCountFromTags(way.tags),
                    bidirectional: way.tags?.oneway !== "yes",
                }, {
                    degreeMap,
                    edgeKeySet,
                    notify: false,
                    refreshKinds: false,
                });
                if (result.ok) {
                    importedEdges += 1;
                } else {
                    skippedEdges += 1;
                }
            }
            previousNode = node;
        }
    }

    dedupeRoadNodes(document);
    const collapsedNodes = collapseStraightRoadChains(document);
    refreshNodeKinds(document);
    document.notify?.();

    return {
        importedEdges,
        skippedEdges,
        collapsedNodes,
        nodeCount: document.roads.nodes.length,
        edgeCount: document.roads.edges.length,
    };
}

/**
 * Fetch and import roads for bounds into document.
 * @param {import("../../editor/document/EnvironmentDocument.js").EnvironmentDocument} document
 * @param {{ north: number, south: number, east: number, west: number }} bounds
 * @param {{ anchor: { lat: number, lng: number }, providerId?: string, replaceExisting?: boolean, fetchImpl?: typeof fetch }} options
 */
export async function fetchAndImportRoads(document, bounds, options) {
    const provider = createRoadNetworkProvider(options.providerId, {
        fetchImpl: options.fetchImpl,
    });
    const network = await provider.fetchRoadNetwork(bounds);
    const stats = importRoadNetworkToDocument(document, network, {
        anchor: options.anchor,
        replaceExisting: options.replaceExisting,
    });
    return {
        network,
        stats,
        providerId: provider.id,
    };
}
