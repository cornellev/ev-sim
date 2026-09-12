import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { RoadOptions, ROAD_OPTION_ISSUE_CODES } from "../app/3d/editor/objects/types/road.js";
import { LANE_LAYOUT_ISSUE_CODES } from "../app/roads/RoadLaneModel.js";
import { ROAD_EDGE_ISSUE_CODES, updateRoadEdge } from "../app/3d/editor/document/documentMutations.js";

/** Two roads created through the command service so they carry object records. */
function twoRoads(options = {}) {
    const document = new EnvironmentDocument({ environmentId: "lanes", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const first = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], kind: "polyline", options });
    const second = service.run("createRoad", { points: [{ x: 0, z: 30 }, { x: 40, z: 30 }], kind: "polyline", options });
    assert.equal(first.ok, true, JSON.stringify(first.issues));
    assert.equal(second.ok, true, JSON.stringify(second.issues));
    return { document, service, bus: service.bus, a: first.result.edge.id, b: second.result.edge.id };
}

test("ED-05 the first lane edit materializes only the target edge and undo restores exact bytes", () => {
    const { document, service, bus, a, b } = twoRoads();
    const before = document.snapshot();
    const otherBefore = structuredClone(document.getEdge(b));
    const result = service.run("setRoadLane", { edgeId: a, laneId: "lane-0", patch: { width: 5 } });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const edge = document.getEdge(a);
    assert.deepEqual(edge.lanes, [{ id: "lane-0", direction: 1, width: 5 }, { id: "lane-1", direction: -1, width: 3.5 }]);
    assert.equal(edge.width, 8.5);
    assert.equal(edge.laneCount, 2);
    assert.equal(edge.bidirectional, true);
    assert.deepEqual(document.getEdge(b), otherBefore, "the untouched road never gains a lanes key");
    assert.equal("lanes" in document.getEdge(b), false);
    assert.deepEqual(Object.keys(result.changeSet.domains), ["roads.edges"]);
    assert.equal(bus.undo().ok, true);
    assert.deepEqual(document.snapshot(), before);
    assert.equal(bus.redo().ok, true);
    assert.equal(document.getEdge(a).width, 8.5);
});

test("ED-05 a lane layout equal to the derived default canonicalizes back to implicit fields", () => {
    const { document, service, a } = twoRoads();
    // Turning the reverse lane forward makes an ordinary two-lane one-way road.
    const oneWay = service.run("setRoadLane", { edgeId: a, laneId: "lane-1", patch: { direction: 1 } });
    assert.equal(oneWay.ok, true, JSON.stringify(oneWay.issues));
    const edge = document.getEdge(a);
    assert.equal("lanes" in edge, false);
    assert.equal(edge.bidirectional, false);
    assert.equal(edge.direction, 1);
    assert.equal(edge.laneCount, 2);
    assert.equal(edge.width, 7);
    // And back: a symmetric two-way split is implicit again.
    const twoWay = service.run("setRoadLane", { edgeId: a, laneId: "lane-1", patch: { direction: -1 } });
    assert.equal(twoWay.ok, true, JSON.stringify(twoWay.issues));
    assert.equal("lanes" in document.getEdge(a), false);
    assert.equal(document.getEdge(a).bidirectional, true);
    assert.equal(document.getEdge(a).direction, undefined);
});

