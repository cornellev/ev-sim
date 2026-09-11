const DEFAULT_ROAD_WIDTH = 7;
const DEFAULT_LANE_COUNT = 2;
const EPSILON = 1e-9;

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function roadIsBidirectional(edge) {
    return edge?.bidirectional !== false && edge?.oneWay !== true;
}

export function roadIsReversed(edge) {
    return edge?.direction === -1
        || edge?.direction === "reverse"
        || edge?.oneWayDirection === -1
        || edge?.oneWayDirection === "reverse";
}

export function roadLaneCount(edge) {
    const value = finite(edge?.laneCount, DEFAULT_LANE_COUNT);
    return Math.max(1, Math.round(value));
}

export function roadWidth(edge) {
    return Math.max(0, finite(edge?.width, DEFAULT_ROAD_WIDTH));
}

export function roadLaneWidth(edge) {
    return roadWidth(edge) / roadLaneCount(edge);
}

export function validateRoadLaneLayout(edge) {
    const rawCount = finite(edge?.laneCount, DEFAULT_LANE_COUNT);
    if (!Number.isInteger(rawCount) || rawCount < 1) {
        return { ok: false, code: "route.environment.lane-layout-invalid", error: "Road laneCount must be a positive integer." };
    }
    if (roadIsBidirectional(edge) && rawCount > 1 && rawCount % 2 !== 0) {
        return {
            ok: false,
            code: "route.environment.lane-layout-invalid",
            error: "A bidirectional road must have one shared lane or an even lane count.",
        };
    }
    if (roadWidth(edge) <= EPSILON) {
        return { ok: false, code: "route.environment.lane-layout-invalid", error: "Road width must be greater than zero." };
    }
    return { ok: true };
}

/** Physical lane index 0 is the rightmost lane when the edge is traversed start -> end. */
export function laneCenterRightOffset(edge, laneIndex) {
    const count = roadLaneCount(edge);
    const index = Math.max(0, Math.min(count - 1, Math.trunc(finite(laneIndex, 0))));
    const laneWidth = roadLaneWidth(edge);
    return roadWidth(edge) * 0.5 - laneWidth * (index + 0.5);
}

export function laneDirections(edge, laneIndex) {
    const count = roadLaneCount(edge);
    const index = Math.max(0, Math.min(count - 1, Math.trunc(finite(laneIndex, 0))));
    if (!roadIsBidirectional(edge)) return [roadIsReversed(edge) ? -1 : 1];
    if (count === 1) return [1, -1];
    return [index < count / 2 ? 1 : -1];
}

export function legalLaneIndices(edge, direction) {
    const normalizedDirection = direction === -1 ? -1 : 1;
    const result = [];
    for (let index = 0; index < roadLaneCount(edge); index += 1) {
        if (laneDirections(edge, index).includes(normalizedDirection)) result.push(index);
    }
    return result;
}

export function edgeAllowsArrivalAtNode(edge, nodeId) {
    if (!edge || (edge.startNodeId !== nodeId && edge.endNodeId !== nodeId)) return false;
    const direction = edge.endNodeId === nodeId ? 1 : -1;
    return legalLaneIndices(edge, direction).length > 0;
}

export function edgeAllowsDepartureFromNode(edge, nodeId) {
    if (!edge || (edge.startNodeId !== nodeId && edge.endNodeId !== nodeId)) return false;
    const direction = edge.startNodeId === nodeId ? 1 : -1;
    return legalLaneIndices(edge, direction).length > 0;
}

export function rightmostLegalLaneIndex(edge, direction) {
    const lanes = legalLaneIndices(edge, direction);
    if (lanes.length === 0) return null;
    return direction === -1 ? lanes[lanes.length - 1] : lanes[0];
}

