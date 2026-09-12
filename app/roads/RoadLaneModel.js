/**
 * Lane semantics for road edges. Lanes are either implicit (derived from the
 * legacy `laneCount`/`width`/`bidirectional`/`direction` fields with a
 * symmetric split and equal widths) or explicit (`edge.lanes`, ordered across
 * the road with stable ids, per-lane directions, and per-lane widths). Every
 * consumer reads lanes through `roadLanes(edge)`, so both representations
 * produce the same physical model. Physical lane index 0 is the rightmost lane
 * when the edge is traversed start -> end.
 *
 * Implicit edges keep their historical arithmetic verbatim so existing hashes,
 * proofs, and world resources never move. An explicit array equal to the
 * derived default canonicalizes back to implicit (`normalizeRoadLanes`).
 */

const DEFAULT_ROAD_WIDTH = 7;
const DEFAULT_LANE_COUNT = 2;
const EPSILON = 1e-9;
const WIDTH_SUM_TOLERANCE = 1e-5;

export const ROAD_MARKINGS = Object.freeze(["none", "solid_white", "solid_yellow", "dashed_white", "dashed_yellow"]);
export const LANE_DIRECTIONS = Object.freeze([1, -1, 0]);
export const LANE_ID_PREFIX = "lane-";
export const LANE_LAYOUT_ISSUE_CODES = Object.freeze({
    LEGACY: "route.environment.lane-layout-invalid",
    VERSION_REQUIRED: "road.lane.version-required",
    EMPTY: "road.lane.empty",
    ID_INVALID: "road.lane.id-invalid",
    DIRECTION_INVALID: "road.lane.direction-invalid",
    SHARED_REQUIRES_SINGLE: "road.lane.shared-requires-single",
    DIRECTION_INTERLEAVED: "road.lane.direction-interleaved",
    WIDTH_INVALID: "road.lane.width-invalid",
    WIDTH_MISMATCH: "road.lane.width-mismatch",
    COUNT_MISMATCH: "road.lane.count-mismatch",
    BIDIRECTIONAL_MISMATCH: "road.lane.bidirectional-mismatch",
    DIRECTION_MISMATCH: "road.lane.direction-mismatch",
    MARKING_INVALID: "road.lane.marking-invalid",
    MARKING_OUTER_FORBIDDEN: "road.lane.marking-outer-forbidden",
});

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

export function hasExplicitRoadLanes(edge) {
    return Array.isArray(edge?.lanes);
}

function legacyLaneCount(edge) {
    const value = finite(edge?.laneCount, DEFAULT_LANE_COUNT);
    return Math.max(1, Math.round(value));
}

/** Legacy direction of a physical lane: 1, -1, or 0 for the shared two-way lane. */
function legacyLaneDirection(edge, index, count) {
    if (!roadIsBidirectional(edge)) return roadIsReversed(edge) ? -1 : 1;
    if (count === 1) return 0;
    return index < count / 2 ? 1 : -1;
}

export function roadLaneCount(edge) {
    if (hasExplicitRoadLanes(edge)) return Math.max(1, edge.lanes.length);
    return legacyLaneCount(edge);
}

export function roadWidth(edge) {
    return Math.max(0, finite(edge?.width, DEFAULT_ROAD_WIDTH));
}

/** Width of one physical lane; without an index this is the legacy equal split. */
export function roadLaneWidth(edge, laneIndex = null) {
    if (hasExplicitRoadLanes(edge) && Number.isInteger(laneIndex)) {
        const lane = edge.lanes[Math.max(0, Math.min(edge.lanes.length - 1, laneIndex))];
        return Math.max(0, finite(lane?.width, 0));
    }
    return roadWidth(edge) / roadLaneCount(edge);
}

export function laneIdForIndex(index) {
    return `${LANE_ID_PREFIX}${index}`;
}

/** Smallest unused `lane-<n>` id among the supplied lanes. */
export function nextLaneId(lanes) {
    const used = new Set((Array.isArray(lanes) ? lanes : []).map((lane) => String(lane?.id ?? "")));
    let index = 0;
    while (used.has(laneIdForIndex(index))) index += 1;
    return laneIdForIndex(index);
}

/** The lanes an implicit edge describes: equal widths, symmetric split, ids `lane-<i>`. */
export function derivedRoadLanes(edge) {
    const count = legacyLaneCount(edge);
    const laneWidth = roadWidth(edge) / count;
    return Array.from({ length: count }, (_, index) => ({
        id: laneIdForIndex(index),
        direction: legacyLaneDirection(edge, index, count),
        width: laneWidth,
    }));
}

