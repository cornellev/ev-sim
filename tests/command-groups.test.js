import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/index.js";
import {
    OBJECT_ISSUE_CODES,
    TRANSFORM_ISSUE_CODES,
    deltaFromScale,
    deltaFromTranslation,
    deltaFromYaw,
    deriveObjectGraph,
    readObjectTransform,
    validateObjectGraph,
    objectTypeRegistry,
} from "../app/3d/editor/objects/index.js";
import { COMMAND_ISSUE_CODES } from "../app/3d/editor/commands/commandIssues.js";
import { childrenOf } from "../app/3d/editor/commands/objectMutations.js";
import { readEnvironmentEditorFixture } from "./helpers/environmentEditorBaseline.js";

const SKY = { sky: null };

test.beforeEach(() => {
    resetDocumentIdCounter();
});

async function yardService() {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const service = createEnvironmentCommandService({ document });
    return { document, service, bus: service.bus };
}

function nodeXZ(document, id) {
    const node = document.getNode(id);
    return [node.x, node.z];
}

function worldPositions(document) {
    return new Map(document.objects.map((record) => [record.id, readObjectTransform(record, document.snapshot(), objectTypeRegistry, SKY)]));
}

test("ED-02 group translate moves every shared road node exactly once and keeps outside roads connected", async () => {
    const { document, service } = await yardService();
    // e0 and e1 share n1; e1 and the junction record n2 share n2; e2/e3 stay outside.
    const grouped = service.run("groupObjects", { objectIds: ["e0", "e1", "n2", "building-0", "feature-cone"], name: "Course" });
    assert.equal(grouped.ok, true);
    const groupId = grouped.result.groupId;
    const group = document.getObject(groupId);
    assert.deepEqual(childrenOf(document.objects, groupId).map((record) => [record.id, record.order]), [["e0", 0], ["e1", 1], ["n2", 2], ["building-0", 3], ["feature-cone", 4]]);
    assert.equal(group.order, 1, "the group takes the first root's slot");
    assert.deepEqual(document.objects.filter((record) => record.parentId === null).map((record) => record.order), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(group.components.transform.position, { x: (20 + 40 + 40 + 14 + 60) / 5, y: 0, z: (0 + 20 + 40 + 14 + 44) / 5 });
    assert.equal(validateObjectGraph(document.snapshot(), objectTypeRegistry, SKY).ok, true);

    const moved = service.run("transformObjects", { objectIds: [groupId], delta: deltaFromTranslation({ x: 10, z: 20 }) });
    assert.equal(moved.ok, true);
    assert.deepEqual(nodeXZ(document, "n0"), [10, 20]);
    assert.deepEqual(nodeXZ(document, "n1"), [50, 20], "n1 is reached through e0 and e1 but moves once");
    assert.deepEqual(nodeXZ(document, "n2"), [50, 60], "n2 is reached through e1 and its intersection record but moves once");
    assert.deepEqual(nodeXZ(document, "n3"), [80, 40], "nodes only referenced by outside roads stay");
    assert.deepEqual(nodeXZ(document, "n4"), [40, 80]);
    assert.deepEqual(document.roads.edges.map((edge) => [edge.startNodeId, edge.endNodeId]), [["n0", "n1"], ["n1", "n2"], ["n2", "n3"], ["n2", "n4"]], "connected roads stay connected");
    assert.deepEqual(document.getBuilding("building-0").footprint.map((point) => [point.x, point.z]), [[20, 30], [28, 30], [28, 38], [20, 38]]);
    assert.equal(document.getBuilding("building-0").height, 8);
    assert.deepEqual([document.getFeature("feature-cone").x, document.getFeature("feature-cone").z], [70, 64]);
    assert.deepEqual(document.getObject(groupId).components.transform.position, { x: 34.8 + 10, y: 0, z: 23.6 + 20 });
    assert.equal(moved.changeSet.domains["roads.nodes"].after.size, 3);
    assert.equal(moved.changeSet.domains["roads.edges"], undefined, "edges without arms are untouched by a pure translation");
});

test("ED-02 nested groups compose frames once and bake the delta into every leaf once", async () => {
    const { document, service } = await yardService();
    const inner = service.run("groupObjects", { objectIds: ["feature-cone", "feature-barrel"], name: "Inner" }).result.groupId;
    const outer = service.run("groupObjects", { objectIds: [inner, "e1"], name: "Outer" }).result.groupId;
    assert.equal(document.getObject(inner).parentId, outer);
    assert.equal(document.getObject("feature-cone").parentId, inner);
    const innerFrame = structuredClone(document.getObject(inner).components.transform);
    const outerFrame = structuredClone(document.getObject(outer).components.transform);

    const yaw = service.run("transformObjects", { objectIds: [outer], delta: deltaFromYaw(Math.PI / 2, { x: 40, z: 40 }) });
    assert.equal(yaw.ok, true);
    const near = (left, right) => assert.ok(Math.abs(left - right) < 1e-9, `${left} ≈ ${right}`);
    // Leaves: rotated once about (40,40). cone (60,44) → (44, 20); barrel (30,30) → (30, 50); n1 (40,0) → (0,40); n2 stays.
    near(document.getFeature("feature-cone").x, 44);
    near(document.getFeature("feature-cone").z, 20);
    near(document.getFeature("feature-cone").rotationY, Math.PI / 2);
    near(document.getFeature("feature-barrel").x, 30);
    near(document.getFeature("feature-barrel").z, 50);
    near(document.getNode("n1").x, 0);
    near(document.getNode("n1").z, 40);
    near(document.getNode("n2").x, 40);
    near(document.getNode("n2").z, 40);
    // Frames: each composed exactly once (yaw + rotated pivot), never re-applied through the parent.
    const rotate = (point) => ({ x: 40 + (point.z - 40), z: 40 - (point.x - 40) });
    const innerAfter = document.getObject(inner).components.transform;
    const outerAfter = document.getObject(outer).components.transform;
    near(innerAfter.rotationY, Math.PI / 2);
    near(outerAfter.rotationY, Math.PI / 2);
    near(innerAfter.position.x, rotate(innerFrame.position).x);
    near(innerAfter.position.z, rotate(innerFrame.position).z);
    near(outerAfter.position.x, rotate(outerFrame.position).x);
    near(outerAfter.position.z, rotate(outerFrame.position).z);
    assert.equal(yaw.changeSet.domains.objects.after.size, 2);
    // Selecting a child together with its ancestor applies the delta once (roots are pruned).
    const before = document.snapshot();
    service.run("transformObjects", { objectIds: [outer, inner, "feature-cone"], delta: deltaFromTranslation({ x: 1 }) });
    near(document.getFeature("feature-cone").x, before.features.find((feature) => feature.id === "feature-cone").x + 1);
    near(document.getFeature("feature-barrel").x, before.features.find((feature) => feature.id === "feature-barrel").x + 1);
});

test("ED-02 reparent preserves world placement, renumbers siblings, and rejects cycles atomically", async () => {
    const { document, service, bus } = await yardService();
    const groupA = service.run("groupObjects", { objectIds: ["feature-cone"], name: "A" }).result.groupId;
    const groupB = service.run("groupObjects", { objectIds: ["feature-tire", "feature-stop"], name: "B" }).result.groupId;
    const before = worldPositions(document);
    const geometryBefore = structuredClone({ ...document.snapshot(), objects: undefined, objectGraphVersion: undefined });

    const moved = service.run("reparentObjects", { objectIds: ["feature-cone", "building-0"], parentId: groupB, index: 1 });
    assert.equal(moved.ok, true);
    assert.deepEqual(childrenOf(document.objects, groupB).map((record) => [record.id, record.order]), [["feature-tire", 0], ["feature-cone", 1], ["building-0", 2], ["feature-stop", 3]]);
    assert.deepEqual(childrenOf(document.objects, groupA), []);
    const after = worldPositions(document);
    for (const [id, transform] of before) assert.deepEqual(after.get(id), transform, `${id} placement unchanged`);
    assert.deepEqual({ ...document.snapshot(), objects: undefined, objectGraphVersion: undefined }, geometryBefore, "reparent never touches geometry");
    assert.equal(moved.changeSet.domains.objects.after.size >= 3, true);
    assert.equal(Object.keys(moved.changeSet.domains).join(), "objects");

    const nested = service.run("reparentObjects", { objectIds: [groupA], parentId: groupB });
    assert.equal(nested.ok, true);
    const snapshot = document.snapshot();
    for (const [ids, parentId, code] of [
        [[groupB], groupA, OBJECT_ISSUE_CODES.PARENT_CYCLE],
        [[groupB], groupB, OBJECT_ISSUE_CODES.PARENT_CYCLE],
        [["feature-cone"], "feature-barrel", OBJECT_ISSUE_CODES.PARENT_NOT_GROUP],
        [["feature-cone"], "missing-group", OBJECT_ISSUE_CODES.PARENT_MISSING],
        [["skybox"], groupB, COMMAND_ISSUE_CODES.REPARENT_NOT_GROUPABLE],
    ]) {
        const rejected = service.run("reparentObjects", { objectIds: ids, parentId });
        assert.equal(rejected.ok, false, `${ids} → ${parentId}`);
        assert.deepEqual(rejected.issues.map((issue) => issue.code), [code]);
        assert.deepEqual(document.snapshot(), snapshot);
    }
    bus.undo();
    assert.equal(document.getObject(groupA).parentId, null);
    bus.undo();
    assert.equal(document.getObject("feature-cone").parentId, groupA);
    assert.deepEqual(childrenOf(document.objects, groupB).map((record) => record.id), ["feature-tire", "feature-stop"]);
    // Reordering within a parent is a reparent to the same parent.
    const reordered = service.run("reorderObjects", { objectIds: ["feature-stop"], index: 0 });
    assert.equal(reordered.ok, true);
    assert.deepEqual(childrenOf(document.objects, groupB).map((record) => record.id), ["feature-stop", "feature-tire"]);
});

test("ED-02 unsupported group transforms are rejected atomically before any mutation", async () => {
    const { document, service, bus } = await yardService();
    const roads = service.run("groupObjects", { objectIds: ["e1", "n2"], name: "Roads" }).result.groupId;
    const props = service.run("groupObjects", { objectIds: ["feature-cone", "building-0"], name: "Props" }).result.groupId;
    const snapshot = document.snapshot();
    const historyLength = bus.history.length;

    const nonUniform = service.run("transformObjects", { objectIds: [roads], delta: deltaFromScale({ x: 2, y: 1, z: 1 }, { x: 40, z: 40 }) });
    assert.equal(nonUniform.ok, false);
    assert.ok(nonUniform.issues.every((issue) => issue.code === TRANSFORM_ISSUE_CODES.NON_UNIFORM_SCALE));
    const propScale = service.run("transformObjects", { objectIds: [props], delta: deltaFromScale(2, { x: 40, z: 40 }) });
    assert.equal(propScale.ok, false);
    assert.deepEqual(propScale.issues.map((issue) => issue.code), [TRANSFORM_ISSUE_CODES.SCALE_UNSUPPORTED]);
    const uniformRoads = service.run("transformObjects", { objectIds: [roads], delta: deltaFromScale(2, { x: 40, z: 40 }) });
    assert.equal(uniformRoads.ok, true, "uniform scale on a road group is allowed");
    bus.undo();
    service.run("setObjectsLocked", { objectIds: ["feature-cone"], locked: true });
    const lockedChild = service.run("transformObjects", { objectIds: [props], delta: deltaFromTranslation({ x: 1 }) });
    assert.equal(lockedChild.ok, false);
    assert.deepEqual(lockedChild.issues.map((issue) => issue.code), [TRANSFORM_ISSUE_CODES.LOCKED]);
    const gesture = bus.beginGesture({ objectIds: [props] });
    assert.equal(gesture.ok, false);
    bus.undo();
    assert.deepEqual(document.snapshot(), snapshot);
    assert.equal(bus.history.length, historyLength);
    // Groupable check: the skybox cannot join a group.
    const badGroup = service.run("groupObjects", { objectIds: ["skybox", "feature-tire"] });
    assert.deepEqual(badGroup.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.NOT_GROUPABLE]);
    assert.deepEqual(service.run("groupObjects", { objectIds: [] }).issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.SELECTION_EMPTY]);
});

