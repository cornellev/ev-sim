import { createId, DEFAULT_ROAD_EDGE } from "../document/EnvironmentDocument.js";
import { compileRoadPlan, getNodeDegree, pruneInfeasibleTurnRules, setTurnMovementAllowed } from "../document/documentMutations.js";
import { cloneRoadGeometry, resolveRoadEdge } from "../../../roads/RoadGeometryRecord.js";
import {
    LANE_DIRECTIONS,
    ROAD_MARKINGS,
    cloneRoadLanes,
    explicitRoadLanes,
    hasExplicitRoadLanes,
    nextLaneId,
    normalizeRoadLanes,
} from "../../../roads/RoadLaneModel.js";
import { sampleCenterline, splitEdge as splitGeometry } from "../../../roads/RoadGeometry.js";
import { ROAD_GEOMETRY_POLICY_V1 } from "../../../roads/RoadGeometryPolicy.js";
import { commandFailure, commandIssue, commandSuccess, COMMAND_ISSUE_CODES } from "./commandIssues.js";
import { ensureObjectRecord, removeObjectRecords, renumberSiblings, upsertObjectRecord } from "./objectMutations.js";

const EPSILON = 1e-9;
const ROAD_KIND = new Set(["polyline", "cubic-bezier"]);

function finitePoint(value, label = "Road point") {
    const x = Number(value?.x);
    const y = Number(value?.y ?? 0);
    const z = Number(value?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new TypeError(`${label} must have finite X, Y, and Z coordinates.`);
    return { x, y, z };
}

function subtract(left, right) {
    return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value, amount) {
    return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function uniqueId(document, prefix, lookup) {
    let id = createId(prefix);
    while (lookup(document, id)) id = createId(prefix);
    return id;
}

function uniqueNodeId(document, prefix = "node") {
    return uniqueId(document, prefix, (target, id) => target.getNode(id));
}

function uniqueEdgeId(document) {
    return uniqueId(document, "road", (target, id) => target.getEdge(id));
}

function ensureKind(kind) {
    const result = String(kind ?? "cubic-bezier");
    if (!ROAD_KIND.has(result)) throw new TypeError(`Road geometry kind "${result}" is unsupported.`);
    return result;
}

function requireUnlocked(ctx, ...objectIds) {
    const issues = objectIds.filter((value) => value !== null && value !== undefined).flatMap((value) => {
        const objectId = String(value);
        const record = ctx.document.getObject(objectId);
        return record?.components?.locked === true
            ? [commandIssue(COMMAND_ISSUE_CODES.OBJECT_LOCKED, `"${record.name ?? objectId}" is locked.`, { objectId })]
            : [];
    });
    if (issues.length > 0) {
        const error = new Error(issues[0].message);
        error.issues = issues;
        throw error;
    }
}

function legacyPolyline(document, edge) {
    const start = document.getNode(edge.startNodeId);
    const end = document.getNode(edge.endNodeId);
    const candidates = [start, edge.startArm, edge.endArm, end].filter(Boolean).map((value) => finitePoint(value));
    const points = candidates.filter((value, index) => index === 0 || distance(value, candidates[index - 1]) > EPSILON);
    if (points.length < 2) throw new TypeError(`Road "${edge.id}" cannot be upgraded because it has zero length.`);
    const knots = points.map((value, index) => ({
        id: index === 0 ? "start" : index === points.length - 1 ? "end" : `legacy-${index}`,
        ...(index > 0 && index < points.length - 1 ? { position: value } : {}),
    }));
    return { version: 1, kind: "polyline", knots };
}

export function ensureRoadGeometryV2(ctx) {
    const { document } = ctx;
    if (Number(document.roads?.geometryVersion ?? 1) === 2) return false;
    for (const edge of document.roads.edges) {
        edge.geometry = legacyPolyline(document, edge);
        edge.startArm = null;
        edge.endArm = null;
    }
    document.setRoadGeometryVersion(2, { notify: false });
    document.setScalar("roadsAuthored", true, { notify: false });
    return true;
}

function command(id, label, mutation) {
    return {
        id,
        label,
        run(ctx) {
            try {
                const result = mutation(ctx);
                return commandSuccess(result ?? {});
            } catch (error) {
                return commandFailure(error.issues ?? commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, error.message));
            }
        },
    };
}

function nodeFor(document, id, fallbackPoint, kind = "endpoint") {
    if (id !== undefined && id !== null) {
        const existing = document.getNode(String(id));
        if (!existing) throw new TypeError(`Road node "${id}" does not exist.`);
        return existing;
    }
    const point = finitePoint(fallbackPoint);
    const node = { id: uniqueNodeId(document, kind), ...point, kind };
    document.roads.nodes.push(node);
    return node;
}

function geometryFromPoints(points, kind) {
    return {
        version: 1,
        kind,
        knots: points.map((point, index) => ({
            id: index === 0 ? "start" : index === points.length - 1 ? "end" : `k${index}`,
            ...(index > 0 && index < points.length - 1 ? { position: point } : {}),
            ...(kind === "cubic-bezier" ? { mode: "auto" } : {}),
        })),
    };
}

export function createRoad({ points = [], kind = "cubic-bezier", startNodeId = null, endNodeId = null, options = {}, parentId = null } = {}) {
    return command("road.create", "Create road", (ctx) => {
        requireUnlocked(ctx, parentId, startNodeId, endNodeId);
        ensureRoadGeometryV2(ctx);
        const values = points.map((point, index) => finitePoint(point, `Road point ${index}`));
        if (values.length < 2) throw new TypeError("A road stroke requires at least two points.");
        for (let index = 1; index < values.length; index += 1) {
            if (distance(values[index - 1], values[index]) <= EPSILON) throw new TypeError("A road stroke cannot contain duplicate consecutive points.");
        }
        const geometryKind = ensureKind(kind);
        const start = nodeFor(ctx.document, startNodeId, values[0]);
        const end = nodeFor(ctx.document, endNodeId, values.at(-1));
        if (start.id === end.id) throw new TypeError("A road cannot connect a node to itself.");
        const edge = {
            id: uniqueEdgeId(ctx.document),
            startNodeId: start.id,
            endNodeId: end.id,
            bidirectional: options.bidirectional ?? DEFAULT_ROAD_EDGE.bidirectional,
            ...(options.direction !== undefined ? { direction: options.direction } : {}),
            width: Number(options.width ?? DEFAULT_ROAD_EDGE.width),
            laneCount: Number(options.laneCount ?? DEFAULT_ROAD_EDGE.laneCount),
            shoulderWidth: Number(options.shoulderWidth ?? 0),
            tension: options.tension ?? null,
            borderLeft: options.borderLeft ?? null,
            borderRight: options.borderRight ?? null,
            startArm: null,
            endArm: null,
            geometry: geometryFromPoints(values, geometryKind),
        };
        if (Array.isArray(options.lanes)) {
            if (options.lanes.length === 0) throw new TypeError("A road needs at least one lane.");
            const lanes = [];
            for (const input of options.lanes) lanes.push(laneRecord(input, lanes, nextLaneId(lanes)));
            edge.lanes = lanes;
        }
        normalizeRoadLanes(edge);
        ctx.document.roads.edges.push(edge);
        ensureObjectRecord(ctx.document, { id: edge.id, typeId: "road", name: options.name ?? "Road", parentId }, { notify: false });
        return { edge, startNode: start, endNode: end };
    });
}

function manualBezierFromPolyline(resolved) {
    const knots = resolved.geometry.knots.map((knot, index, values) => {
        const previous = values[index - 1]?.position ?? null;
        const next = values[index + 1]?.position ?? null;
        return {
            id: knot.id,
            ...(index > 0 && index < values.length - 1 ? { position: { ...knot.position } } : {}),
            mode: "free",
            ...(previous ? { handleIn: scale(subtract(previous, knot.position), 1 / 3) } : {}),
            ...(next ? { handleOut: scale(subtract(next, knot.position), 1 / 3) } : {}),
        };
    });
    return { version: 1, kind: "cubic-bezier", knots };
}

function polylineFromSamples(samples) {
    return {
        version: 1,
        kind: "polyline",
        knots: samples.points.map((point, index) => ({
            id: index === 0 ? "start" : index === samples.points.length - 1 ? "end" : `k${index}`,
            ...(index > 0 && index < samples.points.length - 1 ? { position: { ...point } } : {}),
        })),
    };
}

export function convertRoadGeometry({ edgeId, kind } = {}) {
    return command("road.convert-geometry", "Convert road geometry", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = ctx.document.getEdge(String(edgeId));
        if (!edge) throw new TypeError(`Road "${edgeId}" does not exist.`);
        const target = ensureKind(kind);
        if (edge.geometry.kind === target) return { edge, changed: false };
        const resolved = resolveRoadEdge(edge, ctx.document.index().nodes);
        edge.geometry = target === "cubic-bezier"
            ? manualBezierFromPolyline(resolved)
            : polylineFromSamples(sampleCenterline(resolved, ROAD_GEOMETRY_POLICY_V1));
        return { edge, changed: true };
    });
}