export function cloneRoadLane(lane) {
    if (!lane || typeof lane !== "object") return { id: "", direction: NaN, width: NaN };
    const direction = Number(lane.direction);
    return {
        id: String(lane.id ?? ""),
        direction: direction === 0 ? 0 : direction,
        width: Number(lane.width),
        ...(lane.markingLeft !== undefined && lane.markingLeft !== null ? { markingLeft: String(lane.markingLeft) } : {}),
    };
}

export function cloneRoadLanes(lanes) {
    return Array.isArray(lanes) ? lanes.map(cloneRoadLane) : null;
}

/** Physical lanes of the edge: explicit records when present, otherwise the derived default. */
export function roadLanes(edge) {
    return hasExplicitRoadLanes(edge) ? cloneRoadLanes(edge.lanes) : derivedRoadLanes(edge);
}

/** Materialize the current lanes as an explicit array (never returns the stored array itself). */
export function explicitRoadLanes(edge) {
    return roadLanes(edge);
}

export function roadLaneId(edge, laneIndex) {
    const lanes = roadLanes(edge);
    return Number.isInteger(laneIndex) && laneIndex >= 0 && laneIndex < lanes.length ? lanes[laneIndex].id : null;
}

export function roadLaneIndexOf(edge, laneId) {
    if (laneId === undefined || laneId === null) return -1;
    return roadLanes(edge).findIndex((lane) => lane.id === String(laneId));
}

function laneIssue(path, code, message) {
    return { path, code, message };
}

function laneTravelSenses(lanes) {
    const forward = lanes.some((lane) => lane.direction === 1 || lane.direction === 0);
    const backward = lanes.some((lane) => lane.direction === -1 || lane.direction === 0);
    return { forward, backward };
}

function sumLaneWidths(lanes) {
    let total = 0;
    for (const lane of lanes) total += finite(lane.width, 0);
    return total;
}

