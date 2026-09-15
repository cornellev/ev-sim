import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
    ROUTE_ALGORITHM_VERSION_V7,
    isRouteVerificationCurrent,
    routeAlgorithmVersionFor,
    validateRouteVerification,
    verifyRoute,
} from "../app/scenarios/route/Route.js";
import { buildDirectedRoadGraph, projectPointToRoadNetwork } from "../app/scenarios/route/roadGraph.js";
import { hashWaypoints } from "../app/scenarios/route/waypoints.js";
import { followPolylineFromRoute } from "../app/scenarios/route/followPath.js";
import { duffyRoutingFixture } from "./helpers/duffyRouting.js";

const polyline = { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] };
const ASYMMETRIC_LANES = [
    { id: "lane-0", direction: 1, width: 3.5 },
    { id: "lane-1", direction: 1, width: 3.5 },
    { id: "lane-2", direction: -1, width: 4 },
];

function straightV2(edge = {}) {
    return {
        environmentId: "v7-straight",
        roads: {
            geometryVersion: 2,
            nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 60, y: 0, z: 0 }],
            edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 11, laneCount: 3, geometry: polyline, lanes: ASYMMETRIC_LANES, ...edge }],
        },
    };
}

/** Straight two-lane v1 network with a legacy v5 proof for byte-identity checks. */
function straightV1() {
    return {
        environmentId: "v5-straight",
        roads: {
            nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 40, y: 0, z: 0 }],
            edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 12, laneCount: 4 }],
        },
    };
}

test("ED-05 geometry-v2 roads dispatch to route algorithm 7 with lane ids on anchors and every proof step", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/environment-editor/curved-elevated-network.v2.json", import.meta.url)));
    const env = { environmentId: fixture.environmentId, roads: fixture.roads };
    assert.equal(routeAlgorithmVersionFor(env), ROUTE_ALGORITHM_VERSION_V7);
    const projection = projectPointToRoadNetwork({ x: 20, y: 0, z: 10 }, env);
    assert.equal(projection.kind, "road");
    assert.equal(projection.laneMode, "fixed");
    assert.equal(projection.laneId, `lane-${projection.laneIndex}`, "v2 projections expose the stable lane id");

    const verified = verifyRoute(env, [
        { id: "start", x: 1, z: 0, anchor: { kind: "road", id: "curve", fraction: 0.05, laneMode: "fixed", laneIndex: 0 } },
        { id: "finish", x: 39, z: 0, anchor: { kind: "road", id: "curve", fraction: 0.95, laneMode: "fixed", laneIndex: 0 } },
    ]);
    assert.equal(verified.ok, true, JSON.stringify(verified.issues));
    assert.equal(verified.verification.algorithmVersion, 7);
    assert.equal(verified.verification.distanceMetric, "xz");
    assert.equal(verified.verification.geometryPolicy.id, "road-geometry-policy-v1");
    assert.deepEqual(verified.route.waypoints.map((waypoint) => waypoint.anchor.laneId), ["lane-0", "lane-0"], "index-only anchors are upgraded to lane ids on verification");
    for (const step of verified.verification.edgeTraversal) {
        assert.equal(step.fromLaneId, `lane-${step.fromLaneIndex}`);
        assert.equal(step.toLaneId, `lane-${step.toLaneIndex}`);
        assert.equal(step.fromSubnode.laneId, step.fromLaneId);
        assert.equal(step.toSubnode.laneId, step.toLaneId);
    }
    assert.equal(validateRouteVerification(verified.route, env).ok, true);
    assert.ok(followPolylineFromRoute(verified.route).every((point) => point.y === 0), "v7 follows the flattened XZ path like v6");

    const laneIdOnly = verifyRoute(env, [
        { id: "start", x: 1, z: 0, anchor: { kind: "road", id: "curve", fraction: 0.05, laneMode: "fixed", laneId: "lane-0" } },
        { id: "finish", x: 39, z: 0, anchor: { kind: "road", id: "curve", fraction: 0.95, laneMode: "fixed", laneId: "lane-0" } },
    ]);
    assert.equal(laneIdOnly.ok, true, JSON.stringify(laneIdOnly.issues));
    assert.equal(laneIdOnly.verification.waypointHash, verified.verification.waypointHash, "lane id and index anchors share one identity");
    assert.equal(laneIdOnly.verification.environmentHash, verified.verification.environmentHash);

    const stripped = structuredClone(verified.route);
    delete stripped.verification.sections[0].edgeTraversal[0].fromLaneId;
    const structural = validateRouteVerification(stripped);
    assert.equal(structural.ok, false);
    assert.ok(structural.issues.some((issue) => issue.code === "route.verification.lane-traversal-invalid"));
});

test("ED-05 canonical mouth precision does not reject Duffy's legal straight-through connector", () => {
    const environment = duffyRoutingFixture();
    const graph = buildDirectedRoadGraph(environment);
    assert.equal(graph.infeasibleMovements.size, 0);

    const result = verifyRoute(environment, environment.waypoints);

    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(result.verification.edgeTraversal.map((step) => [step.edgeId, step.direction, step.fromLaneId, step.toLaneId]), [
        ["junction-west", -1, "lane-1", "lane-1"],
        ["east-junction", -1, "lane-1", "lane-1"],
    ]);
});

