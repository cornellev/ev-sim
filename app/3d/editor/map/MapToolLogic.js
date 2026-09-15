/**
 * Map tool logic. Every document change dispatches a CommandBus command;
 * the SceneProjector updates the 3D runtime from the resulting change set.
 * Node and feature drags are gestures (begin/update/commit/cancel) so they
 * are one undoable operation and never rebuild the whole world.
 */

import {
    computeArmPoint,
    findNearestIntersection,
    findNearestNode,
    getDocumentNode,
    isIntersectionNode,
    snapPoint,
} from "../document/documentMutations.js";
import { MAP_TOOLS } from "../EditorState.js";
import { deltaFromTranslation } from "../objects/transformDelta.js";
import * as legacyCommands from "../commands/legacyCommands.js";
import { connectRoadEndpoint } from "../commands/roadCommands.js";
import { deleteObjects } from "../commands/objectCommands.js";
import { commandFailure, commandIssue, commandSuccess, COMMAND_ISSUE_CODES } from "../commands/commandIssues.js";
import { screenRadiusToWorld } from "./mapCoords.js";
import { panMapViewport, zoomMapViewport } from "./mapViewport.js";
import { endpointNodeIdForSub, resolveIntersectionConnectTarget } from "./mapRoadConnect.js";
import { roadGeometryVersionOf } from "../../../roads/RoadGeometryRecord.js";
import { isAssetBackedObject } from "../../../editor-assets/AssetBackedObject.js";

const SNAP_RADIUS_SCREEN = 12;

export { SNAP_RADIUS_SCREEN };

function busOf(data) {
    return data?.commands?.() ?? data?.environment?.()?.commands?.() ?? null;
}

function selectionOf(data) {
    return data?.selection?.() ?? data?.environment?.()?.selection?.() ?? null;
}

function roadControllerOf(data) {
    return data?.environment?.()?.toolController?.roadAuthoringController ?? null;
}

/**
 * @param {{ x: number, z: number }} worldPoint
 * @param {import("../EditorState.js").EditorState} editor
 */
export function applySnap(worldPoint, editor) {
    const map = editor.snapshot().map;
    if (!map.snapEnabled) return worldPoint;
    return snapPoint(worldPoint, map.snapSize);
}

function buildEdgeArms(document, startNode, endNode) {
    const options = {};
    if (isIntersectionNode(document, startNode)) options.startArm = computeArmPoint(startNode, endNode);
    if (isIntersectionNode(document, endNode)) options.endArm = computeArmPoint(endNode, startNode);
    return options;
}

/** Command: resolve the node under the pen (nearest intersection, else an endpoint node, creating one if needed). */
export function resolveRoadPenNode({ point, snapRadius, label = "Start road" }) {
    return {
        id: "resolve-road-pen-node",
        label,
        run(ctx) {
            const intersection = findNearestIntersection(point, ctx.document, snapRadius);
            if (intersection) return commandSuccess({ node: intersection, created: false });
            const endpointCandidates = ctx.document.roads.nodes.filter((node) => !isIntersectionNode(ctx.document, node));
            const existing = findNearestNode(point, endpointCandidates, snapRadius);
            if (existing) return commandSuccess({ node: existing, created: false });
            const created = legacyCommands.createEndpointNode({ point }).run(ctx);
            if (!created.ok) return created;
            return commandSuccess({ node: created.result.node, created: true });
        },
    };
}

/**
 * Prefer an intersection (then any node) under the unsnapped pointer so grid
 * snap cannot steal a diamond hit. Free placement still uses map snap.
 */
export function resolveRoadPenSnap({ worldPoint, document, editor, draft = null }) {
    const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
    const connect = resolveIntersectionConnectTarget(document, worldPoint, snapRadius, {
        kind: "stroke",
        startNodeId: draft?.type === "road-stroke" ? draft.startNodeId : null,
    });
    if (connect) {
        return {
            point: { x: connect.position.x, y: worldPoint.y ?? connect.position.y, z: connect.position.z },
            snapTarget: { nodeId: connect.intersectionId, position: connect.position },
            connect,
        };
    }
    const node = findNearestNode(worldPoint, document.roads.nodes, snapRadius);
    if (node) {
        return {
            point: { x: node.x, y: worldPoint.y ?? node.y ?? 0, z: node.z },
            snapTarget: { nodeId: node.id, position: node },
            connect: null,
        };
    }
    const snapped = applySnap(worldPoint, editor);
    return { point: { ...snapped, y: worldPoint.y ?? 0 }, snapTarget: null, connect: null };
}

