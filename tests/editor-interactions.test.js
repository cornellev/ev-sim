import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { EDITOR_MODES, EDITOR_TOOLS, MAP_TOOLS } from "../app/3d/editor/EditorState.js";
import { resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { objectCommands } from "../app/3d/editor/commands/index.js";
import { MapPointerController } from "../app/3d/editor/map/MapPointerController.js";
import { handleMapDelete, handleRoadPenClick, handleFeaturePlace, handleBuildingRectDown, handleBuildingRectMove, handleBuildingRectUp } from "../app/3d/editor/map/MapToolLogic.js";
import { EditorToolController } from "../app/3d/editor/tools/EditorToolController.js";
import { applyPickToSelection, isAdditiveSelectionEvent } from "../app/3d/editor/tools/SelectTool.js";
import { resolveGizmoPolicy, resolveTransformTargets } from "../app/3d/editor/tools/TransformTool.js";
import { defaultFacingForAsset } from "../app/3d/editor/tools/PlaceTool.js";
import { resolveSelectionVisuals } from "../app/3d/overlay/SelectionVisualizer.js";
import { mapSelectionFromSelection } from "../app/3d/editor/selection/selectionIds.js";
import { deltaFromTranslation } from "../app/3d/editor/objects/index.js";
import { createEditorHarness } from "./helpers/editorRuntimeHarness.js";

test.beforeEach(() => {
    resetDocumentIdCounter();
});

function makeController(harness) {
    const controller = new EditorToolController({ data: harness.data, scene: harness.scene, camera: harness.camera, renderer: harness.renderer });
    return { controller, transform: controller.transformTool };
}

function dragPivot(transform, { x = 0, y = 0, z = 0 }) {
    transform.pivot.position.add(new THREE.Vector3(x, y, z));
    transform.pivot.updateMatrixWorld(true);
    transform.onObjectChange();
}

test("ED-02 picking translates entities into shared selection with modifiers and sub-objects", async () => {
    const harness = await createEditorHarness();
    const { selection, registry, document } = harness;
    const cone = registry.getEntity("fusion:feature-cone");
    const building = registry.getEntity("building:building-0");
    applyPickToSelection({ selection, document, entity: cone });
    assert.deepEqual(selection.ids, ["feature-cone"]);
    applyPickToSelection({ selection, document, entity: building, additive: true });
    assert.deepEqual(selection.ids, ["feature-cone", "building-0"]);
    assert.equal(selection.primary, "building-0");
    applyPickToSelection({ selection, document, entity: cone, additive: true });
    assert.deepEqual(selection.ids, ["building-0"]);
    applyPickToSelection({ selection, document, entity: registry.getEntity("road-node:n0") });
    assert.deepEqual(selection.ids, ["e0"]);
    assert.deepEqual(selection.sub, { kind: "road-node", id: "n0" });
    applyPickToSelection({ selection, document, entity: null, activeTool: EDITOR_TOOLS.TRANSLATE });
    assert.deepEqual(selection.ids, ["e0"], "empty clicks only clear with the select tool");
    applyPickToSelection({ selection, document, entity: null, activeTool: EDITOR_TOOLS.SELECT });
    assert.deepEqual(selection.ids, []);
    assert.equal(isAdditiveSelectionEvent({ shiftKey: true }), true);
    assert.equal(isAdditiveSelectionEvent({}), false);
    assert.deepEqual(mapSelectionFromSelection({ primary: "building-0", ids: ["building-0"] }, document), { type: "building", id: "building-0" });
    assert.deepEqual(mapSelectionFromSelection({ primary: "feature-cone", ids: ["feature-cone"] }, document.snapshot()), { type: "feature", id: "feature-cone" });
    assert.equal(mapSelectionFromSelection({ primary: "skybox", ids: ["skybox"] }, document), null);
});

test("ED-02 transform targets and gizmo policy follow the selection kinds", async () => {
    const harness = await createEditorHarness();
    const { registry, document, bus } = harness;
    const single = resolveTransformTargets({ selectionSnapshot: { ids: ["feature-cone"], sub: null }, document, registry });
    assert.equal(single.object3Ds.length, 1);
    assert.deepEqual(resolveGizmoPolicy(single, "translate"), { supported: true, showX: true, showY: false, showZ: true, uniformOnly: false });
    assert.equal(resolveGizmoPolicy(single, "scale").supported, false);
    assert.deepEqual(resolveGizmoPolicy(single, "rotate"), { supported: true, showX: false, showY: true, showZ: false, uniformOnly: false });
    const buildingOnly = resolveTransformTargets({ selectionSnapshot: { ids: ["building-0"], sub: null }, document, registry });
    assert.deepEqual(resolveGizmoPolicy(buildingOnly, "scale"), { supported: true, showX: true, showY: true, showZ: true, uniformOnly: false });
    const roads = resolveTransformTargets({ selectionSnapshot: { ids: ["e0", "n2"], sub: null }, document, registry });
    assert.equal(roads.object3Ds.length, 2);
    assert.deepEqual(resolveGizmoPolicy(roads, "translate"), { supported: true, showX: true, showY: true, showZ: true, uniformOnly: false });
    assert.equal(resolveGizmoPolicy(roads, "scale").uniformOnly, true);
    const sub = resolveTransformTargets({ selectionSnapshot: { ids: ["e0"], sub: { kind: "road-node", id: "n0" } }, document, registry });
    assert.deepEqual(sub.objectIds, []);
    assert.deepEqual(sub.sub, { kind: "road-node", id: "n0" });
    assert.equal(sub.object3Ds[0], registry.getEntity("road-node:n0").object3D);
    const grouped = bus.execute(objectCommands.groupObjects({ objectIds: ["feature-cone", "building-0"], name: "Kit" })).result.groupId;
    const group = resolveTransformTargets({ selectionSnapshot: { ids: [grouped], sub: null }, document, registry });
    assert.equal(group.hasGroup, true);
    assert.equal(group.object3Ds.length, 2);
    assert.equal(resolveGizmoPolicy(group, "scale").supported, false, "a group with props cannot scale");
    const visuals = resolveSelectionVisuals({ selectionSnapshot: { ids: [grouped], sub: null }, document, registry });
    assert.equal(visuals.leaves.length, 2);
    assert.equal(visuals.groups[0].members.length, 2);
    assert.equal(defaultFacingForAsset("stop-sign"), 1);
    assert.equal(defaultFacingForAsset("cone"), 0);
});

test("ED-02 gizmo drags are one undoable gesture; Escape restores; undo and redo move the meshes back and forth", async () => {
    const harness = await createEditorHarness();
    const { selection, document, registry, bus, editor, keys } = { ...harness, editor: harness.data.editor() };
    const { controller, transform } = makeController(harness);
    const mesh = registry.getEntity("fusion:feature-cone").object3D;
    const events = [];
    document.subscribe((snapshot, event) => events.push(event.source + (event.transient ? "*" : "")));

    selection.select("feature-cone");
    editor.setActiveTool(EDITOR_TOOLS.TRANSLATE);
    assert.equal(transform.controls.object, transform.pivot, "the gizmo attaches to the pivot");
    assert.ok(Math.abs(transform.pivot.position.x - 60) < 1e-6 && Math.abs(transform.pivot.position.z - 44) < 1e-6);

    transform.beginDrag();
    assert.ok(bus.activeGesture);
    assert.equal(harness.settings.locks.includes("environment-transform-controls"), true);
    dragPivot(transform, { x: 5 });
    dragPivot(transform, { z: 3 });
    assert.equal(document.getFeature("feature-cone").x, 65);
    assert.equal(document.getFeature("feature-cone").z, 47);
    assert.deepEqual(mesh.position.toArray(), [65, 0, 47], "the projector moves the mesh during the drag");
    assert.ok(events.filter((entry) => entry === "gesture*").length >= 2);
    transform.endDrag();
    assert.equal(bus.activeGesture, null);
    assert.equal(bus.history.length, 1, "one drag is one history entry");
    assert.equal(events.at(-1), "gesture");
    assert.equal(selection.isSuppressed(), true, "the pointer-up after a drag does not reselect");
    assert.equal(harness.settings.locks.includes("environment-transform-controls"), false);

    // Escape mid-drag restores the pristine state and ignores the rest of the drag.
    transform.beginDrag();
    dragPivot(transform, { x: 100 });
    assert.equal(document.getFeature("feature-cone").x, 165);
    keys.press("Escape");
    assert.equal(bus.activeGesture, null);
    assert.equal(document.getFeature("feature-cone").x, 65);
    assert.deepEqual(mesh.position.toArray(), [65, 0, 47]);
    assert.equal(events.at(-1), "cancel");
    dragPivot(transform, { x: 100 });
    assert.equal(document.getFeature("feature-cone").x, 65, "frames after a cancel are ignored");
    transform.endDrag();
    assert.equal(bus.history.length, 1);

    bus.undo();
    assert.deepEqual(mesh.position.toArray(), [60, 0, 44]);
    assert.ok(Math.abs(transform.pivot.position.x - 60) < 1e-6, "the pivot follows undo");
    bus.redo();
    assert.deepEqual(mesh.position.toArray(), [65, 0, 47]);

    // Escape without a gesture: tool back to select, then clear selection.
    keys.press("Escape");
    assert.equal(editor.snapshot().activeTool, EDITOR_TOOLS.SELECT);
    keys.press("Escape");
    assert.deepEqual(selection.ids, []);
    assert.equal(transform.controls.object, undefined);
    controller.dispose();
});

test("ED-02 sub-object and group drags through the gizmo move exactly what the selection describes", async () => {
    const harness = await createEditorHarness();
    const { selection, document, registry, bus } = harness;
    const editor = harness.data.editor();
    const { controller, transform } = makeController(harness);
    editor.setActiveTool(EDITOR_TOOLS.TRANSLATE);

    applyPickToSelection({ selection, document, entity: registry.getEntity("road-node:n0") });
    assert.equal(transform.controls.object, transform.pivot);
    transform.beginDrag();
    dragPivot(transform, { x: -5, z: 2 });
    assert.deepEqual([document.getNode("n0").x, document.getNode("n0").z], [-5, 2]);
    assert.deepEqual([document.getNode("n1").x, document.getNode("n1").z], [40, 0], "only the endpoint moves");
    transform.endDrag();
    assert.equal(bus.history.length, 1);

    const groupId = bus.execute(objectCommands.groupObjects({ objectIds: ["feature-cone", "feature-barrel"], name: "Pair" })).result.groupId;
    selection.select(groupId);
    assert.equal(transform.controls.object, transform.pivot);
    transform.beginDrag();
    dragPivot(transform, { x: 1, z: 1 });
    assert.deepEqual([document.getFeature("feature-cone").x, document.getFeature("feature-barrel").x], [61, 31]);
    transform.endDrag();
    assert.deepEqual(registry.getEntity("fusion:feature-cone").object3D.position.toArray(), [61, 0, 45]);
    assert.deepEqual(document.getObject(groupId).components.transform.position, { x: 46, y: 0, z: 38 });

    // A prop selection with the scale tool detaches the gizmo instead of starting a rejected gesture.
    selection.select("feature-cone");
    editor.setActiveTool(EDITOR_TOOLS.SCALE);
    assert.equal(transform.controls.object, undefined);
    controller.dispose();
});

test("ED-02 duplicate, reparent, and reload keep selection, history, and runtime consistent", async () => {
    const harness = await createEditorHarness();
    const { selection, document, registry, bus, environment } = harness;
    selection.select(["feature-cone", "feature-tire"]);
    const duplicated = bus.execute(objectCommands.duplicateObjects({ objectIds: selection.ids }));
    assert.equal(duplicated.ok, true);
    for (const id of duplicated.result.rootIds) assert.ok(registry.getEntity(`fusion:${id}`)?.object3D, `${id} placed`);
    selection.select(duplicated.result.rootIds);
    const groupId = bus.execute(objectCommands.groupObjects({ objectIds: selection.ids, name: "Copies" })).result.groupId;
    const before = document.getFeature(duplicated.result.rootIds[0]).x;
    const reparented = bus.execute(objectCommands.reparentObjects({ objectIds: ["building-0"], parentId: groupId }));
    assert.equal(reparented.ok, true);
    assert.equal(document.getFeature(duplicated.result.rootIds[0]).x, before, "reparent never moves anything");
    assert.equal(registry.getEntity("building:building-0").object3D.position.x, 14);

    // Reload: the loader restores a snapshot, resets history, and prunes the selection.
    const pristine = harness.manifest.document;
    selection.select([groupId, "feature-cone"]);
    document.restoreSnapshot({ ...pristine, objects: undefined });
    bus.reset();
    selection.prune(new Set(document.objects.map((record) => String(record.id))));
    assert.equal(bus.canUndo, false);
    assert.equal(bus.canRedo, false);
    assert.equal(document.objects.length, 0);
    assert.deepEqual(selection.ids, [], "a pristine v2 document has no records, so nothing stays selected");
    assert.equal(environment.projector().applied > 0, true);
});

test("ED-02 map gestures drag nodes and props through the bus, draw roads as one entry, and delete through commands", async () => {
    const harness = await createEditorHarness();
    const { data, document, selection, bus, registry, city } = harness;
    const editor = data.editor();
    editor.setEditorMode(EDITOR_MODES.MAP);
    editor.setMapSnapEnabled(false);
    editor.setMapViewport({ centerX: 40, centerZ: 40, zoom: 1 });
    const controller = new MapPointerController();
    const ctx = {
        data,
        size: { width: 800, height: 600 },
        layers: { buildings: true, roads: true, props: true },
        showDetail: true,
        documentSnapshot: document.snapshot(),
        getWorldFromEvent: (event) => ({ x: event.worldX, z: event.worldZ }),
    };
    const pointer = (worldX, worldZ, extra = {}) => ({ button: 0, clientX: 0, clientY: 0, worldX, worldZ, ...extra });

    // Drag the free endpoint n0.
    assert.equal(controller.handlePointerDown(ctx, pointer(0, 0)), true);
    assert.equal(controller.activeInteraction.type, "move-node");
    assert.ok(bus.activeGesture);
    controller.handlePointerMove(ctx, pointer(-6, 2));
    assert.deepEqual([document.getNode("n0").x, document.getNode("n0").z], [-6, 2]);
    controller.handlePointerUp(ctx, pointer(-6, 2));
    assert.equal(bus.activeGesture, null);
    assert.equal(bus.history.length, 1);
    assert.deepEqual(registry.getEntity("road-node:n0").object3D.position.toArray(), [-6, 0, 2]);

    // Drag the junction n2: connected roads follow.
    const roadsBefore = city.roads.length;
    assert.equal(controller.handlePointerDown(ctx, pointer(40, 40)), true);
    assert.deepEqual(selection.ids, ["n2"], "junction drags select the intersection record");
    controller.handlePointerMove(ctx, pointer(45, 45));
    controller.handlePointerUp(ctx, pointer(45, 45));
    assert.deepEqual([document.getNode("n2").x, document.getNode("n2").z], [45, 45]);
    assert.equal(document.roads.edges.filter((edge) => edge.startNodeId === "n2" || edge.endNodeId === "n2").length, 3);
    assert.equal(city.roads.length, roadsBefore);
    assert.equal(bus.history.length, 2);

    // Pointer cancel restores the capture.
    controller.handlePointerDown(ctx, pointer(45, 45));
    controller.handlePointerMove(ctx, pointer(90, 90));
    controller.cancel(ctx);
    assert.deepEqual([document.getNode("n2").x, document.getNode("n2").z], [45, 45]);
    assert.equal(bus.history.length, 2);

    // Feature drag.
    controller.handlePointerDown(ctx, pointer(60, 44));
    assert.equal(controller.activeInteraction.type, "move-feature");
    assert.deepEqual(selection.ids, ["feature-cone"]);
    controller.handlePointerMove(ctx, pointer(62, 40));
    controller.handlePointerUp(ctx, pointer(62, 40));
    assert.deepEqual([document.getFeature("feature-cone").x, document.getFeature("feature-cone").z], [62, 40]);
    assert.deepEqual(registry.getEntity("fusion:feature-cone").object3D.position.toArray(), [62, 0, 40]);
    assert.equal(bus.history.length, 3);

    // Click selection with modifiers; empty click clears.
    controller.handlePointerDown(ctx, pointer(14, 14, { showDetail: false }));
    controller.handlePointerUp(ctx, pointer(14, 14));
    assert.deepEqual(selection.ids, ["building-0"]);
    controller.handlePointerDown(ctx, pointer(62, 40, { shiftKey: true }));
    controller.handlePointerUp(ctx, pointer(62, 40));
    assert.deepEqual(selection.ids, ["building-0", "feature-cone"]);
    controller.handlePointerDown(ctx, pointer(-100, -100));
    controller.handlePointerUp(ctx, pointer(-100, -100));
    assert.deepEqual(selection.ids, []);

    // Road pen: start, then draw one edge per click as one history entry each.
    editor.setActiveMapTool(MAP_TOOLS.ROAD_PEN);
    const first = handleRoadPenClick({ worldPoint: { x: 100, z: 100 }, document, editor, data });
    assert.ok(first.node);
    assert.equal(editor.snapshot().map.draft.activeNodeId, first.node.id);
    const historyBefore = bus.history.length;
    const second = handleRoadPenClick({ worldPoint: { x: 140, z: 100 }, document, editor, data });
    assert.ok(second.edge, JSON.stringify(second));
    assert.equal(bus.history.length, historyBefore + 1);
    assert.equal(bus.snapshot().history.at(-1), "Draw road");
    assert.ok(registry.getEntity(`road:${second.edge.id}`)?.road, "the new road is projected");
    assert.ok(document.getObject(second.edge.id));
    bus.undo();
    assert.equal(document.getEdge(second.edge.id), null);
    assert.equal(registry.getEntity(`road:${second.edge.id}`), null);
    bus.redo();
    assert.ok(registry.getEntity(`road:${second.edge.id}`));

    // Building rectangle and feature placement.
    editor.setActiveMapTool(MAP_TOOLS.BUILDING_RECT);
    handleBuildingRectDown({ worldPoint: { x: 200, z: 200 }, editor });
    handleBuildingRectMove({ worldPoint: { x: 212, z: 210 }, editor });
    const rect = handleBuildingRectUp({ editor, data });
    assert.ok(rect.record);
    assert.ok(registry.getEntity(`building:${rect.record.buildingId}`)?.object3D);
    assert.deepEqual(selection.ids, [rect.record.buildingId]);
    editor.setMapFeatureType("barrel");
    const placed = handleFeaturePlace({ worldPoint: { x: 5, z: 5 }, editor, data });
    assert.ok(registry.getEntity(`fusion:${placed.objectId}`));
    assert.deepEqual(selection.ids, [placed.objectId]);

    // Delete through the shared command path.
    const deleted = handleMapDelete({ data, objectIds: [placed.objectId, rect.record.buildingId] });
    assert.equal(deleted.ok, true);
    assert.equal(registry.getEntity(`fusion:${placed.objectId}`), null);
    assert.equal(registry.getEntity(`building:${rect.record.buildingId}`), null);
    assert.deepEqual(selection.ids, []);
    assert.deepEqual(handleMapDelete({ data, objectIds: [] }), { ok: false, error: "Nothing selected." });
});