test("ED-05 v6 proofs are stale against geometry-v2 environments while v5 proofs on v1 roads are untouched", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/environment-editor/curved-elevated-network.v2.json", import.meta.url)));
    const env = { environmentId: fixture.environmentId, roads: fixture.roads };
    const v7 = verifyRoute(env, [
        { id: "start", x: 0, z: 0, anchor: { kind: "road", id: "curve", fraction: 0, laneMode: "auto" } },
        { id: "finish", x: 40, z: 0, anchor: { kind: "road", id: "curve", fraction: 1, laneMode: "auto" } },
    ]);
    assert.equal(v7.ok, true);
    const v6 = structuredClone(v7.route);
    v6.verification.algorithmVersion = 6;
    for (const step of v6.verification.edgeTraversal) { delete step.fromLaneId; delete step.toLaneId; }
    assert.equal(isRouteVerificationCurrent(v6, env), false);
    const validation = validateRouteVerification(v6, env);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues[0].code, "route.verification.algorithm-invalid");
    assert.match(validation.issues[0].message, /version 7/);

    const legacy = straightV1();
    assert.equal(routeAlgorithmVersionFor(legacy), 5);
    const v5 = verifyRoute(legacy, [
        { id: "start", x: 2, z: 4.5, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "fixed", laneIndex: 0 } },
        { id: "finish", x: 38, z: 4.5, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "fixed", laneIndex: 0 } },
    ]);
    assert.equal(v5.ok, true, JSON.stringify(v5.issues));
    assert.equal(v5.verification.algorithmVersion, 5);
    assert.equal("laneId" in v5.route.waypoints[0].anchor, false, "v5 anchors never gain lane ids");
    assert.ok(v5.verification.edgeTraversal.every((step) => !("fromLaneId" in step) && !("laneId" in step.fromSubnode)));
    assert.equal(hashWaypoints(v5.route.waypoints), v5.verification.waypointHash);
    assert.equal(isRouteVerificationCurrent(v5.route, legacy), true);
});

test("ED-05 asymmetric lanes route legally in both directions with unequal-width lateral costs", () => {
    const environment = straightV2();
    const graph = buildDirectedRoadGraph(environment);
    assert.equal(graph.infeasibleMovements.size, 0);
    assert.deepEqual(graph.adjacency.get("a").map((step) => step.direction), [1]);
    assert.deepEqual(graph.adjacency.get("b").map((step) => step.direction), [-1]);

    const laneChange = verifyRoute(environment, [
        { id: "start", x: 3, z: 3.75, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "fixed", laneId: "lane-0" } },
        { id: "finish", x: 57, z: 0.25, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "fixed", laneId: "lane-1" } },
    ]);
    assert.equal(laneChange.ok, true, JSON.stringify(laneChange.issues));
    assert.deepEqual(laneChange.verification.edgeTraversal.map((step) => [step.direction, step.fromLaneId, step.toLaneId]), [[1, "lane-0", "lane-1"]]);
    assert.ok(Math.abs(laneChange.route.polyline[0].z - 3.75) < 1e-6);
    assert.ok(Math.abs(laneChange.route.polyline.at(-1).z - 0.25) < 1e-6);

    const reverse = verifyRoute(environment, [
        { id: "start", x: 57, z: -3.5, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "auto" } },
        { id: "finish", x: 3, z: -3.5, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "auto" } },
    ]);
    assert.equal(reverse.ok, true, JSON.stringify(reverse.issues));
    assert.deepEqual(reverse.verification.edgeTraversal.map((step) => [step.direction, step.fromLaneId]), [[-1, "lane-2"]]);
});

test("ED-05 v7 rejects fixed anchors on lanes that cannot travel the required direction", () => {
    const environment = straightV2({ laneCount: 2, lanes: [{ id: "only", direction: 1, width: 5 }, { id: "back", direction: -1, width: 6 }] });
    // "only" travels a → b, so a route b → a fixed on it needs an endpoint U-turn
    // on each side; with fixed anchors at both ends the itinerary still exists.
    const uTurn = verifyRoute(environment, [
        { id: "start", x: 57, z: 3, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "fixed", laneId: "only" } },
        { id: "finish", x: 3, z: 3, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "fixed", laneId: "only" } },
    ]);
    assert.equal(uTurn.ok, true, JSON.stringify(uTurn.issues));
    assert.deepEqual(uTurn.verification.edgeTraversal.map((step) => step.toLaneId), ["only", "back", "only"]);

    const unknown = verifyRoute(environment, [
        { id: "start", x: 3, z: 3, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "fixed", laneId: "ghost" } },
        { id: "finish", x: 57, z: 3, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "fixed", laneId: "only" } },
    ]);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.issues[0].code, "route.waypoint.lane-missing");
    assert.equal(unknown.route.waypoints[0].anchor.laneId, "ghost", "the anchor is reported, never re-laned");
});
