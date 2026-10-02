import { EDITOR_MODES, EDITOR_TOOLS, MAP_TOOLS } from "../EditorState.js";
import { PlaceTool } from "./PlaceTool.js";
import { SelectTool } from "./SelectTool.js";
import { TransformTool } from "./TransformTool.js";
import { RoadAuthoringController } from "./RoadAuthoringController.js";
import { RoadSceneTool } from "./RoadSceneTool.js";
import { AssetPlacementController } from "../assets/AssetPlacementController.js";
import { screenToWorld } from "../map/mapCoords.js";
import { getGroundPointFromEvent } from "../editorPointerUtils.js";
import { PLACEMENT_DRAG_MIME, isSceneCanvasPlacementDrop } from "../../overlay/workspace/assetCatalogDrop.js";

export class EditorToolController {
    constructor({ data, scene, camera, renderer }) {
        this.data = data;
        this.camera = camera;
        this.renderer = renderer;
        this.editor = data.editor();
        this.selection = data.selection?.() ?? data.environment().selection?.() ?? null;
        this.bus = data.commands?.() ?? data.environment().commands?.() ?? null;
        this.keyDisposers = [];
        this.editorSnapshot = this.editor.snapshot();
        this.selectionSnapshot = this.selection?.snapshot?.() ?? null;
        this.disposeEditorState = this.editor.subscribe((snapshot) => {
            this.editorSnapshot = snapshot;
            this.publishEscapeFlag();
        });
        this.disposeSelection = this.selection?.subscribe?.((snapshot) => {
            this.selectionSnapshot = snapshot;
            this.publishEscapeFlag();
        }) ?? null;
        this.disposeBus = this.bus?.subscribe?.(() => this.publishEscapeFlag()) ?? null;
        this.selectTool = new SelectTool({ data, scene, camera, renderer });
        this.assetPlacementController = new AssetPlacementController({ data, scene });
        this.placeTool = new PlaceTool({ data, scene, camera, renderer, assetPlacementController: this.assetPlacementController });
        this.transformTool = new TransformTool({ data, scene, camera, renderer });
        this.roadAuthoringController = new RoadAuthoringController({ data });
        this.roadSceneTool = new RoadSceneTool({ data, scene, camera, renderer, controller: this.roadAuthoringController });
        this.tools = [this.selectTool, this.placeTool, this.transformTool, this.roadSceneTool, this.assetPlacementController];
        // ED-03: Q/W/E/R and Escape register through ShortcutProvider
        // (`EditorCommandShortcuts`) so they never fire while typing in a
        // field; this controller only owns the Escape policy.
        this.publishEscapeFlag();
        this.bindScenePlacementDrop();
    }

    bindScenePlacementDrop() {
        if (typeof window === "undefined") return;
        this.onScenePlacementDragOver = (event) => {
            if (!isSceneCanvasPlacementDrop(event, this.renderer?.domElement)) return;
            event.preventDefault();
        };
        this.onScenePlacementDrop = (event) => {
            if (!isSceneCanvasPlacementDrop(event, this.renderer?.domElement)) return;
            const raw = event.dataTransfer?.getData?.(PLACEMENT_DRAG_MIME);
            if (!raw) return;
            event.preventDefault();
            let dropped;
            try { dropped = JSON.parse(raw); } catch { return; }
            const rect = this.renderer.domElement.getBoundingClientRect();
            void this.dropAsset(dropped, event, rect);
        };
        window.addEventListener("dragover", this.onScenePlacementDragOver);
        window.addEventListener("drop", this.onScenePlacementDrop);
    }

    /** Whether the next Escape would be consumed by the editor (so the global switcher defers). */
    consumesEscape() {
        const snapshot = this.editorSnapshot ?? {};
        return Boolean(
            this.bus?.activeGesture
            || snapshot.map?.draft
            || snapshot.roadDraft
            || (this.selectionSnapshot?.ids?.length ?? 0) > 0
            || this.selectionSnapshot?.sub
            || (snapshot.editorMode === EDITOR_MODES.MAP
                ? (snapshot.map?.activeMapTool ?? MAP_TOOLS.SELECT) !== MAP_TOOLS.SELECT
                : snapshot.activeTool !== EDITOR_TOOLS.SELECT),
        );
    }

    publishEscapeFlag() {
        if (typeof window === "undefined") return;
        window.__fusionEnvironmentEditorConsumesEscape = this.consumesEscape();
    }

    async dropAsset(payload, event, rect) {
        if (payload?.kind !== "catalog") return { ok: false };
        const placement = { ...payload, obstacle: true, semantic: payload.semantic ?? "unknown" };
        this.editor.setPlacementAsset(placement);
        await this.assetPlacementController.begin(placement);
        const snapshot = this.editor.snapshot();
        const map = snapshot.editorMode === EDITOR_MODES.MAP;
        const point = map
            ? screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, snapshot.map, { width: rect.width, height: rect.height })
            : getGroundPointFromEvent(event, this.camera, this.renderer);
        if (!point) { this.assetPlacementController.cancel(); return { ok: false }; }
        const result = await this.assetPlacementController.commit(point, { map, obstacle: true, semantic: placement.semantic });
        if (result.ok) {
            if (map) this.editor.setActiveMapTool(MAP_TOOLS.SELECT);
            else this.editor.setActiveTool(EDITOR_TOOLS.SELECT);
        }
        return result;
    }

    /**
     * Escape order: cancel an active gesture, then a map draft (road pen or
     * building rectangle), then leave the tool, then clear the selection.
     * Returns `false` when nothing was consumed so the global workspace
     * switcher can open. Earth Import owns its own Escape.
     */
    handleEscape() {
        const snapshot = this.editor.snapshot();
        const render = () => this.data.simulation()?.render?.();

        if (this.bus?.activeGesture) {
            if (this.roadAuthoringController.cancelSubDrag()) {
                render();
                return true;
            }
            if (!this.transformTool.cancelActiveGesture()) this.bus.cancelGesture(this.bus.activeGesture.id);
            render();
            return true;
        }

        if (snapshot.roadDraft) {
            this.roadAuthoringController.cancelStroke();
            return true;
        }

        if (snapshot.editorMode === EDITOR_MODES.MAP) {
            if (snapshot.map?.draft) {
                this.editor.clearMapDraft();
                render();
                return true;
            }
            if ((snapshot.map?.activeMapTool ?? MAP_TOOLS.SELECT) !== MAP_TOOLS.SELECT) {
                this.editor.setActiveMapTool(MAP_TOOLS.SELECT);
                render();
                return true;
            }
        } else if (snapshot.activeTool !== EDITOR_TOOLS.SELECT) {
            this.editor.setActiveTool(EDITOR_TOOLS.SELECT);
            render();
            return true;
        }

        if (!this.selection || this.selection.isEmpty?.()) return false;
        this.selection.clear?.();
        render();
        return true;
    }

    dispose() {
        if (typeof window !== "undefined") {
            window.removeEventListener("dragover", this.onScenePlacementDragOver);
            window.removeEventListener("drop", this.onScenePlacementDrop);
        }
        this.roadAuthoringController.cancelSubDrag();
        this.disposeEditorState?.();
        this.disposeSelection?.();
        this.disposeBus?.();
        if (typeof window !== "undefined") {
            window.__fusionEnvironmentEditorConsumesEscape = false;
        }
        this.tools.forEach((tool) => tool.dispose?.());
        this.tools = [];
    }
}
