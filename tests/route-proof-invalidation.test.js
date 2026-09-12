import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { createDefaultScenario, normalizeScenario, validateScenario } from "../app/scenarios/ScenarioDocument.js";
import { isRouteVerificationCurrent, validateRouteVerification, verifyRoute } from "../app/scenarios/route/Route.js";
import { hashWaypoints } from "../app/scenarios/route/waypoints.js";

const polyline = { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] };

function threeLaneDocument() {
    return new EnvironmentDocument({
        environmentId: "proofs",
        roadsAuthored: true,
        roads: {
            geometryVersion: 2,
            nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 60, y: 0, z: 0 }],
            edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 11, laneCount: 3, geometry: polyline, lanes: [
                { id: "lane-0", direction: 1, width: 3.5 },
                { id: "lane-1", direction: 1, width: 3.5 },
                { id: "lane-2", direction: -1, width: 4 },
            ] }],
        },
    });
}

function environmentOf(document) {
    return { environmentId: document.environmentId, roads: document.snapshot().roads };
}

function verifiedOnLane(document, laneId, z) {
    const result = verifyRoute(environmentOf(document), [
        { id: "start", x: 3, z, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "fixed", laneId } },
        { id: "finish", x: 57, z, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "fixed", laneId } },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    return result.route;
}

test("ED-05 removing the anchored lane reports lane-missing instead of re-laning the waypoint", () => {
    const document = threeLaneDocument();
    const service = createEnvironmentCommandService({ document });
    const route = verifiedOnLane(document, "lane-1", 0.25);
    assert.equal(isRouteVerificationCurrent(route, environmentOf(document)), true);

    assert.equal(service.run("removeRoadLane", { edgeId: "ab", laneId: "lane-1" }).ok, true);
    const environment = environmentOf(document);
    assert.equal(isRouteVerificationCurrent(route, environment), false, "the road-network hash moved");
    const stale = validateRouteVerification(route, environment);
    assert.equal(stale.ok, false);
    assert.ok(stale.issues.some((issue) => issue.code === "route.verification.rebuild-failed"), JSON.stringify(stale.issues));
    assert.match(stale.issues.find((issue) => issue.code === "route.verification.rebuild-failed").message, /lane "lane-1"/);

    const rebuilt = verifyRoute(environment, route.waypoints);
    assert.equal(rebuilt.ok, false);
    assert.equal(rebuilt.issues[0].code, "route.waypoint.lane-missing");
    assert.equal(rebuilt.route.waypoints[0].anchor.laneId, "lane-1");
    assert.equal(rebuilt.route.waypoints[0].anchor.laneIndex, 1, "the stale positional index is preserved for the author to inspect");
    // A positional-only anchor would silently land on the lane that moved into index 1.
    assert.equal(document.getEdge("ab").lanes[1].id, "lane-2");
});

test("ED-05 flipping the anchored lane's direction invalidates the proof and forces a legal rebuild", () => {
    const document = threeLaneDocument();
    const service = createEnvironmentCommandService({ document });
    const route = verifiedOnLane(document, "lane-1", 0.25);
    assert.deepEqual(route.verification.edgeTraversal.map((step) => step.direction), [1]);

    assert.equal(service.run("setRoadLane", { edgeId: "ab", laneId: "lane-1", patch: { direction: -1 } }).ok, true);
    const environment = environmentOf(document);
    assert.equal(isRouteVerificationCurrent(route, environment), false);
    assert.equal(validateRouteVerification(route, environment).ok, false);
    const rebuilt = verifyRoute(environment, route.waypoints);
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.issues));
    assert.deepEqual(rebuilt.route.waypoints.map((waypoint) => waypoint.anchor.laneId), ["lane-1", "lane-1"], "the waypoint stays on its lane");
    // lane-1 now only travels b → a, so reaching 0.95 from 0.05 on it means
    // driving back to a, U-turning onto the forward lane, and U-turning again at b.
    assert.deepEqual(rebuilt.verification.edgeTraversal.map((step) => step.direction), [-1, 1, -1]);
    for (const step of rebuilt.verification.edgeTraversal) {
        const legal = step.direction === 1 ? ["lane-0"] : ["lane-1", "lane-2"];
        assert.ok(legal.includes(step.fromLaneId) && legal.includes(step.toLaneId), JSON.stringify(step));
    }
});

