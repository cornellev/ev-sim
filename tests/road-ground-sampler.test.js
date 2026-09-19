import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { buildDirectedRoadGraph, projectPointToRoadNetwork } from "../app/scenarios/route/roadGraph.js";
import {
    createRoadGroundSampler,
    sampleRoadGround,
} from "../app/simulation/vehicles/roadGroundSampler.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";

function v1Ramp(endY = 5) {
    return {
        environmentId: "v1-ramp",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 10, y: endY, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "ab",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
                width: 8,
                laneCount: 2,
            }],
        },
    };
}

function v1Flat() {
    return {
        environmentId: "v1-flat",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0 },
                { id: "b", x: 10, y: 0, z: 0 },
            ],
            edges: [{
                id: "ab",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
                width: 8,
                laneCount: 2,
            }],
        },
    };
}

test("v1 ramp samples interpolated y and heading-aligned pitch", () => {
    const env = v1Ramp(5);
    const graph = buildDirectedRoadGraph(env);
    const mid = sampleRoadGround({ x: 5, z: 0 }, graph, 0);
    assert.equal(mid.kind, "road");
    assert.ok(Math.abs(mid.y - 2.5) <= 1e-9, `expected y 2.5, got ${mid.y}`);
    const expectedPitch = Math.atan2(5, 10);
    assert.ok(Math.abs(mid.pitch - expectedPitch) <= 1e-9);
    const downhill = sampleRoadGround({ x: 5, z: 0 }, graph, Math.PI);
    assert.ok(Math.abs(downhill.pitch + expectedPitch) <= 1e-9);
});

test("flat paved edge reports y 0 and pitch 0", () => {
    const graph = buildDirectedRoadGraph(v1Flat());
    const hit = sampleRoadGround({ x: 4, z: 0 }, graph, 0);
    assert.deepEqual({ y: hit.y, pitch: hit.pitch, kind: hit.kind }, { y: 0, pitch: 0, kind: "road" });
});

test("off-paved XZ returns null", () => {
    const graph = buildDirectedRoadGraph(v1Ramp());
    assert.equal(sampleRoadGround({ x: 5, z: 30 }, graph, 0), null);
});

test("v2 elevated curve samples centerline y at endpoints and the interior knot", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/environment-editor/curved-elevated-network.v2.json", import.meta.url)));
    const env = { environmentId: fixture.environmentId, roads: fixture.roads };
    const sampler = createRoadGroundSampler(env);
    const start = sampler.sample(0, 0, 0);
    const finish = sampler.sample(40, 0, 0);
    const knot = sampler.sample(20, 12, 0);
    assert.ok(start, "start is on the paved union");
    assert.ok(finish, "finish is on the paved union");
    assert.ok(knot, "interior knot is on the paved union");
    assert.ok(Math.abs(start.y - 0) <= 1e-6, `start y ${start.y}`);
    assert.ok(Math.abs(finish.y - 8) <= 1e-6, `finish y ${finish.y}`);
    const projected = projectPointToRoadNetwork({ x: 20, z: 12 }, env);
    assert.ok(Math.abs(knot.y - projected.y) <= 1e-9);
    assert.ok(knot.y > 0);
    assert.ok(start.pitch > 0, "climbing +X has positive pitch");
});

test("createRoadGroundSampler rebuilds only when the road-network hash changes", () => {
    const env = v1Ramp(5);
    const sampler = createRoadGroundSampler({ getEnvironment: () => env });
    const first = sampler.sample(5, 0, 0);
    const second = sampler.sample(6, 0, 0);
    assert.equal(sampler.graphBuilds, 1);
    assert.ok(Math.abs(first.y - 2.5) <= 1e-9);
    assert.ok(Math.abs(second.y - 3) <= 1e-9);
    env.roads.nodes[1].y = 8;
    const raised = sampler.sample(5, 0, 0);
    assert.equal(sampler.graphBuilds, 2);
    assert.ok(Math.abs(raised.y - 4) <= 1e-9);
});

test("conforming junction samples interpolate mouth elevation instead of node y", () => {
    const document = new EnvironmentDocument({ environmentId: "t-ground", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const west = service.run("createRoad", { points: [{ x: -20, y: 1, z: 0 }, { x: 0, y: 2, z: 0 }] }).result;
    service.run("createRoad", { points: [{ x: 0, y: 2, z: 0 }, { x: 20, y: 3, z: 0 }], startNodeId: west.endNode.id });
    service.run("createRoad", { points: [{ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: -20 }], startNodeId: west.endNode.id });
    const junctionId = west.endNode.id;

    const flat = sampleRoadGround({ x: 0, z: 0 }, buildDirectedRoadGraph(document), 0);
    assert.equal(flat.kind, "intersection");
    assert.ok(Math.abs(flat.y - 2) <= 1e-6);
    assert.ok(Math.abs(flat.pitch) <= 1e-9);

    document.getNode(junctionId).conformToRoads = true;
    const graph = buildDirectedRoadGraph(document);
    const westIncident = graph.compiledPlan.junctionByNode.get(junctionId).incidents
        .find((incident) => incident.edgeId === west.edge.id);
    const probe = {
        x: westIncident.mouth.x * 0.75,
        z: westIncident.mouth.z,
    };
    const hit = sampleRoadGround(probe, graph, 0);
    assert.equal(hit.kind, "intersection", JSON.stringify({ probe, hit, mouth: westIncident.mouth }));
    assert.ok(Math.abs(hit.y - 2) > 0.05, `expected warped y, got ${hit.y}`);
    assert.ok(Math.abs(hit.y - westIncident.mouth.y) < Math.abs(hit.y - 2));
});
