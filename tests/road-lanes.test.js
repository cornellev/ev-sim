import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import {
    LANE_LAYOUT_ISSUE_CODES,
    derivedRoadLanes,
    explicitRoadLanes,
    laneCenterRightOffset,
    laneDirections,
    laneDividerDescriptors,
    legalLaneIndices,
    nextLaneId,
    normalizeRoadLanes,
    roadLaneCount,
    roadLaneId,
    roadLaneIndexOf,
    roadLaneWidth,
    roadLanes,
    scaleRoadLanesToWidth,
    validateRoadLaneLayout,
} from "../app/roads/RoadLaneModel.js";
import { normalizeMetricRoads, validateRoadDomain } from "../app/roads/RoadGeometryRecord.js";
import { buildRoadSurface } from "../app/roads/RoadGeometry.js";
import { buildDirectedRoadGraph, hashEnvironmentRoadNetwork, verifyRoute } from "../app/scenarios/route/index.js";
import {
    assertWorldResource,
    createWorldDescription,
    createWorldResource,
    hashWorldDescription,
} from "../app/simulation/world/WorldDescription.js";

async function curvedFixture() {
    return JSON.parse(await readFile(new URL("./fixtures/environment-editor/curved-elevated-network.v2.json", import.meta.url)));
}

function straightV2(edge = {}) {
    return {
        environmentId: "lanes-straight",
        roads: {
            geometryVersion: 2,
            nodes: [
                { id: "a", x: 0, y: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 40, y: 0, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "ab",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
                width: 11,
                laneCount: 3,
                geometry: { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] },
                ...edge,
            }],
        },
    };
}

/** Two forward lanes (3.5 m) and one backward lane (4 m): the ED-05 asymmetric case. */
const ASYMMETRIC_LANES = [
    { id: "lane-0", direction: 1, width: 3.5 },
    { id: "lane-1", direction: 1, width: 3.5 },
    { id: "lane-2", direction: -1, width: 4 },
];

function worldInput(roads, environmentId = "lanes-world") {
    return {
        environmentId,
        templateId: "blank",
        document: { environmentId, roadsAuthored: true, buildingsAuthored: true, featuresAuthored: true, roads, buildings: [], features: [] },
    };
}

test("ED-05 derived lanes reproduce the legacy symmetric model bit for bit", () => {
    const cases = [
        { width: 4, laneCount: 1, bidirectional: true },
        { width: 7, laneCount: 2, bidirectional: true },
        { width: 12, laneCount: 4, bidirectional: true },
        { width: 3.3, laneCount: 1, bidirectional: false },
        { width: 6.6, laneCount: 2, bidirectional: false, direction: -1 },
        { width: 10.5, laneCount: 3, bidirectional: false },
    ];
    for (const edge of cases) {
        const lanes = derivedRoadLanes(edge);
        assert.equal(lanes.length, edge.laneCount);
        for (const [index, lane] of lanes.entries()) {
            assert.equal(lane.id, `lane-${index}`);
            assert.equal(lane.width, edge.width / edge.laneCount);
            const legacyDirections = laneDirections(edge, index);
            assert.deepEqual(lane.direction === 0 ? [1, -1] : [lane.direction], legacyDirections);
            // The implicit branch must keep the literal historical expression.
            const laneWidth = edge.width / edge.laneCount;
            assert.equal(laneCenterRightOffset(edge, index), edge.width * 0.5 - laneWidth * (index + 0.5));
            // The explicit branch of the same layout lands on the same centre.
            const explicit = { ...edge, lanes };
            assert.ok(Math.abs(laneCenterRightOffset(explicit, index) - laneCenterRightOffset(edge, index)) < 1e-12);
        }
    }
    const twoWay = { width: 12, laneCount: 4, bidirectional: true };
    assert.deepEqual([0, 1, 2, 3].map((index) => laneCenterRightOffset(twoWay, index)), [4.5, 1.5, -1.5, -4.5]);
    assert.equal(roadLaneWidth(twoWay), 3);
    assert.equal(roadLaneWidth({ ...twoWay, lanes: derivedRoadLanes(twoWay) }, 2), 3);
});

