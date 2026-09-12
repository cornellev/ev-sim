import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { getIntersectionMovements, setTurnMovementAllowed } from "../app/3d/editor/document/documentMutations.js";
import { planRoadNetworkGeometry } from "../app/roads/RoadNetworkGeometry.js";
import {
    MOVEMENT_INFEASIBLE_REASONS,
    TURN_RULE_ISSUE_CODES,
    arrivingLaneIndices,
    departingLaneIndices,
    movementConnector,
    validateJunctionMovements,
} from "../app/roads/RoadJunctionValidation.js";

const polyline = { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] };

/**
 * T-junction at b: ab arrives from the west with two forward lanes and one
 * reverse lane, bc continues east as an ordinary two-way road, and bd is a
 * one-way spur that only travels d → b (so nothing can depart b along it).
 */
function tJunction() {
    return new EnvironmentDocument({
        environmentId: "turns",
        roads: {
            geometryVersion: 2,
            nodes: [
                { id: "a", x: 0, y: 0, z: 0 },
                { id: "b", x: 30, y: 0, z: 0, kind: "intersection" },
                { id: "c", x: 60, y: 0, z: 0 },
                { id: "d", x: 30, y: 0, z: 30 },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 11, laneCount: 3, geometry: polyline, lanes: [
                    { id: "lane-0", direction: 1, width: 3.5 },
                    { id: "lane-1", direction: 1, width: 3.5 },
                    { id: "lane-2", direction: -1, width: 4 },
                ] },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 7, laneCount: 2, geometry: polyline },
                { id: "bd", startNodeId: "b", endNodeId: "d", bidirectional: false, direction: -1, width: 7, laneCount: 2, geometry: polyline },
            ],
        },
    });
}

test("ED-05 lane order for connectors is rightmost travel lane first", () => {
    const document = tJunction();
    const ab = document.getEdge("ab");
    const bd = document.getEdge("bd");
    assert.deepEqual(arrivingLaneIndices(ab, "b"), [0, 1]);
    assert.deepEqual(departingLaneIndices(ab, "b"), [2]);
    assert.deepEqual(arrivingLaneIndices(bd, "b"), [1, 0], "travelling -1 the rightmost lane is the highest index");
    assert.deepEqual(departingLaneIndices(bd, "b"), []);
    assert.deepEqual(arrivingLaneIndices(ab, "zzz"), []);
});

test("ED-05 the movement matrix exposes every incident pair with feasibility, reason, and lane connector", () => {
    const document = tJunction();
    const movements = getIntersectionMovements(document, "b");
    assert.deepEqual(movements.incident.map((edge) => edge.id), ["ab", "bc", "bd"]);
    assert.deepEqual(movements.incoming.map((edge) => edge.id), ["ab", "bc", "bd"]);
    assert.deepEqual(movements.outgoing.map((edge) => edge.id), ["ab", "bc"]);
    assert.equal(movements.cells.length, 9);
    const cell = (from, to) => movements.cells.find((entry) => entry.fromEdgeId === from && entry.toEdgeId === to);
    assert.equal(cell("ab", "bd").feasible, false);
    assert.equal(cell("ab", "bd").reason, MOVEMENT_INFEASIBLE_REASONS.NO_DEPARTURE_LANE);
    assert.equal(cell("ab", "bd").allowed, false);
    assert.equal(cell("bd", "bd").feasible, false);
    assert.equal(cell("ab", "bc").feasible, true);
    assert.equal(cell("ab", "bc").allowed, true);
    assert.deepEqual(cell("ab", "bc").connector, { fromLaneId: "lane-0", toLaneId: "lane-0", fromLaneIndex: 0, toLaneIndex: 0 });
    assert.deepEqual(cell("bd", "ab").connector, { fromLaneId: "lane-1", toLaneId: "lane-2", fromLaneIndex: 1, toLaneIndex: 2 }, "the spur arrives on its rightmost -1 lane and departs on ab's only reverse lane");
    assert.equal(cell("ab", "ab").allowed, false, "U-turns stay forbidden by default at a junction");
    assert.equal(cell("ab", "ab").feasible, true);

    const plan = planRoadNetworkGeometry(document.roads);
    assert.equal(movementConnector(plan, "b", "ab", "bc").fromLaneId, "lane-0");
    assert.equal(movementConnector(plan, "a", "ab", "ab"), undefined, "endpoints have no junction surface");
    assert.deepEqual(validateJunctionMovements(document.roads, plan), []);
    assert.deepEqual(getIntersectionMovements(document, "b", { plan }).cells.map((entry) => entry.feasible), movements.cells.map((entry) => entry.feasible));
});

