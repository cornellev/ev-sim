import { findNearestNode } from "../document/documentMutations.js";
import { MAP_SELECTION_TYPES, MAP_TOOLS } from "../EditorState.js";
import { pickMapTarget } from "./mapHitTest.js";
import {
    beginFeatureDrag,
    beginAssetDrag,
    beginNodeDrag,
    beginRoadDrag,
    cancelDrag,
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
    shouldPanImmediately,
    SNAP_RADIUS_SCREEN,
    updateFeatureDrag,
    updateAssetDrag,
    updateNodeDrag,
    updateRoadDrag,
    zoomViewport,
} from "./MapToolLogic.js";
import { advancePanDrag } from "./mapPointerInteractions.js";
import { screenRadiusToWorld } from "./mapCoords.js";

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
 * - { type: "building-rect" }
 * - { type: "move-node", nodeId, gestureId, start }
 * - { type: "move-feature", featureId, gestureId, start }
 */
export class MapPointerController {
    constructor() {
        this.activeInteraction = null;
    }

    reset() {
        this.activeInteraction = null;
    }

    /** Cancel an in-progress drag gesture (pointer cancel, Escape). */
    cancel(ctx) {
        const interaction = this.activeInteraction;
        this.activeInteraction = null;
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
            -event.deltaY,
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
            const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
            if (showDetail) {
                const node = findNearestNode(world, document.roads.nodes, snapRadius);
                if (node) {
                    const interaction = beginNodeDrag({ document, data, nodeId: node.id });
                    if (interaction) {
                        this.activeInteraction = interaction;
                        return true;
                    }
                }
            }

            const pick = pickMapTarget(
                world,
                document,
                editor.snapshot().map,
                { ...layers, detail: showDetail, selectedRoadId: selection?.snapshot?.().primary ?? null },
                SNAP_RADIUS_SCREEN,
                ctx.runtimeAssetBounds,
            );

            if (pick?.type === MAP_SELECTION_TYPES.ASSET && !isAdditive(event)) {
                const interaction = beginAssetDrag({ document, data, objectId: pick.id });
                if (interaction) {
                    this.activeInteraction = interaction;
                    return true;
                }
            }

            if (pick?.type === MAP_SELECTION_TYPES.FEATURE && !isAdditive(event)) {
                const interaction = beginFeatureDrag({ document, data, featureId: pick.id });
                if (interaction) {
                    this.activeInteraction = interaction;
                    return true;
                }
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
                    const controller = data.environment?.()?.toolController?.roadAuthoringController;
                    const begun = controller?.beginSubDrag?.(pick.sub);
                    if (begun?.ok) {
                        this.activeInteraction = { type: "move-road-sub", start: { x: world.x, z: world.z }, controller };
                        return true;
                    }
                }
                const interaction = beginRoadDrag({ data, edgeId: pick.id, worldPoint: world });
                if (interaction) {
                    this.activeInteraction = interaction;
                    return true;
                }
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
        const { data, getWorldFromEvent, documentSnapshot } = ctx;
        const editor = data?.editor?.();
        if (!editor) return;

        if (this.activeInteraction?.type === "move-node") {
            const world = getWorldFromEvent(event);
            if (world) updateNodeDrag({ interaction: this.activeInteraction, editor, data, worldPoint: world });
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
            if (world) this.activeInteraction.controller.updateSubDrag({ x: world.x - this.activeInteraction.start.x, z: world.z - this.activeInteraction.start.z });
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
            data.environment?.()?.toolController?.roadAuthoringController?.updateStrokeCursor?.(world);
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

        if (interaction.type === "building-rect") {
            handleBuildingRectUp({ editor, data });
            return;
        }

        const world = getWorldFromEvent(event);
        if (interaction.type === "move-node") {
            finishNodeDrag({ interaction, document: environment.getDocument(), editor, data, worldPoint: world });
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
            interaction.controller.finishSubDrag();
            data.simulation()?.render?.();
        }
    }
}
