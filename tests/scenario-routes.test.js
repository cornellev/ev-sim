import assert from "node:assert/strict";
import test from "node:test";
import {
    deterministicDirectedAStar,
    hashEnvironmentRoadNetwork,
    isRouteVerificationCurrent,
    moveWaypoint,
    normalizeWaypoints,
    projectPointToRoadNetwork,
    removeWaypoint,
    reorderWaypoint,
    rightTravelNormal,
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
    assert.equal(road.point.z, 1);
    assert.equal(road.laneIndex, 0);
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

    const moved = moveWaypoint(waypoints, "first", {
        authoredPosition: { x: 8, y: 0, z: 1 },
        position: { x: 8, y: 0, z: 0 },
        anchor: { kind: "road", id: "ab", fraction: 0.8 },
    });
    assert.deepEqual(moved.map((waypoint) => waypoint.id), ["start", "first", "second", "finish"]);
    assert.deepEqual(moved.map((waypoint) => waypoint.kind), ["start", "intermediate", "intermediate", "finish"]);
    assert.deepEqual(moved[1].position, { x: 8, y: 0, z: 0 });
    assert.deepEqual(moved[1].authoredPosition, { x: 8, y: 0, z: 1 });
    assert.deepEqual(moved[1].anchor, { kind: "road", id: "ab", fraction: 0.8 });
    assert.equal(moved[1].x, 8);
    assert.equal(moved[1].z, 0);
    assert.equal(moved[0].x, 1);
    assert.deepEqual(moveWaypoint(waypoints, "missing", { position: { x: 0, z: 0 } }), waypoints);
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
    serialized.verification.algorithmVersion = 4;
    assert.equal(isRouteVerificationCurrent(serialized, environment), false);

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
    assert.ok(wrongWay.issues.some((issue) => issue.code === "route.section.illegal-direction"));
});

test("rightTravelNormal matches Road.js mesh right edge", () => {
    const plusX = rightTravelNormal({ x: 0, z: 0 }, { x: 10, z: 0 });
    assert.ok(Math.abs(plusX.x) < 1e-9 && Math.abs(plusX.z - 1) < 1e-9, `+X travel right is +Z, got (${plusX.x}, ${plusX.z})`);
    const plusZ = rightTravelNormal({ x: 0, z: 0 }, { x: 0, z: 10 });
    assert.ok(Math.abs(plusZ.x - (-1)) < 1e-9 && Math.abs(plusZ.z) < 1e-9, `+Z travel right is -X, got (${plusZ.x}, ${plusZ.z})`);
});

test("two-way routes sit on the right-hand travel side of the road", () => {
    const environment = {
        environmentId: "rht-two-way",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 },
            ],
        },
    };

    const outbound = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 18, z: 0 },
    ]);
    assert.equal(outbound.ok, true);
    assert.equal(outbound.route.verification.algorithmVersion, 5);
    for (const point of outbound.route.polyline) {
        assert.ok(Math.abs(point.z - 2) < 1e-6, `expected z=+2 (width/4 right of +X travel), got ${point.z}`);
    }
    assert.ok(Math.abs(outbound.route.waypoints[0].z - 2) < 1e-6);
    assert.ok(Math.abs(outbound.route.waypoints[1].z - 2) < 1e-6);

    const inbound = verifyRoute(environment, [
        { id: "start", x: 18, z: 0 },
        { id: "finish", x: 2, z: 0 },
    ]);
    assert.equal(inbound.ok, true);
    for (const point of inbound.route.polyline) {
        assert.ok(Math.abs(point.z - (-2)) < 1e-6, `expected z=-2 (width/4 right of -X travel), got ${point.z}`);
    }
});

test("one-way legal travel uses a physical lane and reverse is illegal-direction", () => {
    const environment = {
        environmentId: "rht-one-way",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: false, width: 8, laneCount: 2 },
            ],
        },
    };

    const legal = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 18, z: 0 },
    ]);
    assert.equal(legal.ok, true);
    for (const point of legal.route.polyline) {
        assert.ok(Math.abs(point.z - 2) < 1e-6, `one-way lane center must be z=2, got z=${point.z}`);
    }

    const illegal = verifyRoute(environment, [
        { id: "start", x: 18, z: 0 },
        { id: "finish", x: 2, z: 0 },
    ]);
    assert.equal(illegal.ok, false);
    assert.ok(illegal.issues.some((issue) => issue.code === "route.section.illegal-direction"));
});

test("missing road connectivity is disconnected rather than illegal-direction", () => {
    const environment = {
        environmentId: "disconnected",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 10, z: 0, kind: "endpoint" },
                { id: "c", x: 30, z: 0, kind: "endpoint" },
                { id: "d", x: 40, z: 0, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 4 },
                { id: "cd", startNodeId: "c", endNodeId: "d", bidirectional: true, width: 4 },
            ],
        },
    };

    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 35, z: 0 },
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "route.section.disconnected"));
    assert.equal(result.issues.some((issue) => issue.code === "route.section.illegal-direction"), false);
});

