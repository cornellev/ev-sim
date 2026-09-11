import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import {
    getIntersectionMovements,
    setTurnMovementAllowed,
} from "../app/3d/editor/document/documentMutations.js";
import {
    laneCenterRightOffset,
    laneDirections,
    legalLaneIndices,
    nearestLegalLaneIndex,
    validateRoadLaneLayout,
} from "../app/roads/RoadLaneModel.js";
import { normalizeScenario, validateScenario } from "../app/scenarios/ScenarioDocument.js";
import {
    buildDirectedRoadGraph,
    deterministicDirectedAStar,
    hashEnvironmentRoadNetwork,
    projectPointToRoadNetwork,
    verifyRoute,
} from "../app/scenarios/route/index.js";
import { hashWaypoints } from "../app/scenarios/route/waypoints.js";
import {
    createWorldDescription,
    hashWorldDescription,
} from "../app/simulation/world/WorldDescription.js";

function straightEnvironment(edge = {}) {
    return {
        environmentId: "lane-straight",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, y: 0, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "ab",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
                width: 12,
                laneCount: 4,
                ...edge,
            }],
        },
    };
}

function worldInput(roads) {
    return {
        environmentId: "turn-world",
        templateId: "blank",
        document: {
            environmentId: "turn-world",
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: true,
            roads,
            buildings: [],
            features: [],
        },
    };
}

test("physical lane indexing and legal directions follow right-hand traffic", () => {
    const twoWay = { width: 12, laneCount: 4, bidirectional: true };
    assert.deepEqual([0, 1, 2, 3].map((index) => laneCenterRightOffset(twoWay, index)), [4.5, 1.5, -1.5, -4.5]);
    assert.deepEqual(legalLaneIndices(twoWay, 1), [0, 1]);
    assert.deepEqual(legalLaneIndices(twoWay, -1), [2, 3]);
    assert.equal(nearestLegalLaneIndex(twoWay, 1, 3), 1);
    assert.equal(nearestLegalLaneIndex(twoWay, -1, 0), 2);

    const oneWay = { width: 12, laneCount: 4, bidirectional: false };
    assert.deepEqual([0, 1, 2, 3].map((index) => laneDirections(oneWay, index)), [[1], [1], [1], [1]]);
    assert.deepEqual(legalLaneIndices({ ...oneWay, direction: -1 }, -1), [0, 1, 2, 3]);

    const shared = { width: 4, laneCount: 1, bidirectional: true };
    assert.deepEqual(laneDirections(shared, 0), [1, -1]);
    assert.equal(laneCenterRightOffset(shared, 0), 0);
    assert.equal(validateRoadLaneLayout(shared).ok, true);
    assert.equal(validateRoadLaneLayout({ width: 9, laneCount: 3, bidirectional: true }).ok, false);
});

test("road projection snaps to a physical lane and routing preserves the selected lane", () => {
    const environment = straightEnvironment();
    const projection = projectPointToRoadNetwork({ x: 2, z: -4.4 }, environment);
    assert.equal(projection.laneIndex, 3);
    assert.equal(projection.point.z, -4.5);

    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: -4.4 },
        { id: "finish", x: 18, z: -4.4 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.verification.algorithmVersion, 5);
    assert.equal(result.route.waypoints[0].anchor.laneIndex, 3);
    assert.equal(result.route.waypoints[1].anchor.laneIndex, 3);
    assert.equal(result.route.waypoints[0].z, -4.5);
    assert.equal(result.route.waypoints[1].z, -4.5);
    assert.deepEqual(result.route.edgeTraversal.map((step) => step.direction), [-1, 1, -1]);
    assert.equal(result.route.edgeTraversal[0].fromLaneIndex, 3);
    assert.equal(result.route.edgeTraversal.at(-1).toLaneIndex, 3);
});

test("fixed road anchors reject missing, coerced, negative, and out-of-range lane indices", () => {
    const environment = straightEnvironment();
    for (const laneIndex of [null, "1", -1, 4]) {
        const result = verifyRoute(environment, [
            {
                id: "start",
                position: { x: 2, y: 0, z: 4.5 },
                anchor: { kind: "road", id: "ab", fraction: 0.1, laneMode: "fixed", laneIndex },
            },
            {
                id: "finish",
                position: { x: 18, y: 0, z: 4.5 },
                anchor: { kind: "road", id: "ab", fraction: 0.9, laneMode: "fixed", laneIndex: 0 },
            },
        ]);
        assert.equal(result.ok, false);
        assert.ok(result.issues.some((issue) => issue.code === "route.waypoint.lane-invalid"));
    }

    const scenario = normalizeScenario({
        id: "invalid-lane-anchor",
        environment: { id: "igvc" },
        actors: [{ id: "ego", role: "ego" }],
        routes: [{
            id: "route",
            actorId: "ego",
            waypoints: [
                { id: "start", anchor: { kind: "road", id: "ab", laneIndex: -1 } },
                { id: "finish", anchor: { kind: "road", id: "ab", laneIndex: 0 } },
            ],
        }],
    });
    assert.equal(scenario.routes[0].waypoints[0].anchor.laneIndex, -1);
    assert.ok(validateScenario(scenario).issues.some((issue) => issue.path.endsWith("anchor.laneIndex")));
});