function nextKnotId(edge) {
    const ids = new Set(edge.geometry.knots.map((knot) => knot.id));
    let index = 1;
    while (ids.has(`k${index}`)) index += 1;
    return `k${index}`;
}

export function insertRoadKnot({ edgeId, at } = {}) {
    return command("road.insert-knot", "Insert road knot", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = ctx.document.getEdge(String(edgeId));
        if (!edge) throw new TypeError(`Road "${edgeId}" does not exist.`);
        const split = splitGeometry(resolveRoadEdge(edge, ctx.document.index().nodes), at);
        const knotId = nextKnotId(edge);
        split.geometry.knots.find((knot) => knot.id === "split").id = knotId;
        edge.geometry = split.geometry;
        return { edge, knotId, point: split.point };
    });
}

export function removeRoadKnot({ edgeId, knotId } = {}) {
    return command("road.remove-knot", "Remove road knot", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = ctx.document.getEdge(String(edgeId));
        if (!edge) throw new TypeError(`Road "${edgeId}" does not exist.`);
        if (["start", "end"].includes(String(knotId))) throw new TypeError("Road endpoint knots cannot be removed.");
        const index = edge.geometry.knots.findIndex((knot) => knot.id === String(knotId));
        if (index < 0) throw new TypeError(`Road knot "${knotId}" does not exist.`);
        edge.geometry.knots.splice(index, 1);
        return { edge, knotId: String(knotId) };
    });
}