test("ED-05 explicit lanes equal to the derived default canonicalize back to implicit", () => {
    const edge = { id: "e", width: 7, laneCount: 2, bidirectional: true };
    const materialized = { ...edge, lanes: explicitRoadLanes(edge) };
    assert.deepEqual(materialized.lanes, [{ id: "lane-0", direction: 1, width: 3.5 }, { id: "lane-1", direction: -1, width: 3.5 }]);
    normalizeRoadLanes(materialized);
    assert.equal(materialized.lanes, undefined);
    assert.deepEqual(materialized, edge);

    const shared = { id: "s", width: 4, laneCount: 1, bidirectional: true, lanes: [{ id: "lane-0", direction: 0, width: 4 }] };
    normalizeRoadLanes(shared);
    assert.equal(shared.lanes, undefined);
    assert.deepEqual(laneDirections(shared, 0), [1, -1]);

    const oneWay = { id: "o", width: 6, laneCount: 2, bidirectional: true, lanes: [{ id: "lane-0", direction: -1, width: 3 }, { id: "lane-1", direction: -1, width: 3 }] };
    normalizeRoadLanes(oneWay);
    assert.equal(oneWay.lanes, undefined, "an all-reverse layout is the derived default of a reversed one-way road");
    assert.equal(oneWay.bidirectional, false);
    assert.equal(oneWay.direction, -1);

    const marked = { id: "m", width: 7, laneCount: 2, bidirectional: true, lanes: [{ id: "lane-0", direction: 1, width: 3.5, markingLeft: "solid_yellow" }, { id: "lane-1", direction: -1, width: 3.5 }] };
    normalizeRoadLanes(marked);
    assert.ok(Array.isArray(marked.lanes), "an authored marking keeps the lanes explicit");
});

test("ED-05 normalization derives the stored width, count, and direction fields from the lanes", () => {
    const edge = { id: "e", width: 7, laneCount: 2, bidirectional: true, oneWay: true, direction: -1, lanes: ASYMMETRIC_LANES.map((lane) => ({ ...lane })) };
    normalizeRoadLanes(edge);
    assert.equal(edge.width, 11);
    assert.equal(edge.laneCount, 3);
    assert.equal(edge.bidirectional, true);
    assert.equal(edge.direction, undefined);
    assert.equal(edge.oneWay, undefined);
    assert.equal(validateRoadLaneLayout(edge).ok, true);

    const forward = { id: "f", width: 1, laneCount: 1, bidirectional: true, lanes: [{ id: "x", direction: 1, width: 3 }, { id: "y", direction: 1, width: 3.25 }] };
    normalizeRoadLanes(forward);
    assert.equal(forward.bidirectional, false);
    assert.equal(forward.direction, 1);
    assert.equal(forward.width, 6.25);
    assert.ok(Array.isArray(forward.lanes), "custom ids and unequal widths stay explicit");

    const scaled = scaleRoadLanesToWidth(ASYMMETRIC_LANES, 22);
    assert.deepEqual(scaled.map((lane) => lane.width), [7, 7, 8]);
    const odd = scaleRoadLanesToWidth(ASYMMETRIC_LANES, 10);
    assert.equal(odd.reduce((sum, lane) => sum + lane.width, 0), 10, "the last lane absorbs rounding so the sum is exact");
    assert.equal(nextLaneId(ASYMMETRIC_LANES), "lane-3");
    assert.equal(nextLaneId([{ id: "lane-0" }, { id: "lane-2" }]), "lane-1");
});

test("ED-05 asymmetric lanes expose cumulative offsets, legal directions, and an opposing divider", () => {
    const edge = { id: "ab", width: 11, laneCount: 3, bidirectional: true, lanes: ASYMMETRIC_LANES };
    assert.equal(validateRoadLaneLayout(edge).ok, true);
    assert.equal(roadLaneCount(edge), 3);
    assert.deepEqual([0, 1, 2].map((index) => laneCenterRightOffset(edge, index)), [3.75, 0.25, -3.5]);
    assert.deepEqual([0, 1, 2].map((index) => roadLaneWidth(edge, index)), [3.5, 3.5, 4]);
    assert.deepEqual(legalLaneIndices(edge, 1), [0, 1]);
    assert.deepEqual(legalLaneIndices(edge, -1), [2]);
    assert.equal(roadLaneId(edge, 2), "lane-2");
    assert.equal(roadLaneIndexOf(edge, "lane-1"), 1);
    assert.equal(roadLaneIndexOf(edge, "missing"), -1);
    const dividers = laneDividerDescriptors(edge);
    assert.deepEqual(dividers.map((divider) => [divider.dividerIndex, divider.rightOffset, divider.opposing, divider.rightLaneId, divider.leftLaneId, divider.marking]), [
        [1, 2, false, "lane-0", "lane-1", null],
        [2, -1.5, true, "lane-1", "lane-2", null],
    ]);
    const marked = { ...edge, lanes: [{ ...ASYMMETRIC_LANES[0], markingLeft: "dashed_white" }, ...ASYMMETRIC_LANES.slice(1)] };
    assert.equal(laneDividerDescriptors(marked)[0].marking, "dashed_white");
    assert.deepEqual(roadLanes(marked)[0], { id: "lane-0", direction: 1, width: 3.5, markingLeft: "dashed_white" });
    assert.notEqual(roadLanes(marked), marked.lanes, "roadLanes returns copies");
});

