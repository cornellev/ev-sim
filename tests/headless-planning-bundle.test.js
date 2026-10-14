import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { createPlanningBundle, firstClearRouteIndex, yawFromDirection } from "../server/headless/PlanningBundle.js";
import { StorageService } from "../server/storage/StorageService.js";

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
    assert.equal(first.resolved.scenario.scenario.triggers[0].condition.kind, "zone-enter");
});

test("finish none keeps a verified route and does not end at the far end", async () => {
    const bundle = await createPlanningBundle({ finish: "none", bundleId: "free-drive" });
    const scenario = bundle.resolved.scenario.scenario;
    assert.equal(scenario.zones.length, 0);
    assert.equal(scenario.triggers.length, 1);
    assert.equal(scenario.triggers[0].condition.kind, "flag");
    assert.equal(scenario.triggers[0].condition.flag, "cev-sim.free-drive.stop");
    assert.equal(scenario.triggers[0].actions[0].kind, "finish");
    assert.equal(scenario.completion.conditions.length, 0);
    assert.ok(scenario.routes[0].verification.totalLength > 0);
    assert.equal(bundle.manifest.scenario.egoVehicleId, "big-car");
});

test("a stored vehicle is copied and its box is used for clearance", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-planning-vehicle-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const storage = new StorageService(dataDir);
    await storage.createVehicleManifest(createDefaultVehicleManifest({
        id: "slim-car",
        name: "Slim Car",
        boundingBox: {
            size: { x: 2.2, y: 1.2, z: 1.6 },
            center: { x: 0, y: 0.6, z: 0 },
        },
    }));
    await storage.createVehicleManifest(createDefaultVehicleManifest({
        id: "huge-car",
        name: "Huge Car",
        boundingBox: {
            size: { x: 80, y: 2, z: 80 },
            center: { x: 0, y: 1, z: 0 },
        },
    }));
    const bundle = await createPlanningBundle({
        dataDir,
        vehicleId: "slim-car",
        bundleId: "slim",
    });
    const resolved = bundle.resolved.vehicles.find((entry) => entry.actorId === "ego");
    assert.equal(resolved.vehicleId, "slim-car");
    assert.equal(resolved.manifest.boundingBox.size.x, 2.2);
    assert.equal(resolved.manifest.boundingBox.size.z, 1.6);
    const pose = bundle.manifest.initialState.vehicles[0].pose.position;
    const yaw = bundle.manifest.initialState.vehicles[0].pose.rotation.y;
    const obstacles = bundle.resolved.world.description.obstacles;
    assert.equal(firstClearRouteIndex([
        pose,
        { x: pose.x + Math.cos(yaw), z: pose.z - Math.sin(yaw) },
    ], resolved.manifest.boundingBox.size, obstacles), 0);
    const polyline = bundle.resolved.scenario.scenario.routes[0].verification.polyline;
    assert.equal(firstClearRouteIndex(polyline, { x: 80, z: 80 }, obstacles), -1);
    await assert.rejects(
        () => createPlanningBundle({ dataDir, vehicleId: "huge-car", bundleId: "huge" }),
        /no start pose clear of obstacles/,
    );
});

test("a manifest without state sensors receives the localization rig", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-planning-sensors-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const storage = new StorageService(dataDir);
    const source = await storage.getRunManifest("igvc-default");
    const stripped = structuredClone(source);
    stripped.sensorRig.sensors = [];
    stripped.topics = stripped.topics.filter((topic) => !["imu", "gnss", "wheel-odometry"].includes(topic.id));
    await storage.putRunManifest("igvc-default", {
        manifest: stripped,
        expectedRevision: source.revision,
    });
    const bundle = await createPlanningBundle({ dataDir, bundleId: "restored-sensors" });
    assert.deepEqual(
        bundle.manifest.sensorRig.sensors.map((sensor) => sensor.type).sort(),
        ["gnss", "imu", "wheel-odometry"],
    );
    const topicIds = new Set(bundle.manifest.topics.map((topic) => topic.id));
    assert.equal(topicIds.has("imu") && topicIds.has("gnss") && topicIds.has("wheel-odometry"), true);
});