test("multi-lane one-way roads retain lane preference and use eight samples for a lane change", () => {
    const environment = straightEnvironment({ bidirectional: false });
    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 4.5 },
        { id: "finish", x: 18, z: 1.5 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.route.edgeTraversal[0].fromLaneIndex, 0);
    assert.equal(result.route.edgeTraversal[0].toLaneIndex, 1);
    assert.equal(result.route.polyline.length, 8);
    assert.equal(result.route.polyline[0].z, 4.5);
    assert.equal(result.route.polyline.at(-1).z, 1.5);
    for (let index = 1; index < result.route.polyline.length; index += 1) {
        assert.ok(result.route.polyline[index].z <= result.route.polyline[index - 1].z);
    }
});

test("invalid odd bidirectional lane layouts fail route and world validation", () => {
    const environment = straightEnvironment({ width: 9, laneCount: 3 });
    const result = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 18, z: 0 },
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "route.environment.lane-layout-invalid"));
    assert.throws(() => createWorldDescription(worldInput(environment.roads)), /invalid lane layout/i);
});

test("turn rules prohibit movements, allow legal detours, and carry across intersection waypoints", () => {
    const roads = {
        nodes: [
            { id: "a", x: 0, z: 0 },
            { id: "b", x: 10, z: 0, kind: "intersection" },
            { id: "c", x: 20, z: 0 },
        ],
        edges: [
            { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 4, laneCount: 2 },
            { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 4, laneCount: 2 },
        ],
        turnRules: [{ nodeId: "b", fromEdgeId: "ab", toEdgeId: "bc", allowed: false }],
    };
    const direct = verifyRoute({ environmentId: "turns", roads }, [
        { id: "start", x: 1, z: 0 },
        { id: "finish", x: 19, z: 0 },
    ]);
    assert.equal(direct.ok, false);
    assert.ok(direct.issues.some((issue) => issue.code === "route.section.turn-restricted"));

    const staged = verifyRoute({ environmentId: "turns", roads }, [
        { id: "start", x: 1, z: 0 },
        { id: "middle", x: 10, z: 0 },
        { id: "finish", x: 19, z: 0 },
    ]);
    assert.equal(staged.ok, false);
    assert.ok(staged.issues.some((issue) => issue.code === "route.section.turn-restricted" && issue.section === 1));

    const detourRoads = structuredClone(roads);
    detourRoads.nodes.push({ id: "d", x: 10, z: 10 });
    detourRoads.edges.push({ id: "bd", startNodeId: "b", endNodeId: "d", bidirectional: true, width: 4, laneCount: 2 });
    const detour = verifyRoute({ environmentId: "detour", roads: detourRoads }, [
        { id: "start", x: 1, z: 0 },
        { id: "finish", x: 19, z: 0 },
    ]);
    assert.equal(detour.ok, true);
    assert.deepEqual(detour.route.sections[0].edgeIds, ["ab", "bd", "bd", "bc"]);
});

test("staged routing chooses a longer waypoint approach when it enables the next legal turn", () => {
    const environment = {
        environmentId: "staged-detour",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "intersection" },
                { id: "b", x: 10, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: 0 },
                { id: "d", x: 0, z: 10 },
                { id: "e", x: 10, z: 10 },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 4, laneCount: 2 },
                { id: "ad", startNodeId: "a", endNodeId: "d", bidirectional: true, width: 4, laneCount: 2 },
                { id: "de", startNodeId: "d", endNodeId: "e", bidirectional: true, width: 4, laneCount: 2 },
                { id: "eb", startNodeId: "e", endNodeId: "b", bidirectional: true, width: 4, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 4, laneCount: 2 },
            ],
            turnRules: [{ nodeId: "b", fromEdgeId: "ab", toEdgeId: "bc", allowed: false }],
        },
    };

    const result = verifyRoute(environment, [
        { id: "start", x: 0, z: 0 },
        { id: "middle", x: 10, z: 0 },
        { id: "finish", x: 20, z: 0 },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.route.sections[0].edgeIds, ["ad", "de", "eb"]);
    assert.deepEqual(result.route.sections[1].edgeIds, ["bc"]);
});

