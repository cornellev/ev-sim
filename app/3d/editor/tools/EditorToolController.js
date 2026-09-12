import { EDITOR_MODES, EDITOR_TOOLS, MAP_TOOLS } from "../EditorState.js";
import { PlaceTool } from "./PlaceTool.js";
import { SelectTool } from "./SelectTool.js";
import { TransformTool } from "./TransformTool.js";

export class EditorToolController {
    constructor({ data, scene, camera, renderer }) {
        this.data = data;
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
        this.placeTool = new PlaceTool({ data, scene, camera, renderer });
        this.transformTool = new TransformTool({ data, scene, camera, renderer });
        this.tools = [this.selectTool, this.placeTool, this.transformTool];
        // ED-03: Q/W/E/R and Escape register through ShortcutProvider
        // (`EditorCommandShortcuts`) so they never fire while typing in a
        // field; this controller only owns the Escape policy.
        this.publishEscapeFlag();
    }

    /** Whether the next Escape would be consumed by the editor (so the global switcher defers). */
    consumesEscape() {
        const snapshot = this.editorSnapshot ?? {};
        return Boolean(
            snapshot.editorMode === EDITOR_MODES.EARTH_IMPORT
            || this.bus?.activeGesture
            || snapshot.map?.draft
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

    /**
     * Escape order: cancel an active gesture, then a map draft (road pen or
     * building rectangle), then leave the tool, then clear the selection.
     * Returns `false` when nothing was consumed so the global workspace
     * switcher can open. Earth Import owns its own Escape.
     */
    handleEscape() {
        const snapshot = this.editor.snapshot();
        if (snapshot.editorMode === EDITOR_MODES.EARTH_IMPORT) return false;
        const render = () => this.data.simulation()?.render?.();

        if (this.bus?.activeGesture) {
            if (!this.transformTool.cancelActiveGesture()) this.bus.cancelGesture(this.bus.activeGesture.id);
            render();
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
