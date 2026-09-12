import assert from "node:assert/strict";
import test from "node:test";

import { EDITOR_MODES, EDITOR_TOOLS, EditorState, MAP_TOOLS, TRANSFORM_SPACES } from "../app/3d/editor/EditorState.js";
import { TOOLBAR_ACTIONS, buildToolbarModel, runToolbarAction } from "../app/3d/editor/workspace/toolbarModel.js";

function ids(groups, groupId) {
    return groups.find((group) => group.id === groupId)?.items.map((item) => item.id) ?? null;
}

test("ED-03 the toolbar model shows scene tools in scene view and map tools in map view", () => {
    const editor = new EditorState();
    const scene = buildToolbarModel({ editorSnapshot: editor.snapshot(), busSnapshot: { canUndo: false, canRedo: true }, selectionSnapshot: { ids: [] } });
    assert.deepEqual(scene.map((group) => group.id), ["tools", "transform", "view", "overlays", "history"]);
    assert.deepEqual(ids(scene, "tools"), ["tool-select", "tool-translate", "tool-rotate", "tool-scale"]);
    assert.deepEqual(ids(scene, "overlays"), ["overlay-grid", "overlay-chunks", "overlay-bounds"]);
    const select = scene[0].items[0];
    assert.equal(select.active, true);
    assert.equal(select.tooltip, "Select (Q)");
    assert.equal(select.kind, "toggle");
    const history = scene.find((group) => group.id === "history").items;
    assert.deepEqual(history.map((item) => [item.id, item.disabled]), [["undo", true], ["redo", false], ["frame", true]]);
    assert.equal(ids(scene, "view").length, 2);
    assert.equal(scene.find((group) => group.id === "view").items[0].active, true);

    editor.setEditorMode(EDITOR_MODES.MAP);
    editor.setActiveMapTool(MAP_TOOLS.ROAD_PEN);
    const map = buildToolbarModel({ editorSnapshot: editor.snapshot(), busSnapshot: { canUndo: true, canRedo: false }, selectionSnapshot: { ids: ["e0"] } });
    assert.deepEqual(map.map((group) => group.id), ["map-tools", "transform", "view", "overlays", "history"]);
    assert.equal(ids(map, "tools"), null, "Q/W/E/R tools do not show in map view");
    assert.deepEqual(ids(map, "map-tools"), ["map-select", "map-pan", "map-intersection", "map-road-pen", "map-building-rect"]);
    assert.equal(map[0].items.find((item) => item.id === "map-road-pen").active, true);
    assert.deepEqual(ids(map, "overlays"), ["overlay-grid"], "chunks and bounds are scene-only");
    assert.equal(map.find((group) => group.id === "transform").items[0].active, true, "map snap is on by default");
    assert.equal(map.find((group) => group.id === "history").items[2].disabled, false);

    editor.setEditorMode(EDITOR_MODES.EARTH_IMPORT);
    assert.deepEqual(buildToolbarModel({ editorSnapshot: editor.snapshot() }), [], "Earth import owns its own chrome");
});

