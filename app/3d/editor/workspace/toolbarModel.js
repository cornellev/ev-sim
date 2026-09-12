/**
 * Scene toolbar model: which tools, toggles, and view switches show for the
 * current editor state, and how each maps to an editor action. Pure so the
 * toolbar can be tested under node; the React toolbar maps `icon` names to
 * Tabler icons and renders the groups in order.
 */

import { EDITOR_LAYERS, EDITOR_MODES, EDITOR_TOOLS, MAP_TOOLS } from "../EditorState.js";

export const TOOLBAR_ACTIONS = Object.freeze({
    SET_TOOL: "set-tool",
    SET_MAP_TOOL: "set-map-tool",
    SET_VIEW: "set-view",
    SET_TRANSFORM_SPACE: "set-transform-space",
    TOGGLE_SNAP: "toggle-snap",
    TOGGLE_GRID: "toggle-grid",
    TOGGLE_CHUNKS: "toggle-chunks",
    TOGGLE_BOUNDS: "toggle-bounds",
    SET_LAYER: "set-layer",
    UNDO: "undo",
    REDO: "redo",
    FRAME: "frame",
});

const SCENE_TOOLS = Object.freeze([
    { id: "tool-select", tool: EDITOR_TOOLS.SELECT, label: "Select", shortcut: "Q", icon: "pointer" },
    { id: "tool-translate", tool: EDITOR_TOOLS.TRANSLATE, label: "Move", shortcut: "W", icon: "move" },
    { id: "tool-rotate", tool: EDITOR_TOOLS.ROTATE, label: "Rotate", shortcut: "E", icon: "rotate" },
    { id: "tool-scale", tool: EDITOR_TOOLS.SCALE, label: "Scale", shortcut: "R", icon: "scale" },
]);

const MAP_TOOL_ITEMS = Object.freeze([
    { id: "map-select", tool: MAP_TOOLS.SELECT, label: "Select", icon: "pointer" },
    { id: "map-pan", tool: MAP_TOOLS.PAN, label: "Pan", icon: "hand" },
    { id: "map-intersection", tool: MAP_TOOLS.INTERSECTION, label: "Place intersection", icon: "intersection" },
    { id: "map-road-pen", tool: MAP_TOOLS.ROAD_PEN, label: "Road pen", icon: "road" },
    { id: "map-building-rect", tool: MAP_TOOLS.BUILDING_RECT, label: "Building rectangle", icon: "building" },
]);

export const LAYER_ITEMS = Object.freeze([
    { id: EDITOR_LAYERS.BUILDINGS, label: "Buildings", hint: "Building meshes and footprints" },
    { id: EDITOR_LAYERS.ROADS, label: "Roads", hint: "Road surfaces and intersections" },
    { id: EDITOR_LAYERS.PROPS, label: "Props", hint: "Signs, barrels, and decorations" },
]);

function item({ id, label, icon, kind = "button", active = false, disabled = false, shortcut = null, action }) {
    return { id, label, tooltip: shortcut ? `${label} (${shortcut})` : label, shortcut, icon, kind, active, disabled, action };
}

/**
 * @param {{ editorSnapshot: object|null, busSnapshot?: object|null, selectionSnapshot?: object|null }} input
 * @returns {Array<{ id: string, label: string, items: object[] }>}
 */