test("ED-05 every explicit-lane validation code fires with an edge-relative path", () => {
    const base = { id: "e", width: 11, laneCount: 3, bidirectional: true };
    const codeFor = (edge, options) => validateRoadLaneLayout(edge, options).issues.map((entry) => [entry.code, entry.path.join(".")]);
    assert.deepEqual(codeFor({ ...base, lanes: [] }), [[LANE_LAYOUT_ISSUE_CODES.EMPTY, "lanes"]]);
    assert.deepEqual(codeFor({ ...base, lanes: ASYMMETRIC_LANES }, { geometryVersion: 1 }), [[LANE_LAYOUT_ISSUE_CODES.VERSION_REQUIRED, "lanes"]]);
    assert.deepEqual(codeFor({ ...base, lanes: [{ id: "", direction: 1, width: 5.5 }, { id: "x", direction: 1, width: 5.5 }] }), [[LANE_LAYOUT_ISSUE_CODES.ID_INVALID, "lanes.0.id"]]);
    assert.deepEqual(codeFor({ ...base, lanes: [{ id: "x", direction: 1, width: 5.5 }, { id: "x", direction: 1, width: 5.5 }] }), [[LANE_LAYOUT_ISSUE_CODES.ID_INVALID, "lanes.1.id"]]);
    assert.deepEqual(codeFor({ ...base, lanes: [{ id: "x", direction: 2, width: 11 }] }), [[LANE_LAYOUT_ISSUE_CODES.DIRECTION_INVALID, "lanes.0.direction"]]);
    assert.deepEqual(codeFor({ ...base, lanes: [{ id: "x", direction: 0, width: 5.5 }, { id: "y", direction: 1, width: 5.5 }] }), [[LANE_LAYOUT_ISSUE_CODES.SHARED_REQUIRES_SINGLE, "lanes.0.direction"]]);
    assert.deepEqual(codeFor({ ...base, lanes: [{ id: "x", direction: 1, width: 4 }, { id: "y", direction: -1, width: 3 }, { id: "z", direction: 1, width: 4 }] }), [[LANE_LAYOUT_ISSUE_CODES.DIRECTION_INTERLEAVED, "lanes"]]);
    assert.deepEqual(codeFor({ ...base, lanes: [{ id: "x", direction: 1, width: 0 }, { id: "y", direction: -1, width: 11 }] }), [[LANE_LAYOUT_ISSUE_CODES.WIDTH_INVALID, "lanes.0.width"]]);
    assert.deepEqual(codeFor({ ...base, width: 12, lanes: ASYMMETRIC_LANES }), [[LANE_LAYOUT_ISSUE_CODES.WIDTH_MISMATCH, "width"]]);
    assert.deepEqual(codeFor({ ...base, laneCount: 2, lanes: ASYMMETRIC_LANES }), [[LANE_LAYOUT_ISSUE_CODES.COUNT_MISMATCH, "laneCount"]]);
    assert.deepEqual(codeFor({ ...base, bidirectional: false, lanes: ASYMMETRIC_LANES }), [[LANE_LAYOUT_ISSUE_CODES.BIDIRECTIONAL_MISMATCH, "bidirectional"]]);
    assert.deepEqual(codeFor({ ...base, width: 7, laneCount: 2, bidirectional: true, lanes: [{ id: "x", direction: 1, width: 3.5 }, { id: "y", direction: 1, width: 3.5 }] }), [[LANE_LAYOUT_ISSUE_CODES.BIDIRECTIONAL_MISMATCH, "bidirectional"]]);
    assert.deepEqual(codeFor({ ...base, width: 7, laneCount: 2, bidirectional: false, direction: -1, lanes: [{ id: "x", direction: 1, width: 3.5 }, { id: "y", direction: 1, width: 3.5 }] }), [[LANE_LAYOUT_ISSUE_CODES.DIRECTION_MISMATCH, "direction"]]);
    assert.deepEqual(codeFor({ ...base, lanes: [{ ...ASYMMETRIC_LANES[0], markingLeft: "purple" }, ...ASYMMETRIC_LANES.slice(1)] }), [[LANE_LAYOUT_ISSUE_CODES.MARKING_INVALID, "lanes.0.markingLeft"]]);
    assert.deepEqual(codeFor({ ...base, lanes: [...ASYMMETRIC_LANES.slice(0, 2), { ...ASYMMETRIC_LANES[2], markingLeft: "none" }] }), [[LANE_LAYOUT_ISSUE_CODES.MARKING_OUTER_FORBIDDEN, "lanes.2.markingLeft"]]);
    // Legacy callers still read the first issue as code/error.
    const legacy = validateRoadLaneLayout({ ...base, lanes: [] });
    assert.equal(legacy.code, LANE_LAYOUT_ISSUE_CODES.EMPTY);
    assert.match(legacy.error, /at least one lane/);
    // Implicit edges keep the historical rules untouched.
    assert.equal(validateRoadLaneLayout({ width: 9, laneCount: 3, bidirectional: true }).code, LANE_LAYOUT_ISSUE_CODES.LEGACY);
    assert.equal(validateRoadLaneLayout({ width: 4, laneCount: 1, bidirectional: true }).ok, true);
});

