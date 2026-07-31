import assert from "node:assert/strict";
import test from "node:test";
import {
    deterministicDirectedAStar,
    hashEnvironmentRoadNetwork,
    isRouteVerificationCurrent,
    normalizeWaypoints,
    projectPointToRoadNetwork,
    removeWaypoint,
    reorderWaypoint,
    routeProgress,
    routeSectionCount,
    sampleRoute,
    sampleRouteSection,
    normalizeRoute,
    verifyRoute,
} from "../app/scenarios/route/index.js";
import {
    FollowRouteBlock,
    FollowRouteSectionBlock,
    RouteSectionCountBlock,
} from "../app/scripting/units/mission/RouteBlocks.block.js";

function roadEnvironment() {
    return {
        environmentId: "route-test",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 10, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: 0, kind: "endpoint" },
                { id: "d", x: 10, z: 10, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: false, width: 4 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: false, width: 4 },
                { id: "bd", startNodeId: "b", endNodeId: "d", bidirectional: true, width: 4 },
            ],
        },
    };
}

test("road projection rejects non-road territory and recognizes intersection footprints", () => {
    const environment = roadEnvironment();
    const road = projectPointToRoadNetwork({ x: 2, z: 1 }, environment);
    assert.equal(road.kind, "road");
    assert.equal(road.edgeId, "ab");
    assert.equal(road.point.x, 2);
    assert.equal(road.point.z, 0);
    assert.equal(projectPointToRoadNetwork(environment, { x: 2, z: 1 }).edgeId, "ab");

    const intersection = projectPointToRoadNetwork({ x: 10, z: 2 }, environment);
    assert.equal(intersection.kind, "intersection");
    assert.equal(intersection.nodeId, "b");

    assert.equal(projectPointToRoadNetwork({ x: 2, z: 3 }, environment), null);
});

test("deterministic A* respects one-way edges and stable edge ordering", () => {
    const environment = roadEnvironment();
    const outbound = deterministicDirectedAStar(environment, "a", "c");
    assert.equal(outbound.ok, true);
    assert.deepEqual(outbound.nodeIds, ["a", "b", "c"]);
    assert.deepEqual(outbound.edgeIds, ["ab", "bc"]);

    const reverse = deterministicDirectedAStar(environment, "c", "a");
    assert.equal(reverse.ok, false);
});

test("waypoint helpers preserve endpoint roles and renumber after reorder/removal", () => {
    const waypoints = normalizeWaypoints([
        { id: "start", x: 1, z: 0 },
        { id: "first", x: 7, z: 0 },
        { id: "second", x: 13, z: 0 },
        { id: "finish", x: 19, z: 0 },
    ]);
    assert.deepEqual(waypoints.map((waypoint) => waypoint.kind), ["start", "intermediate", "intermediate", "finish"]);

    const reordered = reorderWaypoint(waypoints, "second", 1);
    assert.deepEqual(reordered.map((waypoint) => waypoint.id), ["start", "second", "first", "finish"]);
    assert.deepEqual(reordered.map((waypoint) => waypoint.number), [0, 1, 2, 3]);

    const removed = removeWaypoint(reordered, "second");
    assert.deepEqual(removed.map((waypoint) => waypoint.id), ["start", "first", "finish"]);
    assert.deepEqual(removed.map((waypoint) => waypoint.number), [0, 1, 2]);
    assert.deepEqual(removeWaypoint(removed, "start"), removed);
    assert.equal(normalizeRoute(removed).schema, "cev-sim.route");
});

test("route verification builds deterministic sections, traversal, hashes, and arc geometry", () => {
    const environment = roadEnvironment();
    const result = verifyRoute(environment, {
        id: "ego-route",
        waypoints: [
            { id: "start", x: 1, z: 0 },
            { id: "middle", x: 10, z: 1 },
            { id: "finish", x: 19, z: 0 },
        ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.route.verified, true);
    assert.equal(result.route.sections.length, 2);
    assert.deepEqual(result.route.sections.map((section) => section.edgeIds), [["ab"], ["bc"]]);
    assert.equal(result.route.totalLength, 18);
    assert.equal(result.route.environmentHash, hashEnvironmentRoadNetwork(environment));
    assert.equal(isRouteVerificationCurrent(result.route, environment), true);

    const again = verifyRoute({ document: environment }, result.route.waypoints);
    assert.equal(again.ok, true);
    assert.equal(again.route.environmentHash, result.route.environmentHash);
    assert.equal(again.route.waypointHash, result.route.waypointHash);
    assert.equal(isRouteVerificationCurrent(again.route, environment), true);
    const serialized = structuredClone(again.route);
    serialized.waypoints.forEach((waypoint) => delete waypoint.authoredPosition);
    assert.equal(isRouteVerificationCurrent(serialized, environment), true);

    const invalid = verifyRoute(environment, [
        { id: "start", x: 1, z: 0 },
        { id: "finish", x: 2, z: 4 },
    ]);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.issues[0].code, "route.waypoint.off-road");

    const malformed = verifyRoute(environment, [{ id: "missing" }, { id: "finish", x: 19, z: 0 }]);
    assert.equal(malformed.ok, false);
    assert.ok(malformed.issues.some((issue) => issue.code === "route.waypoint.position-invalid"));

    const wrongWay = verifyRoute(environment, [
        { id: "start", x: 19, z: 0 },
        { id: "finish", x: 1, z: 0 },
    ]);
    assert.equal(wrongWay.ok, false);
    assert.ok(wrongWay.issues.some((issue) => issue.code === "route.section.disconnected"));
});

test("route sampling clamps percentages and samples each section by arc length", () => {
    const result = verifyRoute(roadEnvironment(), [
        { id: "start", x: 1, z: 0 },
        { id: "middle", x: 10, z: 0 },
        { id: "finish", x: 19, z: 0 },
    ]);
    const route = result.route;
    assert.equal(routeSectionCount(route), 2);
    assert.equal(sampleRoute(route, -1).x, 1);
    assert.equal(sampleRoute(route, 0.5).x, 10);
    assert.equal(sampleRoute(route, 2).x, 19);
    assert.equal(sampleRouteSection(route, 1, 0.5).x, 14.5);
    assert.equal(sampleRouteSection(route, 3, 0.5), null);

    const progress = routeProgress(route, { x: 14.5, y: 0, z: 1 });
    assert.equal(progress.segment, 1);
    assert.equal(progress.progress, 0.75);
});

function executeBlock(BlockClass, values) {
    const block = new BlockClass("route-unit");
    block.inputs = Object.fromEntries(Object.keys(values).map((key) => [key, {}]));
    block.getInput = (label) => values[label];
    return block.execute();
}

test("canonical route visual blocks expose typed pure operations", () => {
    const route = {
        waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 10, y: 0, z: 0 },
            { x: 10, y: 0, z: 20 },
        ],
    };
    const followed = executeBlock(FollowRouteBlock, { route, percent: 0.5 });
    assert.deepEqual(
        { x: followed.get("waypoint").x, z: followed.get("waypoint").z },
        { x: 10, z: 5 },
    );

    const section = executeBlock(FollowRouteSectionBlock, { route, section: 1, percent: 0.25 });
    assert.deepEqual(
        { x: section.get("waypoint").x, z: section.get("waypoint").z },
        { x: 10, z: 5 },
    );
    assert.equal(executeBlock(RouteSectionCountBlock, { route }).get("count"), 2);
});
