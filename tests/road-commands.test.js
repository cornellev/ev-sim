import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { deltaFromTranslation } from "../app/3d/editor/objects/transformDelta.js";

function legacy() {
    return new EnvironmentDocument({ environmentId: "x", roads: { nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 20, y: 0, z: 0 }], edges: [{ id: "e", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2, startArm: { x: 5, y: 0, z: 2 }, endArm: { x: 15, y: 0, z: 2 } }] } });
}

test("ED-04 first geometry command upgrades atomically and undo restores exact legacy bytes", () => {
    const document = legacy(); const before = document.snapshot();
    const service = createEnvironmentCommandService({ document });
    const result = service.run("insertRoadKnot", { edgeId: "e", at: { span: 0, u: 0.5 } });
    assert.equal(result.ok, true);
    assert.equal(document.roads.geometryVersion, 2);
    assert.equal(document.getEdge("e").startArm, null);
    assert.ok(document.getEdge("e").geometry.knots.length > 2);
    service.bus.undo();
    assert.deepEqual(document.snapshot(), before);
    service.bus.redo();
    assert.equal(document.roads.geometryVersion, 2);
});

test("ED-04 split, detach, connect, and duplicate preserve topology", () => {
    const document = legacy(); const service = createEnvironmentCommandService({ document });
    service.run("convertRoadGeometry", { edgeId: "e", kind: "cubic-bezier" });
    const split = service.run("splitRoad", { edgeId: "e", at: { span: 0, u: 0.5 } });
    assert.equal(split.ok, true);
    assert.equal(document.roads.edges.length, 2);
    assert.equal(split.result.left.endNodeId, split.result.right.startNodeId);
    const detached = service.run("detachRoadEndpoint", { edgeId: split.result.right.id, end: "start" });
    assert.equal(detached.ok, true);
    assert.notEqual(detached.result.node.id, split.result.node.id);
    const connected = service.run("connectRoadEndpoint", { edgeId: split.result.right.id, end: "start", target: { nodeId: split.result.node.id } });
    assert.equal(connected.ok, true);
    const nodeCount = document.roads.nodes.length;
    const originalNodes = new Set(document.roads.nodes.map((node) => node.id));
    const duplicated = service.run("duplicateObjects", { objectIds: [split.result.left.id, split.result.right.id] });
    assert.equal(duplicated.ok, true);
    assert.equal(document.roads.edges.length, 4);
    assert.equal(document.roads.nodes.length, nodeCount + 3, "the selected two-edge subgraph clones its shared node once");
    const copiedEdges = duplicated.result.createdIds.map((id) => document.getEdge(id)).filter(Boolean);
    assert.equal(copiedEdges.length, 2);
    assert.equal(copiedEdges[0].endNodeId, copiedEdges[1].startNodeId);
    assert.equal(copiedEdges.every((edge) => !originalNodes.has(edge.startNodeId) && !originalNodes.has(edge.endNodeId)), true, "external connections are not cloned into the duplicate");

    const intersection = service.run("createIntersection", { point: { x: 60, y: 2, z: 20 } });
    const isolated = service.run("duplicateObjects", { objectIds: [intersection.result.objectId] });
    assert.equal(isolated.ok, true);
    const isolatedNode = document.getNode(isolated.result.rootIds[0]);
    assert.equal(isolatedNode.kind, "intersection");
    assert.equal(document.roads.edges.some((edge) => edge.startNodeId === isolatedNode.id || edge.endNodeId === isolatedNode.id), false);
});

test("ED-04 knot/handle gestures validate previews and cancel losslessly", () => {
    const document = new EnvironmentDocument({ environmentId: "x", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const created = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 10, z: 5 }, { x: 20, z: 0 }] });
    const edgeId = created.result.edge.id;
    const knotId = document.getEdge(edgeId).geometry.knots[1].id;
    const before = document.snapshot();
    const begun = service.bus.beginGesture({ objectIds: [], sub: { kind: "road-handle", edgeId, knotId, side: "out" }, label: "Move handle" });
    assert.equal(begun.ok, true);
    assert.equal(service.bus.updateGesture(begun.gestureId, deltaFromTranslation({ x: 1, z: 2 })).ok, true);
    assert.equal(document.getEdge(edgeId).geometry.knots[1].mode, "aligned");
    service.bus.cancelGesture(begun.gestureId);
    assert.deepEqual(document.snapshot(), before);
});

test("ED-04 road commands and shared-node gestures reject locked dependencies", () => {
    const document = new EnvironmentDocument({ environmentId: "x", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const first = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] });
    const shared = first.result.endNode.id;
    const second = service.run("createRoad", { points: [{ x: 10, z: 0 }, { x: 20, z: 0 }], startNodeId: shared });
    assert.equal(service.run("setObjectsLocked", { objectIds: [second.result.edge.id], locked: true }).ok, true);
    const edit = service.run("insertRoadKnot", { edgeId: second.result.edge.id, at: { span: 0, u: 0.5 } });
    assert.equal(edit.ok, false);
    assert.equal(edit.issues[0].code, "command.object.locked");
    const gesture = service.bus.beginGesture({ objectIds: [first.result.edge.id], label: "Move road" });
    assert.equal(gesture.ok, false);
    assert.equal(gesture.issues.some((issue) => issue.objectId === second.result.edge.id), true);
});
