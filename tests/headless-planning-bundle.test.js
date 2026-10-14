import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stampVehiclePluginPlantLock } from "../app/plugin/PluginSensorAuthoring.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { PluginRunSession, PLG03_RUNTIME_CAPABILITIES } from "../app/plugin/PluginRunSession.js";
import { HeadlessVehicleManager } from "../app/simulation/headless/HeadlessVehicleManager.js";
import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { createPlanningBundle, firstClearRouteIndex, yawFromDirection } from "../server/headless/PlanningBundle.js";
import { StorageService } from "../server/storage/StorageService.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

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
    assert.deepEqual(first.resolved.identityProfile, { id: "world-bound", version: 2 });
    assert.equal(first.resolved.pluginPackages, undefined);
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

test("a vehicle dynamics plant is copied into the planning bundle and steps", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-planning-plant-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const storage = new StorageService(dataDir);
    const resource = await pluginFixtureResource({ fixture: "test.plant-fixture" });
    const verified = verifyPluginPackage(resource);
    await storage.plugins.putPackage(resource);
    const plantId = verified.document.plants[0].id;
    await storage.createVehicleManifest(createDefaultVehicleManifest({
        id: "plant-car",
        name: "Plant Car",
        dynamics: { plant: plantId },
        pluginLocks: stampVehiclePluginPlantLock(undefined, {
            pluginId: verified.document.id,
            version: verified.document.version,
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            plantId,
        }),
    }));
    const bundle = await createPlanningBundle({ dataDir, vehicleId: "plant-car", bundleId: "plant-route" });
    const ego = bundle.resolved.vehicles.find((entry) => entry.actorId === "ego");
    assert.equal(ego.manifest.dynamics.plant, plantId);
    assert.deepEqual(bundle.resolved.identityProfile, { id: "world-bound-plugins", version: 1 });
    assert.equal(bundle.resolved.plugins[0].pluginId, verified.document.id);
    assert.equal(bundle.resolved.plugins[0].packageHash, resource.packageHash);
    assert.deepEqual(bundle.manifest.plugins.artifacts[0].capabilities, ["plant.step"]);
    assert.equal(bundle.resolved.pluginPackages.length, 1);
    assert.equal(verifyPluginPackage(bundle.resolved.pluginPackages[0]).document.id, verified.document.id);
    const session = await new PluginRunSession({
        moduleSource: { async importRuntime() { throw new Error("unexpected import"); } },
        plugins: bundle.resolved.plugins,
        availableCapabilities: PLG03_RUNTIME_CAPABILITIES,
    }).prepareDefinitions(bundle.resolved.pluginPackages);
    t.after(() => session.dispose());
    const manager = new HeadlessVehicleManager();
    await manager.configureFromManifest(bundle.manifest.initialState.vehicles, null, {
        plants: session.plants,
        resolvedVehicles: bundle.resolved.vehicles,
    });
    const before = manager.vehicles[0].position.x;
    manager.vehicles[0].acceleration.x = 1;
    manager.update(0.02);
    assert.notEqual(manager.vehicles[0].position.x, before);
});

test("a dynamics plant without a lock or an installed package fails before export", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-planning-plant-fail-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const storage = new StorageService(dataDir);
    await storage.createVehicleManifest(createDefaultVehicleManifest({
        id: "plain-car",
        name: "Plain Car",
    }));
    const vehiclePath = path.join(dataDir, "vehicles", "plain-car.json");
    const stored = JSON.parse(await fs.readFile(vehiclePath, "utf8"));
    stored.dynamics = { plant: "test.plant-fixture.bicycle" };
    delete stored.pluginLocks;
    await fs.writeFile(vehiclePath, JSON.stringify(stored));
    await assert.rejects(
        () => createPlanningBundle({ dataDir, vehicleId: "plain-car", bundleId: "unlocked" }),
        /no matching plugin lock/,
    );

    const resource = await pluginFixtureResource({ fixture: "test.plant-fixture" });
    const verified = verifyPluginPackage(resource);
    await storage.plugins.putPackage(resource);
    const plantId = verified.document.plants[0].id;
    await storage.createVehicleManifest(createDefaultVehicleManifest({
        id: "plant-car",
        name: "Plant Car",
        dynamics: { plant: plantId },
        pluginLocks: stampVehiclePluginPlantLock(undefined, {
            pluginId: verified.document.id,
            version: verified.document.version,
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            plantId,
        }),
    }));
    await fs.rm(path.join(dataDir, "plugins", "cas", "sha256", resource.packageHash), { recursive: true, force: true });
    await assert.rejects(
        () => createPlanningBundle({ dataDir, vehicleId: "plant-car", bundleId: "missing-package" }),
        /must be installed in the data directory/,
    );
});