test("ED-03 toolbar actions drive the editor state per view", () => {
    const editor = new EditorState();
    let renders = 0;
    let focused = 0;
    const undo = { ok: true };
    const data = { editor: () => editor, commands: () => ({ undo: () => undo, redo: () => ({ ok: false }) }), simulation: () => ({ render() { renders += 1; } }), environment: () => ({ objects: () => ({ setLayerVisible() {} }) }) };

    runToolbarAction(data, { type: TOOLBAR_ACTIONS.SET_TOOL, tool: EDITOR_TOOLS.ROTATE });
    assert.equal(editor.snapshot().activeTool, EDITOR_TOOLS.ROTATE);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.SET_TRANSFORM_SPACE, space: "local" });
    assert.equal(editor.snapshot().transformSpace, TRANSFORM_SPACES.LOCAL);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_SNAP });
    assert.equal(editor.snapshot().transformSnap.enabled, true);
    assert.equal(editor.snapshot().map.snapEnabled, true, "scene snap never touches map snap");
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_GRID });
    assert.equal(editor.snapshot().sceneGridVisible, false);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_CHUNKS });
    assert.equal(editor.snapshot().chunkOutlinesVisible, false);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_BOUNDS });
    assert.equal(editor.snapshot().selectionBoundsVisible, false);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.SET_LAYER, layer: "roads", visible: false });
    assert.equal(editor.snapshot().layers.roads, false);
    assert.equal(runToolbarAction(data, { type: TOOLBAR_ACTIONS.UNDO }), true);
    assert.equal(runToolbarAction(data, { type: TOOLBAR_ACTIONS.REDO }), false);
    assert.equal(runToolbarAction(data, { type: TOOLBAR_ACTIONS.FRAME }, { focus: () => { focused += 1; return true; } }), true);
    assert.equal(focused, 1);
    assert.equal(runToolbarAction(data, { type: "nope" }), false);
    assert.ok(renders >= 7);

    runToolbarAction(data, { type: TOOLBAR_ACTIONS.SET_VIEW, mode: EDITOR_MODES.MAP });
    assert.equal(editor.snapshot().editorMode, EDITOR_MODES.MAP);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.SET_MAP_TOOL, tool: MAP_TOOLS.BUILDING_RECT });
    assert.equal(editor.snapshot().map.activeMapTool, MAP_TOOLS.BUILDING_RECT);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_SNAP });
    assert.equal(editor.snapshot().map.snapEnabled, false, "in map view snap toggles the map option");
    assert.equal(editor.snapshot().transformSnap.enabled, true);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_GRID });
    assert.equal(editor.snapshot().map.gridVisible, false);
    assert.equal(editor.snapshot().sceneGridVisible, false);
});

test("ED-03 view options are session state: in snapshots and preferences, never in the persisted editor state", () => {
    const editor = new EditorState({ transformSpace: "local", transformSnap: { enabled: true, translation: 2, rotationDeg: -5, scale: "x" }, sceneGridVisible: false });
    const snapshot = editor.snapshot();
    assert.equal(snapshot.transformSpace, "local");
    assert.deepEqual(snapshot.transformSnap, { enabled: true, translation: 2, rotationDeg: 15, scale: 0.1 }, "invalid snap values fall back");
    assert.equal(snapshot.sceneGridVisible, false);
    assert.equal(snapshot.selectionBoundsVisible, true);
    const persisted = editor.persistedSnapshot();
    for (const key of ["transformSpace", "transformSnap", "sceneGridVisible", "selectionBoundsVisible", "chunkOutlinesVisible"]) {
        assert.equal(key in persisted, false, `${key} must not persist with the environment`);
    }
    assert.deepEqual(Object.keys(editor.viewOptionsSnapshot()).sort(), ["chunkOutlinesVisible", "sceneGridVisible", "selectionBoundsVisible", "transformSnap", "transformSpace"]);

    let notifications = 0;
    editor.subscribe(() => { notifications += 1; });
    editor.applyViewOptions({ transformSpace: "world", transformSnap: { enabled: false }, selectionBoundsVisible: false, chunkOutlinesVisible: false });
    assert.equal(notifications, 2, "one notification for the whole batch");
    assert.equal(editor.snapshot().transformSpace, "world");
    assert.equal(editor.snapshot().transformSnap.enabled, false);
    assert.equal(editor.snapshot().transformSnap.translation, 2, "unpatched snap fields are kept");
    assert.equal(editor.snapshot().selectionBoundsVisible, false);
    assert.equal(editor.snapshot().chunkOutlinesVisible, false);
    editor.applyViewOptions({ transformSpace: "world" });
    assert.equal(notifications, 2, "no-op batches do not notify");
    editor.setTransformSnap({ translation: 0 });
    assert.equal(editor.snapshot().transformSnap.translation, 2, "non-positive snap steps are rejected");
    editor.setTransformSpace("sideways");
    assert.equal(editor.snapshot().transformSpace, "world");
});