/**
 * Road pen: first click starts a draft at a node; later clicks draw an edge
 * from the previous node to the clicked node as one transaction.
 */
export function handleRoadPenClick({ worldPoint, document, editor, data }) {
    const controller = roadControllerOf(data);
    if (!controller) return { error: "Road authoring is unavailable." };
    const draft = editor.snapshot().roadDraft;
    const { point, snapTarget } = resolveRoadPenSnap({ worldPoint, document, editor, draft });
    return draft?.type === "road-stroke"
        ? controller.appendStrokePoint(point, snapTarget)
        : controller.beginStroke(point, snapTarget);
}

export function handleIntersectionPlace({ worldPoint, document, editor, data }) {
    const snapped = applySnap(worldPoint, editor);
    const existing = findNearestIntersection(snapped, document, 2);
    if (existing) return { node: existing, reused: true };
    const result = busOf(data).execute(legacyCommands.createIntersection({ point: snapped }));
    if (!result.ok) return { error: result.error };
    selectionOf(data)?.select(result.result.objectId);
    return { node: result.result.node, reused: false };
}

/**
 * Begin a node drag. Junction nodes drag through their intersection record;
 * free endpoints drag as a sub-object. Returns the interaction state.
 */
export function beginNodeDrag({ document, data, nodeId, worldPoint = null }) {
    const bus = busOf(data);
    const node = getDocumentNode(document, nodeId);
    if (!node) return null;
    const record = document.getObject?.(nodeId) ?? null;
    const begun = bus.beginGesture({
        objectIds: record ? [nodeId] : [],
        sub: record ? null : { kind: "road-node", id: nodeId },
        label: "Move road node",
    });
    if (!begun.ok) return null;
    if (record) selectionOf(data)?.select(nodeId);
    const start = worldPoint ? { x: worldPoint.x, z: worldPoint.z } : { x: node.x, z: node.z };
    return { type: "move-node", nodeId, gestureId: begun.gestureId, start, origin: { x: node.x, z: node.z } };
}

export function updateNodeDrag({ interaction, editor, data, worldPoint, magnet = null }) {
    const bus = busOf(data);
    if (!interaction?.gestureId) return { ok: false };
    const delta = magnet && interaction.origin
        ? { x: magnet.x - interaction.origin.x, z: magnet.z - interaction.origin.z }
        : (() => {
            const snapped = applySnap(worldPoint, editor);
            return { x: snapped.x - interaction.start.x, z: snapped.z - interaction.start.z };
        })();
    const result = bus.updateGesture(interaction.gestureId, deltaFromTranslation(delta));
    data.simulation()?.render?.();
    return result;
}

function endpointConnectTarget({ document, editor, worldPoint, nodeId }) {
    if (!worldPoint || !nodeId || roadGeometryVersionOf(document) !== 2) return null;
    const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
    return resolveIntersectionConnectTarget(document, worldPoint, snapRadius, { kind: "endpoint", nodeId });
}

/**
 * Finish a node drag. Geometry-v2 free endpoints dropped on an intersection
 * cancel the move and run `road.connect-endpoint` as one undo step. Legacy v1
 * still commits the move, then merges with `connectEndpoint`.
 */