function vectorLength(value) {
    return Math.hypot(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
}

function alignedOpposite(value, previous) {
    const magnitude = vectorLength(previous);
    const inputMagnitude = vectorLength(value);
    if (inputMagnitude <= EPSILON || magnitude <= EPSILON) return previous;
    return scale(value, -magnitude / inputMagnitude);
}

export function setRoadKnot({ edgeId, knotId, patch = {} } = {}) {
    return command("road.set-knot", "Edit road knot", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = ctx.document.getEdge(String(edgeId));
        if (!edge) throw new TypeError(`Road "${edgeId}" does not exist.`);
        const knotIndex = edge.geometry.knots.findIndex((knot) => knot.id === String(knotId));
        if (knotIndex < 0) throw new TypeError(`Road knot "${knotId}" does not exist.`);
        const knot = edge.geometry.knots[knotIndex];
        if (patch.position !== undefined) {
            const position = finitePoint(patch.position, "Road knot position");
            if (knot.id === "start" || knot.id === "end") {
                const node = ctx.document.getNode(knot.id === "start" ? edge.startNodeId : edge.endNodeId);
                Object.assign(node, position);
            } else knot.position = position;
        }
        if (edge.geometry.kind === "cubic-bezier") {
            const resolved = resolveRoadEdge(edge, ctx.document.index().nodes).geometry.knots[knotIndex];
            if (patch.mode !== undefined) {
                if (!["auto", "aligned", "free"].includes(patch.mode)) throw new TypeError(`Unknown road handle mode "${patch.mode}".`);
                knot.mode = patch.mode;
                if (patch.mode !== "auto") {
                    if (knotIndex > 0) knot.handleIn = { ...resolved.handleIn };
                    if (knotIndex < edge.geometry.knots.length - 1) knot.handleOut = { ...resolved.handleOut };
                } else {
                    delete knot.handleIn;
                    delete knot.handleOut;
                }
            }
            for (const side of ["handleIn", "handleOut"]) {
                if (patch[side] === undefined) continue;
                const value = finitePoint(patch[side], side);
                if (side === "handleIn" && knotIndex === 0 || side === "handleOut" && knotIndex === edge.geometry.knots.length - 1) throw new TypeError("The outer endpoint handle is unused.");
                if ((knot.mode ?? "auto") === "auto") {
                    knot.mode = "aligned";
                    if (knotIndex > 0) knot.handleIn = { ...resolved.handleIn };
                    if (knotIndex < edge.geometry.knots.length - 1) knot.handleOut = { ...resolved.handleOut };
                }
                knot[side] = value;
                if (knot.mode === "aligned") {
                    const opposite = side === "handleIn" ? "handleOut" : "handleIn";
                    if (knot[opposite]) knot[opposite] = alignedOpposite(value, knot[opposite]);
                }
            }
        }
        return { edge, knotId: knot.id };
    });
}

