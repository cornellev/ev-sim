/**
 * Collect road/intersection control points for GLB elevation draping and
 * turn sampled elevations into `PlanStep`s. Kernel-safe: no Three, DOM, or
 * scene registry.
 */

import { cloneRoadGeometry } from "../../../roads/RoadGeometryRecord.js";
import { INTERSECTION_TYPE_ID } from "../objects/types/intersection.js";
import { ROAD_TYPE_ID } from "../objects/types/road.js";

export const ROAD_DRAPE_Y_EPSILON = 1e-6;
const ROAD_SUB_KINDS = new Set(["road-node", "road-knot", "road-handle", "road-lane"]);

function nodeY(point) {
    const y = Number(point?.y);
    return Number.isFinite(y) ? y : 0;
}

function asId(value) {
    return value === undefined || value === null ? null : String(value);
}

function edgeOf(document, id) {
    const key = asId(id);
    if (!document || !key) return null;
    return document.getEdge?.(key) ?? document.roads?.edges?.find((edge) => String(edge.id) === key) ?? null;
}

function nodeOf(document, id) {
    const key = asId(id);
    if (!document || !key) return null;
    return document.getNode?.(key) ?? document.roads?.nodes?.find((node) => String(node.id) === key) ?? null;
}

function objectOf(document, id) {
    const key = asId(id);
    if (!document || !key) return null;
    return document.getObject?.(key) ?? document.objects?.find((record) => String(record.id) === key) ?? null;
}

function addEdgeSeeds(document, edge, edgeIds, nodeIds) {
    if (!edge) return;
    edgeIds.add(String(edge.id));
    if (edge.startNodeId != null) nodeIds.add(String(edge.startNodeId));
    if (edge.endNodeId != null) nodeIds.add(String(edge.endNodeId));
}

function expandConnected(document, edgeIds, nodeIds) {
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of document.roads?.edges ?? []) {
            const id = String(edge.id);
            const start = String(edge.startNodeId);
            const end = String(edge.endNodeId);
            if (!edgeIds.has(id) && !nodeIds.has(start) && !nodeIds.has(end)) continue;
            if (!edgeIds.has(id)) {
                edgeIds.add(id);
                changed = true;
            }
            if (!nodeIds.has(start)) {
                nodeIds.add(start);
                changed = true;
            }
            if (!nodeIds.has(end)) {
                nodeIds.add(end);
                changed = true;
            }
        }
    }
}

function collectLockedIds(document, edgeIds, nodeIds) {
    const lockedIds = [];
    const seen = new Set();
    const consider = (id) => {
        const key = asId(id);
        if (!key || seen.has(key)) return;
        seen.add(key);
        const record = objectOf(document, key);
        if (record?.components?.locked === true) lockedIds.push(key);
    };
    for (const edgeId of edgeIds) consider(edgeId);
    for (const nodeId of nodeIds) consider(nodeId);
    return lockedIds;
}

function interiorKnotsOf(edge) {
    return (edge?.geometry?.knots ?? []).filter((knot) => knot?.id !== "start" && knot?.id !== "end" && knot?.position);
}

/**
 * True when the current selection can be draped: a road or intersection
 * object, or a road node/knot/handle/lane sub-selection.
 */
export function selectionCanDrapeRoads(document, selection = {}) {
    if (!document) return false;
    const sub = selection?.sub;
    if (sub && ROAD_SUB_KINDS.has(sub.kind)) {
        if (sub.kind === "road-node") return Boolean(nodeOf(document, sub.id));
        return Boolean(edgeOf(document, sub.edgeId));
    }
    for (const id of selection?.ids ?? []) {
        const record = objectOf(document, id);
        if (record?.typeId === ROAD_TYPE_ID || record?.typeId === INTERSECTION_TYPE_ID) return true;
        if (edgeOf(document, id) || nodeOf(document, id)) return true;
    }
    return false;
}

/**
 * @returns {{
 *   nodes: Array<{ nodeId: string, x: number, y: number, z: number }>,
 *   knots: Array<{ edgeId: string, knotId: string, x: number, y: number, z: number }>,
 *   edgeIds: string[],
 *   lockedIds: string[],
 * }}
 */
