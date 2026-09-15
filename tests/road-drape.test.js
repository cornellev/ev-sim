import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { collectRoadDrapeTargets, planRoadDrape, selectionCanDrapeRoads } from "../app/3d/editor/document/roadDrapeTargets.js";
import { COMMAND_ISSUE_CODES, createEnvironmentCommandService } from "../app/3d/editor/commands/index.js";
import { drapeRoadControlPoints } from "../app/3d/editor/commands/roadCommands.js";

function v1Document() {
    return new EnvironmentDocument({
        environmentId: "drape",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0 },
                { id: "b", x: 10, y: 0, z: 0 },
            ],
            edges: [{ id: "e", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2 }],
        },
    });
}

function samplerAt(yByKey) {
    return (x, z) => {
        const exact = yByKey[`${x},${z}`];
        if (Number.isFinite(exact)) return exact;
        if (typeof yByKey.default === "number") return yByKey.default;
        return null;
    };
}

test("collectRoadDrapeTargets walks a selected road without expanding neighbours", () => {
    const document = new EnvironmentDocument({
        environmentId: "drape",
        roads: {
            geometryVersion: 2,
            nodes: [
                { id: "a", x: 0, y: 0, z: 0 },
                { id: "b", x: 10, y: 0, z: 0 },
                { id: "c", x: 20, y: 0, z: 0 },
            ],
            edges: [
                {
                    id: "ab",
                    startNodeId: "a",
                    endNodeId: "b",
                    width: 7,
                    laneCount: 2,
                    geometry: {
                        version: 1,
                        kind: "polyline",
                        knots: [
                            { id: "start" },
                            { id: "k1", position: { x: 5, y: 0, z: 0 } },
                            { id: "end" },
                        ],
                    },
                },
                {
                    id: "bc",
                    startNodeId: "b",
                    endNodeId: "c",
                    width: 7,
                    laneCount: 2,
                    geometry: {
                        version: 1,
                        kind: "polyline",
                        knots: [
                            { id: "start" },
                            { id: "k2", position: { x: 15, y: 0, z: 0 } },
                            { id: "end" },
                        ],
                    },
                },
            ],
        },
    });

    const selected = collectRoadDrapeTargets(document, { objectIds: ["ab"] });
    assert.deepEqual(selected.nodes.map((node) => node.nodeId).sort(), ["a", "b"]);
    assert.deepEqual(selected.knots.map((knot) => knot.knotId), ["k1"]);

    const connected = collectRoadDrapeTargets(document, { objectIds: ["ab"], includeConnected: true });
    assert.deepEqual(connected.nodes.map((node) => node.nodeId).sort(), ["a", "b", "c"]);
    assert.deepEqual(connected.knots.map((knot) => knot.knotId).sort(), ["k1", "k2"]);

    const knotOnly = collectRoadDrapeTargets(document, { objectIds: ["ab"], sub: { kind: "road-knot", edgeId: "ab", knotId: "k1" } });
    assert.deepEqual(knotOnly.nodes, []);
    assert.deepEqual(knotOnly.knots.map((knot) => knot.knotId), ["k1"]);
});

test("selectionCanDrapeRoads is true for roads, intersections, and road subs", () => {
    const document = v1Document();
    assert.equal(selectionCanDrapeRoads(document, { ids: ["e"] }), true);
    assert.equal(selectionCanDrapeRoads(document, { ids: [], sub: { kind: "road-node", id: "a" } }), true);
    assert.equal(selectionCanDrapeRoads(document, { ids: ["building-1"] }), false);
    assert.equal(selectionCanDrapeRoads(document, { ids: [] }), false);
});

test("drapeRoadControlPoints moves v1 nodes, applies offset, and skips misses", () => {
    const document = v1Document();
    const service = createEnvironmentCommandService({ document });
    const result = service.bus.execute(drapeRoadControlPoints({
        objectIds: ["e"],
        offset: 0.05,
        sampleElevation: samplerAt({ "0,0": 2, "10,0": null }),
    }));
    assert.equal(result.ok, true);
    assert.equal(document.getNode("a").y, 2.05);
    assert.equal(document.getNode("b").y, 0);
    assert.deepEqual(result.result.movedNodeIds, ["a"]);
    assert.equal(result.result.skipped, 1);

    const before = document.snapshot();
    const empty = service.bus.execute(drapeRoadControlPoints({
        objectIds: ["e"],
        offset: 0.05,
        sampleElevation: samplerAt({ "0,0": 2, "10,0": null }),
    }));
    assert.equal(empty.ok, false);
    assert.equal(empty.issues[0].code, COMMAND_ISSUE_CODES.DRAPE_EMPTY);
    assert.deepEqual(document.snapshot(), before);
});

