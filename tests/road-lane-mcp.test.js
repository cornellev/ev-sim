import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageService } from "../server/storage/StorageService.js";
import { registerEnvironmentTools } from "../server/mcp/environmentTools.js";
import { LANE_LAYOUT_ISSUE_CODES } from "../app/roads/RoadLaneModel.js";
import { TURN_RULE_ISSUE_CODES } from "../app/roads/RoadJunctionValidation.js";

function parse(result) {
    return JSON.parse(result.content[0].text);
}

async function withTools(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed05-mcp-"));
    try {
        const storage = new StorageService(dir);
        await storage.createEnvironment({ id: "lanes", name: "Lanes", templateId: "blank" });
        const tools = new Map();
        registerEnvironmentTools({ registerTool(name, _definition, handler) { tools.set(name, handler); } }, storage);
        const call = async (name, args) => parse(await tools.get(name)({ environmentId: "lanes", ...args }));
        await fn({ storage, call });
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

test("ED-05 MCP road edits author lanes, markings, and turn rules through the shared commands", async () => {
    await withTools(async ({ storage, call }) => {
        const created = await call("environment_add_road", {
            points: [{ x: 0, z: 0 }, { x: 60, z: 0 }],
            geometryKind: "polyline",
            lanes: [{ direction: 1, width: 3.5 }, { direction: 1, width: 3.5 }, { id: "back", direction: -1, width: 4 }],
        });
        assert.equal(created.ok, true, JSON.stringify(created));
        const edgeId = created.createdEdges[0].id;
        assert.deepEqual(created.createdEdges[0].lanes.map((lane) => lane.id), ["lane-0", "lane-1", "back"]);
        assert.equal(created.createdEdges[0].width, 11);

        const rejected = await call("environment_add_road", { points: [{ x: 0, z: 40 }, { x: 60, z: 40 }], lanes: [{ direction: 1, width: 3 }] });
        assert.equal(rejected.ok, false, "explicit lanes need geometry v2");

        const setLane = await call("environment_edit_road", { operation: "set-lane", edgeId, laneId: "back", patch: { width: 5, markingLeft: null } });
        assert.equal(setLane.ok, true, JSON.stringify(setLane));
        let stored = await storage.getEnvironment("lanes");
        assert.equal(stored.document.roads.edges[0].width, 12);

        const marking = await call("environment_edit_road", { operation: "set-marking", edgeId, laneId: "lane-0", marking: "solid_white" });
        assert.equal(marking.ok, true, JSON.stringify(marking));
        const border = await call("environment_edit_road", { operation: "set-marking", edgeId, boundary: "left", marking: "solid_yellow" });
        assert.equal(border.ok, true, JSON.stringify(border));
        stored = await storage.getEnvironment("lanes");
        assert.equal(stored.document.roads.edges[0].lanes[0].markingLeft, "solid_white");
        assert.equal(stored.document.roads.edges[0].borderLeft, "solid_yellow");

        const inserted = await call("environment_edit_road", { operation: "insert-lane", edgeId, laneId: "back", side: "right", lane: { width: 3 } });
        assert.equal(inserted.ok, true, JSON.stringify(inserted));
        stored = await storage.getEnvironment("lanes");
        assert.deepEqual(stored.document.roads.edges[0].lanes.map((lane) => [lane.id, lane.direction, lane.width]), [["lane-0", 1, 3.5], ["lane-1", 1, 3.5], ["lane-2", -1, 3], ["back", -1, 5]]);

        const removed = await call("environment_edit_road", { operation: "remove-lane", edgeId, laneId: "lane-2" });
        assert.equal(removed.ok, true);

        const invalid = await call("environment_edit_road", { operation: "set-lanes", edgeId, lanes: [{ direction: 1, width: 3 }, { direction: -1, width: 3 }, { direction: 1, width: 3 }] });
        assert.equal(invalid.ok, false);
        assert.ok(invalid.issues.some((issue) => issue.code === LANE_LAYOUT_ISSUE_CODES.DIRECTION_INTERLEAVED), JSON.stringify(invalid));
        stored = await storage.getEnvironment("lanes");
        assert.equal(stored.document.roads.edges[0].lanes.length, 3, "a rejected MCP edit persists nothing");

        const options = await call("environment_edit_road", { operation: "set-options", edgeId, patch: { width: 24 } });
        assert.equal(options.ok, true, JSON.stringify(options));
        stored = await storage.getEnvironment("lanes");
        assert.deepEqual(stored.document.roads.edges[0].lanes.map((lane) => lane.width), [7, 7, 10], "the Width option scales explicit lanes");
        const readOnly = await call("environment_edit_road", { operation: "set-options", edgeId, patch: { laneCount: 5 } });
        assert.equal(readOnly.ok, false);

        const missingEdge = await call("environment_edit_road", { operation: "set-lane", laneId: "back", patch: { width: 4 } });
        assert.equal(missingEdge.ok, false);
    });
});

test("ED-05 MCP turn rules and validation surface lane feasibility with structured issues", async () => {
    await withTools(async ({ storage, call }) => {
        const west = await call("environment_add_road", { points: [{ x: -40, z: 0 }, { x: 0, z: 0 }], geometryKind: "polyline", lanes: [{ direction: 1, width: 3.5 }, { direction: 1, width: 3.5 }, { direction: -1, width: 4 }] });
        assert.equal(west.ok, true, JSON.stringify(west));
        const junctionId = west.createdNodes[1].id;
        const east = await call("environment_add_road", { points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], geometryKind: "polyline" });
        assert.equal(east.ok, true, JSON.stringify(east));
        const spur = await call("environment_add_road", { points: [{ x: 0, z: 0 }, { x: 0, z: 40 }], geometryKind: "polyline", lanes: [{ direction: -1, width: 3 }, { direction: -1, width: 3 }] });
        assert.equal(spur.ok, true, JSON.stringify(spur));
        const [ab, bc, bd] = [west, east, spur].map((result) => result.createdEdges[0].id);
        // Geometry strokes own their endpoints; join the other two roads onto ab's end node.
        for (const edgeId of [bc, bd]) {
            const connected = await call("environment_edit_road", { operation: "connect", edgeId, end: "start", targetNodeId: junctionId });
            assert.equal(connected.ok, true, JSON.stringify(connected));
        }
        const stored = await storage.getEnvironment("lanes");
        assert.equal(stored.document.roads.nodes.length, 4, "orphaned stroke endpoints are removed on connect");
        assert.equal(stored.document.roads.edges.find((edge) => edge.id === bd).startNodeId, junctionId);

        const denied = await call("environment_edit_road", { operation: "set-turn-rule", nodeId: junctionId, fromEdgeId: ab, toEdgeId: bc, allowed: false });
        assert.equal(denied.ok, true, JSON.stringify(denied));
        assert.deepEqual((await storage.getEnvironment("lanes")).document.roads.turnRules, [{ nodeId: junctionId, fromEdgeId: ab, toEdgeId: bc, allowed: false }]);

        const infeasible = await call("environment_edit_road", { operation: "set-turn-rule", nodeId: junctionId, fromEdgeId: ab, toEdgeId: bd, allowed: true });
        assert.equal(infeasible.ok, false);
        assert.ok(infeasible.issues.some((issue) => issue.code === TURN_RULE_ISSUE_CODES.INFEASIBLE), JSON.stringify(infeasible));

        const validation = await call("environment_validate", {});
        assert.equal(validation.ok, true);
        assert.equal(validation.roadsOk, true);
        assert.equal(validation.objectGraphOk, true);
        assert.equal(validation.issues.filter((issue) => issue.severity === "error").length, 0);
    });
});