export function nearestLaneIndexForOffset(edge, rightOffset, candidates = null) {
    const lanes = Array.isArray(candidates)
        ? candidates
        : Array.from({ length: roadLaneCount(edge) }, (_, index) => index);
    const desired = finite(rightOffset, 0);
    let best = null;
    for (const laneIndex of lanes) {
        const distance = Math.abs(laneCenterRightOffset(edge, laneIndex) - desired);
        if (!best || distance < best.distance - EPSILON || (Math.abs(distance - best.distance) <= EPSILON && laneIndex < best.laneIndex)) {
            best = { laneIndex, distance };
        }
    }
    return best?.laneIndex ?? null;
}

export function nearestLegalLaneIndex(edge, direction, preferredLaneIndex = null, preferredRightOffset = null) {
    const legal = legalLaneIndices(edge, direction);
    if (legal.length === 0) return null;
    if (Number.isInteger(preferredLaneIndex) && legal.includes(preferredLaneIndex)) return preferredLaneIndex;
    const desiredOffset = Number.isInteger(preferredLaneIndex)
        ? laneCenterRightOffset(edge, preferredLaneIndex)
        : finite(preferredRightOffset, laneCenterRightOffset(edge, rightmostLegalLaneIndex(edge, direction)));
    return nearestLaneIndexForOffset(edge, desiredOffset, legal);
}

export function rightNormalXZ(start, end) {
    const dx = finite(end?.x, 0) - finite(start?.x, 0);
    const dz = finite(end?.z, 0) - finite(start?.z, 0);
    const length = Math.hypot(dx, dz);
    if (length <= EPSILON) return { x: 0, z: 0 };
    return { x: -dz / length, z: dx / length };
}

export function signedRightOffset(point, start, end) {
    const normal = rightNormalXZ(start, end);
    return (finite(point?.x, 0) - finite(start?.x, 0)) * normal.x
        + (finite(point?.z, 0) - finite(start?.z, 0)) * normal.z;
}

export function offsetRoadPoint(point, start, end, rightOffset) {
    const normal = rightNormalXZ(start, end);
    return {
        x: finite(point?.x, 0) + normal.x * finite(rightOffset, 0),
        y: finite(point?.y, 0),
        z: finite(point?.z, 0) + normal.z * finite(rightOffset, 0),
    };
}

export function laneCenterPoint(point, start, end, edge, laneIndex) {
    return offsetRoadPoint(point, start, end, laneCenterRightOffset(edge, laneIndex));
}

export function laneDividerDescriptors(edge) {
    const result = [];
    const count = roadLaneCount(edge);
    const laneWidth = roadLaneWidth(edge);
    for (let dividerIndex = 1; dividerIndex < count; dividerIndex += 1) {
        const leftDirections = laneDirections(edge, dividerIndex - 1);
        const rightDirections = laneDirections(edge, dividerIndex);
        const opposing = !leftDirections.some((direction) => rightDirections.includes(direction));
        result.push({
            dividerIndex,
            rightOffset: roadWidth(edge) * 0.5 - laneWidth * dividerIndex,
            opposing,
        });
    }
    return result;
}

export function movementDefaultAllowed(nodeDegree, fromEdgeId, toEdgeId) {
    if (!fromEdgeId || !toEdgeId) return true;
    if (fromEdgeId !== toEdgeId) return true;
    return Number(nodeDegree) <= 1;
}

export function movementRuleKey(nodeId, fromEdgeId, toEdgeId) {
    return `${String(nodeId)}\u0000${String(fromEdgeId)}\u0000${String(toEdgeId)}`;
}

export function movementAllowed({ nodeId, fromEdgeId, toEdgeId, nodeDegree, turnRules = [] }) {
    if (!fromEdgeId || !toEdgeId) return true;
    const rule = turnRules.find((entry) => (
        String(entry?.nodeId) === String(nodeId)
        && String(entry?.fromEdgeId) === String(fromEdgeId)
        && String(entry?.toEdgeId) === String(toEdgeId)
    ));
    return rule ? rule.allowed === true : movementDefaultAllowed(nodeDegree, fromEdgeId, toEdgeId);
}
