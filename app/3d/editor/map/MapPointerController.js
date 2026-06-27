import { findNearestMovableNode } from "../document/documentMutations.js";
import { MAP_SELECTION_TYPES, MAP_TOOLS } from "../EditorState.js";
import { pickMapTarget } from "./mapHitTest.js";
import {
    handleBuildingRectDown,
    handleBuildingRectMove,
    handleBuildingRectUp,
    handleEndpointMove,
    handleFeatureMove,
    handleFeaturePlace,
    handleIntersectionPlace,
    handleRoadPenClick,
    panViewport,
    shouldPanImmediately,
    SNAP_RADIUS_SCREEN,
    zoomViewport,
} from "./MapToolLogic.js";
import { advancePanDrag } from "./mapPointerInteractions.js";
import { screenRadiusToWorld } from "./mapCoords.js";

function getScene(data) {
    return data?.three?.()?.scene ?? data?.scene ?? null;
}

/**
 * Map pointer interaction state machine. Keeps drag/pan/tool gestures out of MapSurface.
 *
 * Interaction shapes:
 * - { mode: "pan" | "pending-pan", x, y }
 * - { type: "building-rect" }
 * - { type: "move-endpoint", nodeId }
 * - { type: "move-feature", featureId }
 */
export class MapPointerController {
    constructor() {
        this.activeInteraction = null;
    }

    reset() {
        this.activeInteraction = null;
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
        const scene = getScene(data);
        if (!editor || !environment) return false;

        const world = getWorldFromEvent(event);
        if (!world) return false;

        const tool = editor.snapshot().map.activeMapTool;
        const document = environment.getDocument();
        const altPan = event.altKey || event.button === 1;

        if (shouldPanImmediately(tool, altPan)) {
            this.activeInteraction = {
                x: event.clientX,
                y: event.clientY,
                mode: "pan",
            };
            return true;
        }

        if (tool === MAP_TOOLS.INTERSECTION) {
            handleIntersectionPlace({ worldPoint: world, document, editor });
            return true;
        }

        if (tool === MAP_TOOLS.ROAD_PEN) {
            if (!scene) return false;
            handleRoadPenClick({
                worldPoint: world,
                document,
                editor,
                data,
                scene,
                size: ctx.size,
            });
            return true;
        }

        if (tool === MAP_TOOLS.BUILDING_RECT) {
            handleBuildingRectDown({ worldPoint: world, editor });
            this.activeInteraction = { type: "building-rect" };
            return true;
        }

        if (tool === MAP_TOOLS.FEATURE_PLACE) {
            if (!scene) return false;
            handleFeaturePlace({
                worldPoint: world,
                document,
                editor,
                data,
                scene,
            });
            return true;
        }

        if (tool === MAP_TOOLS.SELECT) {
            const snapRadius = screenRadiusToWorld(SNAP_RADIUS_SCREEN, editor.snapshot().map);
            if (showDetail) {
                const endpoint = findNearestMovableNode(document, world, snapRadius);
                if (endpoint) {
                    editor.clearMapSelection();
                    this.activeInteraction = {
                        type: "move-endpoint",
                        nodeId: endpoint.id,
                    };
                    return true;
                }
            }

            const pick = pickMapTarget(
                world,
                document,
                editor.snapshot().map,
                { ...layers, detail: showDetail },
                SNAP_RADIUS_SCREEN,
            );

            if (pick?.type === MAP_SELECTION_TYPES.FEATURE) {
                editor.selectMapItem(pick);
                this.activeInteraction = {
                    type: "move-feature",
                    featureId: pick.id,
                };
                return true;
            }

            if (pick) {
                editor.selectMapItem(pick);
            } else {
                editor.clearMapSelection();
            }

            this.activeInteraction = {
                x: event.clientX,
                y: event.clientY,
                mode: "pending-pan",
            };
            return true;
        }

        if (tool === MAP_TOOLS.PAN) {
            this.activeInteraction = {
                x: event.clientX,
                y: event.clientY,
                mode: "pan",
            };
            return true;
        }

        return false;
    }

    handlePointerMove(ctx, event) {
        const { data, getWorldFromEvent, documentSnapshot } = ctx;
        const editor = data?.editor?.();
        const environment = data?.environment?.();
        const scene = getScene(data);
        if (!editor) return;

        if (this.activeInteraction?.type === "move-endpoint") {
            const world = getWorldFromEvent(event);
            if (world && scene && environment) {
                handleEndpointMove({
                    document: environment.getDocument(),
                    editor,
                    data,
                    scene,
                    nodeId: this.activeInteraction.nodeId,
                    worldPoint: world,
                });
            }
            return;
        }

        if (this.activeInteraction?.type === "move-feature") {
            const world = getWorldFromEvent(event);
            if (world && environment) {
                handleFeatureMove({
                    document: environment.getDocument(),
                    editor,
                    data,
                    featureId: this.activeInteraction.featureId,
                    worldPoint: world,
                });
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
        const scene = getScene(data);

        if (!editor || !environment) {
            this.reset();
            return;
        }

        if (this.activeInteraction?.type === "building-rect") {
            if (scene) {
                handleBuildingRectUp({
                    document: environment.getDocument(),
                    editor,
                    data,
                    scene,
                });
            } else {
                editor.clearMapDraft();
            }
        }

        if (this.activeInteraction?.type === "move-endpoint" && scene) {
            const world = getWorldFromEvent(event);
            if (world) {
                handleEndpointMove({
                    document: environment.getDocument(),
                    editor,
                    data,
                    scene,
                    nodeId: this.activeInteraction.nodeId,
                    worldPoint: world,
                    finalize: true,
                });
            }
        }

        this.reset();
    }
}
