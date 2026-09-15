import assert from "node:assert/strict";
import test from "node:test";

import { EDITOR_MODES, EDITOR_TOOLS, EditorState, MAP_TOOLS, TRANSFORM_SPACES } from "../app/3d/editor/EditorState.js";
import { TOOLBAR_ACTIONS, buildToolbarModel, runToolbarAction } from "../app/3d/editor/workspace/toolbarModel.js";
import { editorChromeKey } from "../app/3d/editor/workspace/editorChromeKey.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";

function ids(groups, groupId) {
    return groups.find((group) => group.id === groupId)?.items.map((item) => item.id) ?? null;
}

test("ED-03 the toolbar model shows scene tools in scene view and map tools in map view", () => {
    const editor = new EditorState();
    const scene = buildToolbarModel({ editorSnapshot: editor.snapshot(), busSnapshot: { canUndo: false, canRedo: true }, selectionSnapshot: { ids: [] } });
    assert.deepEqual(scene.map((group) => group.id), ["tools", "editing-tools", "transform", "view", "overlays", "history"]);
    assert.deepEqual(ids(scene, "tools"), ["tool-select", "tool-translate", "tool-rotate", "tool-scale"]);
    assert.deepEqual(ids(scene, "editing-tools"), ["tool-road-pen"]);
    assert.deepEqual(ids(scene, "overlays"), ["overlay-grid", "overlay-chunks", "overlay-bounds", "overlay-road-handles"]);
    assert.equal(scene.flatMap((group) => group.items).some((item) => /lidar|collision/i.test(`${item.id} ${item.label}`)), false);
    const select = scene[0].items[0];
    assert.equal(select.active, true);
    assert.equal(select.tooltip, "Select (Q)");
    assert.equal(select.kind, "toggle");
    const grid = scene.find((group) => group.id === "overlays").items.find((item) => item.id === "overlay-grid");
    assert.equal(grid.shortcut, "G");
    assert.equal(grid.tooltip, "Grid (G)");
    const history = scene.find((group) => group.id === "history").items;
    assert.deepEqual(history.map((item) => [item.id, item.disabled]), [["undo", true], ["redo", false], ["frame", true], ["drape-roads-to-glb", true]]);
    assert.equal(ids(scene, "view").length, 2);
    assert.equal(scene.find((group) => group.id === "view").items[0].active, true);

    editor.setEditorMode(EDITOR_MODES.MAP);
    editor.setActiveMapTool(MAP_TOOLS.ROAD_PEN);
    const map = buildToolbarModel({ editorSnapshot: editor.snapshot(), busSnapshot: { canUndo: true, canRedo: false }, selectionSnapshot: { ids: ["e0"] } });
    assert.deepEqual(map.map((group) => group.id), ["map-tools", "transform", "view", "overlays", "history"]);
    assert.equal(ids(map, "tools"), null, "Q/W/E/R tools do not show in map view");
    assert.deepEqual(ids(map, "map-tools"), ["map-select", "map-pan", "map-intersection", "map-road-pen", "map-building-rect"]);
    assert.equal(map[0].items.find((item) => item.id === "map-road-pen").active, true);
    assert.deepEqual(ids(map, "overlays"), ["overlay-grid", "overlay-satellite"], "satellite is map-only; chunks and bounds are scene-only");
    assert.equal(map.flatMap((group) => group.items).some((item) => /lidar|collision/i.test(`${item.id} ${item.label}`)), false);
    assert.equal(map.find((group) => group.id === "transform").items[0].active, true, "map snap is on by default");
    assert.equal(map.find((group) => group.id === "history").items[2].disabled, false);

    editor.setEditorMode(EDITOR_MODES.EARTH_IMPORT);
    const earthImport = buildToolbarModel({ editorSnapshot: editor.snapshot() });
    assert.deepEqual(earthImport.map((group) => group.id), ["tools", "editing-tools", "transform", "view", "overlays", "history"], "Earth import is not a live toolbar view");
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
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_ROAD_HANDLES });
    assert.equal(editor.snapshot().roadHandlesVisible, true);
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
    editor.setEditorMode(EDITOR_MODES.SCENE);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_GRID });
    assert.equal(editor.snapshot().sceneGridVisible, true);
    editor.setEditorMode(EDITOR_MODES.MAP);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_GRID });
    assert.equal(editor.snapshot().map.gridVisible, true);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_SATELLITE });
    assert.equal(editor.snapshot().map.satelliteVisible, true);
    runToolbarAction(data, { type: TOOLBAR_ACTIONS.TOGGLE_SATELLITE });
    assert.equal(editor.snapshot().map.satelliteVisible, false);
});