export function finishNodeDrag({ interaction, document, editor, data, worldPoint }) {
    const bus = busOf(data);
    if (!interaction?.gestureId) return { ok: false };
    const connectTarget = endpointConnectTarget({ document, editor, worldPoint, nodeId: interaction.nodeId });
    if (connectTarget) {
        bus.cancelGesture(interaction.gestureId);
        const connected = bus.execute(connectRoadEndpoint({
            edgeId: connectTarget.edgeId,
            end: connectTarget.end,
            target: { nodeId: connectTarget.intersectionId },
        }));
        editor.clearConnectPreview?.();
        data.simulation()?.render?.();
        return { ok: connected.ok, connected: connected.ok, issues: connected.issues };
    }
    if (worldPoint) updateNodeDrag({ interaction, editor, data, worldPoint });
    const committed = bus.commitGesture(interaction.gestureId);
    const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
    const node = getDocumentNode(document, interaction.nodeId);
    if (committed.ok && roadGeometryVersionOf(document) === 1 && node && !isIntersectionNode(document, node)) {
        const connected = bus.execute(legacyCommands.connectEndpoint({
            endpointId: interaction.nodeId,
            point: { x: node.x, z: node.z },
            snapRadius,
        }));
        editor.clearConnectPreview?.();
        data.simulation()?.render?.();
        return { ok: true, connected: connected.ok && connected.result?.connected === true };
    }
    editor.clearConnectPreview?.();
    data.simulation()?.render?.();
    return { ok: committed.ok, connected: false, issues: committed.issues };
}

/** Finish a start/end knot drag; same v2 connect-on-drop as a free endpoint node. */
export function finishEndpointSubDrag({ interaction, document, editor, data, worldPoint }) {
    const controller = interaction?.controller;
    if (!controller) return { ok: false };
    const nodeId = endpointNodeIdForSub(document, controller.subDrag?.sub);
    const connectTarget = endpointConnectTarget({ document, editor, worldPoint, nodeId });
    if (connectTarget) {
        controller.cancelSubDrag();
        const connected = busOf(data).execute(connectRoadEndpoint({
            edgeId: connectTarget.edgeId,
            end: connectTarget.end,
            target: { nodeId: connectTarget.intersectionId },
        }));
        editor.clearConnectPreview?.();
        data.simulation()?.render?.();
        return { ok: connected.ok, connected: connected.ok, issues: connected.issues };
    }
    const result = controller.finishSubDrag();
    editor.clearConnectPreview?.();
    data.simulation()?.render?.();
    return { ok: result.ok, connected: false, issues: result.issues };
}

export function cancelDrag({ interaction, data }) {
    const bus = busOf(data);
    if (interaction?.gestureId) bus.cancelGesture(interaction.gestureId);
    data.simulation()?.render?.();
}

export function beginFeatureDrag({ document, data, featureId, worldPoint = null }) {
    const bus = busOf(data);
    const feature = document.getFeature(featureId);
    if (!feature) return null;
    selectionOf(data)?.select(featureId);
    const begun = bus.beginGesture({ objectIds: [featureId], label: "Move prop" });
    if (!begun.ok) return null;
    const start = worldPoint ? { x: worldPoint.x, z: worldPoint.z } : { x: feature.x, z: feature.z };
    return { type: "move-feature", featureId, gestureId: begun.gestureId, start };
}

export function updateFeatureDrag({ interaction, editor, data, worldPoint }) {
    return updateNodeDrag({ interaction, editor, data, worldPoint });
}

export function finishFeatureDrag({ interaction, editor, data, worldPoint }) {
    const bus = busOf(data);
    if (!interaction?.gestureId) return { ok: false };
    if (worldPoint) updateNodeDrag({ interaction, editor, data, worldPoint });
    const committed = bus.commitGesture(interaction.gestureId);
    data.simulation()?.render?.();
    return committed;
}

export function beginAssetDrag({ document, data, objectId, worldPoint }) {
    const record = document.getObject(String(objectId));
    if (!isAssetBackedObject(record) || !worldPoint) return null;
    selectionOf(data)?.select(record.id);
    const begun = busOf(data).beginGesture({ objectIds: [record.id], label: "Move asset" });
    if (!begun.ok) return null;
    return { type: "move-asset", objectId: record.id, gestureId: begun.gestureId, start: { x: worldPoint.x, z: worldPoint.z } };
}

export function updateAssetDrag({ interaction, editor, data, worldPoint }) {
    return updateNodeDrag({ interaction, editor, data, worldPoint });
}

export function finishAssetDrag({ interaction, editor, data, worldPoint }) {
    return finishFeatureDrag({ interaction, editor, data, worldPoint });
}

export function handleMapDelete({ data, objectIds }) {
    const ids = [...(objectIds ?? [])];
    if (ids.length === 0) return { ok: false, error: "Nothing selected." };
    const result = busOf(data).execute(deleteObjects({ objectIds: ids }));
    data.simulation()?.render?.();
    return result.ok ? { ok: true, deleted: result.result.deleted } : { ok: false, error: result.error, issues: result.issues };
}

