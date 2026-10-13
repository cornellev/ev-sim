import assert from "node:assert/strict";
import test from "node:test";

import { createPlanningBundle, firstClearRouteIndex, yawFromDirection } from "../server/headless/PlanningBundle.js";

function stripVolatile(value) {
    if (Array.isArray(value)) return value.map(stripVolatile);
    if (!value || typeof value !== "object") return value;
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
        if (["exportedAt", "createdAt", "updatedAt"].includes(key)) continue;
        copy[key] = stripVolatile(entry);
    }
    return copy;
}

test("planning bundle clearance skips an obstacle on the first pose", () => {
    const polyline = [
        { x: 0, z: 0 },
        { x: 2, z: 0 },
        { x: 4, z: 0 },
    ];
    const obstacles = [{
        footprint: [
            { x: -1, z: -1 },
            { x: 1, z: -1 },
            { x: 1, z: 1 },
            { x: -1, z: 1 },
        ],
    }];
    const index = firstClearRouteIndex(polyline, { x: 1, z: 0.5 }, obstacles);
    assert.equal(index, 1);
    assert.ok(yawFromDirection(1, 0) === 0);
});

test("create-bundle is deterministic, validated, and starts clear of obstacles", async () => {
    const [first, second] = await Promise.all([
        createPlanningBundle({ bundleId: "planning-route" }),
        createPlanningBundle({ bundleId: "planning-route" }),
    ]);
    assert.deepEqual(stripVolatile(first), stripVolatile(second));
    assert.equal(first.kind, "cev-sim.run-bundle");
    assert.equal(first.manifest.id, "planning-route");
    const sensors = first.manifest.sensorRig.sensors.map((sensor) => sensor.type).sort();
    assert.deepEqual(sensors, ["gnss", "imu", "wheel-odometry"]);
    const pose = first.manifest.initialState.vehicles[0].pose.position;
    const yaw = first.manifest.initialState.vehicles[0].pose.rotation.y;
    const size = first.resolved.vehicles[0].manifest.boundingBox.size;
    assert.equal(firstClearRouteIndex([
        pose,
        { x: pose.x + Math.cos(yaw), z: pose.z - Math.sin(yaw) },
    ], size, first.resolved.world.description.obstacles), 0);
    assert.ok(first.resolved.scenario.scenario.routes[0].verification.totalLength > 0);
    assert.match(first.resolvedHash, /^[0-9a-f]{64}$/);
});