test("ED-03 view options are session state: in snapshots and preferences, never in the persisted editor state", () => {
    const editor = new EditorState({ transformSpace: "local", transformSnap: { enabled: true, translation: 2, rotationDeg: -5, scale: "x" }, sceneGridVisible: false });
    const snapshot = editor.snapshot();
    assert.equal(snapshot.transformSpace, "local");
    assert.deepEqual(snapshot.transformSnap, { enabled: true, translation: 2, rotationDeg: 15, scale: 0.1 }, "invalid snap values fall back");
    assert.equal(snapshot.sceneGridVisible, false);
    assert.equal(snapshot.selectionBoundsVisible, true);
    const persisted = editor.persistedSnapshot();
    for (const key of ["transformSpace", "transformSnap", "sceneGridVisible", "selectionBoundsVisible", "chunkOutlinesVisible", "roadHandlesVisible", "roadGlbSnapOffset", "roadGlbSnapIncludeConnected"]) {
        assert.equal(key in persisted, false, `${key} must not persist with the environment`);
    }
    assert.deepEqual(Object.keys(editor.viewOptionsSnapshot()).sort(), [
        "chunkOutlinesVisible",
        "roadGlbSnapIncludeConnected",
        "roadGlbSnapOffset",
        "roadHandlesVisible",
        "sceneGridVisible",
        "selectionBoundsVisible",
        "transformSnap",
        "transformSpace",
    ]);
    assert.equal(editor.snapshot().roadHandlesVisible, false);

    let notifications = 0;
    editor.subscribe(() => { notifications += 1; });
    editor.applyViewOptions({ transformSpace: "world", transformSnap: { enabled: false }, selectionBoundsVisible: false, chunkOutlinesVisible: false, roadHandlesVisible: true, roadGlbSnapOffset: 0.05, roadGlbSnapIncludeConnected: true });
    assert.equal(notifications, 2, "one notification for the whole batch");
    assert.equal(editor.snapshot().transformSpace, "world");
    assert.equal(editor.snapshot().transformSnap.enabled, false);
    assert.equal(editor.snapshot().transformSnap.translation, 2, "unpatched snap fields are kept");
    assert.equal(editor.snapshot().selectionBoundsVisible, false);
    assert.equal(editor.snapshot().chunkOutlinesVisible, false);
    assert.equal(editor.snapshot().roadHandlesVisible, true);
    assert.equal(editor.snapshot().roadGlbSnapOffset, 0.05);
    assert.equal(editor.snapshot().roadGlbSnapIncludeConnected, true);
    editor.applyViewOptions({ transformSpace: "world" });
    assert.equal(notifications, 2, "no-op batches do not notify");
    editor.setTransformSnap({ translation: 0 });
    assert.equal(editor.snapshot().transformSnap.translation, 2, "non-positive snap steps are rejected");
    editor.setTransformSpace("sideways");
    assert.equal(editor.snapshot().transformSpace, "world");
});

test("editorChromeKey ignores map pan, zoom, drafts, and road-pen cursor", () => {
    const editor = new EditorState();
    const baseline = editorChromeKey(editor.snapshot());
    editor.setMapViewport({ centerX: 40, centerZ: -12, zoom: 2 });
    assert.equal(editorChromeKey(editor.snapshot()), baseline);
    editor.setMapDraft({ type: "building-rect", cornerA: { x: 0, z: 0 }, cornerB: { x: 4, z: 4 } });
    assert.equal(editorChromeKey(editor.snapshot()), baseline);
    editor.setRoadDraft({ type: "road-stroke", points: [{ x: 0, y: 0, z: 0 }], cursor: { x: 1, y: 0, z: 1 } });
    assert.equal(editorChromeKey(editor.snapshot()), baseline);
    editor.setRoadDraft({ type: "road-stroke", points: [{ x: 0, y: 0, z: 0 }], cursor: { x: 8, y: 0, z: 3 } });
    assert.equal(editorChromeKey(editor.snapshot()), baseline);
    editor.setConnectPreview({ intersectionId: "int-c" });
    assert.equal(editorChromeKey(editor.snapshot()), baseline);
    assert.equal(editor.persistedSnapshot().connectPreview, undefined);

    editor.setEditorMode(EDITOR_MODES.MAP);
    const mapKey = editorChromeKey(editor.snapshot());
    assert.notEqual(mapKey, baseline);
    editor.setActiveMapTool(MAP_TOOLS.ROAD_PEN);
    assert.notEqual(editorChromeKey(editor.snapshot()), mapKey);
    editor.setMapSnapEnabled(false);
    const snapKey = editorChromeKey(editor.snapshot());
    editor.setMapViewport({ centerX: 99, zoom: 0.5 });
    assert.equal(editorChromeKey(editor.snapshot()), snapKey);
    editor.setLayerVisible("roads", false);
    assert.notEqual(editorChromeKey(editor.snapshot()), snapKey);
    editor.setMapSatelliteVisible(true);
    const satelliteKey = editorChromeKey(editor.snapshot());
    assert.notEqual(satelliteKey, editorChromeKey({ ...editor.snapshot(), map: { ...editor.snapshot().map, satelliteVisible: false } }));
    editor.setMapViewport({ centerX: 12, zoom: 3 });
    assert.equal(editorChromeKey(editor.snapshot()), satelliteKey);
});

test("toolbar Snap to GLB enables for a selected road and runs the injected drape callback", () => {
    const editor = new EditorState();
    const document = new EnvironmentDocument({
        environmentId: "drape",
        roads: {
            nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }],
            edges: [{ id: "e0", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2 }],
        },
    });
    const disabled = buildToolbarModel({ editorSnapshot: editor.snapshot(), selectionSnapshot: { ids: [] }, document });
    assert.equal(disabled.find((group) => group.id === "history").items.find((item) => item.id === "drape-roads-to-glb").disabled, true);
    const enabled = buildToolbarModel({ editorSnapshot: editor.snapshot(), selectionSnapshot: { ids: ["e0"] }, document });
    const drape = enabled.find((group) => group.id === "history").items.find((item) => item.id === "drape-roads-to-glb");
    assert.equal(drape.disabled, false);
    let ran = 0;
    assert.equal(runToolbarAction({}, drape.action, { drapeRoadsToGlb: () => { ran += 1; return { ok: true }; } }), true);
    assert.equal(ran, 1);
    editor.setRoadGlbSnapOffset("nope");
    assert.equal(editor.snapshot().roadGlbSnapOffset, 0);
    editor.setRoadGlbSnapOffset(-0.02);
    assert.equal(editor.snapshot().roadGlbSnapOffset, -0.02);
});