test("road waypoint stages retain travel direction instead of permitting an implicit U-turn", () => {
    const environment = {
        environmentId: "staged-direction",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0 },
                { id: "b", x: 30, z: 0, kind: "intersection" },
                { id: "c", x: 60, z: 0 },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 4, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true, width: 4, laneCount: 2 },
            ],
        },
    };

    const result = verifyRoute(environment, [
        { id: "start", x: 5, z: 0 },
        { id: "middle", x: 15, z: 0 },
        { id: "finish", x: 10, z: 0 },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.route.sections[0].edgeIds, ["ab", "bc", "bc", "ab"]);
    assert.deepEqual(result.route.sections[1].edgeIds, ["ab"]);
});

test("intersection U-turn defaults, explicit allowances, and one-way precedence are enforced", () => {
    const environment = {
        environmentId: "uturns",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0 },
                { id: "b", x: 10, z: 0, kind: "intersection" },
                { id: "c", x: 10, z: 10 },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 4, laneCount: 2 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: false, width: 4, laneCount: 2 },
            ],
        },
    };
    let graph = buildDirectedRoadGraph(environment);
    assert.equal(deterministicDirectedAStar(graph, "b", "b", { incomingEdgeId: "ab", outgoingEdgeId: "ab" }).ok, false);
    assert.equal(deterministicDirectedAStar(graph, "a", "a", { incomingEdgeId: "ab", outgoingEdgeId: "ab" }).ok, true);

    environment.roads.turnRules = [{ nodeId: "b", fromEdgeId: "ab", toEdgeId: "ab", allowed: true }];
    graph = buildDirectedRoadGraph(environment);
    assert.equal(deterministicDirectedAStar(graph, "b", "b", { incomingEdgeId: "ab", outgoingEdgeId: "ab" }).ok, true);

    assert.throws(() => createWorldDescription(worldInput({
        ...environment.roads,
        turnRules: [{ nodeId: "c", fromEdgeId: "bc", toEdgeId: "bc", allowed: true }],
    })), /cannot depart/i);
});

test("turn-rule editing is sparse, persistent, deterministic, and changes road hashes", () => {
    const document = new EnvironmentDocument({
        environmentId: "editor-turns",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0 },
                { id: "b", x: 10, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: 0 },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: true },
            ],
        },
    });
    const beforeHash = hashEnvironmentRoadNetwork(document);
    const matrix = getIntersectionMovements(document, "b");
    assert.equal(matrix.cells.find((cell) => cell.fromEdgeId === "ab" && cell.toEdgeId === "bc").allowed, true);
    assert.equal(matrix.cells.find((cell) => cell.fromEdgeId === "ab" && cell.toEdgeId === "ab").allowed, false);

    assert.equal(setTurnMovementAllowed(document, "b", "ab", "bc", false).ok, true);
    assert.deepEqual(document.roads.turnRules, [{ nodeId: "b", fromEdgeId: "ab", toEdgeId: "bc", allowed: false }]);
    assert.notEqual(hashEnvironmentRoadNetwork(document), beforeHash);
    assert.deepEqual(EnvironmentDocument.fromManifest(document.snapshot()).roads.turnRules, document.roads.turnRules);
    assert.equal(setTurnMovementAllowed(document, "b", "ab", "bc", true).ok, true);
    assert.deepEqual(document.roads.turnRules, []);
    assert.equal(hashEnvironmentRoadNetwork(document), beforeHash);

    const baseWorld = createWorldDescription(worldInput(document.roads));
    setTurnMovementAllowed(document, "b", "ab", "bc", false);
    const ruledWorld = createWorldDescription(worldInput(document.roads));
    assert.notEqual(hashWorldDescription(ruledWorld), hashWorldDescription(baseWorld));
    assert.deepEqual(ruledWorld.roads.turnRules, document.roads.turnRules);
});

test("lane anchors are semantic while raw pointer position is editor-only", () => {
    const base = [{
        id: "start",
        kind: "start",
        order: 0,
        x: 2,
        y: 0,
        z: 1.5,
        anchor: { kind: "road", id: "ab", fraction: 0.1, laneIndex: 1 },
        authoredPosition: { x: 2, y: 0, z: -4.4 },
    }];
    assert.equal(hashWaypoints(base), hashWaypoints([{ ...base[0], authoredPosition: { x: 99, y: 0, z: 99 } }]));
    assert.notEqual(hashWaypoints(base), hashWaypoints([{
        ...base[0],
        anchor: { ...base[0].anchor, laneIndex: 0 },
    }]));

    const scenario = normalizeScenario({
        id: "lane-anchor",
        name: "Lane anchor",
        environment: { id: "igvc" },
        actors: [{ id: "ego", role: "ego" }],
        routes: [{ id: "route", actorId: "ego", waypoints: base }],
    });
    assert.equal(scenario.routes[0].waypoints[0].anchor.laneIndex, 1);
    assert.equal(scenario.routes[0].waypoints[0].anchor.laneMode, "fixed");
    assert.equal("authoredPosition" in scenario.routes[0].waypoints[0], false);
});