test("ED-05 insert and remove keep ids stable, widen or narrow the road, and reject the last lane", () => {
    const { document, service, a } = twoRoads();
    const inserted = service.run("insertRoadLane", { edgeId: a, at: { laneId: "lane-0", side: "left" } });
    assert.equal(inserted.ok, true, JSON.stringify(inserted.issues));
    assert.equal(inserted.result.laneId, "lane-2");
    assert.deepEqual(document.getEdge(a).lanes.map((lane) => [lane.id, lane.direction, lane.width]), [["lane-0", 1, 3.5], ["lane-2", 1, 3.5], ["lane-1", -1, 3.5]]);
    assert.equal(document.getEdge(a).width, 10.5);
    assert.equal(document.getEdge(a).laneCount, 3);

    const custom = service.run("insertRoadLane", { edgeId: a, at: { laneId: "lane-1", side: "left" }, lane: { direction: -1, width: 4, markingLeft: "solid_white" } });
    assert.equal(custom.ok, false, "the leftmost lane cannot carry an interior marking");
    assert.ok(custom.issues.some((entry) => entry.code === LANE_LAYOUT_ISSUE_CODES.MARKING_OUTER_FORBIDDEN), JSON.stringify(custom.issues));
    assert.equal(document.getEdge(a).lanes.length, 3, "a rejected insert leaves the document untouched");

    const wide = service.run("insertRoadLane", { edgeId: a, at: { laneId: "lane-1", side: "left" }, lane: { width: 4 } });
    assert.equal(wide.ok, true, JSON.stringify(wide.issues));
    assert.deepEqual(document.getEdge(a).lanes.map((lane) => [lane.id, lane.direction, lane.width]), [["lane-0", 1, 3.5], ["lane-2", 1, 3.5], ["lane-1", -1, 3.5], ["lane-3", -1, 4]]);
    assert.equal(document.getEdge(a).width, 14.5);

    assert.equal(service.run("removeRoadLane", { edgeId: a, laneId: "lane-3" }).ok, true);
    assert.equal(service.run("removeRoadLane", { edgeId: a, laneId: "lane-2" }).ok, true);
    assert.equal("lanes" in document.getEdge(a), false, "removing the extra lanes restores the implicit two-lane layout");
    assert.equal(document.getEdge(a).width, 7);
    assert.equal(service.run("removeRoadLane", { edgeId: a, laneId: "lane-1" }).ok, true);
    assert.deepEqual(document.getEdge(a).lanes, undefined);
    assert.equal(document.getEdge(a).bidirectional, false);
    assert.equal(document.getEdge(a).laneCount, 1);
    const last = service.run("removeRoadLane", { edgeId: a, laneId: "lane-0" });
    assert.equal(last.ok, false);
    assert.match(last.issues[0].message, /at least one lane/);
    const missing = service.run("removeRoadLane", { edgeId: a, laneId: "lane-9" });
    assert.equal(missing.ok, false);
});

test("ED-05 splitting a shared single lane yields a right-hand two-way pair", () => {
    const { document, service, a } = twoRoads({ laneCount: 1, width: 4 });
    assert.equal(document.getEdge(a).bidirectional, true);
    const result = service.run("insertRoadLane", { edgeId: a, at: { laneId: "lane-0", side: "left" } });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const edge = document.getEdge(a);
    assert.equal("lanes" in edge, false, "[+1, -1] with equal widths is the derived two-lane default");
    assert.equal(edge.laneCount, 2);
    assert.equal(edge.width, 8);
    assert.equal(edge.bidirectional, true);
    const right = service.run("insertRoadLane", { edgeId: a, at: { laneId: "lane-0", side: "right" }, lane: { width: 3 } });
    assert.equal(right.ok, true, JSON.stringify(right.issues));
    assert.deepEqual(document.getEdge(a).lanes.map((lane) => [lane.id, lane.direction, lane.width]), [["lane-2", 1, 3], ["lane-0", 1, 4], ["lane-1", -1, 4]]);
});

