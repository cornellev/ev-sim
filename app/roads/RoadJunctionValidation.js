/**
 * Junction movement feasibility. A movement (arrive on `fromEdgeId`, depart
 * on `toEdgeId` at `nodeId`) is feasible when some lane legally arrives, some
 * lane legally departs, and a lane-to-lane connector fits inside the compiled
 * junction surface. Pure and kernel-safe: consumers pass the compiled plan
 * from `planRoadNetworkGeometry` (or `null` for legacy v1 roads, where only
 * lane directions apply).
 */

import {
    edgeAllowsArrivalAtNode,
    edgeAllowsDepartureFromNode,
    legalLaneIndices,
    movementAllowed,
    roadLaneId,
} from "./RoadLaneModel.js";
import { buildJunctionConnector } from "./RoadNetworkGeometry.js";

export const TURN_RULE_ISSUE_CODES = Object.freeze({
    REFERENCE_MISSING: "road.turn-rule.reference-missing",
    INFEASIBLE: "road.turn-rule.infeasible",
    CONNECTOR_INFEASIBLE: "road.turn-rule.connector-infeasible",
});

export const MOVEMENT_INFEASIBLE_REASONS = Object.freeze({
    REFERENCE_MISSING: "turn.infeasible.reference-missing",
    NO_ARRIVAL_LANE: "turn.infeasible.no-arrival-lane",
    NO_DEPARTURE_LANE: "turn.infeasible.no-departure-lane",
    CONNECTOR_OUTSIDE_JUNCTION: "turn.infeasible.connector-outside-junction",
});

/** Lane indices that legally arrive at `nodeId` along `edge`, rightmost travel lane first. */
export function arrivingLaneIndices(edge, nodeId) {
    if (!edge || (edge.startNodeId !== nodeId && edge.endNodeId !== nodeId)) return [];
    const direction = edge.endNodeId === nodeId ? 1 : -1;
    const lanes = legalLaneIndices(edge, direction);
    return direction === -1 ? [...lanes].reverse() : lanes;
}

/** Lane indices that legally depart from `nodeId` along `edge`, rightmost travel lane first. */
export function departingLaneIndices(edge, nodeId) {
    if (!edge || (edge.startNodeId !== nodeId && edge.endNodeId !== nodeId)) return [];
    const direction = edge.startNodeId === nodeId ? 1 : -1;
    const lanes = legalLaneIndices(edge, direction);
    return direction === -1 ? [...lanes].reverse() : lanes;
}

function edgeFromPlan(plan, edgeId) {
    return plan?.edgeById?.get?.(String(edgeId))?.edge ?? null;
}

/**
 * First lane pair whose connector stays inside the junction, searching
 * rightmost arriving lane × rightmost departing lane first. Returns `null`
 * when no connector fits, and `undefined` when the node has no junction
 * surface in the plan (direct joins and endpoints need no connector).
 */
export function movementConnector(plan, nodeId, fromEdgeId, toEdgeId) {
    const junction = plan?.junctionByNode?.get?.(String(nodeId));
    if (!junction) return undefined;
    const fromEdge = edgeFromPlan(plan, fromEdgeId);
    const toEdge = edgeFromPlan(plan, toEdgeId);
    if (!fromEdge || !toEdge) return null;
    for (const fromLaneIndex of arrivingLaneIndices(fromEdge, String(nodeId))) {
        for (const toLaneIndex of departingLaneIndices(toEdge, String(nodeId))) {
            try {
                const connector = buildJunctionConnector(plan, { nodeId, fromEdgeId, toEdgeId, fromLaneIndex, toLaneIndex });
                if (connector) {
                    return {
                        ...connector,
                        fromLaneId: roadLaneId(fromEdge, fromLaneIndex),
                        toLaneId: roadLaneId(toEdge, toLaneIndex),
                    };
                }
            } catch {
                // The connector left the paved surface; try the next lane pair.
            }
        }
    }
    return null;
}

/**
 * Assess one movement: `{ feasible, reason, connector }`. `connector` is the
 * lane pair the movement would use (or `null` when the plan has no junction
 * surface for the node, e.g. v1 roads or direct joins).
 */
export function assessMovement({ nodeId, fromEdge, toEdge, plan = null }) {
    const id = String(nodeId);
    if (!fromEdge || !toEdge) return { feasible: false, reason: MOVEMENT_INFEASIBLE_REASONS.REFERENCE_MISSING, connector: null };
    if (!edgeAllowsArrivalAtNode(fromEdge, id)) return { feasible: false, reason: MOVEMENT_INFEASIBLE_REASONS.NO_ARRIVAL_LANE, connector: null };
    if (!edgeAllowsDepartureFromNode(toEdge, id)) return { feasible: false, reason: MOVEMENT_INFEASIBLE_REASONS.NO_DEPARTURE_LANE, connector: null };
    const connector = movementConnector(plan, id, fromEdge.id, toEdge.id);
    if (connector === null) return { feasible: false, reason: MOVEMENT_INFEASIBLE_REASONS.CONNECTOR_OUTSIDE_JUNCTION, connector: null };
    return { feasible: true, reason: null, connector: connector ?? null };
}

export function describeInfeasibleMovement(reason) {
    switch (reason) {
        case MOVEMENT_INFEASIBLE_REASONS.REFERENCE_MISSING: return "The movement references a missing node or road.";
        case MOVEMENT_INFEASIBLE_REASONS.NO_ARRIVAL_LANE: return "No lane on the incoming road travels toward this junction.";
        case MOVEMENT_INFEASIBLE_REASONS.NO_DEPARTURE_LANE: return "No lane on the outgoing road travels away from this junction.";
        case MOVEMENT_INFEASIBLE_REASONS.CONNECTOR_OUTSIDE_JUNCTION: return "No lane-to-lane connector fits inside the junction surface.";
        default: return "The movement is infeasible.";
    }
}

/**
 * Warnings for allowed movements that have no lane-to-lane connector inside
 * their junction. Warnings never block editing; `road.set-turn-rule` refuses
 * to allow such a movement explicitly.
 */
export function validateJunctionMovements(roads, plan) {
    const issues = [];
    if (!plan?.junctions?.length) return issues;
    const turnRules = Array.isArray(roads?.turnRules) ? roads.turnRules : [];
    for (const junction of plan.junctions) {
        const nodeId = String(junction.node.id);
        const incidents = junction.incidents ?? [];
        for (const from of incidents) {
            for (const to of incidents) {
                const fromEdge = edgeFromPlan(plan, from.edgeId);
                const toEdge = edgeFromPlan(plan, to.edgeId);
                if (!fromEdge || !toEdge) continue;
                if (!edgeAllowsArrivalAtNode(fromEdge, nodeId) || !edgeAllowsDepartureFromNode(toEdge, nodeId)) continue;
                if (!movementAllowed({ nodeId, fromEdgeId: fromEdge.id, toEdgeId: toEdge.id, nodeDegree: incidents.length, turnRules })) continue;
                if (movementConnector(plan, nodeId, fromEdge.id, toEdge.id) === null) {
                    issues.push({
                        path: ["roads", "nodes", nodeId],
                        code: TURN_RULE_ISSUE_CODES.CONNECTOR_INFEASIBLE,
                        message: `Movement ${fromEdge.id} → ${toEdge.id} at "${nodeId}" has no lane connector inside the junction.`,
                        severity: "warning",
                        objectId: nodeId,
                    });
                }
            }
        }
    }
    return issues;
}
