import assert from "node:assert/strict";
import test from "node:test";

import { buildDirectedRoadGraph, offsetEdgeSample, projectPointToRoadNetwork } from "../app/scenarios/route/roadGraph.js";
import { buildWaypointLaneIndex, snapWaypointToNearestLane } from "../app/scenarios/ui/waypointPlacement.js";

function straightRoads() {
    return {
        roads: {
            nodes: [{ id: "a", x: 0, y: 2, z: 0 }, { id: "b", x: 40, y: 10, z: 0 }],
            edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", width: 8, laneCount: 2, bidirectional: true }],
        },
    };
}

test("waypoint drops outside the road snap to the nearest physical lane, retaining elevation", () => {
    const graph = buildDirectedRoadGraph(straightRoads());
    const index = buildWaypointLaneIndex(graph);
    const drop = { x: 12, z: -20 };
    assert.equal(projectPointToRoadNetwork(drop, null, { graph }), null, "click placement still rejects off-road points");
    const snapped = snapWaypointToNearestLane(drop, index);
    assert.deepEqual(snapped.position, { x: 12, y: 4.4, z: -2 });
    assert.deepEqual(snapped.anchor, { kind: "road", id: "ab", fraction: 0.3, laneMode: "fixed", laneIndex: 1 });
    assert.deepEqual(snapWaypointToNearestLane({ x: 100, z: 20 }, index).position, { x: 40, y: 10, z: 2 });
    assert.deepEqual(snapWaypointToNearestLane({ x: -50, z: -20 }, index).position, { x: 0, y: 2, z: -2 });
});

test("nearest-lane drops use curved lane segments and the routing anchor's centerline fraction", () => {
    const environment = straightRoads();
    environment.roads.geometryVersion = 2;
    environment.roads.edges[0].geometry = {
        version: 1, kind: "cubic-bezier",
        knots: [{ id: "start", mode: "auto" }, { id: "bend", mode: "auto", position: { x: 20, y: 6, z: 15 } }, { id: "end", mode: "auto" }],
    };
    const graph = buildDirectedRoadGraph(environment);
    const index = buildWaypointLaneIndex(graph);
    const segment = index.segments.find((entry) => entry.laneIndex === 0 && entry.fromT > 0.25);
    const t = 0.37;
    const onLane = {
        x: segment.from.x + (segment.to.x - segment.from.x) * t,
        z: segment.from.z + (segment.to.z - segment.from.z) * t,
    };
    const dx = segment.to.x - segment.from.x;
    const dz = segment.to.z - segment.from.z;
    const length = Math.hypot(dx, dz);
    const drop = { x: onLane.x - dz / length * 0.2, z: onLane.z + dx / length * 0.2 };
    const snapped = snapWaypointToNearestLane(drop, index);
    assert.equal(snapped.anchor.laneId, "lane-0");
    assert.ok(Math.hypot(snapped.position.x - onLane.x, snapped.position.z - onLane.z) < 1e-9);
    const rebuilt = offsetEdgeSample(graph.edges.get("ab"), snapped.anchor.fraction, snapped.anchor.laneIndex, graph);
    assert.ok(Math.hypot(rebuilt.x - snapped.position.x, rebuilt.y - snapped.position.y, rebuilt.z - snapped.position.z) < 1e-9);
});

test("junction drops choose a lane mouth and exact ties are independent of road insertion order", () => {
    const environment = straightRoads();
    environment.roads.geometryVersion = 2;
    environment.roads.nodes.push({ id: "c", x: 40, y: 10, z: 40 });
    environment.roads.edges.push({ id: "bc", startNodeId: "b", endNodeId: "c", width: 8, laneCount: 2, bidirectional: true });
    for (const edge of environment.roads.edges) {
        edge.geometry = { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] };
    }
    const graph = buildDirectedRoadGraph(environment);
    const snapped = snapWaypointToNearestLane({ x: 40, z: 0 }, buildWaypointLaneIndex(graph));
    assert.equal(snapped.anchor.kind, "road");
    assert.equal(snapped.anchor.laneMode, "fixed");
    const compiled = graph.edges.get(snapped.anchor.id).compiled;
    assert.ok(snapped.anchor.fraction >= compiled.startMouthFraction);
    assert.ok(snapped.anchor.fraction <= compiled.endMouthFraction);
    assert.ok(Math.hypot(snapped.position.x - 40, snapped.position.z) > 0);
    environment.roads.edges.reverse();
    assert.deepEqual(snapWaypointToNearestLane({ x: 40, z: 0 }, buildWaypointLaneIndex(buildDirectedRoadGraph(environment))), snapped);
});

test("nearest-lane drops reject invalid positions and an empty network", () => {
    const index = buildWaypointLaneIndex(buildDirectedRoadGraph(straightRoads()));
    assert.equal(snapWaypointToNearestLane({ x: NaN, z: 0 }, index), null);
    assert.equal(snapWaypointToNearestLane(null, index), null);
    assert.equal(snapWaypointToNearestLane({ x: 1, z: 1 }, buildWaypointLaneIndex(buildDirectedRoadGraph(null))), null);
});