function validateExplicitLanes(edge, { geometryVersion = null } = {}) {
    const issues = [];
    const lanes = edge.lanes;
    if (geometryVersion !== null && Number(geometryVersion) !== 2) {
        issues.push(laneIssue(["lanes"], LANE_LAYOUT_ISSUE_CODES.VERSION_REQUIRED, "Explicit lanes require road geometry version 2."));
    }
    if (lanes.length < 1) {
        issues.push(laneIssue(["lanes"], LANE_LAYOUT_ISSUE_CODES.EMPTY, "A road needs at least one lane."));
        return issues;
    }
    const ids = new Set();
    for (const [index, lane] of lanes.entries()) {
        const id = lane?.id === undefined || lane?.id === null ? "" : String(lane.id);
        if (!id || ids.has(id)) {
            issues.push(laneIssue(["lanes", index, "id"], LANE_LAYOUT_ISSUE_CODES.ID_INVALID, `Lane ${index} has a missing or duplicate id.`));
        }
        ids.add(id);
        const direction = Number(lane?.direction);
        if (!LANE_DIRECTIONS.includes(direction)) {
            issues.push(laneIssue(["lanes", index, "direction"], LANE_LAYOUT_ISSUE_CODES.DIRECTION_INVALID, `Lane "${id || index}" direction must be 1, -1, or 0.`));
        } else if (direction === 0 && lanes.length > 1) {
            issues.push(laneIssue(["lanes", index, "direction"], LANE_LAYOUT_ISSUE_CODES.SHARED_REQUIRES_SINGLE, `Lane "${id || index}" can only be shared when it is the road's single lane.`));
        }
        const width = Number(lane?.width);
        if (!Number.isFinite(width) || width <= EPSILON) {
            issues.push(laneIssue(["lanes", index, "width"], LANE_LAYOUT_ISSUE_CODES.WIDTH_INVALID, `Lane "${id || index}" width must be greater than zero.`));
        }
        if (lane?.markingLeft !== undefined && lane?.markingLeft !== null) {
            if (!ROAD_MARKINGS.includes(lane.markingLeft)) {
                issues.push(laneIssue(["lanes", index, "markingLeft"], LANE_LAYOUT_ISSUE_CODES.MARKING_INVALID, `Lane "${id || index}" has an unknown marking.`));
            }
            if (index === lanes.length - 1) {
                issues.push(laneIssue(["lanes", index, "markingLeft"], LANE_LAYOUT_ISSUE_CODES.MARKING_OUTER_FORBIDDEN, "The leftmost lane's outer edge is the road border, not a lane marking."));
            }
        }
    }
    const directions = lanes.map((lane) => Number(lane?.direction));
    if (directions.every((direction) => LANE_DIRECTIONS.includes(direction))) {
        let changes = 0;
        for (let index = 1; index < directions.length; index += 1) {
            if (directions[index] !== directions[index - 1]) changes += 1;
        }
        if (changes > 1) {
            issues.push(laneIssue(["lanes"], LANE_LAYOUT_ISSUE_CODES.DIRECTION_INTERLEAVED, "Lanes travelling in the same direction must be adjacent."));
        }
    }
    if (issues.length > 0) return issues;

    const total = sumLaneWidths(lanes);
    if (Math.abs(roadWidth(edge) - total) > WIDTH_SUM_TOLERANCE) {
        issues.push(laneIssue(["width"], LANE_LAYOUT_ISSUE_CODES.WIDTH_MISMATCH, `Road width ${roadWidth(edge)} must equal the sum of its lane widths (${total}).`));
    }
    if (edge.laneCount !== undefined && edge.laneCount !== null && Math.round(Number(edge.laneCount)) !== lanes.length) {
        issues.push(laneIssue(["laneCount"], LANE_LAYOUT_ISSUE_CODES.COUNT_MISMATCH, `Road laneCount ${String(edge.laneCount)} disagrees with its ${lanes.length} explicit lanes.`));
    }
    const senses = laneTravelSenses(lanes.map(cloneRoadLane));
    const bidirectional = senses.forward && senses.backward;
    if (roadIsBidirectional(edge) !== bidirectional) {
        issues.push(laneIssue(["bidirectional"], LANE_LAYOUT_ISSUE_CODES.BIDIRECTIONAL_MISMATCH, bidirectional
            ? "Explicit lanes travel both ways but the road is marked one-way."
            : "Explicit lanes travel one way but the road is marked two-way."));
    } else if (!bidirectional) {
        const stored = roadIsReversed(edge) ? -1 : 1;
        const actual = senses.forward ? 1 : -1;
        if (stored !== actual) {
            issues.push(laneIssue(["direction"], LANE_LAYOUT_ISSUE_CODES.DIRECTION_MISMATCH, "Road direction disagrees with its explicit lane directions."));
        }
    }
    return issues;
}

/**
 * Validate an edge's lane layout. Implicit edges keep the historical rules;
 * explicit edges validate the lane records. `code`/`error` mirror the first
 * issue for legacy callers; `issues[]` carries edge-relative paths.
 */
export function validateRoadLaneLayout(edge, options = {}) {
    const issues = [];
    if (hasExplicitRoadLanes(edge)) {
        issues.push(...validateExplicitLanes(edge, options));
    } else {
        const rawCount = finite(edge?.laneCount, DEFAULT_LANE_COUNT);
        if (!Number.isInteger(rawCount) || rawCount < 1) {
            issues.push(laneIssue([], LANE_LAYOUT_ISSUE_CODES.LEGACY, "Road laneCount must be a positive integer."));
        } else if (roadIsBidirectional(edge) && rawCount > 1 && rawCount % 2 !== 0) {
            issues.push(laneIssue([], LANE_LAYOUT_ISSUE_CODES.LEGACY, "A bidirectional road must have one shared lane, an even lane count, or explicit lanes."));
        }
        if (roadWidth(edge) <= EPSILON) {
            issues.push(laneIssue([], LANE_LAYOUT_ISSUE_CODES.LEGACY, "Road width must be greater than zero."));
        }
    }
    if (issues.length === 0) return { ok: true, issues };
    return { ok: false, code: issues[0].code, error: issues[0].message, issues };
}

function lanesEqualDerived(edge) {
    const derived = derivedRoadLanes(edge);
    const lanes = edge.lanes;
    if (lanes.length !== derived.length) return false;
    return lanes.every((lane, index) => (
        String(lane.id) === derived[index].id
        && Number(lane.direction) === derived[index].direction
        && Math.abs(Number(lane.width) - derived[index].width) <= EPSILON
        && (lane.markingLeft === undefined || lane.markingLeft === null)
    ));
}