test("intersection right-turn L uses lane-boundary subnodes and a bounded connector", () => {
    const environment = {
        environmentId: "rht-l-right",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: 20, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 8, laneCount: 2 },
            ],
        },
    };

    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 20, z: 18 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.verification.algorithmVersion, 5);
    assert.equal(
        result.route.polyline.some((point) => Math.abs(point.x - 20) < 1e-6 && Math.abs(point.z) < 1e-6),
        false,
        "polyline must not include the raw intersection node center",
    );

    assert.equal(result.route.polyline.length, 11);
    assert.ok(Math.abs(result.route.polyline[0].z - 2) < 1e-6);
    assert.deepEqual(result.route.edgeTraversal[0].toSubnode.position, { x: 15, y: 0, z: 2 });
    assert.deepEqual(result.route.edgeTraversal[1].fromSubnode.position, { x: 18, y: 0, z: 5 });
    assert.ok(Math.abs(result.route.polyline.at(-1).x - 18) < 1e-6);

    const again = verifyRoute(environment, result.route);
    assert.equal(again.ok, true);
    assert.deepEqual(again.route.polyline, result.route.polyline);
});

test("intersection left-turn L uses lane-boundary subnodes without a fold", () => {
    const environment = {
        environmentId: "rht-l-left",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: -20, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 8, laneCount: 2 },
            ],
        },
    };

    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 20, z: -18 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.polyline.length, 11);
    assert.equal(
        result.route.polyline.some((point) => Math.abs(point.x - 20) < 1e-6 && Math.abs(point.z) < 1e-6),
        false,
        "polyline must not include the raw intersection node center",
    );
    // No node-axis overshoot at (20, +2): that was the v2 fold that filleted into a loop.
    assert.equal(
        result.route.polyline.some((point) => Math.abs(point.x - 20) < 1e-6 && Math.abs(point.z - 2) < 1e-6),
        false,
        "left turn must not overshoot to the node on the inbound offset",
    );
    assert.deepEqual(result.route.edgeTraversal[0].toSubnode.position, { x: 15, y: 0, z: 2 });
    assert.deepEqual(result.route.edgeTraversal[1].fromSubnode.position, { x: 22, y: 0, z: -5 });
    assert.ok(result.route.polyline.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
});

test("all four driving left turns retain right-hand lane entry and exit subnodes", () => {
    const width = 8;
    const cases = [
        {
            name: "E then N",
            nodes: [
                { id: "a", x: 0, z: 0 }, { id: "i", x: 20, z: 0 }, { id: "b", x: 20, z: -20 },
            ],
            edges: [
                { id: "1", startNodeId: "a", endNodeId: "i", bidirectional: true, width },
                { id: "2", startNodeId: "i", endNodeId: "b", bidirectional: true, width },
            ],
            start: { x: 2, z: 0 },
            finish: { x: 20, z: -18 },
        },
        {
            name: "W then S",
            nodes: [
                { id: "a", x: 40, z: 0 }, { id: "i", x: 20, z: 0 }, { id: "b", x: 20, z: 20 },
            ],
            edges: [
                { id: "1", startNodeId: "a", endNodeId: "i", bidirectional: true, width },
                { id: "2", startNodeId: "i", endNodeId: "b", bidirectional: true, width },
            ],
            start: { x: 38, z: 0 },
            finish: { x: 20, z: 18 },
        },
        {
            name: "N then W",
            nodes: [
                { id: "a", x: 20, z: 20 }, { id: "i", x: 20, z: 0 }, { id: "b", x: 0, z: 0 },
            ],
            edges: [
                { id: "1", startNodeId: "a", endNodeId: "i", bidirectional: true, width },
                { id: "2", startNodeId: "i", endNodeId: "b", bidirectional: true, width },
            ],
            start: { x: 20, z: 18 },
            finish: { x: 2, z: 0 },
        },
        {
            name: "S then E",
            nodes: [
                { id: "a", x: 20, z: -20 }, { id: "i", x: 20, z: 0 }, { id: "b", x: 40, z: 0 },
            ],
            edges: [
                { id: "1", startNodeId: "a", endNodeId: "i", bidirectional: true, width },
                { id: "2", startNodeId: "i", endNodeId: "b", bidirectional: true, width },
            ],
            start: { x: 20, z: -18 },
            finish: { x: 38, z: 0 },
        },
    ];

    for (const entry of cases) {
        const result = verifyRoute(
            { environmentId: `left-${entry.name}`, roads: { nodes: entry.nodes, edges: entry.edges } },
            [{ id: "start", ...entry.start }, { id: "finish", ...entry.finish }],
        );
        assert.equal(result.ok, true, entry.name);
        assert.equal(result.route.polyline.length, 11, entry.name);
        assert.equal(result.route.edgeTraversal[0].toLaneIndex, 0, entry.name);
        assert.equal(result.route.edgeTraversal[1].fromLaneIndex, 0, entry.name);
        assert.ok(result.route.edgeTraversal[0].toSubnode, entry.name);
        assert.ok(result.route.edgeTraversal[1].fromSubnode, entry.name);
        assert.equal(
            result.route.polyline.some((point) => Math.abs(point.x - entry.nodes[1].x) < 1e-6 && Math.abs(point.z - entry.nodes[1].z) < 1e-6),
            false,
            `${entry.name}: route must not pass through the raw node center`,
        );
    }
});