export function buildToolbarModel({ editorSnapshot, busSnapshot = null, selectionSnapshot = null } = {}) {
    const editor = editorSnapshot ?? {};
    const view = editor.editorMode === EDITOR_MODES.MAP ? "map" : editor.editorMode === EDITOR_MODES.EARTH_IMPORT ? "earth-import" : "scene";
    const groups = [];

    if (view === "scene") {
        groups.push({
            id: "tools",
            label: "Tools",
            items: SCENE_TOOLS.map((entry) => item({
                ...entry,
                kind: "toggle",
                active: (editor.activeTool ?? EDITOR_TOOLS.SELECT) === entry.tool,
                action: { type: TOOLBAR_ACTIONS.SET_TOOL, tool: entry.tool },
            })),
        });
        const space = editor.transformSpace === "local" ? "local" : "world";
        groups.push({
            id: "transform",
            label: "Transform options",
            items: [
                item({
                    id: "transform-space",
                    label: space === "local" ? "Local axes" : "World axes",
                    icon: space === "local" ? "local" : "world",
                    kind: "toggle",
                    active: space === "local",
                    action: { type: TOOLBAR_ACTIONS.SET_TRANSFORM_SPACE, space: space === "local" ? "world" : "local" },
                }),
                item({
                    id: "transform-snap",
                    label: "Snap",
                    icon: "magnet",
                    kind: "toggle",
                    active: editor.transformSnap?.enabled === true,
                    action: { type: TOOLBAR_ACTIONS.TOGGLE_SNAP },
                }),
            ],
        });
    } else if (view === "map") {
        groups.push({
            id: "map-tools",
            label: "Map tools",
            items: MAP_TOOL_ITEMS.map((entry) => item({
                ...entry,
                kind: "toggle",
                active: (editor.map?.activeMapTool ?? MAP_TOOLS.SELECT) === entry.tool,
                action: { type: TOOLBAR_ACTIONS.SET_MAP_TOOL, tool: entry.tool },
            })),
        });
        groups.push({
            id: "transform",
            label: "Map options",
            items: [
                item({
                    id: "transform-snap",
                    label: "Snap",
                    icon: "magnet",
                    kind: "toggle",
                    active: editor.map?.snapEnabled === true,
                    action: { type: TOOLBAR_ACTIONS.TOGGLE_SNAP },
                }),
            ],
        });
    }

    if (view !== "earth-import") {
        groups.push({
            id: "view",
            label: "View",
            items: [
                item({ id: "view-scene", label: "Scene view", icon: "scene", kind: "toggle", active: view === "scene", action: { type: TOOLBAR_ACTIONS.SET_VIEW, mode: EDITOR_MODES.SCENE } }),
                item({ id: "view-map", label: "Map view", icon: "map", kind: "toggle", active: view === "map", action: { type: TOOLBAR_ACTIONS.SET_VIEW, mode: EDITOR_MODES.MAP } }),
            ],
        });
        const overlays = [
            item({
                id: "overlay-grid",
                label: "Grid",
                icon: "grid",
                kind: "toggle",
                active: view === "map" ? editor.map?.gridVisible !== false : editor.sceneGridVisible !== false,
                action: { type: TOOLBAR_ACTIONS.TOGGLE_GRID },
            }),
        ];
        if (view === "scene") {
            overlays.push(item({ id: "overlay-chunks", label: "Chunks", icon: "chunks", kind: "toggle", active: editor.chunkOutlinesVisible !== false, action: { type: TOOLBAR_ACTIONS.TOGGLE_CHUNKS } }));
            overlays.push(item({ id: "overlay-bounds", label: "Selection bounds", icon: "bounds", kind: "toggle", active: editor.selectionBoundsVisible !== false, action: { type: TOOLBAR_ACTIONS.TOGGLE_BOUNDS } }));
        }
        groups.push({ id: "overlays", label: "Overlays", items: overlays });
        groups.push({
            id: "history",
            label: "History",
            items: [
                item({ id: "undo", label: "Undo", shortcut: "Mod+Z", icon: "undo", disabled: !busSnapshot?.canUndo, action: { type: TOOLBAR_ACTIONS.UNDO } }),
                item({ id: "redo", label: "Redo", shortcut: "Shift+Mod+Z", icon: "redo", disabled: !busSnapshot?.canRedo, action: { type: TOOLBAR_ACTIONS.REDO } }),
                item({ id: "frame", label: "Frame selection", shortcut: "F", icon: "frame", disabled: !(selectionSnapshot?.ids?.length > 0), action: { type: TOOLBAR_ACTIONS.FRAME } }),
            ],
        });
    }
    return groups;
}

/**
 * Apply a toolbar action to the editor services. `data` is the runtime
 * accessor object; `focus` frames the selection (browser-only, injected).
 */
export function runToolbarAction(data, action, { focus = null } = {}) {
    const editor = data?.editor?.();
    const bus = data?.commands?.();
    if (!action) return false;
    switch (action.type) {
        case TOOLBAR_ACTIONS.SET_TOOL:
            editor?.setActiveTool?.(action.tool);
            break;
        case TOOLBAR_ACTIONS.SET_MAP_TOOL:
            editor?.setActiveMapTool?.(action.tool);
            break;
        case TOOLBAR_ACTIONS.SET_VIEW:
            editor?.setEditorMode?.(action.mode);
            break;
        case TOOLBAR_ACTIONS.SET_TRANSFORM_SPACE:
            editor?.setTransformSpace?.(action.space);
            break;
        case TOOLBAR_ACTIONS.TOGGLE_SNAP: {
            const snapshot = editor?.snapshot?.();
            if (snapshot?.editorMode === EDITOR_MODES.MAP) editor?.setMapSnapEnabled?.(!(snapshot.map?.snapEnabled === true));
            else editor?.setTransformSnapEnabled?.(!(snapshot?.transformSnap?.enabled === true));
            break;
        }
        case TOOLBAR_ACTIONS.TOGGLE_GRID: {
            const snapshot = editor?.snapshot?.();
            if (snapshot?.editorMode === EDITOR_MODES.MAP) editor?.setMapGridVisible?.(!(snapshot.map?.gridVisible !== false));
            else editor?.setSceneGridVisible?.(!(snapshot?.sceneGridVisible !== false));
            break;
        }
        case TOOLBAR_ACTIONS.TOGGLE_CHUNKS:
            editor?.setChunkOutlinesVisible?.(!(editor.snapshot?.().chunkOutlinesVisible !== false));
            break;
        case TOOLBAR_ACTIONS.TOGGLE_BOUNDS:
            editor?.setSelectionBoundsVisible?.(!(editor.snapshot?.().selectionBoundsVisible !== false));
            break;
        case TOOLBAR_ACTIONS.SET_LAYER:
            editor?.setLayerVisible?.(action.layer, action.visible);
            data?.environment?.()?.objects?.()?.setLayerVisible?.(action.layer, action.visible);
            break;
        case TOOLBAR_ACTIONS.UNDO:
            return bus?.undo?.()?.ok === true;
        case TOOLBAR_ACTIONS.REDO:
            return bus?.redo?.()?.ok === true;
        case TOOLBAR_ACTIONS.FRAME:
            return focus?.() ?? false;
        default:
            return false;
    }
    data?.simulation?.()?.render?.();
    return true;
}