function rewriteSplitTurnRules(document, source, leftId, rightId, splitNodeId) {
    document.roads.turnRules = (document.roads.turnRules ?? []).map((rule) => {
        const replacement = rule.nodeId === source.startNodeId ? leftId : rule.nodeId === source.endNodeId ? rightId : null;
        if (!replacement) return rule;
        return {
            ...rule,
            fromEdgeId: rule.fromEdgeId === source.id ? replacement : rule.fromEdgeId,
            toEdgeId: rule.toEdgeId === source.id ? replacement : rule.toEdgeId,
        };
    }).filter((rule) => rule.nodeId !== splitNodeId);
}

function replaceObjectForSplit(document, sourceEdgeId, leftId, rightId) {
    const source = document.getObject(sourceEdgeId);
    if (!source) return;
    const parentId = source.parentId ?? null;
    const siblings = document.objects.filter((record) => (record.parentId ?? null) === parentId).sort((left, right) => left.order - right.order || String(left.id).localeCompare(String(right.id)));
    const index = siblings.findIndex((record) => record.id === source.id);
    removeObjectRecords(document, [source.id], { notify: false });
    for (const [offset, id] of [leftId, rightId].entries()) {
        upsertObjectRecord(document, { ...source, id, name: offset === 0 ? source.name : `${source.name} 2`, order: source.order + offset }, { notify: false });
    }
    renumberSiblings(document.objects, parentId, { moved: [leftId, rightId], index: Math.max(0, index) });
}

function splitRoadMutation(ctx, edgeId, at) {
    requireUnlocked(ctx, edgeId);
    const source = ctx.document.getEdge(String(edgeId));
    if (!source) throw new TypeError(`Road "${edgeId}" does not exist.`);
    const split = splitGeometry(resolveRoadEdge(source, ctx.document.index().nodes), at);
    // A split introduces a topological anchor, not an explicitly authored
    // junction. The compiler derives any required junction surface from degree.
    const node = { id: uniqueNodeId(ctx.document, "road-node"), ...split.point, kind: "endpoint" };
    const leftId = uniqueEdgeId(ctx.document);
    const rightId = uniqueEdgeId(ctx.document);
    const shared = { ...structuredClone(source), startArm: null, endArm: null };
    const left = { ...structuredClone(shared), id: leftId, endNodeId: node.id, geometry: cloneRoadGeometry(split.leftGeometry) };
    const right = { ...structuredClone(shared), id: rightId, startNodeId: node.id, geometry: cloneRoadGeometry(split.rightGeometry) };
    const sourceIndex = ctx.document.roads.edges.indexOf(source);
    ctx.document.roads.nodes.push(node);
    ctx.document.roads.edges.splice(sourceIndex, 1, left, right);
    rewriteSplitTurnRules(ctx.document, source, leftId, rightId, node.id);
    replaceObjectForSplit(ctx.document, source.id, leftId, rightId);
    return { sourceEdgeId: source.id, node, left, right };
}

