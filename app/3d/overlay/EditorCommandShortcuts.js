'use client';

import { useEffect, useState } from "react";
import { useShortcut } from "../../ui";
import { EDITOR_MODES, EDITOR_TOOLS } from "../editor/EditorState";
import { objectCommands } from "../editor/commands/index.js";
import { finalizeRoadPen } from "../editor/map/MapToolLogic.js";
import { focusCameraOnSelection } from "../editor/tools/cameraFocus.js";

/**
 * Editor shortcuts registered through ShortcutProvider so they never fire
 * inside editable fields and consume the event only when something happened.
 * Escape runs `EditorToolController.handleEscape()` (gesture → map draft →
 * tool → selection) and yields to the global workspace switcher when nothing
 * was consumed. Earth Import owns its own keys.
 */
export function EditorCommandShortcuts({ data }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);

    const editorMode = editorSnapshot?.editorMode ?? EDITOR_MODES.SCENE;
    const inScene = editorMode === EDITOR_MODES.SCENE;
    const inMap = editorMode === EDITOR_MODES.MAP;
    const inEditor = inScene || inMap;
    const bus = () => data?.commands?.();
    const editor = () => data?.editor?.();
    const selection = () => data?.selection?.();
    const selectedIds = () => selection()?.ids ?? [];
    const render = () => data?.simulation?.()?.render?.();
    const consume = (result) => (result?.ok ? true : false);
    const setTool = (tool) => () => {
        editor()?.setActiveTool?.(tool);
        render();
        return true;
    };

    useShortcut({ id: "environment-tool-select", keys: "q", priority: 10, enabled: inScene, handler: setTool(EDITOR_TOOLS.SELECT) });
    useShortcut({ id: "environment-tool-translate", keys: "w", priority: 10, enabled: inScene, handler: setTool(EDITOR_TOOLS.TRANSLATE) });
    useShortcut({ id: "environment-tool-rotate", keys: "e", priority: 10, enabled: inScene, handler: setTool(EDITOR_TOOLS.ROTATE) });
    useShortcut({ id: "environment-tool-scale", keys: "r", priority: 10, enabled: inScene, handler: setTool(EDITOR_TOOLS.SCALE) });
    useShortcut({
        id: "environment-escape",
        keys: "Escape",
        priority: 15,
        enabled: inEditor,
        handler: () => {
            const controller = data?.environment?.()?.toolController;
            if (typeof controller?.handleEscape === "function") return controller.handleEscape() === true;
            return false;
        },
    });
    useShortcut({
        id: "environment-map-finish-road",
        keys: "Enter",
        priority: 15,
        enabled: inMap && editorSnapshot?.map?.draft?.type === "road-pen",
        handler: () => {
            finalizeRoadPen(editor());
            render();
            return true;
        },
    });
    useShortcut({
        id: "environment-undo",
        keys: "Mod+z",
        priority: 15,
        enabled: inEditor,
        handler: () => {
            const result = bus()?.undo();
            render();
            return consume(result);
        },
    });
    useShortcut({
        id: "environment-redo",
        keys: ["Shift+Mod+z", "Ctrl+y"],
        priority: 16,
        enabled: inEditor,
        handler: () => {
            const result = bus()?.redo();
            render();
            return consume(result);
        },
    });
    useShortcut({
        id: "environment-duplicate",
        keys: "Mod+d",
        priority: 15,
        enabled: inEditor,
        handler: () => {
            const ids = selectedIds();
            if (ids.length === 0) return false;
            const result = bus()?.execute(objectCommands.duplicateObjects({ objectIds: ids }));
            if (result?.ok && result.result?.rootIds?.length) selection()?.select(result.result.rootIds);
            render();
            return consume(result);
        },
    });
    useShortcut({
        id: "environment-delete",
        keys: ["Delete", "Backspace"],
        priority: 15,
        enabled: inEditor,
        handler: () => {
            const ids = selectedIds();
            if (ids.length === 0) return false;
            const result = bus()?.execute(objectCommands.deleteObjects({ objectIds: ids }));
            render();
            return consume(result);
        },
    });
    useShortcut({
        id: "environment-group",
        keys: "Mod+g",
        priority: 15,
        enabled: inEditor,
        handler: () => {
            const ids = selectedIds();
            if (ids.length === 0) return false;
            const result = bus()?.execute(objectCommands.groupObjects({ objectIds: ids }));
            if (result?.ok) selection()?.select(result.result.groupId);
            return consume(result);
        },
    });
    useShortcut({
        id: "environment-ungroup",
        keys: "Shift+Mod+g",
        priority: 16,
        enabled: inEditor,
        handler: () => {
            const ids = selectedIds();
            if (ids.length === 0) return false;
            const result = bus()?.execute(objectCommands.ungroupObjects({ objectIds: ids }));
            if (result?.ok) selection()?.select(result.result.children);
            return consume(result);
        },
    });
    useShortcut({
        id: "environment-frame",
        keys: "f",
        priority: 10,
        enabled: inScene,
        handler: () => focusCameraOnSelection({ data }),
    });

    return null;
}