test("straight through an intersection retains both lane-boundary subnodes", () => {
    const environment = {
        environmentId: "rht-straight",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 40, z: 0, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 8, laneCount: 2 },
            ],
        },
    };
    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 38, z: 0 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.polyline.length, 5);
    assert.ok(
        Math.abs(result.route.polyline[2].x - 20) < 1e-6 && Math.abs(result.route.polyline[2].z - 2) < 1e-6,
    );
    assert.deepEqual(result.route.edgeTraversal[0].toSubnode.position, { x: 15, y: 0, z: 2 });
    assert.deepEqual(result.route.edgeTraversal[1].fromSubnode.position, { x: 25, y: 0, z: 2 });
    for (const point of result.route.polyline) {
        assert.ok(Math.abs(point.z - 2) < 1e-6);
    }
});

test("mixed-width left turn produces finite lane-boundary geometry", () => {
    const environment = {
        environmentId: "rht-mixed-width",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: -20, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 12, laneCount: 2 },
            ],
        },
    };
    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 20, z: -18 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.polyline.length, 11);
    assert.deepEqual(result.route.edgeTraversal[0].toSubnode.position, { x: 15, y: 0, z: 2 });
    assert.deepEqual(result.route.edgeTraversal[1].fromSubnode.position, { x: 23, y: 0, z: -5 });
    assert.ok(result.route.polyline.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
});

test("one-way L-path joins its lane centers through the intersection", () => {
    const environment = {
        environmentId: "rht-one-way-l",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: -20, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: false, width: 8 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: false, width: 8 },
            ],
        },
    };
    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 20, z: -18 },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.route.edgeTraversal[0].toSubnode.position, { x: 15, y: 0, z: 2 });
    assert.deepEqual(result.route.edgeTraversal[1].fromSubnode.position, { x: 22, y: 0, z: -5 });
    assert.ok(result.route.polyline.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
});

test("left turn with an intersection waypoint splits the bounded lane connector", () => {
    const environment = {
        environmentId: "rht-left-intersection-wp",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: -20, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 8, laneCount: 2 },
            ],
        },
    };
    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "mid", x: 20, z: 0 },
        { id: "finish", x: 20, z: -18 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.verification.sections.length, 2);
    assert.equal(result.route.polyline.length, 11);

    const mid = result.route.waypoints.find((point) => point.id === "mid");
    assert.equal(mid.anchor.kind, "intersection");
    assert.deepEqual(mid.position, result.route.sections[0].polyline.at(-1));
    assert.deepEqual(mid.position, result.route.sections[1].polyline[0]);
    assert.ok(Math.hypot(mid.position.x - 20, mid.position.z) <= 5);

    const again = verifyRoute(environment, result.route);
    assert.equal(again.ok, true);
    assert.deepEqual(again.route.polyline, result.route.polyline);
});

test("right turn with an intersection waypoint splits the bounded lane connector", () => {
    const environment = {
        environmentId: "rht-right-intersection-wp",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: 20, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 8, laneCount: 2 },
            ],
        },
    };
    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "mid", x: 20, z: 0 },
        { id: "finish", x: 20, z: 18 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.polyline.length, 11);
    const mid = result.route.waypoints.find((point) => point.id === "mid");
    assert.equal(mid.anchor.kind, "intersection");
    assert.deepEqual(mid.position, result.route.sections[0].polyline.at(-1));
    assert.deepEqual(mid.position, result.route.sections[1].polyline[0]);
    assert.ok(Math.hypot(mid.position.x - 20, mid.position.z) <= 5);
});

test("straight through with an intermediate intersection waypoint keeps the lane midpoint", () => {
    const environment = {
        environmentId: "rht-straight-intersection-wp",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 40, z: 0, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 8, laneCount: 2 },
            ],
        },
    };
    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "mid", x: 20, z: 0 },
        { id: "finish", x: 38, z: 0 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.polyline.length, 5);
    assert.ok(
        Math.abs(result.route.polyline[2].x - 20) < 1e-6 && Math.abs(result.route.polyline[2].z - 2) < 1e-6,
    );
    for (const point of result.route.polyline) {
        assert.ok(Math.abs(point.z - 2) < 1e-6);
    }
    const mid = result.route.waypoints.find((point) => point.id === "mid");
    assert.equal(mid.anchor.kind, "intersection");
    assert.ok(Math.abs(mid.position.x - 20) < 1e-6 && Math.abs(mid.position.z - 2) < 1e-6);
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