test("ED-05 turn-rule writes return structured issues and refuse infeasible movements", () => {
    const document = tJunction();
    const infeasible = setTurnMovementAllowed(document, "b", "ab", "bd", false, { notify: false });
    assert.equal(infeasible.ok, false);
    assert.equal(infeasible.issues[0].code, TURN_RULE_ISSUE_CODES.INFEASIBLE);
    assert.deepEqual(document.roads.turnRules, []);
    const missing = setTurnMovementAllowed(document, "b", "ab", "zz", false, { notify: false });
    assert.equal(missing.issues[0].code, TURN_RULE_ISSUE_CODES.REFERENCE_MISSING);

    const service = createEnvironmentCommandService({ document });
    const denied = service.run("setRoadTurnRule", { nodeId: "b", fromEdgeId: "ab", toEdgeId: "bc", allowed: false });
    assert.equal(denied.ok, true, JSON.stringify(denied.issues));
    assert.deepEqual(document.roads.turnRules, [{ nodeId: "b", fromEdgeId: "ab", toEdgeId: "bc", allowed: false }]);
    assert.ok(Object.keys(denied.changeSet.domains).includes("roads.turnRules"));
    assert.equal("roads.edges" in denied.changeSet.domains, false);
    const rejected = service.run("setRoadTurnRule", { nodeId: "b", fromEdgeId: "ab", toEdgeId: "bd", allowed: true });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.issues[0].code, TURN_RULE_ISSUE_CODES.INFEASIBLE);
    assert.equal(rejected.issues[0].objectId, "b");
    const legacy = service.run("setTurnRule", { nodeId: "b", fromEdgeId: "ab", toEdgeId: "bd", allowed: true });
    assert.equal(legacy.ok, false);
    assert.equal(legacy.issues[0].code, TURN_RULE_ISSUE_CODES.INFEASIBLE, "the legacy command surfaces the same structured issue");
    const restored = service.run("setRoadTurnRule", { nodeId: "b", fromEdgeId: "ab", toEdgeId: "bc", allowed: true });
    assert.equal(restored.ok, true);
    assert.deepEqual(document.roads.turnRules, []);
    assert.equal(service.bus.undo().ok, true);
    assert.deepEqual(document.roads.turnRules, [{ nodeId: "b", fromEdgeId: "ab", toEdgeId: "bc", allowed: false }]);
});

test("ED-05 lane direction changes prune overrides whose movement no longer exists", () => {
    const document = tJunction();
    const service = createEnvironmentCommandService({ document });
    assert.equal(service.run("setRoadTurnRule", { nodeId: "b", fromEdgeId: "ab", toEdgeId: "bc", allowed: false }).ok, true);
    assert.equal(service.run("setRoadTurnRule", { nodeId: "b", fromEdgeId: "bc", toEdgeId: "ab", allowed: false }).ok, true);
    assert.equal(document.roads.turnRules.length, 2);

    // Reversing ab entirely means nothing arrives at b along it; ab → bc goes away.
    const reversed = service.run("setRoadLanes", { edgeId: "ab", lanes: [{ direction: -1, width: 3.5 }, { direction: -1, width: 3.5 }, { direction: -1, width: 4 }] });
    assert.equal(reversed.ok, true, JSON.stringify(reversed.issues));
    assert.deepEqual(document.getEdge("ab").lanes.map((lane) => lane.direction), [-1, -1, -1], "unequal widths keep the layout explicit");
    assert.equal(document.getEdge("ab").bidirectional, false);
    assert.equal(document.getEdge("ab").direction, -1);
    assert.deepEqual(document.roads.turnRules, [{ nodeId: "b", fromEdgeId: "bc", toEdgeId: "ab", allowed: false }]);
    assert.ok(["roads.edges", "roads.turnRules"].every((domain) => domain in reversed.changeSet.domains));

    assert.equal(service.bus.undo().ok, true);
    assert.equal(document.roads.turnRules.length, 2, "undo restores the pruned rule with the lanes");
    assert.deepEqual(document.getEdge("ab").lanes.map((lane) => lane.direction), [1, 1, -1]);
});
