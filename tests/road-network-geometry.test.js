import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { buildJunctionConnector, planRoadNetworkGeometry, sampleIndexedSurfacePoint } from "../app/roads/RoadNetworkGeometry.js";
import { validateRoadDomain } from "../app/roads/RoadGeometryRecord.js";
import { hashEnvironmentRoadNetwork } from "../app/scenarios/route/roadGraph.js";

function pointInConvex(point, polygon) {
    let sign = 0;
    for (let index = 0; index < polygon.length; index += 1) {
        const a = polygon[index]; const b = polygon[(index + 1) % polygon.length];
        const cross = (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x);
        if (Math.abs(cross) < 1e-8) continue;
        if (sign && Math.sign(cross) !== sign) return false;
        sign = Math.sign(cross);
    }
    return true;
}

function tNetwork() {
    const document = new EnvironmentDocument({ environmentId: "t", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const west = service.run("createRoad", { points: [{ x: -20, y: 1, z: 0 }, { x: 0, y: 2, z: 0 }] }).result;
    const east = service.run("createRoad", { points: [{ x: 0, y: 2, z: 0 }, { x: 20, y: 3, z: 0 }], startNodeId: west.endNode.id }).result;
    const south = service.run("createRoad", { points: [{ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: -20 }], startNodeId: west.endNode.id }).result;
    return { document, west, east, south };
}

test("ED-04 compiles deterministic upward road/junction surfaces and contained connectors", () => {
    const { document, west, east } = tNetwork();
    const plan = planRoadNetworkGeometry(document.roads);
    assert.equal(plan.junctions.length, 1);
    const junction = plan.junctions[0];
    for (let index = 0; index < junction.surface.indices.length; index += 3) {
        const [a, b, c] = junction.surface.indices.slice(index, index + 3).map((value) => junction.surface.vertices[value]);
        assert.ok((b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) > 0);
    }
    assert.ok(junction.surface.vertices.every((point) => point.y === 2));
    const connector = buildJunctionConnector(plan, { nodeId: junction.node.id, fromEdgeId: west.edge.id, toEdgeId: east.edge.id });
    assert.ok(connector.points.every((point) => pointInConvex(point, junction.surface.vertices)));
});

test("conforming junctions keep mouth Y from attached roads and stay flush with trimmed ends", () => {
    const { document, west, east } = tNetwork();
    const junctionId = document.roads.edges.find((edge) => edge.id === west.edge.id).endNodeId;
    const flat = planRoadNetworkGeometry(document.roads);
    assert.ok(flat.junctions[0].surface.vertices.every((point) => point.y === 2));
    const omittedHash = hashEnvironmentRoadNetwork(document);

    document.getNode(junctionId).conformToRoads = false;
    assert.equal(hashEnvironmentRoadNetwork(document), omittedHash, "explicit false does not change the road-network hash");

    document.getNode(junctionId).conformToRoads = true;
    const plan = planRoadNetworkGeometry(document.roads);
    const junction = plan.junctions[0];
    assert.equal(hashEnvironmentRoadNetwork(document) === omittedHash, false, "conformToRoads true is metric");
    assert.ok(junction.surface.vertices.some((point) => Math.abs(point.y - 2) > 1e-6), "mouths that slope off the node lift the hull");

    for (const incident of junction.incidents) {
        const entry = plan.edgeById.get(incident.edgeId);
        const roadEnd = incident.end === "start" ? entry.trimmedSamples.points[0] : entry.trimmedSamples.points.at(-1);
        assert.ok(Math.abs(roadEnd.y - incident.mouth.y) < 1e-6, `${incident.edgeId} trimmed end matches mouth Y`);
        const nearest = junction.surface.vertices.reduce((best, vertex) => {
            const distance = Math.hypot(vertex.x - incident.mouth.x, vertex.z - incident.mouth.z);
            return distance < best.distance ? { distance, vertex } : best;
        }, { distance: Infinity, vertex: null });
        assert.ok(nearest.distance < 4, `${incident.edgeId} mouth is on the hull`);
        assert.ok(Math.abs(nearest.vertex.y - incident.mouth.y) < 1e-6, `${incident.edgeId} hull Y matches mouth`);
    }

    const connector = buildJunctionConnector(plan, { nodeId: junction.node.id, fromEdgeId: west.edge.id, toEdgeId: east.edge.id });
    assert.ok(connector.points.every((point) => pointInConvex(point, junction.surface.vertices)));
    const sampled = sampleIndexedSurfacePoint(junction.node, junction.surface);
    assert.ok(sampled);
    assert.ok(Number.isFinite(sampled.point.y));
});

test("non-boolean conformToRoads is a domain error", () => {
    const { document, west } = tNetwork();
    const junctionId = document.roads.edges.find((edge) => edge.id === west.edge.id).endNodeId;
    document.getNode(junctionId).conformToRoads = "yes";
    const result = validateRoadDomain(document.roads);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "road.node.conform-invalid"));
});

test("ED-04 direct degree-two joins omit a patch and cache untouched samples and surfaces", () => {
    const { document } = tNetwork();
    document.roads.edges.pop();
    const cache = new Map();
    const first = planRoadNetworkGeometry(document.roads, { cache });
    const second = planRoadNetworkGeometry(document.roads, { cache });
    assert.equal(first.junctions.length, 0);
    assert.equal(second.edges[0].samples, first.edges[0].samples);
    assert.equal(second.edges[0].surface, first.edges[0].surface);
});

test("ED-04 reports same-elevation crossings away from shared junctions", () => {
    const document = new EnvironmentDocument({ environmentId: "x", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    service.run("createRoad", { points: [{ x: -10, z: 0 }, { x: 10, z: 0 }] });
    service.run("createRoad", { points: [{ x: 0, z: -10 }, { x: 0, z: 10 }] });
    const plan = planRoadNetworkGeometry(document.roads);
    assert.equal(plan.conflicts[0].code, "road.geometry.overlap");
    assert.throws(() => planRoadNetworkGeometry(document.roads, { strict: true }), /overlap outside a junction/);
});
