import { EDITOR_MODES, EDITOR_TOOLS } from "../EditorState.js";
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

        const keys = data.keys?.();
        this.keyDisposers = [
            keys?.registerKeyDown?.("q", () => this.editor.setActiveTool(EDITOR_TOOLS.SELECT)),
            keys?.registerKeyDown?.("w", () => this.editor.setActiveTool(EDITOR_TOOLS.TRANSLATE)),
            keys?.registerKeyDown?.("e", () => this.editor.setActiveTool(EDITOR_TOOLS.ROTATE)),
            keys?.registerKeyDown?.("r", () => this.editor.setActiveTool(EDITOR_TOOLS.SCALE)),
            keys?.registerKeyDown?.("Escape", () => this.handleEscape()),
        ].filter(Boolean);
    }

    publishEscapeFlag() {
        if (typeof window === "undefined") return;
        const snapshot = this.editorSnapshot ?? {};
        window.__fusionEnvironmentEditorConsumesEscape = Boolean(
            snapshot.editorMode === EDITOR_MODES.MAP
            || snapshot.editorMode === EDITOR_MODES.EARTH_IMPORT
            || this.bus?.activeGesture
            || (this.selectionSnapshot?.ids?.length ?? 0) > 0
            || this.selectionSnapshot?.sub
            || snapshot.activeTool !== EDITOR_TOOLS.SELECT,
        );
    }

    /** Escape order: cancel an active gesture, then leave the tool, then clear the selection. */
    handleEscape() {
        const snapshot = this.editor.snapshot();
        if (snapshot.editorMode === EDITOR_MODES.MAP
            || snapshot.editorMode === EDITOR_MODES.EARTH_IMPORT) return;

        if (this.bus?.activeGesture) {
            if (!this.transformTool.cancelActiveGesture()) this.bus.cancelGesture(this.bus.activeGesture.id);
            this.data.simulation()?.render?.();
            return;
        }

        if (snapshot.activeTool !== EDITOR_TOOLS.SELECT) {
            this.editor.setActiveTool(EDITOR_TOOLS.SELECT);
            this.data.simulation()?.render?.();
            return;
        }

        this.selection?.clear?.();
        this.data.simulation()?.render?.();
    }

    dispose() {
        this.disposeEditorState?.();
        this.disposeSelection?.();
        this.disposeBus?.();
        if (typeof window !== "undefined") {
            window.__fusionEnvironmentEditorConsumesEscape = false;
        }
        this.keyDisposers.forEach((dispose) => dispose?.());
        this.keyDisposers = [];
        this.tools.forEach((tool) => tool.dispose?.());
        this.tools = [];
    }
}
