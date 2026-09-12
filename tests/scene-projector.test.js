import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { legacyCommands, objectCommands } from "../app/3d/editor/commands/index.js";
import { computeRoadClosure } from "../app/3d/editor/projection/projectors/roadsProjector.js";
import { planRoadNetwork } from "../app/3d/city/RoadNetwork.js";
import { documentToRoadNetworkInputs } from "../app/3d/editor/document/documentMutations.js";
import { roadNetworkOptions, toVector3Map } from "../app/3d/editor/projection/roadRuntimeEntities.js";
import { deltaFromScale, deltaFromTranslation, deltaFromYaw } from "../app/3d/editor/objects/index.js";
import { createEditorHarness } from "./helpers/editorRuntimeHarness.js";

test.beforeEach(() => {
    resetDocumentIdCounter();
});

function roadByEdge(city, edgeId) {
    return city.roads.find((road) => road.network?.edgeId === edgeId) ?? null;
}

function intersectionByNode(city, nodeId) {
    return city.intersections.find((intersection) => intersection.networkNodeId === nodeId) ?? null;
}

test("ED-02 a prop move updates its mesh and entity in place without touching roads or buildings", async () => {
    const harness = await createEditorHarness();
    const { bus, registry, city, runtime, objectDatabase } = harness;
    const mesh = registry.getEntity("fusion:feature-cone").object3D;
    const roads = [...city.roads];
    const building = registry.getEntity("building:building-0").object3D;
    const replaceCalls = objectDatabase.replaceCalls.length;

    const result = bus.execute(objectCommands.transformObjects({ objectIds: ["feature-cone"], delta: deltaFromTranslation({ x: 5, z: 3 }) }));
    assert.equal(result.ok, true);
    assert.equal(harness.projector.applied, 1);
    assert.deepEqual(harness.projector.errors, []);
    const entity = registry.getEntity("fusion:feature-cone");
    assert.equal(entity.object3D, mesh, "the mesh identity is preserved");
    assert.deepEqual(mesh.position.toArray(), [65, 0, 47]);
    assert.deepEqual(entity.fusionObject.position.toArray(), [65, 0, 47]);
    assert.deepEqual(city.roads, roads, "no road was rebuilt");
    assert.equal(registry.getEntity("building:building-0").object3D, building);
    assert.equal(runtime.counters.generateBuildings, 0);
    assert.equal(runtime.counters.placeFeature, 0);
    assert.equal(objectDatabase.replaceCalls.length, replaceCalls, "no LiDAR triangles were touched");
    assert.equal(entity.primaryChunk, "3,2", "chunk membership follows the move");

    const yaw = bus.execute(objectCommands.transformObjects({ objectIds: ["feature-cone"], delta: deltaFromYaw(Math.PI / 2, { x: 65, z: 47 }) }));
    assert.equal(yaw.ok, true);
    assert.ok(Math.abs(mesh.rotation.y - Math.PI / 2) < 1e-9);

    bus.undo();
    bus.undo();
    assert.deepEqual(mesh.position.toArray(), [60, 0, 44]);
    assert.equal(mesh.rotation.y, 0);
    assert.equal(registry.getEntity("fusion:feature-cone").object3D, mesh);
});

test("ED-02 prop add, delete, undo, and redo place and remove runtime objects", async () => {
    const harness = await createEditorHarness();
    const { bus, registry, runtime, scene, objectDatabase } = harness;
    const added = bus.execute(legacyCommands.addFeature({ type: "barrel", x: 3, z: 4 }));
    assert.equal(added.ok, true);
    const id = added.result.objectId;
    assert.equal(runtime.counters.placeFeature, 1);
    const entity = registry.getEntity(`fusion:${id}`);
    assert.ok(entity?.object3D);
    assert.equal(entity.object3D.parent !== null, true);
    assert.deepEqual(entity.object3D.position.toArray(), [3, 0, 4]);
    assert.equal(objectDatabase.inScene.includes(id), true);

    const removed = bus.execute(objectCommands.deleteObjects({ objectIds: [id] }));
    assert.equal(removed.ok, true);
    assert.equal(registry.getEntity(`fusion:${id}`), null);
    assert.equal(runtime.counters.removeFeature, 1);
    assert.equal(scene.getObjectByName(`Prop:${id}`), undefined);

    bus.undo();
    assert.ok(registry.getEntity(`fusion:${id}`)?.object3D, "undo places the prop again");
    assert.equal(runtime.counters.placeFeature, 2);
    bus.redo();
    assert.equal(registry.getEntity(`fusion:${id}`), null);
});