test("ED-05 setRoadLanes replaces the layout, assigns ids, and rejects illegal layouts atomically", () => {
    const { document, service, bus, a } = twoRoads();
    const before = document.snapshot();
    const historyBefore = bus.snapshot().historyLength;
    const interleaved = service.run("setRoadLanes", { edgeId: a, lanes: [{ direction: 1, width: 3 }, { direction: -1, width: 3 }, { direction: 1, width: 3 }] });
    assert.equal(interleaved.ok, false);
    const domainIssue = interleaved.issues.find((entry) => entry.code === LANE_LAYOUT_ISSUE_CODES.DIRECTION_INTERLEAVED);
    assert.ok(domainIssue, JSON.stringify(interleaved.issues));
    assert.deepEqual(domainIssue.path, ["roads", "edges", 0, "lanes"]);
    assert.equal(domainIssue.objectId, a);
    assert.deepEqual(document.snapshot(), before);
    assert.equal(bus.snapshot().historyLength, historyBefore);

    const shared = service.run("setRoadLanes", { edgeId: a, lanes: [{ direction: 0, width: 3 }, { direction: 1, width: 3 }] });
    assert.equal(shared.ok, false);
    assert.ok(shared.issues.some((entry) => entry.code === LANE_LAYOUT_ISSUE_CODES.SHARED_REQUIRES_SINGLE));

    const duplicate = service.run("setRoadLanes", { edgeId: a, lanes: [{ id: "x", direction: 1, width: 3 }, { id: "x", direction: -1, width: 3 }] });
    assert.equal(duplicate.ok, false);

    const result = service.run("setRoadLanes", { edgeId: a, lanes: [{ direction: 1, width: 3.5 }, { direction: 1, width: 3.5 }, { id: "back", direction: -1, width: 4 }] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(document.getEdge(a).lanes, [
        { id: "lane-0", direction: 1, width: 3.5 },
        { id: "lane-1", direction: 1, width: 3.5 },
        { id: "back", direction: -1, width: 4 },
    ]);
    assert.equal(document.getEdge(a).width, 11);
    assert.equal(document.getEdge(a).laneCount, 3);
    assert.equal(document.getEdge(a).bidirectional, true);
});

test("ED-05 the Width field scales explicit lanes proportionally and derived fields are read-only", () => {
    const { document, service, a } = twoRoads();
    assert.equal(service.run("setRoadLane", { edgeId: a, laneId: "lane-0", patch: { width: 5 } }).ok, true);
    const scaled = service.run("setObjectOptions", { objectId: a, patch: { width: 17 } });
    assert.equal(scaled.ok, true, JSON.stringify(scaled.issues));
    assert.deepEqual(document.getEdge(a).lanes.map((lane) => lane.width), [10, 7]);
    assert.equal(document.getEdge(a).width, 17);

    const count = service.run("setObjectOptions", { objectId: a, patch: { laneCount: 4 } });
    assert.equal(count.ok, false);
    assert.equal(count.issues[0].code, ROAD_OPTION_ISSUE_CODES.LANE_LAYOUT);
    assert.deepEqual(count.issues[0].path, ["laneCount"]);
    assert.equal(document.getEdge(a).laneCount, 2);

    const direction = service.run("setObjectOptions", { objectId: a, patch: { bidirectional: false } });
    assert.equal(direction.ok, false);
    assert.deepEqual(direction.issues[0].path, ["bidirectional"]);
    assert.equal(document.getEdge(a).bidirectional, true);

    // Equal-width scaling lands back on the derived default and drops the array.
    assert.equal(service.run("setRoadLane", { edgeId: a, laneId: "lane-0", patch: { width: 7 } }).ok, true);
    assert.equal("lanes" in document.getEdge(a), false);
    assert.equal(document.getEdge(a).width, 14);

    // The raw mutation guards the same fields for callers that bypass options.
    assert.equal(service.run("setRoadLane", { edgeId: a, laneId: "lane-0", patch: { width: 5 } }).ok, true);
    const raw = updateRoadEdge(document, a, { laneCount: 3 }, { notify: false });
    assert.equal(raw.ok, false);
    assert.equal(raw.issues[0].code, ROAD_EDGE_ISSUE_CODES.EXPLICIT_FIELD_READONLY);
    assert.equal(updateRoadEdge(document, a, { laneCount: 2, bidirectional: true, shoulderWidth: 1 }, { notify: false }).ok, true, "equal derived values are no-ops");
    assert.equal(document.getEdge(a).shoulderWidth, 1);
});

test("ED-05 explicit lanes hide the derived fields and illegal layouts are field-level issues", () => {
    const options = new RoadOptions();
    const all = options.getFields().map((descriptor) => descriptor.path[0]);
    assert.deepEqual(all, ["width", "laneCount", "shoulderWidth", "bidirectional", "direction", "borderLeft", "borderRight"]);
    const explicit = options.getFields({ value: options.normalize({ width: 11, laneCount: 3, lanes: [{ id: "a", direction: 1, width: 5 }, { id: "b", direction: 1, width: 3 }, { id: "c", direction: -1, width: 3 }] }) });
    assert.deepEqual(explicit.map((descriptor) => descriptor.path[0]), ["width", "shoulderWidth", "borderLeft", "borderRight"]);
    const odd = options.validate(options.normalize({ width: 9, laneCount: 3, bidirectional: true }));
    assert.deepEqual(odd.map((entry) => [entry.code, entry.path]), [[ROAD_OPTION_ISSUE_CODES.LANE_LAYOUT, ["laneCount"]]]);
    assert.deepEqual(options.validate(options.normalize({ width: 4, laneCount: 1, bidirectional: true })), []);
});

test("ED-05 markings are authored per boundary and stay appearance-only", () => {
    const { document, service, a } = twoRoads();
    const border = service.run("setRoadMarking", { edgeId: a, boundary: "left", marking: "solid_yellow" });
    assert.equal(border.ok, true, JSON.stringify(border.issues));
    assert.equal(document.getEdge(a).borderLeft, "solid_yellow");
    assert.equal("lanes" in document.getEdge(a), false, "border markings never materialize lanes");

    const divider = service.run("setRoadMarking", { edgeId: a, boundary: { laneId: "lane-0" }, marking: "dashed_yellow" });
    assert.equal(divider.ok, true, JSON.stringify(divider.issues));
    assert.equal(document.getEdge(a).lanes[0].markingLeft, "dashed_yellow");
    const outer = service.run("setRoadMarking", { edgeId: a, boundary: { laneId: "lane-1" }, marking: "none" });
    assert.equal(outer.ok, false);
    assert.ok(outer.issues.some((entry) => entry.code === LANE_LAYOUT_ISSUE_CODES.MARKING_OUTER_FORBIDDEN), JSON.stringify(outer.issues));
    const unknown = service.run("setRoadMarking", { edgeId: a, boundary: { laneId: "lane-0" }, marking: "purple" });
    assert.equal(unknown.ok, false);
    const cleared = service.run("setRoadMarking", { edgeId: a, boundary: { laneId: "lane-0" }, marking: null });
    assert.equal(cleared.ok, true);
    assert.equal("lanes" in document.getEdge(a), false, "clearing the only authored marking returns the road to implicit");
});

test("ED-05 split, duplicate, and locks carry or guard explicit lanes", () => {
    const { document, service, a } = twoRoads();
    const lanes = [{ direction: 1, width: 3 }, { direction: 1, width: 3 }, { direction: -1, width: 4, markingLeft: undefined }];
    assert.equal(service.run("setRoadLanes", { edgeId: a, lanes }).ok, true);
    assert.equal(service.run("setRoadMarking", { edgeId: a, boundary: { laneId: "lane-0" }, marking: "dashed_white" }).ok, true);
    const expected = structuredClone(document.getEdge(a).lanes);

    const split = service.run("splitRoad", { edgeId: a, at: { span: 0, u: 0.5 } });
    assert.equal(split.ok, true, JSON.stringify(split.issues));
    assert.deepEqual(document.getEdge(split.result.left.id).lanes, expected);
    assert.deepEqual(document.getEdge(split.result.right.id).lanes, expected);

    const duplicated = service.run("duplicateObjects", { objectIds: [split.result.left.id] });
    assert.equal(duplicated.ok, true, JSON.stringify(duplicated.issues));
    const copy = duplicated.result.createdIds.map((id) => document.getEdge(id)).find(Boolean);
    assert.deepEqual(copy.lanes, expected);

    assert.equal(service.run("setObjectsLocked", { objectIds: [split.result.left.id], locked: true }).ok, true);
    const locked = service.run("setRoadLane", { edgeId: split.result.left.id, laneId: "lane-0", patch: { width: 9 } });
    assert.equal(locked.ok, false);
    assert.equal(locked.issues[0].code, "command.object.locked");
    assert.deepEqual(document.getEdge(split.result.left.id).lanes, expected);
});

test("ED-05 createRoad accepts explicit lanes and derives the edge fields from them", () => {
    const document = new EnvironmentDocument({ environmentId: "lanes", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const created = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 20, z: 0 }], kind: "polyline", options: { lanes: [{ id: "r", direction: 1, width: 3 }, { id: "l", direction: -1, width: 4 }] } });
    assert.equal(created.ok, true, JSON.stringify(created.issues));
    const edge = document.getEdge(created.result.edge.id);
    assert.equal(edge.width, 7);
    assert.equal(edge.laneCount, 2);
    assert.equal(edge.bidirectional, true);
    assert.deepEqual(edge.lanes, [{ id: "r", direction: 1, width: 3 }, { id: "l", direction: -1, width: 4 }]);
});
