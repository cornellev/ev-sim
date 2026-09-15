import { findNearestNode } from "../document/documentMutations.js";
import { MAP_SELECTION_TYPES, MAP_TOOLS } from "../EditorState.js";
import { pickMapTarget } from "./mapHitTest.js";
import {
    beginFeatureDrag,
    beginAssetDrag,
    beginNodeDrag,
    beginRoadDrag,
    cancelDrag,
    finishEndpointSubDrag,
    finishFeatureDrag,
    finishAssetDrag,
    finishNodeDrag,
    finishRoadDrag,
    finalizeRoadPen,
    handleBuildingRectDown,
    handleBuildingRectMove,
    handleBuildingRectUp,
    handleFeaturePlace,
    handleIntersectionPlace,
    handleRoadPenClick,
    panViewport,
    resolveRoadPenSnap,
    shouldPanImmediately,
    SNAP_RADIUS_SCREEN,
    updateFeatureDrag,
    updateAssetDrag,
    updateNodeDrag,
    updateRoadDrag,
    zoomViewport,
} from "./MapToolLogic.js";
import { advancePanDrag, advancePendingObjectDrag } from "./mapPointerInteractions.js";
import { screenRadiusToWorld } from "./mapCoords.js";
import { mapWheelZoomFactor } from "./mapViewport.js";
import {
    advanceConnectPreview,
    endpointNodeIdForSub,
    resolveIntersectionConnectTarget,
} from "./mapRoadConnect.js";
import { roadGeometryVersionOf } from "../../../roads/RoadGeometryRecord.js";

function selectionOf(data) {
    return data?.selection?.() ?? data?.environment?.()?.selection?.() ?? null;
}

function isAdditive(event) {
    return Boolean(event?.shiftKey || event?.metaKey || event?.ctrlKey);
}

/**
 * Map pointer interaction state machine. Keeps drag/pan/tool gestures out of MapSurface.
 *
 * Interaction shapes:
 * - { mode: "pan" | "pending-pan", x, y }
 * - { mode: "pending-object", x, y, worldStart, begin }
 * - { type: "building-rect" }
 * - { type: "move-node", nodeId, gestureId, start }
 * - { type: "move-feature", featureId, gestureId, start }
 * - { type: "move-asset", objectId, gestureId, start }
 */
export class MapPointerController {
    constructor() {
        this.activeInteraction = null;
        this.connectPreviewState = null;
    }

    reset() {
        this.activeInteraction = null;
        this.connectPreviewState = null;
    }

    clearConnectPreview(editor) {
        this.connectPreviewState = null;
        editor?.clearConnectPreview?.();
    }

    /** Arm the hover highlight after dwell; returns the target only once armed. */
    syncConnectPreview(editor, target, now = Date.now()) {
        const next = advanceConnectPreview(this.connectPreviewState, target?.intersectionId ?? null, now);
        this.connectPreviewState = next.state;
        editor?.setConnectPreview?.(next.armed ? { intersectionId: next.intersectionId } : null);
        return next.armed ? target : null;
    }

    /** Cancel an in-progress drag gesture (pointer cancel, Escape). */
    cancel(ctx) {
        const interaction = this.activeInteraction;
        this.activeInteraction = null;
        this.clearConnectPreview(ctx?.data?.editor?.());
        if (interaction?.gestureId) cancelDrag({ interaction, data: ctx?.data });
        if (interaction?.type === "move-road-sub") interaction.controller?.cancelSubDrag?.();
        if (interaction?.type === "building-rect") ctx?.data?.editor?.()?.clearMapDraft?.();
    }

    handleWheel({ data, containerRect, size }, event) {
        event.preventDefault();
        if (!containerRect) return;

        const editor = data?.editor?.();
        if (!editor) return;

        zoomViewport(
            editor,
            { x: event.clientX - containerRect.left, y: event.clientY - containerRect.top },
            size,
            mapWheelZoomFactor(event.deltaY),
        );
    }

