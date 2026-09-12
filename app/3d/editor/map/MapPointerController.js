import { findNearestNode } from "../document/documentMutations.js";
import { MAP_SELECTION_TYPES, MAP_TOOLS } from "../EditorState.js";
import { pickMapTarget } from "./mapHitTest.js";
import {
    beginFeatureDrag,
    beginNodeDrag,
    cancelDrag,
    finishFeatureDrag,
    finishNodeDrag,
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
    updateNodeDrag,
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
                { ...layers, detail: showDetail },
                SNAP_RADIUS_SCREEN,
            );

            if (pick?.type === MAP_SELECTION_TYPES.FEATURE && !isAdditive(event)) {
                const interaction = beginFeatureDrag({ document, data, featureId: pick.id });
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
            const draft = editor.snapshot().map.draft;
            if (draft?.type === "road-pen" && draft.activeNodeId) {
                const startNode = documentSnapshot.roads.nodes.find((node) => node.id === draft.activeNodeId);
                if (startNode) {
                    editor.setMapDraft({
                        ...draft,
                        cursor: { x: world.x, z: world.z },
                    });
                }
            }
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
        }
    }
}