test("ED-05 the road domain validator scopes lane issues to the edge and rejects lanes on v1 roads", () => {
    const v2 = straightV2({ lanes: [{ id: "x", direction: 1, width: 0 }, { id: "y", direction: -1, width: 11 }] });
    const result = validateRoadDomain(v2.roads);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((entry) => [entry.code, entry.path, entry.objectId]), [
        [LANE_LAYOUT_ISSUE_CODES.WIDTH_INVALID, ["roads", "edges", 0, "lanes", 0, "width"], "ab"],
    ]);
    const v1 = { nodes: v2.roads.nodes, edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", width: 11, laneCount: 3, bidirectional: true, lanes: ASYMMETRIC_LANES }] };
    const legacy = validateRoadDomain(v1);
    assert.ok(legacy.issues.some((entry) => entry.code === LANE_LAYOUT_ISSUE_CODES.VERSION_REQUIRED));
    assert.throws(() => createWorldDescription(worldInput(v1)), /geometry version 2/);
    assert.equal(validateRoadDomain(straightV2({ lanes: ASYMMETRIC_LANES }).roads).ok, true);
});

test("ED-05 explicit lanes survive document snapshots and metric projection drops markings", () => {
    const lanes = [{ ...ASYMMETRIC_LANES[0], markingLeft: "dashed_white" }, ...ASYMMETRIC_LANES.slice(1)];
    const document = new EnvironmentDocument(straightV2({ lanes }));
    assert.deepEqual(document.getEdge("ab").lanes, lanes);
    assert.notEqual(document.getEdge("ab").lanes, lanes);
    const snapshot = document.snapshot();
    assert.deepEqual(snapshot.roads.edges[0].lanes, lanes);
    assert.equal("lanes" in new EnvironmentDocument(straightV2({ laneCount: 2 })).snapshot().roads.edges[0], false, "implicit edges never gain a lanes key");
    const metric = normalizeMetricRoads(document.snapshot().roads);
    assert.deepEqual(metric.edges[0].lanes, ASYMMETRIC_LANES);
});

test("ED-05 lane identity enters the road-network and world hashes only when explicit", async () => {
    const fixture = await curvedFixture();
    const implicit = { environmentId: fixture.environmentId, roads: fixture.roads };
    const materialized = structuredClone(implicit);
    materialized.roads.edges[0].lanes = explicitRoadLanes(materialized.roads.edges[0]);
    normalizeRoadLanes(materialized.roads.edges[0]);
    assert.equal(materialized.roads.edges[0].lanes, undefined);
    assert.equal(hashEnvironmentRoadNetwork(materialized), hashEnvironmentRoadNetwork(implicit));
    assert.equal(hashWorldDescription(createWorldDescription(worldInput(materialized.roads, "curved-elevated"))), hashWorldDescription(createWorldDescription(worldInput(implicit.roads, "curved-elevated"))));

    const asymmetric = structuredClone(implicit);
    asymmetric.roads.edges[0].lanes = [
        { id: "lane-0", direction: 1, width: 3 },
        { id: "lane-1", direction: 1, width: 2 },
        { id: "lane-2", direction: -1, width: 3, markingLeft: "none" },
    ];
    normalizeRoadLanes(asymmetric.roads.edges[0]);
    assert.equal(asymmetric.roads.edges[0].width, 8);
    assert.notEqual(hashEnvironmentRoadNetwork(asymmetric), hashEnvironmentRoadNetwork(implicit));
    const marked = structuredClone(asymmetric);
    marked.roads.edges[0].lanes[0].markingLeft = "solid_yellow";
    assert.equal(hashEnvironmentRoadNetwork(marked), hashEnvironmentRoadNetwork(asymmetric), "markings are appearance-only");

    const world = createWorldResource(worldInput(asymmetric.roads, "curved-elevated"));
    assert.deepEqual(world.description.roads.edges[0].lanes, [
        { id: "lane-0", direction: 1, width: 3 },
        { id: "lane-1", direction: 1, width: 2 },
        { id: "lane-2", direction: -1, width: 3 },
    ]);
    assert.equal(world.description.roads.edges[0].laneCount, 3);
    assert.equal(world.description.roads.edges[0].bidirectional, true);
    assert.doesNotThrow(() => assertWorldResource(world));
    assert.equal(hashWorldDescription(createWorldDescription(worldInput(marked.roads, "curved-elevated"))), world.hash, "world identity ignores markings");
    // The drivable strip depends only on the total width, so it is byte-equal
    // to the implicit two-lane road of the same width.
    const implicitWorld = createWorldResource(worldInput(implicit.roads, "curved-elevated"));
    assert.deepEqual(world.description.drivableSurfaces, implicitWorld.description.drivableSurfaces);
    assert.notEqual(world.hash, implicitWorld.hash);
});