    handlePointerDown(ctx, event) {
        if (event.button !== 0 && event.button !== 1) return false;

        const { data, getWorldFromEvent, layers, showDetail } = ctx;
        const editor = data?.editor?.();
        const environment = data?.environment?.();
        if (!editor || !environment) return false;

        const world = getWorldFromEvent(event);
        if (!world) return false;

        const tool = editor.snapshot().map.activeMapTool;
        const document = environment.getDocument();
        const selection = selectionOf(data);
        const altPan = event.altKey || event.button === 1;

        if (shouldPanImmediately(tool, altPan)) {
            this.activeInteraction = { x: event.clientX, y: event.clientY, mode: "pan" };
            return true;
        }

        if (tool === MAP_TOOLS.INTERSECTION) {
            handleIntersectionPlace({ worldPoint: world, document, editor, data });
            return true;
        }

        if (tool === MAP_TOOLS.ROAD_PEN) {
            handleRoadPenClick({ worldPoint: world, document, editor, data, size: ctx.size });
            if (event.detail >= 2 && editor.snapshot().roadDraft) finalizeRoadPen(editor, data);
            if (!editor.snapshot().roadDraft) this.clearConnectPreview(editor);
            return true;
        }

        if (tool === MAP_TOOLS.BUILDING_RECT) {
            handleBuildingRectDown({ worldPoint: world, editor });
            this.activeInteraction = { type: "building-rect" };
            return true;
        }

        if (tool === MAP_TOOLS.FEATURE_PLACE) {
            handleFeaturePlace({ worldPoint: world, document, editor, data });
            return true;
        }

        if (tool === MAP_TOOLS.ASSET_PLACE) {
            const controller = environment.toolController?.assetPlacementController;
            controller?.updatePoint?.(world, { map: true });
            void controller?.commit?.(world, { map: true });
            return true;
        }

        if (tool === MAP_TOOLS.SELECT) {
            const worldStart = { x: world.x, z: world.z };
            const pendingObject = (begin) => ({
                mode: "pending-object",
                x: event.clientX,
                y: event.clientY,
                worldStart,
                begin,
            });
            const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
            if (showDetail) {
                const node = findNearestNode(world, document.roads.nodes, snapRadius);
                if (node) {
                    const record = document.getObject?.(node.id) ?? null;
                    if (record) selection?.select(node.id);
                    this.activeInteraction = pendingObject(
                        () => beginNodeDrag({ document, data, nodeId: node.id, worldPoint: worldStart }),
                    );
                    return true;
                }
            }

            const pick = pickMapTarget(
                world,
                document,
                editor.snapshot().map,
                { ...layers, detail: showDetail, selectedRoadId: selection?.snapshot?.().primary ?? null },
                SNAP_RADIUS_SCREEN,
                ctx.runtimeAssetBounds,
                ctx.size,
            );

            if (pick?.type === MAP_SELECTION_TYPES.ASSET && !isAdditive(event)) {
                selection?.select(pick.id);
                this.activeInteraction = pendingObject(
                    () => beginAssetDrag({ document, data, objectId: pick.id, worldPoint: worldStart }),
                );
                return true;
            }

            if (pick?.type === MAP_SELECTION_TYPES.FEATURE && !isAdditive(event)) {
                selection?.select(pick.id);
                this.activeInteraction = pendingObject(
                    () => beginFeatureDrag({ document, data, featureId: pick.id, worldPoint: worldStart }),
                );
                return true;
            }

            if (pick?.type === MAP_SELECTION_TYPES.ROAD && !isAdditive(event)) {
                if (pick.sub?.kind === "road-lane") {
                    // A lane pick only changes selection: lanes have no
                    // position to drag, and the road itself stays put.
                    selection?.select(pick.id, { mode: "replace", sub: pick.sub });
                    this.activeInteraction = { x: event.clientX, y: event.clientY, mode: "pending-pan" };
                    return true;
                }
                if (pick.sub) {
                    selection?.select(pick.id, { mode: "replace", sub: pick.sub });
                    this.activeInteraction = pendingObject(() => {
                        const controller = data.environment?.()?.toolController?.roadAuthoringController;
                        const begun = controller?.beginSubDrag?.(pick.sub);
                        if (!begun?.ok) return null;
                        const nodeId = endpointNodeIdForSub(document, pick.sub);
                        const node = nodeId ? document.getNode?.(nodeId) : null;
                        return {
                            type: "move-road-sub",
                            start: { x: worldStart.x, z: worldStart.z },
                            origin: node ? { x: node.x, z: node.z } : null,
                            nodeId: nodeId ?? null,
                            controller,
                        };
                    });
                    return true;
                }
                selection?.select(pick.id);
                this.activeInteraction = pendingObject(
                    () => beginRoadDrag({ data, edgeId: pick.id, worldPoint: worldStart }),
                );
                return true;
            }

            if (pick) {
                selection?.select(pick.id, { mode: isAdditive(event) ? "toggle" : "replace" });
            } else if (!isAdditive(event)) {
                selection?.clear();
            }

            this.activeInteraction = { x: event.clientX, y: event.clientY, mode: "pending-pan" };
            return true;
        }

        if (tool === MAP_TOOLS.PAN) {
            this.activeInteraction = { x: event.clientX, y: event.clientY, mode: "pan" };
            return true;
        }

        return false;
    }

