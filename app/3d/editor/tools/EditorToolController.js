import { EDITOR_MODES, EDITOR_TOOLS } from "../EditorState.js";
import { PlaceTool } from "./PlaceTool.js";
import { SelectTool } from "./SelectTool.js";
import { TransformTool } from "./TransformTool.js";

export class EditorToolController {
    constructor({ data, scene, camera, renderer }) {
        this.data = data;
        this.editor = data.editor();
        this.keyDisposers = [];
        this.disposeEditorState = this.editor.subscribe((snapshot) => {
            if (typeof window === "undefined") return;
            window.__fusionEnvironmentEditorConsumesEscape = Boolean(
                snapshot.editorMode === EDITOR_MODES.MAP
                || snapshot.selection
                || snapshot.activeTool !== EDITOR_TOOLS.SELECT,
            );
        });
        this.tools = [
            new SelectTool({ data, scene, camera, renderer }),
            new PlaceTool({ data, scene, camera, renderer }),
            new TransformTool({ data, scene, camera, renderer }),
        ];

        const keys = data.keys?.();
        this.keyDisposers = [
            keys?.registerKeyDown?.("q", () => this.editor.setActiveTool(EDITOR_TOOLS.SELECT)),
            keys?.registerKeyDown?.("w", () => this.editor.setActiveTool(EDITOR_TOOLS.TRANSLATE)),
            keys?.registerKeyDown?.("e", () => this.editor.setActiveTool(EDITOR_TOOLS.ROTATE)),
            keys?.registerKeyDown?.("r", () => this.editor.setActiveTool(EDITOR_TOOLS.SCALE)),
            keys?.registerKeyDown?.("Escape", () => this.handleEscape()),
        ].filter(Boolean);
    }

    handleEscape() {
        const snapshot = this.editor.snapshot();
        if (snapshot.editorMode === EDITOR_MODES.MAP) return;

        if (snapshot.activeTool !== EDITOR_TOOLS.SELECT) {
            this.editor.setActiveTool(EDITOR_TOOLS.SELECT);
            this.data.simulation()?.render?.();
            return;
        }

        this.editor.clearSelection();
        this.data.simulation()?.render?.();
    }

    dispose() {
        this.disposeEditorState?.();
        if (typeof window !== "undefined") {
            window.__fusionEnvironmentEditorConsumesEscape = false;
        }
        this.keyDisposers.forEach((dispose) => dispose?.());
        this.keyDisposers = [];
        this.tools.forEach((tool) => tool.dispose?.());
        this.tools = [];
    }
}
