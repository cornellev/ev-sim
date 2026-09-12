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
import { deleteObjects } from "../commands/objectCommands.js";
import { commandFailure, commandIssue, commandSuccess, COMMAND_ISSUE_CODES } from "../commands/commandIssues.js";
import { MAP_WORLD_SCALE, screenRadiusToWorld } from "./mapCoords.js";

const SNAP_RADIUS_SCREEN = 12;

export { SNAP_RADIUS_SCREEN };

function busOf(data) {
    return data?.commands?.() ?? data?.environment?.()?.commands?.() ?? null;
}

function selectionOf(data) {
    return data?.selection?.() ?? data?.environment?.()?.selection?.() ?? null;
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
 * Road pen: first click starts a draft at a node; later clicks draw an edge
 * from the previous node to the clicked node as one transaction.
 */
export function handleRoadPenClick({ worldPoint, document, editor, data }) {
    const bus = busOf(data);
    const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
    const snapped = applySnap(worldPoint, editor);
    const draft = editor.snapshot().map.draft;

    if (!draft?.type || draft.type !== "road-pen") {
        const started = bus.execute(resolveRoadPenNode({ point: snapped, snapRadius }));
        if (!started.ok) return { error: started.error };
        const node = started.result.node;
        editor.setMapDraft({ type: "road-pen", activeNodeId: node.id, cursor: { x: snapped.x, z: snapped.z } });
        return { node };
    }

    let outcome = null;
    const result = bus.transaction("Draw road", (run) => {
        const resolved = run(resolveRoadPenNode({ point: snapped, snapRadius }));
        const node = resolved.result.node;
        if (draft.activeNodeId === node.id) {
            outcome = { node };
            return;
        }
        const startNode = getDocumentNode(document, draft.activeNodeId);
        if (!startNode) {
            throw new Error("The road pen lost its start node.");
        }
        const edge = run(legacyCommands.addRoadEdge({
            startNodeId: draft.activeNodeId,
            endNodeId: node.id,
            options: buildEdgeArms(document, startNode, node),
        }));
        outcome = { node, edge: edge.result.edge };
    });
    if (!result.ok) return { error: result.error, issues: result.issues };
    if (outcome?.node) {
        editor.setMapDraft({ type: "road-pen", activeNodeId: outcome.node.id, cursor: { x: snapped.x, z: snapped.z } });
    }
    data.simulation()?.render?.();
    return outcome ?? {};
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
export function beginNodeDrag({ document, data, nodeId }) {
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
    return { type: "move-node", nodeId, gestureId: begun.gestureId, start: { x: node.x, z: node.z } };
}

export function updateNodeDrag({ interaction, editor, data, worldPoint }) {
    const bus = busOf(data);
    if (!interaction?.gestureId) return { ok: false };
    const snapped = applySnap(worldPoint, editor);
    const result = bus.updateGesture(interaction.gestureId, deltaFromTranslation({
        x: snapped.x - interaction.start.x,
        z: snapped.z - interaction.start.z,
    }));
    data.simulation()?.render?.();
    return result;
}

/**
 * Finish a node drag: commit, then let a free endpoint merge into a nearby
 * intersection (the legacy snap/connect rule).
 */
export function finishNodeDrag({ interaction, document, editor, data, worldPoint }) {
    const bus = busOf(data);
    if (!interaction?.gestureId) return { ok: false };
    if (worldPoint) updateNodeDrag({ interaction, editor, data, worldPoint });
    const committed = bus.commitGesture(interaction.gestureId);
    const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
    const node = getDocumentNode(document, interaction.nodeId);
    if (committed.ok && node && !isIntersectionNode(document, node)) {
        const connected = bus.execute(legacyCommands.connectEndpoint({
            endpointId: interaction.nodeId,
            point: { x: node.x, z: node.z },
            snapRadius,
        }));
        data.simulation()?.render?.();
        return { ok: true, connected: connected.ok && connected.result?.connected === true };
    }
    data.simulation()?.render?.();
    return { ok: committed.ok, connected: false, issues: committed.issues };
}

export function cancelDrag({ interaction, data }) {
    const bus = busOf(data);
    if (interaction?.gestureId) bus.cancelGesture(interaction.gestureId);
    data.simulation()?.render?.();
}

export function beginFeatureDrag({ document, data, featureId }) {
    const bus = busOf(data);
    const feature = document.getFeature(featureId);
    if (!feature) return null;
    selectionOf(data)?.select(featureId);
    const begun = bus.beginGesture({ objectIds: [featureId], label: "Move prop" });
    if (!begun.ok) return null;
    return { type: "move-feature", featureId, gestureId: begun.gestureId, start: { x: feature.x, z: feature.z } };
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

export function handleMapDelete({ data, objectIds }) {
    const ids = [...(objectIds ?? [])];
    if (ids.length === 0) return { ok: false, error: "Nothing selected." };
    const result = busOf(data).execute(deleteObjects({ objectIds: ids }));
    data.simulation()?.render?.();
    return result.ok ? { ok: true, deleted: result.result.deleted } : { ok: false, error: result.error, issues: result.issues };
}

export function cancelRoadPen(editor) {
    editor.clearMapDraft();
}

export function finalizeRoadPen(editor) {
    editor.clearMapDraft();
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
    const map = editor.snapshot().map;
    const scale = map.zoom * MAP_WORLD_SCALE;
    editor.setMapViewport({
        centerX: map.centerX - deltaX / scale,
        centerZ: map.centerZ - deltaY / scale,
    });
}

export function zoomViewport(editor, screen, size, delta) {
    const map = editor.snapshot().map;
    const factor = delta > 0 ? 1.1 : 0.9;
    const nextZoom = Math.min(8, Math.max(0.25, map.zoom * factor));
    if (nextZoom === map.zoom) return;

    const scale = map.zoom * MAP_WORLD_SCALE;
    const worldX = map.centerX + (screen.x - size.width / 2) / scale;
    const worldZ = map.centerZ + (screen.y - size.height / 2) / scale;

    const nextScale = nextZoom * MAP_WORLD_SCALE;
    editor.setMapViewport({
        zoom: nextZoom,
        centerX: worldX - (screen.x - size.width / 2) / nextScale,
        centerZ: worldZ - (screen.y - size.height / 2) / nextScale,
    });
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