    handlePointerMove(ctx, event) {
        const { data, getWorldFromEvent } = ctx;
        const editor = data?.editor?.();
        if (!editor) return;

        if (this.activeInteraction?.mode === "pending-object") {
            this.activeInteraction = advancePendingObjectDrag(
                this.activeInteraction,
                event.clientX,
                event.clientY,
                (pending) => pending.begin?.() ?? pending,
            );
            if (this.activeInteraction?.mode === "pending-object") return;
        }

        if (this.activeInteraction?.type === "move-node") {
            const world = getWorldFromEvent(event);
            if (world) {
                const document = data.environment?.()?.getDocument?.();
                const magnet = this.endpointMagnet(editor, document, world, this.activeInteraction.nodeId);
                updateNodeDrag({ interaction: this.activeInteraction, editor, data, worldPoint: world, magnet });
            }
            return;
        }

        if (this.activeInteraction?.type === "move-feature") {
            const world = getWorldFromEvent(event);
            if (world) updateFeatureDrag({ interaction: this.activeInteraction, editor, data, worldPoint: world });
            return;
        }

        if (this.activeInteraction?.type === "move-asset") {
            const world = getWorldFromEvent(event);
            if (world) updateAssetDrag({ interaction: this.activeInteraction, editor, data, worldPoint: world });
            return;
        }

        if (this.activeInteraction?.type === "move-road") {
            const world = getWorldFromEvent(event);
            if (world) updateRoadDrag({ interaction: this.activeInteraction, data, worldPoint: world });
            return;
        }
        if (this.activeInteraction?.type === "move-road-sub") {
            const world = getWorldFromEvent(event);
            if (world) {
                const document = data.environment?.()?.getDocument?.();
                const magnet = this.endpointMagnet(editor, document, world, this.activeInteraction.nodeId);
                if (magnet && this.activeInteraction.origin) {
                    this.activeInteraction.controller.updateSubDrag({
                        x: magnet.x - this.activeInteraction.origin.x,
                        z: magnet.z - this.activeInteraction.origin.z,
                    });
                } else {
                    this.activeInteraction.controller.updateSubDrag({
                        x: world.x - this.activeInteraction.start.x,
                        z: world.z - this.activeInteraction.start.z,
                    });
                }
            }
            return;
        }

        if (this.activeInteraction?.mode === "pan" || this.activeInteraction?.mode === "pending-pan") {
            this.activeInteraction = advancePanDrag(
                this.activeInteraction,
                event.clientX,
                event.clientY,
                (dx, dy) => panViewport(editor, dx, dy),
            );
            return;
        }

        const world = getWorldFromEvent(event);
        if (!world) return;

        const tool = editor.snapshot().map.activeMapTool;
        if (tool === MAP_TOOLS.ROAD_PEN) {
            const document = data.environment?.()?.getDocument?.();
            const controller = data.environment?.()?.toolController?.roadAuthoringController;
            if (document && controller) {
                const snap = resolveRoadPenSnap({
                    worldPoint: world,
                    document,
                    editor,
                    draft: editor.snapshot().roadDraft,
                });
                const armed = this.syncConnectPreview(editor, snap.connect);
                controller.updateStrokeCursor(world, armed ? snap.snapTarget : null);
            } else {
                controller?.updateStrokeCursor?.(world);
            }
            return;
        }

        if (tool === MAP_TOOLS.ASSET_PLACE) {
            data.environment?.()?.toolController?.assetPlacementController?.updatePoint?.(world, { map: true });
            return;
        }

        if (tool === MAP_TOOLS.BUILDING_RECT && this.activeInteraction?.type === "building-rect") {
            handleBuildingRectMove({ worldPoint: world, editor });
        }
    }

    handlePointerUp(ctx, event) {
        const { data, getWorldFromEvent } = ctx;
        const editor = data?.editor?.();
        const environment = data?.environment?.();
        const interaction = this.activeInteraction;
        this.activeInteraction = null;

        if (!editor || !environment || !interaction) return;

        if (interaction.mode === "pending-object" || interaction.mode === "pending-pan" || interaction.mode === "pan") {
            return;
        }

        if (interaction.type === "building-rect") {
            handleBuildingRectUp({ editor, data });
            return;
        }

        const world = getWorldFromEvent(event);
        if (interaction.type === "move-node") {
            finishNodeDrag({ interaction, document: environment.getDocument(), editor, data, worldPoint: world });
            this.clearConnectPreview(editor);
            return;
        }

        if (interaction.type === "move-feature") {
            finishFeatureDrag({ interaction, editor, data, worldPoint: world });
            return;
        }
        if (interaction.type === "move-asset") {
            finishAssetDrag({ interaction, editor, data, worldPoint: world });
            return;
        }
        if (interaction.type === "move-road") {
            finishRoadDrag({ interaction, data, worldPoint: world });
            return;
        }
        if (interaction.type === "move-road-sub") {
            finishEndpointSubDrag({
                interaction,
                document: environment.getDocument(),
                editor,
                data,
                worldPoint: world,
            });
            this.clearConnectPreview(editor);
        }
    }

    endpointMagnet(editor, document, worldPoint, nodeId) {
        if (!document || !nodeId || roadGeometryVersionOf(document) !== 2) {
            this.clearConnectPreview(editor);
            return null;
        }
        const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
        const target = resolveIntersectionConnectTarget(document, worldPoint, snapRadius, { kind: "endpoint", nodeId });
        const armed = this.syncConnectPreview(editor, target);
        return armed ? armed.position : null;
    }
}