test("ED-05 per-lane widths move lane centerlines without touching the compiled road strip", () => {
    const implicit = { id: "ab", startNodeId: "a", endNodeId: "b", width: 11, laneCount: 1, bidirectional: true, geometry: { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] } };
    const nodes = new Map([["a", { id: "a", x: 0, y: 0, z: 0 }], ["b", { id: "b", x: 40, y: 0, z: 0 }]]);
    const resolve = (edge) => ({ ...edge, spans: [{ kind: "polyline", p0: nodes.get("a"), p1: nodes.get("b") }] });
    const base = buildRoadSurface(resolve(implicit));
    const explicit = buildRoadSurface(resolve({ ...implicit, laneCount: 3, lanes: ASYMMETRIC_LANES }));
    assert.deepEqual(explicit.vertices, base.vertices);
    assert.deepEqual(explicit.indices, base.indices);
    assert.equal(explicit.laneCenterlines.length, 3);
    assert.deepEqual(explicit.laneCenterlines.map((line) => line[0].z), [3.75, 0.25, -3.5]);
});

test("ED-05 an explicit three-lane two-way road routes in both directions and verifies", () => {
    const environment = straightV2({ lanes: ASYMMETRIC_LANES });
    const graph = buildDirectedRoadGraph(environment);
    assert.deepEqual(graph.adjacency.get("a").map((step) => step.direction), [1]);
    assert.deepEqual(graph.adjacency.get("b").map((step) => step.direction), [-1]);
    assert.equal(graph.laneIssues.length, 0);

    const forward = verifyRoute(environment, [
        { id: "start", x: 2, z: 0, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "fixed", laneIndex: 1 } },
        { id: "finish", x: 38, z: 0, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "fixed", laneIndex: 1 } },
    ]);
    assert.equal(forward.ok, true, JSON.stringify(forward.issues));
    assert.ok(forward.route.polyline.every((point) => Math.abs(point.z - 0.25) < 1e-6), "the inner forward lane centre sits at +0.25 m");

    const backward = verifyRoute(environment, [
        { id: "start", x: 38, z: -3.4, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "auto" } },
        { id: "finish", x: 2, z: -3.4, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "auto" } },
    ]);
    assert.equal(backward.ok, true, JSON.stringify(backward.issues));
    assert.equal(backward.route.edgeTraversal[0].direction, -1);
    assert.equal(backward.route.edgeTraversal[0].fromLaneIndex, 2);
    assert.ok(backward.route.polyline.every((point) => Math.abs(point.z + 3.5) < 1e-6), "the single reverse lane centre sits at -3.5 m");

    // Fixed forward-lane anchors travelling backwards are legal only through
    // the degree-1 endpoint U-turns; every reverse step must use the single
    // reverse lane and every forward step one of the two forward lanes.
    const uTurn = verifyRoute(environment, [
        { id: "start", x: 38, z: 0, anchor: { kind: "road", id: "ab", fraction: 0.95, laneMode: "fixed", laneIndex: 0 } },
        { id: "finish", x: 2, z: 0, anchor: { kind: "road", id: "ab", fraction: 0.05, laneMode: "fixed", laneIndex: 0 } },
    ]);
    assert.equal(uTurn.ok, true);
    assert.deepEqual(uTurn.route.edgeTraversal.map((step) => step.direction), [1, -1, 1]);
    for (const step of uTurn.route.edgeTraversal) {
        const legal = step.direction === -1 ? [2] : [0, 1];
        assert.ok(legal.includes(step.fromLaneIndex) && legal.includes(step.toLaneIndex), JSON.stringify(step));
    }
});
