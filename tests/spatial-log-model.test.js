import test from "node:test";
import assert from "node:assert/strict";

import {
    buildSpatialLogModel,
    discoverVehiclePosePaths,
    routePolylinePoints,
    trailSegmentForTime,
} from "../app/spatial/spatialLogModel.js";
import { simplifyTrajectory, headingFromPose, headingWedgeWorldPoints, worldPointFromPose } from "../app/spatial/trajectorySimplify.js";
import { vehicleForwardTangent } from "../app/scenarios/route/geometry.js";
import { compareWorldCompatibility, buildComparisonTrails } from "../app/spatial/spatialComparison.js";

test("discoverVehiclePosePaths finds pose3 vehicle channels", () => {
    const paths = discoverVehiclePosePaths([
        { path: "vehicles.ego.pose", type: "pose3" },
        { path: "vehicles.npc-1.pose", type: "pose3" },
        { path: "simulation.time", type: "float64" },
    ]);
    assert.deepEqual(paths.map((entry) => entry.path), ["vehicles.ego.pose", "vehicles.npc-1.pose"]);
});

test("simplifyTrajectory preserves endpoints and reduces dense paths", () => {
    const samples = Array.from({ length: 500 }, (_, index) => ({
        timeUs: index * 1000,
        cycle: index,
        position: { x: index, y: 0, z: Math.sin(index / 20) * 2 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    }));
    const simplified = simplifyTrajectory(samples, 40);
    assert.equal(simplified[0].timeUs, 0);
    assert.equal(simplified.at(-1).timeUs, 499000);
    assert.ok(simplified.length <= 40);
    assert.ok(simplified.length >= 2);
});

test("trailSegmentForTime respects history windows", () => {
    const samples = [
        { timeUs: 0, position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 } },
        { timeUs: 20_000_000, position: { x: 1, y: 0, z: 0 }, rotation: { y: 0 } },
        { timeUs: 40_000_000, position: { x: 2, y: 0, z: 0 }, rotation: { y: 0 } },
    ];
    const full = trailSegmentForTime(samples, 40_000_000, "full");
    const windowed = trailSegmentForTime(samples, 40_000_000, "30s");
    assert.equal(full.length, 3);
    assert.equal(windowed.length, 2);
    assert.equal(windowed[0].timeUs, 20_000_000);
});

test("buildSpatialLogModel exposes route polyline and cursor pose", () => {
    const model = buildSpatialLogModel({
        environment: { roads: { nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }], edges: [] }, buildings: [], features: [] },
        resolvedRun: {
            scenario: {
                kind: "cev-sim.scenario",
                routes: [{
                    actorId: "ego",
                    verification: { polyline: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 10, z: 0 }] },
                }],
                actors: [{ id: "ego", role: "ego" }],
            },
        },
        trails: [{
            entityId: "ego",
            path: "vehicles.ego.pose",
            samples: [
                { timeUs: 0, position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 } },
                { timeUs: 1_000_000, position: { x: 2, y: 0, z: 0 }, rotation: { y: 0.2 } },
            ],
        }],
        events: [{ timeUs: 500_000, category: "simulation", name: "tick" }],
        timeUs: 1_000_000,
    });
    assert.equal(routePolylinePoints(model.route).length, 3);
    assert.equal(model.cursor.position.x, 2);
    assert.equal(model.trails[0].segment.length, 2);
    assert.equal(model.events.length, 1);
    assert.ok(model.fitPoints.length >= 3);
    const lastSample = model.trails[0].segment.at(-1);
    assert.equal(lastSample.position.x, model.cursor.position.x);
    assert.equal(lastSample.position.z, model.cursor.position.z);
});

test("heading wedge uses plant-forward -sin(yaw)", () => {
    const origin = { x: 10, z: 4 };
    const alongX = headingWedgeWorldPoints(origin, 0, 2);
    assert.ok(Math.abs(alongX.tip.x - 12) < 1e-5);
    assert.ok(Math.abs(alongX.tip.z - 4) < 1e-5);

    const alongMinusZ = headingWedgeWorldPoints(origin, Math.PI / 2, 2);
    assert.ok(Math.abs(alongMinusZ.tip.x - 10) < 1e-5);
    assert.ok(Math.abs(alongMinusZ.tip.z - 2) < 1e-5);

    const pose = { position: { x: 3, y: 1, z: -1 }, rotation: { y: 0.4 } };
    const heading = headingFromPose(pose);
    const tip = headingWedgeWorldPoints(worldPointFromPose(pose), heading, 1).tip;
    const tangent = vehicleForwardTangent(heading);
    assert.ok(Math.abs((tip.x - 3) - tangent.x) < 1e-5);
    assert.ok(Math.abs((tip.z + 1) - tangent.z) < 1e-5);
    assert.ok(tangent.z < 0);
});

test("compareWorldCompatibility rejects mismatched resolved hashes", () => {
    const result = compareWorldCompatibility([
        { worldHash: "aaa" },
        { worldHash: "bbb" },
    ]);
    assert.equal(result.compatible, false);
    assert.match(result.reason, /different resolved runs/i);
});

test("buildComparisonTrails applies offsets for aligned playback", () => {
    const trails = buildComparisonTrails([
        {
            logId: "a",
            offsetUs: 1_000_000,
            samples: [{ timeUs: 0, position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 } }],
        },
    ]);
    assert.equal(trails[0].samples[0].timeUs, 1_000_000);
});
