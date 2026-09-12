'use client';

import { useEffect, useState } from "react";
import { useShortcut } from "../../ui";
import { EDITOR_MODES } from "../editor/EditorState";
import { objectCommands } from "../editor/commands/index.js";
import { focusCameraOnSelection } from "../editor/tools/cameraFocus.js";

/**
 * Editor command shortcuts registered through ShortcutProvider so they never
 * fire inside editable fields and consume the event only when the command
 * succeeds. Escape stays with EditorToolController (gesture → tool →
 * selection); Delete in map mode stays with MapModeChrome.
 */
export function EditorCommandShortcuts({ data }) {
    const [editorMode, setEditorMode] = useState(EDITOR_MODES.SCENE);
    useEffect(() => data?.editor?.()?.subscribe?.((snapshot) => setEditorMode(snapshot.editorMode)), [data]);

    const inEditor = editorMode === EDITOR_MODES.SCENE || editorMode === EDITOR_MODES.MAP;
    const bus = () => data?.commands?.();
    const selection = () => data?.selection?.();
    const selectedIds = () => selection()?.ids ?? [];
    const consume = (result) => (result?.ok ? true : false);

    useShortcut({
        id: "environment-undo",
        keys: "Mod+z",
        priority: 15,
        enabled: inEditor,
        handler: () => {
            const result = bus()?.undo();
            data?.simulation?.()?.render?.();
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
            data?.simulation?.()?.render?.();
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
            return consume(result);
        },
    });
    useShortcut({
        id: "environment-delete",
        keys: ["Delete", "Backspace"],
        priority: 15,
        enabled: editorMode === EDITOR_MODES.SCENE,
        handler: () => {
            const ids = selectedIds();
            if (ids.length === 0) return false;
            return consume(bus()?.execute(objectCommands.deleteObjects({ objectIds: ids })));
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
        enabled: editorMode === EDITOR_MODES.SCENE,
        handler: () => focusCameraOnSelection({ data }),
    });

    return null;
}