test("drapeRoadControlPoints updates interior knots once and leaves handles unchanged", () => {
    const document = new EnvironmentDocument({ environmentId: "drape", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const created = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }], kind: "cubic-bezier" });
    const edgeId = created.result.edge.id;
    const knotId = document.getEdge(edgeId).geometry.knots[1].id;
    service.run("setRoadKnot", { edgeId, knotId, patch: { mode: "free", handleOut: { x: 1, y: 0.25, z: 0 } } });
    const handleBefore = { ...document.getEdge(edgeId).geometry.knots[1].handleOut };

    const result = service.bus.execute(drapeRoadControlPoints({
        objectIds: [edgeId],
        sampleElevation: () => 4,
    }));
    assert.equal(result.ok, true);
    assert.equal(document.getNode(created.result.startNode.id).y, 4);
    assert.equal(document.getNode(created.result.endNode.id).y, 4);
    const knot = document.getEdge(edgeId).geometry.knots[1];
    assert.equal(knot.position.y, 4);
    assert.deepEqual(knot.handleOut, handleBefore);

    const undone = service.bus.undo();
    assert.equal(undone.ok, true);
    assert.equal(document.getNode(created.result.startNode.id).y, 0);
    assert.equal(document.getEdge(edgeId).geometry.knots[1].position.y, 0);
});

test("drapeRoadControlPoints moves a shared intersection node once", () => {
    const document = new EnvironmentDocument({ environmentId: "drape", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const first = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] });
    const shared = first.result.endNode.id;
    const second = service.run("createRoad", { points: [{ x: 10, z: 0 }, { x: 20, z: 0 }], startNodeId: shared });
    const result = service.bus.execute(drapeRoadControlPoints({
        objectIds: [first.result.edge.id, second.result.edge.id],
        sampleElevation: () => 3,
    }));
    assert.equal(result.ok, true);
    assert.equal(result.result.movedNodeIds.filter((id) => id === shared).length, 1);
    assert.equal(document.getNode(shared).y, 3);
});

test("drapeRoadControlPoints rejects locked roads and missing samplers", () => {
    const document = new EnvironmentDocument({ environmentId: "drape", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const created = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] });
    assert.equal(service.run("setObjectsLocked", { objectIds: [created.result.edge.id], locked: true }).ok, true);
    const locked = service.bus.execute(drapeRoadControlPoints({
        objectIds: [created.result.edge.id],
        sampleElevation: () => 1,
    }));
    assert.equal(locked.ok, false);
    assert.equal(locked.issues[0].code, COMMAND_ISSUE_CODES.OBJECT_LOCKED);
    assert.equal(document.getNode(created.result.startNode.id).y, 0);

    const missing = service.bus.execute(drapeRoadControlPoints({ objectIds: [created.result.edge.id] }));
    assert.equal(missing.ok, false);
    assert.equal(missing.issues[0].code, COMMAND_ISSUE_CODES.ARGUMENT_INVALID);

    const empty = service.bus.execute(drapeRoadControlPoints({ objectIds: [], sampleElevation: () => 1 }));
    assert.equal(empty.ok, false);
    assert.equal(empty.issues[0].code, COMMAND_ISSUE_CODES.SELECTION_EMPTY);
});

test("planRoadDrape keeps XZ and only rewrites sampled knot Y", () => {
    const document = new EnvironmentDocument({
        environmentId: "drape",
        roads: {
            geometryVersion: 2,
            nodes: [{ id: "a", x: 1, y: 0, z: 2 }, { id: "b", x: 4, y: 0, z: 2 }],
            edges: [{
                id: "e",
                startNodeId: "a",
                endNodeId: "b",
                geometry: {
                    version: 1,
                    kind: "polyline",
                    knots: [{ id: "start" }, { id: "k1", position: { x: 2.5, y: 0, z: 2 } }, { id: "end" }],
                },
            }],
        },
    });
    const targets = collectRoadDrapeTargets(document, { objectIds: ["e"] });
    const samples = new Map([["node:a", 8], ["knot:e:k1", 9]]);
    const planned = planRoadDrape(document, targets, samples, 0.5);
    assert.equal(planned.steps[0].op, "move-node");
    assert.deepEqual(planned.steps[0].position, { x: 1, y: 8.5, z: 2 });
    const geometry = planned.steps.find((step) => step.op === "set-road-geometry").geometry;
    assert.equal(geometry.knots[1].position.y, 9.5);
    assert.equal(geometry.knots[1].position.x, 2.5);
});