/**
 * Canonicalize an edge carrying explicit lanes in place: the stored width,
 * lane count, and direction fields follow the lane records, and an array that
 * equals the derived default is removed so untouched roads stay implicit.
 * Returns the edge. Does not validate; callers run the domain validator.
 */
export function normalizeRoadLanes(edge) {
    if (!hasExplicitRoadLanes(edge)) return edge;
    const lanes = cloneRoadLanes(edge.lanes);
    edge.lanes = lanes;
    if (lanes.length === 0) return edge;
    edge.width = sumLaneWidths(lanes);
    edge.laneCount = lanes.length;
    const senses = laneTravelSenses(lanes);
    if (senses.forward && senses.backward) {
        edge.bidirectional = true;
        delete edge.oneWay;
        delete edge.direction;
        delete edge.oneWayDirection;
    } else {
        edge.bidirectional = false;
        edge.direction = senses.forward ? 1 : -1;
        delete edge.oneWay;
        delete edge.oneWayDirection;
    }
    if (lanesEqualDerived(edge)) delete edge.lanes;
    return edge;
}

/**
 * Scale every lane width by the same factor so the road reaches `targetWidth`
 * exactly; the last lane absorbs floating-point rounding.
 */
export function scaleRoadLanesToWidth(lanes, targetWidth) {
    const source = cloneRoadLanes(lanes) ?? [];
    const total = sumLaneWidths(source);
    const target = Math.max(0, finite(targetWidth, total));
    if (source.length === 0 || total <= EPSILON) return source;
    const factor = target / total;
    let running = 0;
    return source.map((lane, index) => {
        if (index === source.length - 1) return { ...lane, width: target - running };
        const width = lane.width * factor;
        running += width;
        return { ...lane, width };
    });
}

/** Physical lane index 0 is the rightmost lane when the edge is traversed start -> end. */
export function laneCenterRightOffset(edge, laneIndex) {
    const count = roadLaneCount(edge);
    const index = Math.max(0, Math.min(count - 1, Math.trunc(finite(laneIndex, 0))));
    if (hasExplicitRoadLanes(edge)) {
        let offset = roadWidth(edge) * 0.5;
        for (let lane = 0; lane < index; lane += 1) offset -= roadLaneWidth(edge, lane);
        return offset - roadLaneWidth(edge, index) * 0.5;
    }
    const laneWidth = roadLaneWidth(edge);
    return roadWidth(edge) * 0.5 - laneWidth * (index + 0.5);
}

export function laneDirections(edge, laneIndex) {
    const count = roadLaneCount(edge);
    const index = Math.max(0, Math.min(count - 1, Math.trunc(finite(laneIndex, 0))));
    if (hasExplicitRoadLanes(edge)) {
        const direction = Number(edge.lanes[index]?.direction);
        if (direction === 0) return [1, -1];
        return [direction === -1 ? -1 : 1];
    }
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

/**
 * Interior lane boundaries, right to left. `dividerIndex` d separates the
 * lane at physical index d-1 (its right) from the lane at d (its left).
 * `marking` is the authored style of that boundary or `null` for automatic.
 */
export function laneDividerDescriptors(edge) {
    const result = [];
    const count = roadLaneCount(edge);
    const explicit = hasExplicitRoadLanes(edge);
    const lanes = explicit ? roadLanes(edge) : null;
    const laneWidth = roadLaneWidth(edge);
    let cumulative = 0;
    for (let dividerIndex = 1; dividerIndex < count; dividerIndex += 1) {
        const rightLaneDirections = laneDirections(edge, dividerIndex - 1);
        const leftLaneDirections = laneDirections(edge, dividerIndex);
        const opposing = !rightLaneDirections.some((direction) => leftLaneDirections.includes(direction));
        cumulative += explicit ? roadLaneWidth(edge, dividerIndex - 1) : 0;
        const rightOffset = explicit
            ? roadWidth(edge) * 0.5 - cumulative
            : roadWidth(edge) * 0.5 - laneWidth * dividerIndex;
        const rightLane = lanes?.[dividerIndex - 1] ?? null;
        result.push({
            dividerIndex,
            rightOffset,
            opposing,
            rightLaneId: rightLane?.id ?? laneIdForIndex(dividerIndex - 1),
            leftLaneId: lanes?.[dividerIndex]?.id ?? laneIdForIndex(dividerIndex),
            marking: rightLane?.markingLeft ?? null,
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
    return `${String(nodeId)} ${String(fromEdgeId)} ${String(toEdgeId)}`;
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