export function collectRoadDrapeTargets(document, { objectIds = [], sub = null, includeConnected = false } = {}) {
    const edgeIds = new Set();
    const nodeIds = new Set();
    const knotKeys = new Set();
    let specificSub = false;

    if (sub?.kind === "road-node" && sub.id != null) {
        specificSub = true;
        const node = nodeOf(document, sub.id);
        if (node) nodeIds.add(String(node.id));
    } else if ((sub?.kind === "road-knot" || sub?.kind === "road-handle") && sub.edgeId != null && sub.knotId != null) {
        specificSub = true;
        const edge = edgeOf(document, sub.edgeId);
        if (edge) {
            edgeIds.add(String(edge.id));
            if (sub.knotId === "start" && edge.startNodeId != null) nodeIds.add(String(edge.startNodeId));
            else if (sub.knotId === "end" && edge.endNodeId != null) nodeIds.add(String(edge.endNodeId));
            else knotKeys.add(`${edge.id}:${sub.knotId}`);
        }
    } else if (sub?.kind === "road-lane" && sub.edgeId != null) {
        addEdgeSeeds(document, edgeOf(document, sub.edgeId), edgeIds, nodeIds);
    }

    if (!specificSub) {
        for (const value of objectIds ?? []) {
            const id = asId(value);
            if (!id) continue;
            const record = objectOf(document, id);
            const edge = edgeOf(document, id);
            const node = nodeOf(document, id);
            if (record?.typeId === ROAD_TYPE_ID || edge) {
                addEdgeSeeds(document, edge ?? edgeOf(document, record?.id ?? id), edgeIds, nodeIds);
            } else if (record?.typeId === INTERSECTION_TYPE_ID || node) {
                nodeIds.add(String(node?.id ?? id));
            }
        }
    }

    if (includeConnected === true) expandConnected(document, edgeIds, nodeIds);

    const lockedIds = collectLockedIds(document, edgeIds, nodeIds);
    const nodes = [];
    for (const nodeId of nodeIds) {
        const node = nodeOf(document, nodeId);
        if (!node) continue;
        nodes.push({
            nodeId: String(node.id),
            x: Number(node.x) || 0,
            y: nodeY(node),
            z: Number(node.z) || 0,
        });
    }

    const restrictKnots = knotKeys.size > 0 && includeConnected !== true;
    const knots = [];
    for (const edgeId of edgeIds) {
        const edge = edgeOf(document, edgeId);
        if (!edge) continue;
        for (const knot of interiorKnotsOf(edge)) {
            const key = `${edge.id}:${knot.id}`;
            if (restrictKnots && !knotKeys.has(key)) continue;
            knots.push({
                edgeId: String(edge.id),
                knotId: String(knot.id),
                x: Number(knot.position.x) || 0,
                y: nodeY(knot.position),
                z: Number(knot.position.z) || 0,
            });
        }
    }

    return { nodes, knots, edgeIds: [...edgeIds], lockedIds };
}

/**
 * Build `move-node` / `set-road-geometry` steps from sampled elevations.
 * `samples` maps `node:<id>` and `knot:<edgeId>:<knotId>` to sampled Y.
 */
export function planRoadDrape(document, { nodes = [], knots = [] } = {}, samples, offset = 0) {
    const lift = Number(offset);
    const steps = [];
    const appliedNodes = [];
    const appliedKnots = [];

    for (const node of nodes) {
        const sampledY = samples.get(`node:${node.nodeId}`);
        if (!Number.isFinite(sampledY)) continue;
        const y = sampledY + lift;
        if (Math.abs(y - node.y) <= ROAD_DRAPE_Y_EPSILON) continue;
        steps.push({
            op: "move-node",
            nodeId: node.nodeId,
            position: { x: node.x, y, z: node.z },
        });
        appliedNodes.push(node.nodeId);
    }

    const knotsByEdge = new Map();
    for (const knot of knots) {
        const sampledY = samples.get(`knot:${knot.edgeId}:${knot.knotId}`);
        if (!Number.isFinite(sampledY)) continue;
        const y = sampledY + lift;
        if (Math.abs(y - knot.y) <= ROAD_DRAPE_Y_EPSILON) continue;
        if (!knotsByEdge.has(knot.edgeId)) knotsByEdge.set(knot.edgeId, []);
        knotsByEdge.get(knot.edgeId).push({ ...knot, y });
    }

    for (const [edgeId, patches] of knotsByEdge) {
        const edge = edgeOf(document, edgeId);
        if (!edge?.geometry) continue;
        const geometry = cloneRoadGeometry(edge.geometry);
        const byId = new Map(patches.map((patch) => [patch.knotId, patch]));
        let changed = false;
        for (const knot of geometry.knots ?? []) {
            const patch = byId.get(String(knot.id));
            if (!patch || !knot.position) continue;
            knot.position = { ...knot.position, y: patch.y };
            changed = true;
            appliedKnots.push({ edgeId, knotId: String(knot.id) });
        }
        if (changed) steps.push({ op: "set-road-geometry", edgeId, geometry });
    }

    return { steps, movedNodeIds: appliedNodes, movedKnots: appliedKnots };
}