test("ED-05 inserting a lane shifts indices but the anchor follows its lane id", () => {
    const document = threeLaneDocument();
    const service = createEnvironmentCommandService({ document });
    const route = verifiedOnLane(document, "lane-1", 0.25);
    assert.equal(route.waypoints[0].anchor.laneIndex, 1);

    assert.equal(service.run("insertRoadLane", { edgeId: "ab", at: { laneId: "lane-0", side: "right" }, lane: { width: 3 } }).ok, true);
    const environment = environmentOf(document);
    assert.equal(document.getEdge("ab").lanes.map((lane) => lane.id).indexOf("lane-1"), 2);
    assert.equal(isRouteVerificationCurrent(route, environment), false, "the road changed, so the proof is stale");

    const rebuilt = verifyRoute(environment, route.waypoints);
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.issues));
    assert.deepEqual(rebuilt.route.waypoints.map((waypoint) => waypoint.anchor.laneId), ["lane-1", "lane-1"], "a positional anchor would now name the lane that moved into index 1");
    assert.deepEqual(rebuilt.route.waypoints.map((waypoint) => waypoint.anchor.laneIndex), [2, 2], "the positional index refreshes on re-verification");
    // The road widened about its centerline (14 m), so lane-1's centre moved
    // from +0.25 m to -1.25 m; the waypoint moved with its lane.
    assert.ok(rebuilt.route.polyline.every((point) => Math.abs(point.z + 1.25) < 1e-6));
    assert.equal(hashWaypoints(rebuilt.route.waypoints), rebuilt.verification.waypointHash);
});

test("ED-05 marking edits are appearance-only and leave proofs current", () => {
    const document = threeLaneDocument();
    const service = createEnvironmentCommandService({ document });
    const route = verifiedOnLane(document, "lane-1", 0.25);
    assert.equal(service.run("setRoadMarking", { edgeId: "ab", boundary: { laneId: "lane-0" }, marking: "dashed_white" }).ok, true);
    assert.equal(service.run("setRoadMarking", { edgeId: "ab", boundary: "left", marking: "solid_yellow" }).ok, true);
    const environment = environmentOf(document);
    assert.equal(isRouteVerificationCurrent(route, environment), true);
    assert.equal(validateRouteVerification(route, environment).ok, true);
});

test("ED-05 scenario documents preserve lane ids on anchors and accept id-only fixed anchors", () => {
    const document = threeLaneDocument();
    const route = verifiedOnLane(document, "lane-0", 3.75);
    const scenario = normalizeScenario({
        ...createDefaultScenario({ id: "lanes", name: "Lanes" }),
        environment: { id: "proofs" },
        routes: [{
            id: "ego-route",
            name: "Ego route",
            actorId: "ego",
            initialSpeedMps: 2,
            controller: { kind: "route-follower", activation: { kind: "start" } },
            waypoints: route.waypoints,
            verification: route.verification,
        }],
        completion: { conditions: [{ id: "duration", name: "Maximum duration", kind: "max-duration", durationNs: 5e9 }] },
        expectedOutcomes: [{ id: "safe", name: "No collisions", kind: "no-collisions" }],
    });
    assert.deepEqual(scenario.routes[0].waypoints.map((waypoint) => [waypoint.anchor.laneMode, waypoint.anchor.laneIndex, waypoint.anchor.laneId]), [["fixed", 0, "lane-0"], ["fixed", 0, "lane-0"]]);
    assert.equal(validateScenario(scenario).ok, true, JSON.stringify(validateScenario(scenario).issues));

    const idOnly = structuredClone(scenario);
    for (const waypoint of idOnly.routes[0].waypoints) delete waypoint.anchor.laneIndex;
    const normalized = normalizeScenario(idOnly, { allowMissingKind: true });
    assert.equal(normalized.routes[0].waypoints[0].anchor.laneId, "lane-0");
    assert.equal("laneIndex" in normalized.routes[0].waypoints[0].anchor, false);
    assert.equal(validateScenario(normalized).issues.some((issue) => /lane index/.test(issue.message)), false, "an id-only fixed anchor is complete");
    const noLane = structuredClone(scenario);
    for (const waypoint of noLane.routes[0].waypoints) { delete waypoint.anchor.laneIndex; delete waypoint.anchor.laneId; }
    assert.ok(validateScenario(normalizeScenario(noLane, { allowMissingKind: true })).issues.some((issue) => /lane index or lane id/.test(issue.message)));
});
