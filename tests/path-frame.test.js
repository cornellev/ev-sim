import assert from "node:assert/strict";
import test from "node:test";

import { linspace, sampleRoadFrame, sampleRouteFrame } from "../app/roads/PathFrame.js";

const NORTH_ROUTE = {
    waypoints: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 10 },
    ],
};

const NORTH_ROAD_WORLD = {
    roads: {
        nodes: [
            { id: "n0", x: 0, y: 0, z: 0 },
            { id: "n1", x: 0, y: 0, z: 10 },
        ],
        edges: [{ id: "e0", startNodeId: "n0", endNodeId: "n1" }],
    },
};

test("linspace is inclusive, empty for non-finite, and capped", () => {
    assert.deepEqual(linspace(0, 1, 3), [0, 0.5, 1]);
    assert.deepEqual(linspace(4, 4, 1), [4]);
    assert.deepEqual(linspace(0, 1, 0), []);
    assert.deepEqual(linspace(Number.NaN, 1, 4), []);
    assert.equal(linspace(0, 1, 5000).length, 4096);
});

test("sampleRouteFrame offsets +lateral to the right of travel", () => {
    const center = sampleRouteFrame(NORTH_ROUTE, 0.5, 0);
    assert.equal(center.found, true);
    assert.ok(Math.abs(center.pose.position.x) < 1e-9);
    assert.ok(Math.abs(center.pose.position.z - 5) < 1e-9);
    assert.equal(center.heading, 0);

    const right = sampleRouteFrame(NORTH_ROUTE, 0.5, 1);
    assert.equal(right.found, true);
    assert.ok(Math.abs(right.pose.position.x + 1) < 1e-9);
    assert.ok(Math.abs(right.pose.position.z - 5) < 1e-9);
    assert.deepEqual(right.normal, { x: -1, y: 0, z: 0 });

    const missing = sampleRouteFrame({ waypoints: [] }, 0.5, 1);
    assert.equal(missing.found, false);
    assert.deepEqual(missing.pose.position, { x: 0, y: 0, z: 0 });
});

test("sampleRoadFrame follows the same right-normal as route frames", () => {
    const right = sampleRoadFrame(NORTH_ROAD_WORLD, "e0", 0.5, 1);
    assert.equal(right.found, true);
    assert.ok(Math.abs(right.pose.position.x + 1) < 1e-9);
    assert.ok(Math.abs(right.pose.position.z - 5) < 1e-9);

    assert.equal(sampleRoadFrame(NORTH_ROAD_WORLD, "missing", 0.5, 0).found, false);
    assert.equal(sampleRoadFrame(null, "e0", 0.5, 0).found, false);
});
