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
    assert.equal(junction.surface.kind, "hull");
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

function bendNetwork({ widthA = 7, widthB = 7, y0 = 0, yNode = 0, yEnd = 0, laneCountA = 2, laneCountB = 2 } = {}) {
    const document = new EnvironmentDocument({ environmentId: "bend", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const west = service.run("createRoad", {
        kind: "polyline",
        points: [{ x: -30, y: y0, z: 0 }, { x: 0, y: yNode, z: 0 }],
        options: { width: widthA, laneCount: laneCountA },
    }).result;
    const north = service.run("createRoad", {
        kind: "polyline",
        points: [{ x: 0, y: yNode, z: 0 }, { x: 0, y: yEnd, z: 30 }],
        startNodeId: west.endNode.id,
        options: { width: widthB, laneCount: laneCountB },
    }).result;
    return { document, west, north };
}

function xzTangent(tangent) {
    const length = Math.hypot(tangent.x, tangent.z);
    return length === 0 ? null : { x: tangent.x / length, z: tangent.z / length };
}

function lineSide(a, b, point) {
    return (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x);
}

function closestCenterline(point, samples) {
    let best = { distance: Infinity, t: 0 };
    for (let index = 0; index < samples.points.length - 1; index += 1) {
        const start = samples.points[index];
        const end = samples.points[index + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const lengthSquared = dx * dx + dz * dz;
        const segmentT = lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
        const x = start.x + dx * segmentT;
        const z = start.z + dz * segmentT;
        const distance = Math.hypot(point.x - x, point.z - z);
        if (distance < best.distance) {
            const along = samples.cumulativeXZ[index] + (samples.cumulativeXZ[index + 1] - samples.cumulativeXZ[index]) * segmentT;
            best = { distance, t: samples.totalLengthXZ <= 1e-12 ? 0 : along / samples.totalLengthXZ };
        }
    }
    return best;
}

test("degree-two bends compile a tangent-matched fillet instead of a straight cross", () => {
    const { document, west, north } = bendNetwork();
    const plan = planRoadNetworkGeometry(document.roads);
    const again = planRoadNetworkGeometry(document.roads);
    assert.equal(plan.junctions.length, 1);
    const junction = plan.junctions[0];
    assert.equal(junction.surface.kind, "fillet");
    assert.ok(junction.surface.vertices.length >= 3);
    assert.ok(junction.surface.vertices.every((point) => point.y === 0));
    for (let index = 0; index < junction.surface.indices.length; index += 3) {
        const [a, b, c] = junction.surface.indices.slice(index, index + 3).map((value) => junction.surface.vertices[value]);
        assert.ok((b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) > 0);
    }
    const centerline = junction.centerline;
    const [start, end] = junction.incidents;
    assert.ok(Math.hypot(centerline.points[0].x - start.mouth.x, centerline.points[0].z - start.mouth.z) < 1e-6);
    assert.ok(Math.hypot(centerline.points.at(-1).x - end.mouth.x, centerline.points.at(-1).z - end.mouth.z) < 1e-6);
    const depart = xzTangent({ x: -start.outwardTangent.x, z: -start.outwardTangent.z });
    const arrive = xzTangent(end.outwardTangent);
    const startTangent = xzTangent(centerline.tangents[0]);
    const endTangent = xzTangent(centerline.tangents.at(-1));
    assert.ok(startTangent.x * depart.x + startTangent.z * depart.z > 0.999);
    assert.ok(endTangent.x * arrive.x + endTangent.z * arrive.z > 0.999);
    const mid = centerline.points[Math.floor((centerline.points.length - 1) / 2)];
    assert.ok(Math.abs(lineSide(centerline.points[0], centerline.points.at(-1), mid)) > 0.5, "centerline leaves the mouth chord");
    const caps = [
        junction.surface.leftBoundary[0],
        junction.surface.leftBoundary.at(-1),
        junction.surface.rightBoundary[0],
        junction.surface.rightBoundary.at(-1),
    ];
    for (const incident of junction.incidents) {
        const entry = plan.edgeById.get(incident.edgeId);
        const atStart = incident.end === "start";
        const corners = atStart
            ? [entry.surface.leftBoundary[0], entry.surface.rightBoundary[0]]
            : [entry.surface.leftBoundary.at(-1), entry.surface.rightBoundary.at(-1)];
        for (const corner of corners) {
            const gap = Math.min(...caps.map((point) => Math.hypot(point.x - corner.x, point.z - corner.z)));
            assert.ok(gap < 1e-6, `fillet misses a road mouth corner by ${gap}`);
        }
    }
    const sampled = sampleIndexedSurfacePoint(mid, junction.surface);
    assert.ok(sampled);
    assert.ok(Number.isFinite(sampled.point.y));

    const rightOf = (tangent) => {
        const flat = xzTangent(tangent);
        return { x: -flat.z, z: flat.x };
    };
    const mouthCorners = (incident, travel) => {
        const normal = rightOf(travel);
        const half = incident.pavedWidth * 0.5;
        return [-half, half].map((offset) => ({
            x: incident.mouth.x + normal.x * offset,
            z: incident.mouth.z + normal.z * offset,
        }));
    };
    const farther = (corners) => corners.sort((left, right) => (
        Math.hypot(right.x - mid.x, right.z - mid.z) - Math.hypot(left.x - mid.x, left.z - mid.z)
    ))[0];
    const outerStart = farther(mouthCorners(start, { x: -start.outwardTangent.x, z: -start.outwardTangent.z }));
    const outerEnd = farther(mouthCorners(end, end.outwardTangent));
    const insideSign = Math.sign(lineSide(outerStart, outerEnd, mid));
    const outerLength = Math.hypot(outerEnd.x - outerStart.x, outerEnd.z - outerStart.z);
    const bulged = [...junction.surface.leftBoundary, ...junction.surface.rightBoundary].some((point) => {
        const side = lineSide(outerStart, outerEnd, point);
        return Math.sign(side) !== 0 && Math.sign(side) !== insideSign && Math.abs(side) / outerLength > 0.02;
    });
    assert.ok(bulged, "outer boundary bulges past the outer mouth chord");

    const connector = buildJunctionConnector(plan, {
        nodeId: junction.node.id,
        fromEdgeId: west.edge.id,
        toEdgeId: north.edge.id,
        fromLaneIndex: 0,
        toLaneIndex: 0,
    });
    assert.ok(connector.points.length >= 2);
    for (const point of connector.points) {
        const nearest = closestCenterline(point, centerline);
        const pavedHalf = (start.pavedWidth + (end.pavedWidth - start.pavedWidth) * nearest.t) * 0.5;
        assert.ok(nearest.distance <= pavedHalf + 1e-4, `connector leaves the fillet pavement by ${nearest.distance - pavedHalf}`);
    }
    assert.equal(JSON.stringify(again.junctions[0].surface), JSON.stringify(junction.surface));
    assert.equal(JSON.stringify(again.junctions[0].centerline), JSON.stringify(centerline));
});

test("degree-two fillets taper between unequal road widths", () => {
    const { document } = bendNetwork({ widthA: 6, widthB: 12 });
    const plan = planRoadNetworkGeometry(document.roads);
    const junction = plan.junctions[0];
    const centerline = junction.centerline;
    const [start, end] = junction.incidents;
    const lateral = (point, other) => Math.hypot(point.x - other.x, point.z - other.z);
    assert.ok(Math.abs(lateral(centerline.points[0], junction.surface.leftBoundary[0]) - start.pavedWidth * 0.5) < 1e-6);
    assert.ok(Math.abs(lateral(centerline.points.at(-1), junction.surface.leftBoundary.at(-1)) - end.pavedWidth * 0.5) < 1e-6);
    const midIndex = centerline.cumulativeXZ.findIndex((distance) => distance >= centerline.totalLengthXZ * 0.5);
    const t = centerline.cumulativeXZ[midIndex] / centerline.totalLengthXZ;
    const expected = (start.pavedWidth + (end.pavedWidth - start.pavedWidth) * t) * 0.5;
    const actual = lateral(centerline.points[midIndex], junction.surface.leftBoundary[midIndex]);
    assert.ok(Math.abs(actual - expected) < 0.05, `mid half-width ${actual} expected ${expected}`);
    assert.ok(actual > Math.min(start.pavedWidth, end.pavedWidth) * 0.5 - 1e-6);
    assert.ok(actual < Math.max(start.pavedWidth, end.pavedWidth) * 0.5 + 1e-6);
});

test("conforming degree-two fillets follow mouth elevation and flat fillets stay at node y", () => {
    const sloped = bendNetwork({ y0: 0, yNode: 4, yEnd: 8 });
    const flatPlan = planRoadNetworkGeometry(sloped.document.roads);
    const flat = flatPlan.junctions[0];
    assert.ok(flat.surface.vertices.every((point) => point.y === flat.node.y));

    sloped.document.getNode(sloped.west.endNode.id).conformToRoads = true;
    const plan = planRoadNetworkGeometry(sloped.document.roads);
    const junction = plan.junctions[0];
    const [start, end] = junction.incidents;
    assert.ok(Math.abs(junction.centerline.points[0].y - start.mouth.y) < 1e-6);
    assert.ok(Math.abs(junction.centerline.points.at(-1).y - end.mouth.y) < 1e-6);
    assert.ok(Math.abs(start.mouth.y - junction.node.y) > 1e-3 || Math.abs(end.mouth.y - junction.node.y) > 1e-3);
    assert.ok(junction.surface.vertices.some((point) => Math.abs(point.y - junction.node.y) > 1e-3));
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
