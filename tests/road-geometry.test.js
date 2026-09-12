import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { buildRoadSurface, evaluate, sampleCenterline, splitEdge } from "../app/roads/RoadGeometry.js";
import { ROAD_GEOMETRY_POLICY_V1 } from "../app/roads/RoadGeometryPolicy.js";
import { resolveRoadEdge, validateRoadDomain } from "../app/roads/RoadGeometryRecord.js";

function curved() {
    const roads = {
        geometryVersion: 2,
        nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 30, y: 6, z: 0 }],
        edges: [{ id: "e", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2, geometry: { version: 1, kind: "cubic-bezier", knots: [{ id: "start", mode: "auto" }, { id: "k1", position: { x: 15, y: 3, z: 10 }, mode: "auto" }, { id: "end", mode: "auto" }] } }],
    };
    return { roads, edge: resolveRoadEdge(roads.edges[0], new Map(roads.nodes.map((node) => [node.id, node]))) };
}

test("ED-04 resolves automatic handles, evaluates spans, and samples deterministically", () => {
    const { edge } = curved();
    assert.deepEqual(evaluate(edge, { span: 0, u: 0 }).point, { x: 0, y: 0, z: 0 });
    assert.ok(edge.geometry.knots[1].handleIn.x < 0);
    assert.ok(edge.geometry.knots[1].handleOut.x > 0);
    const first = sampleCenterline(edge);
    const second = sampleCenterline(edge);
    assert.deepEqual(second, first);
    assert.ok(first.points.length > 3);
    assert.ok(first.cumulativeXZ.every((value, index, values) => index === 0 || value >= values[index - 1]));
});

test("ED-04 de Casteljau insertion and split preserve the cubic exactly", () => {
    const { edge } = curved();
    const split = splitEdge(edge, { span: 0, u: 0.4 });
    const nodes = new Map([["a", edge.geometry.knots[0].position], ["m", split.point], ["b", edge.geometry.knots.at(-1).position]]);
    const left = resolveRoadEdge({ ...edge, endNodeId: "m", geometry: split.leftGeometry }, nodes);
    const right = resolveRoadEdge({ ...edge, startNodeId: "m", geometry: split.rightGeometry }, nodes);
    for (const u of [0, 0.2, 0.7, 1]) {
        const originalU = u <= 0.4 ? u : u;
        const actual = u <= 0.4 ? evaluate(left, { span: 0, u: u / 0.4 }).point : evaluate(right, { span: 0, u: (u - 0.4) / 0.6 }).point;
        const expected = evaluate(edge, { span: 0, u: originalU }).point;
        assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z) < 1e-8);
    }
});

test("ED-04 conversion is explicit and malformed records or sampling exhaustion fail", () => {
    const document = new EnvironmentDocument({ environmentId: "x", roads: { nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 10, y: 0, z: 0 }], edges: [{ id: "e", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2 }] } });
    const service = createEnvironmentCommandService({ document });
    assert.equal(service.run("convertRoadGeometry", { edgeId: "e", kind: "cubic-bezier" }).ok, true);
    assert.equal(document.roads.geometryVersion, 2);
    assert.equal(document.getEdge("e").geometry.kind, "cubic-bezier");
    const invalid = structuredClone(document.roads);
    invalid.edges[0].geometry.knots[0] = { id: "start", mode: "free" };
    assert.equal(validateRoadDomain(invalid).ok, false);
    assert.equal(validateRoadDomain({ ...document.roads, geometryVersion: "2" }).ok, false);
    const unversioned = structuredClone(document.roads);
    delete unversioned.geometryVersion;
    assert.equal(validateRoadDomain(unversioned).issues.some((issue) => issue.code === "road.geometry.version-missing"), true);
    const resolved = resolveRoadEdge(document.getEdge("e"), document.index().nodes);
    assert.throws(() => sampleCenterline(resolved, { ...ROAD_GEOMETRY_POLICY_V1, maxSamplesPerEdge: 4 }), /exceeds 4 samples/);
});

test("ED-04 polyline offsets bevel turns beyond the frozen miter limit", () => {
    const roads = {
        geometryVersion: 2,
        nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 0.1, y: 0, z: 1 }],
        edges: [{
            id: "turn",
            startNodeId: "a",
            endNodeId: "b",
            width: 8,
            laneCount: 2,
            geometry: {
                version: 1,
                kind: "polyline",
                knots: [
                    { id: "start" },
                    { id: "corner", position: { x: 10, y: 0, z: 0 } },
                    { id: "end" },
                ],
            },
        }],
    };
    const edge = resolveRoadEdge(roads.edges[0], new Map(roads.nodes.map((node) => [node.id, node])));
    const samples = sampleCenterline(edge);
    const surface = buildRoadSurface(edge, { samples });
    assert.ok(surface.leftBoundary.length > samples.points.length);
    assert.equal(surface.leftBoundary.length, surface.rightBoundary.length);
});