export function splitRoad({ edgeId, at } = {}) {
    return command("road.split", "Split road", (ctx) => {
        ensureRoadGeometryV2(ctx);
        return splitRoadMutation(ctx, edgeId, at);
    });
}

export function detachRoadEndpoint({ edgeId, end } = {}) {
    return command("road.detach-endpoint", "Detach road endpoint", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = ctx.document.getEdge(String(edgeId));
        if (!edge) throw new TypeError(`Road "${edgeId}" does not exist.`);
        if (!["start", "end"].includes(end)) throw new TypeError("Road endpoint must be start or end.");
        const field = end === "start" ? "startNodeId" : "endNodeId";
        const source = ctx.document.getNode(edge[field]);
        const node = { ...structuredClone(source), id: uniqueNodeId(ctx.document, "endpoint"), kind: "endpoint" };
        ctx.document.roads.nodes.push(node);
        edge[field] = node.id;
        return { edge, node };
    });
}

function removeOrphanEndpoint(document, nodeId) {
    if (getNodeDegree(document, nodeId) > 0) return;
    const node = document.getNode(nodeId);
    if (node?.kind === "intersection") return;
    document.roads.nodes = document.roads.nodes.filter((candidate) => candidate.id !== nodeId);
}

export function connectRoadEndpoint({ edgeId, end, target } = {}) {
    return command("road.connect-endpoint", "Connect road endpoint", (ctx) => {
        requireUnlocked(ctx, edgeId, target?.nodeId, target?.edgeId);
        ensureRoadGeometryV2(ctx);
        let edge = ctx.document.getEdge(String(edgeId));
        if (!edge) throw new TypeError(`Road "${edgeId}" does not exist.`);
        if (!["start", "end"].includes(end)) throw new TypeError("Road endpoint must be start or end.");
        let targetNode;
        let split = null;
        if (target?.nodeId !== undefined) {
            targetNode = ctx.document.getNode(String(target.nodeId));
            if (!targetNode) throw new TypeError(`Target road node "${target.nodeId}" does not exist.`);
        } else if (target?.edgeId !== undefined && target?.at) {
            if (String(target.edgeId) === String(edgeId)) throw new TypeError("A road endpoint cannot connect to its own interior.");
            split = splitRoadMutation(ctx, target.edgeId, target.at);
            targetNode = split.node;
            edge = ctx.document.getEdge(String(edgeId));
        } else throw new TypeError("A connection target must name a node or an interior edge parameter.");
        if (getNodeDegree(ctx.document, targetNode.id) >= 4) throw new TypeError("Road nodes cannot exceed four connected roads.");
        const field = end === "start" ? "startNodeId" : "endNodeId";
        const otherField = end === "start" ? "endNodeId" : "startNodeId";
        if (edge[otherField] === targetNode.id) throw new TypeError("A road cannot connect a node to itself.");
        const previousNodeId = edge[field];
        edge[field] = targetNode.id;
        removeOrphanEndpoint(ctx.document, previousNodeId);
        return { edge, node: targetNode, split };
    });
}

// ------------------------------------------------------------------- lanes
//
// ED-05 lane authoring. Every lane command materializes the target edge's
// lanes (and only that edge's), mutates them, then canonicalizes: width, lane
// count, and direction fields follow the lane records, and a layout equal to
// the derived default returns to implicit. Infeasible turn-rule overrides are
// pruned with the compiled plan. The bus validates the domain afterwards, so
// illegal layouts roll the whole command back with structured issues.

function requireEdge(ctx, edgeId) {
    const edge = ctx.document.getEdge(String(edgeId));
    if (!edge) throw new TypeError(`Road "${edgeId}" does not exist.`);
    return edge;
}

function materializeLanes(edge) {
    if (!hasExplicitRoadLanes(edge)) edge.lanes = explicitRoadLanes(edge);
    return edge.lanes;
}