test("ED-02 ungroup returns children to the parent at the group's slot and discards the frame", async () => {
    const { document, service, bus } = await yardService();
    const groupId = service.run("groupObjects", { objectIds: ["feature-barrel", "feature-cone"], name: "Pair" }).result.groupId;
    service.run("transformObjects", { objectIds: [groupId], delta: deltaFromTranslation({ x: 5 }) });
    const rootsBefore = childrenOf(document.objects, null).map((record) => record.id);
    const slot = rootsBefore.indexOf(groupId);
    const positions = worldPositions(document);
    const result = service.run("ungroupObjects", { objectIds: [groupId] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.children, ["feature-barrel", "feature-cone"]);
    assert.equal(document.getObject(groupId), null);
    const rootsAfter = childrenOf(document.objects, null);
    assert.deepEqual(rootsAfter.slice(slot, slot + 2).map((record) => record.id), ["feature-barrel", "feature-cone"]);
    assert.deepEqual(rootsAfter.map((record) => record.order), rootsAfter.map((_, index) => index));
    for (const [id, transform] of positions) {
        if (id !== groupId) assert.deepEqual(readObjectTransform(document.getObject(id), document.snapshot(), objectTypeRegistry, SKY), transform);
    }
    assert.deepEqual(service.run("ungroupObjects", { objectIds: ["feature-tire"] }).issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.UNGROUP_NOT_GROUP]);
    bus.undo();
    assert.equal(document.getObject(groupId).typeId, "group");
    assert.equal(document.getObject("feature-cone").parentId, groupId);
});