export function cancelRoadPen(editor, data = null) {
    if (!roadControllerOf(data)?.cancelStroke?.()) editor.clearRoadDraft?.();
}

export function finalizeRoadPen(editor, data = null) {
    const controller = roadControllerOf(data);
    return controller ? controller.finishStroke() : (editor.clearRoadDraft?.(), { ok: false });
}

export function beginRoadDrag({ data, edgeId, worldPoint }) {
    selectionOf(data)?.select(edgeId);
    const begun = busOf(data).beginGesture({ objectIds: [edgeId], label: "Move road" });
    if (!begun.ok) return null;
    return { type: "move-road", edgeId, gestureId: begun.gestureId, start: { x: worldPoint.x, z: worldPoint.z } };
}

export function updateRoadDrag({ interaction, data, worldPoint }) {
    const result = busOf(data).updateGesture(interaction.gestureId, deltaFromTranslation({ x: worldPoint.x - interaction.start.x, z: worldPoint.z - interaction.start.z }));
    data.simulation()?.render?.();
    return result;
}

export function finishRoadDrag({ interaction, data, worldPoint }) {
    if (worldPoint) updateRoadDrag({ interaction, data, worldPoint });
    const result = busOf(data).commitGesture(interaction.gestureId);
    data.simulation()?.render?.();
    return result;
}

export function handleBuildingRectDown({ worldPoint, editor }) {
    const snapped = applySnap(worldPoint, editor);
    editor.setMapDraft({
        type: "building-rect",
        cornerA: { x: snapped.x, z: snapped.z },
        cornerB: { x: snapped.x, z: snapped.z },
    });
}

export function handleBuildingRectMove({ worldPoint, editor }) {
    const draft = editor.snapshot().map.draft;
    if (draft?.type !== "building-rect" || !draft.cornerA) return;
    const snapped = applySnap(worldPoint, editor);
    editor.setMapDraft({
        ...draft,
        cornerB: { x: snapped.x, z: snapped.z },
    });
}

export function handleBuildingRectUp({ editor, data }) {
    const draft = editor.snapshot().map.draft;
    if (draft?.type !== "building-rect" || !draft.cornerA || !draft.cornerB) {
        editor.clearMapDraft();
        return null;
    }
    const snapSize = editor.snapshot().map.snapEnabled ? editor.snapshot().map.snapSize : 0;
    editor.clearMapDraft();
    const result = busOf(data).execute(legacyCommands.addBuilding({ cornerA: draft.cornerA, cornerB: draft.cornerB, snapSize }));
    if (!result.ok) return { error: result.error, issues: result.issues };
    selectionOf(data)?.select(result.result.objectId);
    data.simulation()?.render?.();
    return { record: result.result.building };
}

export function handleFeaturePlace({ worldPoint, editor, data }) {
    const featureType = editor.snapshot().map.activeFeatureType;
    if (!featureType) return null;
    const snapped = applySnap(worldPoint, editor);
    const result = busOf(data).execute(legacyCommands.addFeature({ type: featureType, x: snapped.x, z: snapped.z }));
    if (!result.ok) return null;
    selectionOf(data)?.select(result.result.objectId);
    data.simulation()?.render?.();
    return { record: result.result.feature, objectId: result.result.objectId };
}

export function panViewport(editor, deltaX, deltaY) {
    editor.setMapViewport(panMapViewport(editor.snapshot().map, deltaX, deltaY));
}

export function zoomViewport(editor, screen, size, factor) {
    const map = editor.snapshot().map;
    const next = zoomMapViewport(map, screen, size, factor);
    if (next === map) return;
    editor.setMapViewport(next);
}

export function shouldPanOnPointer(activeMapTool) {
    return activeMapTool === MAP_TOOLS.PAN || activeMapTool === MAP_TOOLS.SELECT;
}

export function shouldPanImmediately(activeMapTool, altKey) {
    return activeMapTool === MAP_TOOLS.PAN || altKey;
}

export function emptySelectionFailure() {
    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "Nothing selected."));
}
