import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { followPolylineFromRoute } from "../app/scenarios/route/followPath.js";
import { routeFollowerCommand } from "../app/scenarios/route/routeFollower.js";
import { isRouteVerificationCurrent, routeAlgorithmVersionFor, validateRouteVerification, verifyRoute } from "../app/scenarios/route/Route.js";
import { arePointsOnRoadNetwork, buildDirectedRoadGraph } from "../app/scenarios/route/roadGraph.js";

async function environment() {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/environment-editor/curved-elevated-network.v2.json", import.meta.url)));
    return { environmentId: fixture.environmentId, roads: fixture.roads };
}

test("ED-04/ED-05 v2 roads dispatch to route v7 with XZ arc distance and elevated persisted geometry", async () => {
    const env = await environment();
    assert.equal(routeAlgorithmVersionFor(env), 7);
    const route = { waypoints: [
        { id: "start", x: 0, y: 0, z: 0, anchor: { kind: "road", id: "curve", fraction: 0, laneMode: "auto" } },
        { id: "finish", x: 40, y: 8, z: 0, anchor: { kind: "road", id: "curve", fraction: 1, laneMode: "auto" } },
    ] };
    const verified = verifyRoute(env, route);
    assert.equal(verified.ok, true);
    assert.equal(verified.verification.algorithmVersion, 7);
    assert.equal(verified.verification.distanceMetric, "xz");
    assert.equal(verified.verification.geometryPolicy.id, "road-geometry-policy-v1");
    assert.ok(verified.route.polyline.some((point) => point.y > 0));
    const follow = followPolylineFromRoute(verified.route);
    assert.ok(follow.some((point) => point.y > 0));
    const flattened = follow.map((point) => ({ ...point, y: 0 }));
    const pose = { x: follow[0].x, y: 0, z: follow[0].z };
    const command = routeFollowerCommand({ position: pose, yaw: 0, cruiseSpeedMps: 4, followPolyline: follow });
    const flattenedCommand = routeFollowerCommand({ position: pose, yaw: 0, cruiseSpeedMps: 4, followPolyline: flattened });
    assert.ok(Math.abs(command.speedMps - flattenedCommand.speedMps) <= 1e-12);
    assert.ok(Math.abs(command.steeringRad - flattenedCommand.steeringRad) <= 1e-12);
    assert.equal(validateRouteVerification(verified.route, env).ok, true);
    const stalePolicy = structuredClone(verified.route);
    stalePolicy.verification.geometryPolicy.version = 2;
    assert.equal(validateRouteVerification(stalePolicy, env).ok, false);
});

test("ED-04 missing explicit anchors fail without nearest-road replacement and v5 proofs are stale", async () => {
    const env = await environment();
    const result = verifyRoute(env, { waypoints: [
        { id: "a", x: 1, z: 0, anchor: { kind: "road", id: "deleted", fraction: 0.2 } },
        { id: "b", x: 30, z: 0, anchor: { kind: "road", id: "curve", fraction: 0.8 } },
    ] });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, "route.waypoint.anchor-missing");
    assert.equal(result.route.waypoints[0].anchor.id, "deleted");
    assert.equal(isRouteVerificationCurrent({ ...result.route, verification: { algorithm: "directed-a-star", algorithmVersion: 5 } }, env), false);
    const invalid = verifyRoute(env, { waypoints: [
        { id: "a", x: 1, z: 0, anchor: { kind: "road", id: "curve", fraction: -0.1 } },
        { id: "b", x: 30, z: 0, anchor: { kind: "road", id: "curve", fraction: 0.8 } },
    ] });
    assert.equal(invalid.issues[0].code, "route.waypoint.anchor-invalid");
});

test("ED-04 routing and off-road checks use the compiled paved union including shoulders", async () => {
    const env = await environment();
    const graph = buildDirectedRoadGraph(env);
    assert.equal(graph.geometryVersion, 2);
    assert.equal(graph.edges.get("curve").length, graph.compiledPlan.edgeById.get("curve").samples.totalLengthXZ);
    assert.equal(arePointsOnRoadNetwork([{ x: 20, y: 4, z: 12 }], env), true);
    assert.equal(arePointsOnRoadNetwork([{ x: 20, y: 4, z: 30 }], env), false);
});