test("ED-02 duplicate copies props, buildings, and groups with new ids next to the source", async () => {
    const { document, service, bus } = await yardService();
    const groupId = service.run("groupObjects", { objectIds: ["feature-cone", "building-0"], name: "Kit" }).result.groupId;
    const before = document.snapshot();
    const result = service.run("duplicateObjects", { objectIds: [groupId, "feature-tire"] });
    assert.equal(result.ok, true);
    assert.equal(result.result.rootIds.length, 2);
    assert.equal(result.result.createdIds.length, 4);
    const [newGroup, newTire] = result.result.rootIds;
    assert.equal(document.getObject(newGroup).name, "Kit copy");
    assert.equal(document.getObject(newTire).name, "Tire copy");
    assert.deepEqual(document.getObject(newGroup).components.transform, document.getObject(groupId).components.transform);
    const copies = childrenOf(document.objects, newGroup);
    assert.equal(copies.length, 2);
    const copiedFeature = copies.find((record) => record.typeId === "builtin-prop");
    const copiedBuilding = copies.find((record) => record.typeId === "building");
    assert.deepEqual(
        { ...document.getFeature(copiedFeature.id), id: null },
        { ...document.getFeature("feature-cone"), id: null },
    );
    assert.deepEqual(
        document.getBuilding(copiedBuilding.id).footprint.map((point) => [point.x, point.z]),
        document.getBuilding("building-0").footprint.map((point) => [point.x, point.z]),
    );
    assert.notEqual(copiedBuilding.id, "building-0");
    const roots = childrenOf(document.objects, null).map((record) => record.id);
    assert.equal(roots.indexOf(newGroup), roots.indexOf(groupId) + 1, "copies land right after their source");
    assert.equal(roots.indexOf(newTire), roots.indexOf("feature-tire") + 1);
    assert.equal(document.features.length, 7);
    assert.equal(document.buildings.length, 2);
    assert.equal(validateObjectGraph(document.snapshot(), objectTypeRegistry, SKY).ok, true);
    bus.undo();
    assert.deepEqual(document.snapshot(), before);
    bus.redo();
    assert.equal(document.features.length, 7);
    const unsupported = service.run("duplicateObjects", { objectIds: ["e0", "skybox"] });
    assert.deepEqual(unsupported.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.DUPLICATE_UNSUPPORTED, COMMAND_ISSUE_CODES.DUPLICATE_UNSUPPORTED]);
});