function finishLaneEdit(ctx, edge) {
    normalizeRoadLanes(edge);
    pruneInfeasibleTurnRules(ctx.document, { plan: compileRoadPlan(ctx.document) });
    ctx.document.setScalar("roadsAuthored", true, { notify: false });
    return edge;
}

function laneDirectionValue(value, label = "Lane direction") {
    const direction = Number(value);
    if (!LANE_DIRECTIONS.includes(direction)) throw new TypeError(`${label} must be 1, -1, or 0.`);
    return direction === 0 ? 0 : direction;
}

function laneWidthValue(value, label = "Lane width") {
    const width = Number(value);
    if (!Number.isFinite(width) || width <= EPSILON) throw new TypeError(`${label} must be greater than zero.`);
    return width;
}

function markingValue(value, label = "Marking") {
    if (value === null || value === undefined) return null;
    const marking = String(value);
    if (!ROAD_MARKINGS.includes(marking)) throw new TypeError(`${label} "${marking}" is not a known road marking.`);
    return marking;
}

function laneRecord(input, existing, fallbackId) {
    const source = input && typeof input === "object" ? input : {};
    const id = source.id === undefined || source.id === null || source.id === "" ? fallbackId : String(source.id);
    if (existing.some((lane) => lane.id === id)) throw new TypeError(`Lane id "${id}" is already used on this road.`);
    const marking = markingValue(source.markingLeft, `Lane "${id}" marking`);
    return {
        id,
        direction: laneDirectionValue(source.direction, `Lane "${id}" direction`),
        width: laneWidthValue(source.width, `Lane "${id}" width`),
        ...(marking ? { markingLeft: marking } : {}),
    };
}

function laneIndexOf(edge, laneId) {
    const index = edge.lanes.findIndex((lane) => lane.id === String(laneId));
    if (index < 0) throw new TypeError(`Lane "${laneId}" does not exist on road "${edge.id}".`);
    return index;
}

/** Replace a road's lanes wholesale. Omitted ids are assigned `lane-<n>`. */
export function setRoadLanes({ edgeId, lanes } = {}) {
    return command("road.set-lanes", "Set road lanes", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = requireEdge(ctx, edgeId);
        if (!Array.isArray(lanes) || lanes.length === 0) throw new TypeError("A road needs at least one lane.");
        const next = [];
        for (const input of lanes) next.push(laneRecord(input, next, nextLaneId(next)));
        edge.lanes = next;
        finishLaneEdit(ctx, edge);
        return { edge, lanes: cloneRoadLanes(edge.lanes ?? explicitRoadLanes(edge)) };
    });
}

/** Where a new lane goes and which existing lane it copies its defaults from. */
function resolveInsertion(edge, at) {
    const clampIndex = (value) => Math.max(0, Math.min(edge.lanes.length, value));
    if (Number.isInteger(at) || (at && Number.isInteger(at.index))) {
        const index = clampIndex(Number.isInteger(at) ? at : at.index);
        return { index, reference: edge.lanes[Math.min(edge.lanes.length - 1, index)] };
    }
    if (at?.laneId !== undefined) {
        const referenceIndex = laneIndexOf(edge, at.laneId);
        const side = at.side ?? "left";
        if (!["left", "right"].includes(side)) throw new TypeError("Lane insertion side must be left or right.");
        return { index: side === "left" ? referenceIndex + 1 : referenceIndex, reference: edge.lanes[referenceIndex] };
    }
    return { index: edge.lanes.length, reference: edge.lanes[edge.lanes.length - 1] };
}

/**
 * Insert a lane beside an existing one (`at: { laneId, side }`) or at an
 * index. The new lane copies its neighbour's direction and width unless
 * `lane` overrides them; the road widens by the new lane.
 */