test("ED-02 building gestures move the existing mesh transiently and regenerate once on commit", async () => {
    const harness = await createEditorHarness();
    const { bus, registry, runtime, document, bakeConfig, objectDatabase } = harness;
    const mesh = registry.getEntity("building:building-0").object3D;
    const startPosition = mesh.position.clone();
    const gesture = bus.beginGesture({ objectIds: ["building-0"], label: "Move building" });
    assert.equal(gesture.ok, true);
    bus.updateGesture(gesture.gestureId, deltaFromTranslation({ x: 10, z: 0 }));
    assert.equal(registry.getEntity("building:building-0").object3D, mesh, "transient frames keep the mesh");
    assert.ok(Math.abs(mesh.position.x - (startPosition.x + 10)) < 1e-9);
    bus.updateGesture(gesture.gestureId, deltaFromTranslation({ x: 4, z: 6 }));
    assert.ok(Math.abs(mesh.position.x - (startPosition.x + 4)) < 1e-9, "frames are cumulative, not additive");
    assert.ok(Math.abs(mesh.position.z - (startPosition.z + 6)) < 1e-9);
    assert.equal(runtime.counters.generateBuildings, 0);
    const scale = bus.updateGesture(gesture.gestureId, deltaFromScale(2, { x: 14, y: 0, z: 14 }));
    assert.equal(scale.ok, true);
    assert.ok(Math.abs(mesh.scale.x - 2) < 1e-9 && Math.abs(mesh.scale.y - 2) < 1e-9);
    bus.updateGesture(gesture.gestureId, deltaFromTranslation({ x: 4, z: 6 }));

    const committed = bus.commitGesture(gesture.gestureId);
    assert.equal(committed.ok, true);
    assert.equal(runtime.counters.generateBuildings, 1, "commit regenerates the building once");
    const regenerated = registry.getEntity("building:building-0").object3D;
    assert.notEqual(regenerated, mesh);
    assert.ok(Math.abs(regenerated.position.x - (startPosition.x + 4)) < 1e-9);
    assert.deepEqual(document.getBuilding("building-0").footprint.map((point) => [point.x, point.z]), [[14, 16], [22, 16], [22, 24], [14, 24]]);
    assert.deepEqual(bakeConfig.buildings.map((record) => record.buildingId), ["building-0"], "bake set resynced from the document");
    assert.deepEqual(bakeConfig.buildings[0].footprint.map((point) => point.x), [14, 22, 22, 14]);
    const lastReplace = objectDatabase.replaceCalls.at(-1);
    assert.ok(lastReplace.removed.every((id) => String(id).includes("building-0")), "LiDAR replacement is scoped to the building");
    assert.equal(objectDatabase.triangles().filter((triangle) => triangle.environmentSourceId === "building-0").length, 2);

    bus.undo();
    assert.equal(runtime.counters.generateBuildings, 2);
    const restored = registry.getEntity("building:building-0").object3D;
    assert.ok(Math.abs(restored.position.x - startPosition.x) < 1e-9);
    assert.deepEqual(document.getBuilding("building-0").footprint.map((point) => point.x), [10, 18, 18, 10]);

    // Cancel snaps the mesh back without regenerating twice.
    const second = bus.beginGesture({ objectIds: ["building-0"] });
    bus.updateGesture(second.gestureId, deltaFromTranslation({ x: 50 }));
    assert.ok(Math.abs(registry.getEntity("building:building-0").object3D.position.x - (startPosition.x + 50)) < 1e-9);
    bus.cancelGesture(second.gestureId);
    assert.ok(Math.abs(registry.getEntity("building:building-0").object3D.position.x - startPosition.x) < 1e-9);
    assert.equal(bus.history.length, 0);
});