test("ED-02 delete cascades through groups and the live overlay drops demoted junction records", async () => {
    const { document, service, bus } = await yardService();
    const groupId = service.run("groupObjects", { objectIds: ["n2", "feature-cone"], name: "Junction" }).result.groupId;
    const before = document.snapshot();
    const deleted = service.run("deleteObjects", { objectIds: [groupId] });
    assert.equal(deleted.ok, true);
    assert.deepEqual(deleted.result.deleted, [groupId, "n2", "feature-cone"]);
    assert.deepEqual(document.roads.edges.map((edge) => edge.id), ["e0"], "removing the junction removed its incident roads");
    assert.deepEqual(document.roads.nodes.map((node) => node.id), ["n0", "n1"]);
    assert.equal(document.getFeature("feature-cone"), null);
    assert.deepEqual(document.objects.filter((record) => ["road", "intersection", "group"].includes(record.typeId)).map((record) => record.id), ["e0"], "orphaned road records were dropped by the live overlay");
    assert.equal(validateObjectGraph(document.snapshot(), objectTypeRegistry, SKY).ok, true);
    bus.undo();
    assert.deepEqual(document.snapshot(), before);

    // Removing one edge demotes n1 (degree 2 → 1, kind unset) and drops its record.
    assert.equal(document.getObject("n1").typeId, "intersection");
    const removed = service.run("deleteObjects", { objectIds: ["e0"] });
    assert.equal(removed.ok, true);
    assert.equal(document.getObject("n1"), null);
    assert.equal(document.getNode("n1").kind, "endpoint");
    assert.equal(document.getObject("n2").typeId, "intersection", "explicit intersections keep their record");
    bus.undo();
    assert.equal(document.getObject("n1").typeId, "intersection");
    // Locked objects refuse deletion atomically, including through an ancestor.
    service.run("setObjectsLocked", { objectIds: ["feature-cone"], locked: true });
    const locked = service.run("deleteObjects", { objectIds: [groupId] });
    assert.deepEqual(locked.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.OBJECT_LOCKED]);
    assert.equal(document.getObject("n2").typeId, "intersection");
});

test("ED-02 hidden and locked components round-trip through commands and never touch geometry", async () => {
    const { document, service, bus } = await yardService();
    const geometry = () => ({ ...document.snapshot(), objects: undefined, objectGraphVersion: undefined });
    const before = geometry();
    assert.equal(service.run("setObjectsHidden", { objectIds: ["feature-cone", "e0"], hidden: true }).ok, true);
    assert.equal(document.getObject("feature-cone").components.editorHidden, true);
    assert.equal(document.getObject("e0").components.editorHidden, true);
    assert.equal(service.run("setObjectComponent", { objectId: "feature-cone", key: "tags", value: ["course"] }).ok, true);
    const badKey = service.run("setObjectComponent", { objectId: "feature-cone", key: "transform", value: {} });
    assert.deepEqual(badKey.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.ARGUMENT_INVALID]);
    const badValue = service.run("setObjectComponent", { objectId: "feature-cone", key: "locked", value: "yes" });
    assert.deepEqual(badValue.issues.map((issue) => issue.code), [OBJECT_ISSUE_CODES.COMPONENTS_INVALID]);
    assert.deepEqual(geometry(), before);
    bus.undo();
    bus.undo();
    assert.equal(document.getObject("feature-cone").components.editorHidden, false);
});