export function insertRoadLane({ edgeId, at = null, lane = {} } = {}) {
    return command("road.insert-lane", "Insert lane", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = requireEdge(ctx, edgeId);
        materializeLanes(edge);
        const { index, reference } = resolveInsertion(edge, at);
        const defaults = { direction: reference.direction, width: reference.width };
        if (reference.direction === 0) {
            // Splitting the shared single lane: the rightmost lane travels
            // forward and the leftmost backward, matching right-hand traffic.
            const newIsRight = index <= laneIndexOf(edge, reference.id);
            reference.direction = newIsRight ? -1 : 1;
            defaults.direction = newIsRight ? 1 : -1;
        }
        const record = laneRecord({ ...defaults, ...(lane ?? {}) }, edge.lanes, nextLaneId(edge.lanes));
        edge.lanes.splice(index, 0, record);
        finishLaneEdit(ctx, edge);
        return { edge, laneId: record.id, index };
    });
}

export function removeRoadLane({ edgeId, laneId } = {}) {
    return command("road.remove-lane", "Remove lane", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = requireEdge(ctx, edgeId);
        materializeLanes(edge);
        if (edge.lanes.length <= 1) throw new TypeError("A road needs at least one lane.");
        const index = laneIndexOf(edge, laneId);
        const [removed] = edge.lanes.splice(index, 1);
        const leftmost = edge.lanes[edge.lanes.length - 1];
        if (leftmost.markingLeft !== undefined) delete leftmost.markingLeft;
        finishLaneEdit(ctx, edge);
        return { edge, laneId: removed.id, index };
    });
}

/** Patch one lane's direction, width, or interior marking (`markingLeft: null` clears it). */
export function setRoadLane({ edgeId, laneId, patch = {} } = {}) {
    return command("road.set-lane", "Edit lane", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = requireEdge(ctx, edgeId);
        materializeLanes(edge);
        const lane = edge.lanes[laneIndexOf(edge, laneId)];
        if (patch.direction !== undefined) lane.direction = laneDirectionValue(patch.direction);
        if (patch.width !== undefined) lane.width = laneWidthValue(patch.width);
        if (patch.markingLeft !== undefined) {
            const marking = markingValue(patch.markingLeft);
            if (marking) lane.markingLeft = marking;
            else delete lane.markingLeft;
        }
        finishLaneEdit(ctx, edge);
        return { edge, laneId: lane.id };
    });
}

/**
 * Author a marking: `boundary` is `"left"`/`"right"` for the road borders or
 * `{ laneId }` for the interior boundary on that lane's left.
 */
export function setRoadMarking({ edgeId, boundary, marking } = {}) {
    return command("road.set-marking", "Set road marking", (ctx) => {
        requireUnlocked(ctx, edgeId);
        ensureRoadGeometryV2(ctx);
        const edge = requireEdge(ctx, edgeId);
        const value = markingValue(marking);
        if (boundary === "left" || boundary === "right") {
            edge[boundary === "left" ? "borderLeft" : "borderRight"] = value;
            ctx.document.setScalar("roadsAuthored", true, { notify: false });
            return { edge, boundary };
        }
        if (boundary?.laneId === undefined) throw new TypeError("A marking boundary must be left, right, or a lane id.");
        materializeLanes(edge);
        const lane = edge.lanes[laneIndexOf(edge, boundary.laneId)];
        if (value) lane.markingLeft = value;
        else delete lane.markingLeft;
        finishLaneEdit(ctx, edge);
        return { edge, boundary: { laneId: lane.id } };
    });
}

/** Sparse turn-rule override with structured issues; infeasible movements are refused. */
export function setRoadTurnRule({ nodeId, fromEdgeId, toEdgeId, allowed } = {}) {
    return command("road.set-turn-rule", "Set turn rule", (ctx) => {
        requireUnlocked(ctx, nodeId, fromEdgeId, toEdgeId);
        const result = setTurnMovementAllowed(ctx.document, String(nodeId), String(fromEdgeId), String(toEdgeId), allowed, { notify: false });
        if (!result.ok) {
            const error = new Error(result.error);
            error.issues = result.issues ?? [commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: String(nodeId) })];
            throw error;
        }
        return { nodeId: String(nodeId), fromEdgeId: String(fromEdgeId), toEdgeId: String(toEdgeId), defaultAllowed: result.defaultAllowed, overridden: result.overridden };
    });
}