test("ED-02 road node moves rebuild only the local closure and keep untouched roads, entities, and triangles", async () => {
    const harness = await createEditorHarness();
    const { bus, registry, city, document, objectDatabase } = harness;
    const before = Object.fromEntries(["e0", "e1", "e2", "e3"].map((id) => [id, roadByEdge(city, id)]));
    const ixBefore = { n1: intersectionByNode(city, "n1"), n2: intersectionByNode(city, "n2") };
    const e2Triangles = objectDatabase.triangles().filter((triangle) => triangle.environmentSourceId === "e2");
    const handleN0 = registry.getEntity("road-node:n0").object3D;
    const handleN3 = registry.getEntity("road-node:n3").object3D;

    // Closure math: moving n0 touches e0, junction n1, and therefore e1; e2/e3 and n2 stay.
    const { vectorMap, connections } = documentToRoadNetworkInputs(document);
    const plan = planRoadNetwork(toVector3Map(vectorMap), connections, roadNetworkOptions(harness.data));
    const changeSet = { domains: { "roads.nodes": { before: new Map([["n0", { id: "n0" }]]), after: new Map([["n0", { id: "n0" }]]) } } };
    const closure = computeRoadClosure({ changeSet, document, registry, plan });
    assert.deepEqual([...closure.E1], ["e0"]);
    assert.deepEqual([...closure.J1], ["n1"]);
    assert.deepEqual([...closure.E2].sort(), ["e0", "e1"]);
    assert.deepEqual([...closure.touchedNodeIds].sort(), ["n0", "n1", "n2"]);

    const moved = bus.execute(objectCommands.transformObjects({ objectIds: [], sub: { kind: "road-node", id: "n0" }, delta: deltaFromTranslation({ x: -10, z: 5 }) }));
    assert.equal(moved.ok, true, JSON.stringify(moved.issues));
    assert.deepEqual(harness.projector.errors, []);
    assert.notEqual(roadByEdge(city, "e0"), before.e0, "e0 was rebuilt");
    assert.notEqual(roadByEdge(city, "e1"), before.e1, "e1 was rebuilt (its trim depends on n1)");
    assert.equal(roadByEdge(city, "e2"), before.e2, "e2 untouched");
    assert.equal(roadByEdge(city, "e3"), before.e3, "e3 untouched");
    assert.notEqual(intersectionByNode(city, "n1"), ixBefore.n1);
    assert.equal(intersectionByNode(city, "n2"), ixBefore.n2, "n2 intersection untouched");
    assert.ok(intersectionByNode(city, "n2").roads.includes(roadByEdge(city, "e1")), "n2 was relinked to the rebuilt e1 Road");
    assert.equal(city.roads.length, 4);
    assert.equal(city.intersections.length, 2);
    assert.equal(registry.getEntity("road:e2").road, before.e2);
    assert.equal(registry.getEntity("road:e0").road, roadByEdge(city, "e0"));
    assert.equal(registry.getEntity("intersection:n1").intersection, intersectionByNode(city, "n1"));
    assert.notEqual(registry.getEntity("road-node:n0").object3D, handleN0, "moved node handle recreated");
    assert.deepEqual(registry.getEntity("road-node:n0").object3D.position.toArray(), [-10, 0, 5]);
    assert.equal(registry.getEntity("road-node:n3").object3D, handleN3, "far handle untouched");
    assert.ok(objectDatabase.triangles().filter((triangle) => triangle.environmentSourceId === "e2").every((triangle, index) => triangle === e2Triangles[index]), "e2 triangles untouched");
    const lastReplace = objectDatabase.replaceCalls.at(-1);
    assert.deepEqual([...new Set(lastReplace.removed)].sort(), ["e0", "e1", "n1"], "LiDAR replacement is scoped to the closure");
    assert.equal(roadByEdge(city, "e0").root.parent !== null, true);
    assert.equal(before.e0.root.parent, null, "old road roots leave the scene");

    // Junction move keeps every incident road connected and rebuilds them.
    const junction = bus.execute(objectCommands.transformObjects({ objectIds: ["n2"], delta: deltaFromTranslation({ x: 0, z: 10 }) }));
    assert.equal(junction.ok, true);
    assert.deepEqual(harness.projector.errors, []);
    assert.equal(document.getNode("n2").z, 50);
    for (const id of ["e1", "e2", "e3"]) assert.notEqual(roadByEdge(city, id), before[id], `${id} rebuilt`);
    assert.equal(city.roads.length, 4);
    assert.equal(registry.getEntity("intersection:n2").intersection, intersectionByNode(city, "n2"));

    bus.undo();
    bus.undo();
    assert.deepEqual([document.getNode("n0").x, document.getNode("n0").z, document.getNode("n2").z], [0, 0, 40]);
    assert.deepEqual(registry.getEntity("road-node:n0").object3D.position.toArray(), [0, 0, 0]);
    assert.equal(city.roads.length, 4);
    assert.equal(city.intersections.length, 2);
});

