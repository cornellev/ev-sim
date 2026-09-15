/**
 * Map road-to-intersection connect targeting. Kernel-safe: no React, DOM, or Three.
 * Connect on drop uses the unsnapped pointer so grid snap cannot steal a diamond hit.
 * Dwell only arms the hover preview; a drop inside the snap radius always connects.
 */

import {
    canMoveNode,
    findNearestIntersection,
    getNodeDegree,
    hasEdgeBetween,
    MAX_INTERSECTION_DEGREE,
} from "../document/documentMutations.js";

export const ROAD_CONNECT_PREVIEW_DWELL_MS = 250;

function objectLocked(document, objectId) {
    if (objectId === undefined || objectId === null) return false;
    return document.getObject?.(String(objectId))?.components?.locked === true;
}

function edgeForEndpoint(document, nodeId) {
    return document.roads?.edges?.find(
        (edge) => edge.startNodeId === nodeId || edge.endNodeId === nodeId,
    ) ?? null;
}

/**
 * Topology node id for a start/end knot sub-selection, or null for interior knots/handles.
 * @param {{ getEdge?: Function, roads?: { edges?: object[] } }} document
 * @param {{ kind?: string, edgeId?: string, knotId?: string } | null} sub
 */
export function endpointNodeIdForSub(document, sub) {
    if (sub?.kind !== "road-knot") return null;
    if (!["start", "end"].includes(String(sub.knotId))) return null;
    const edgeId = String(sub.edgeId);
    const edge = typeof document.getEdge === "function"
        ? document.getEdge(edgeId)
        : document.roads?.edges?.find((candidate) => String(candidate.id) === edgeId);
    if (!edge) return null;
    return sub.knotId === "start" ? edge.startNodeId : edge.endNodeId;
}

/**
 * @param {object} document
 * @param {{ x: number, z: number }} point
 * @param {number} snapRadius
 * @param {{ kind: "endpoint", nodeId: string } | { kind: "stroke", startNodeId?: string | null, otherNodeIds?: string[] } | null} [source]
 * @returns {{ intersectionId: string, position: { x: number, y: number, z: number }, edgeId: string | null, end: "start" | "end" | null } | null}
 */
export function resolveIntersectionConnectTarget(document, point, snapRadius, source = null) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.z))) return null;
    const exclude = [];
    let edge = null;
    let end = null;
    let otherNodeId = null;

    if (source?.kind === "endpoint") {
        const nodeId = String(source.nodeId);
        if (!canMoveNode(document, nodeId)) return null;
        exclude.push(nodeId);
        edge = edgeForEndpoint(document, nodeId);
        if (!edge) return null;
        end = edge.startNodeId === nodeId ? "start" : "end";
        otherNodeId = end === "start" ? edge.endNodeId : edge.startNodeId;
        exclude.push(String(otherNodeId));
        if (objectLocked(document, edge.id)) return null;
    } else if (source?.kind === "stroke") {
        if (source.startNodeId !== undefined && source.startNodeId !== null) exclude.push(String(source.startNodeId));
        for (const id of source.otherNodeIds ?? []) {
            if (id !== undefined && id !== null) exclude.push(String(id));
        }
    }

    const intersection = findNearestIntersection(point, document, snapRadius, exclude);
    if (!intersection) return null;
    if (objectLocked(document, intersection.id)) return null;
    if (getNodeDegree(document, intersection.id) >= MAX_INTERSECTION_DEGREE) return null;
    if (otherNodeId && hasEdgeBetween(document, otherNodeId, intersection.id)) return null;

    return {
        intersectionId: intersection.id,
        position: { x: intersection.x, y: Number.isFinite(Number(intersection.y)) ? Number(intersection.y) : 0, z: intersection.z },
        edgeId: edge?.id ?? null,
        end,
    };
}

/**
 * Pure dwell stepper. The same candidate must stay under the pointer for `dwellMs`
 * before the preview arms. Leaving the radius or changing intersection resets it.
 *
 * @param {{ candidateId: string, sinceMs: number, armed: boolean } | null} state
 * @param {string | null} candidateId
 * @param {number} nowMs
 * @param {number} [dwellMs]
 */
export function advanceConnectPreview(state, candidateId, nowMs, dwellMs = ROAD_CONNECT_PREVIEW_DWELL_MS) {
    if (!candidateId) return { state: null, armed: false, intersectionId: null };
    if (state?.candidateId === candidateId) {
        const armed = state.armed === true || (nowMs - state.sinceMs) >= dwellMs;
        return {
            state: { candidateId, sinceMs: state.sinceMs, armed },
            armed,
            intersectionId: armed ? candidateId : null,
        };
    }
    return {
        state: { candidateId, sinceMs: nowMs, armed: false },
        armed: false,
        intersectionId: null,
    };
}