test("grid itinerary reaches a fixed northbound lane waypoint without crossing the divider", () => {
    const nodes = [
        ["tl", 0, 0], ["tc", 40, 0], ["tr", 80, 0],
        ["ml", 0, 40], ["mc", 40, 40], ["mr", 80, 40],
        ["bl", 0, 80], ["bc", 40, 80], ["br", 80, 80],
    ].map(([id, x, z]) => ({ id, x, z, kind: "intersection" }));
    const edge = (id, startNodeId, endNodeId) => ({
        id,
        startNodeId,
        endNodeId,
        bidirectional: true,
        width: 8,
        laneCount: 2,
    });
    const environment = {
        environmentId: "lane-grid-regression",
        roads: {
            nodes,
            edges: [
                edge("top-left", "tl", "tc"), edge("top-right", "tc", "tr"),
                edge("middle-left", "ml", "mc"), edge("middle-right", "mc", "mr"),
                edge("bottom-left", "bl", "bc"), edge("bottom-right", "bc", "br"),
                edge("left-top", "tl", "ml"), edge("left-bottom", "ml", "bl"),
                edge("center-top", "tc", "mc"), edge("center-bottom", "mc", "bc"),
                edge("right-top", "tr", "mr"), edge("right-bottom", "mr", "br"),
            ],
        },
    };
    const intersection = (id, nodeId, position) => ({
        id,
        position,
        anchor: { kind: "intersection", id: nodeId, fraction: 0 },
    });
    const result = verifyRoute(environment, [
        intersection("start", "tl", { x: 0, y: 0, z: -2 }),
        intersection("one", "tc", { x: 42, y: 0, z: -2 }),
        intersection("two", "mc", { x: 42, y: 0, z: 38 }),
        intersection("three", "mr", { x: 78, y: 0, z: 38 }),
        intersection("four", "tr", { x: 78, y: 0, z: 2 }),
        {
            id: "five",
            position: { x: 42, y: 0, z: 26.3 },
            anchor: { kind: "road", id: "center-top", fraction: 0.6575, laneMode: "fixed", laneIndex: 1 },
        },
        intersection("six", "bc", { x: 42, y: 0, z: 78 }),
        intersection("finish", "br", { x: 80, y: 0, z: 78 }),
    ]);

    assert.equal(result.ok, true, result.error);
    const waypointFive = result.route.waypoints.find((waypoint) => waypoint.id === "five");
    assert.equal(waypointFive.position.x, 42);
    assert.ok(Math.abs(waypointFive.position.z - 26.3) < 1e-9);
    assert.equal(waypointFive.anchor.laneIndex, 1);

    const intoFive = result.route.sections[4].edgeTraversal.at(-1);
    const outOfFive = result.route.sections[5].edgeTraversal[0];
    assert.equal(intoFive.edgeId, "center-top");
    assert.equal(intoFive.direction, -1);
    assert.equal(intoFive.toLaneIndex, 1);
    assert.equal(outOfFive.edgeId, "center-top");
    assert.equal(outOfFive.direction, -1);
    assert.equal(outOfFive.fromLaneIndex, 1);

    const centers = new Map(nodes.map((node) => [node.id, node]));
    for (const traversal of result.route.edgeTraversal) {
        const road = environment.roads.edges.find((candidate) => candidate.id === traversal.edgeId);
        const start = centers.get(road.startNodeId);
        const end = centers.get(road.endNodeId);
        for (const subnode of [traversal.fromSubnode, traversal.toSubnode]) {
            if (Math.abs(end.x - start.x) > Math.abs(end.z - start.z)) {
                assert.equal(subnode.position.z, start.z + (traversal.direction === 1 ? 2 : -2));
            } else {
                assert.equal(subnode.position.x, start.x + (traversal.direction === 1 ? -2 : 2));
            }
        }
    }
});

test("version 3 and version 4 route proofs are rejected by version 5 authoring validation", async () => {
    const environment = straightEnvironment({ laneCount: 2, width: 8 });
    const verified = verifyRoute(environment, [
        { id: "start", x: 2, z: 0 },
        { id: "finish", x: 18, z: 0 },
    ]);
    const { validateRouteVerification } = await import("../app/scenarios/route/Route.js");
    const legacy = structuredClone(verified.route);
    legacy.verification.algorithmVersion = 3;
    const validation = validateRouteVerification(legacy, environment);
    assert.equal(validation.ok, false);
    assert.ok(validation.issues.some((issue) => issue.code === "route.verification.algorithm-invalid"));
    legacy.verification.algorithmVersion = 4;
    const v4Validation = validateRouteVerification(legacy, environment);
    assert.equal(v4Validation.ok, false);
    assert.ok(v4Validation.issues.some((issue) => issue.code === "route.verification.algorithm-invalid"));
});