test("ED-02 removing a road tears down its runtime, demotes the junction, and undo restores everything", async () => {
    const harness = await createEditorHarness();
    const { bus, registry, city, document } = harness;
    const e2 = roadByEdge(city, "e2");
    const removed = bus.execute(objectCommands.deleteObjects({ objectIds: ["e0"] }));
    assert.equal(removed.ok, true);
    assert.deepEqual(harness.projector.errors, []);
    assert.equal(roadByEdge(city, "e0"), null);
    assert.equal(registry.getEntity("road:e0"), null);
    assert.equal(intersectionByNode(city, "n1"), null, "n1 is no longer a rendered intersection");
    assert.equal(registry.getEntity("intersection:n1"), null);
    // Runtime hydration marks junction kinds sticky, so n1 keeps its intersection record
    // (and no free-endpoint handle) even though only one road remains; ED-04 revisits topology.
    assert.equal(document.getNode("n1").kind, "intersection");
    assert.equal(document.getObject("n1")?.typeId, "intersection");
    assert.equal(registry.getEntity("road-node:n1"), null);
    assert.equal(registry.getEntity("road-node:n0"), null);
    assert.equal(roadByEdge(city, "e2"), e2);

    bus.undo();
    assert.deepEqual(harness.projector.errors, []);
    assert.ok(roadByEdge(city, "e0"));
    assert.ok(intersectionByNode(city, "n1"));
    assert.ok(registry.getEntity("road:e0")?.road);
    assert.ok(registry.getEntity("intersection:n1")?.intersection);
    assert.equal(registry.getEntity("road-node:n1"), null);
    assert.ok(registry.getEntity("road-node:n0"));
    assert.equal(document.getObject("n1").typeId, "intersection");
    assert.equal(city.roads.length, 4);
});

test("ED-02 hidden and locked records project onto entity visibility through groups", async () => {
    const harness = await createEditorHarness();
    const { bus, registry } = harness;
    const grouped = bus.execute(objectCommands.groupObjects({ objectIds: ["feature-cone", "building-0"], name: "Kit" }));
    const groupId = grouped.result.groupId;
    assert.equal(bus.execute(objectCommands.setObjectsHidden({ objectIds: [groupId], hidden: true })).ok, true);
    assert.equal(registry.getEntity("fusion:feature-cone").visible, false);
    assert.equal(registry.getEntity("fusion:feature-cone").object3D.visible, false);
    assert.equal(registry.getEntity("building:building-0").visible, false);
    assert.equal(registry.getEntity("fusion:feature-tire").visible, true);
    bus.undo();
    assert.equal(registry.getEntity("fusion:feature-cone").visible, true);
    assert.equal(registry.getEntity("building:building-0").object3D.visible, true);
    bus.execute(objectCommands.renameObject({ objectId: "feature-cone", name: "Front cone" }));
    assert.equal(registry.getEntity("fusion:feature-cone").label, "Front cone");
    assert.ok(registry.listEntities().some((entity) => entity.label === "Front cone"));
});

test("ED-02 the projector ignores notifications without a change set and reports errors without throwing", async () => {
    const harness = await createEditorHarness();
    const applied = harness.projector.applied;
    harness.document.notify();
    harness.document.restoreSnapshot(harness.document.snapshot());
    assert.equal(harness.projector.applied, applied);
    harness.projector.projectors.push({ id: "broken", apply() { throw new Error("nope"); } });
    const result = harness.bus.execute(objectCommands.renameObject({ objectId: "feature-cone", name: "X" }));
    assert.equal(result.ok, true);
    assert.equal(harness.projector.errors.at(-1).projector, "broken");
    assert.ok(harness.data.renders() > 0);
    harness.projector.dispose();
    harness.bus.execute(objectCommands.renameObject({ objectId: "feature-cone", name: "Y" }));
    assert.equal(harness.projector.applied, applied + 1, "a disposed projector stops applying");
    assert.ok(new THREE.Vector3().isVector3);
});
