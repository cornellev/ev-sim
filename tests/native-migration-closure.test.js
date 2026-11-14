import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageService } from "../server/storage/StorageService.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createDefaultVehicleManifest, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { createSensorDefinitionRegistry } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { createPluginRangeImageFixtureSensor } from "./helpers/headlessRunnerBundle.js";
import { verifyRunBundleIntegrity } from "../server/headless/RunBundle.js";

test("reviewed native adoption creates a vehicle and sensor package closure without rewriting originals", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cev-native-closure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = new StorageService(root);
    const old = await pluginFixtureResource({ fixture: "test.range-image-fixture" });
    const replacement = await pluginFixtureResource({ fixture: "test.range-image-fixture", mutateDocument(document) {
        document.version = "2.0.0"; document.sensorTypes[0].sensorAbi = 2;
        for (const product of document.sensorTypes[0].products) if (product.kind === "pointCloud") { delete product.rosType; product.valueContract = { id: "cev.points", version: 1 }; }
    }, mutateFiles(files) { files["runtime/index.js"] = new TextEncoder().encode(new TextDecoder().decode(files["runtime/index.js"]).replaceAll("buildPointCloud2", "buildNativePoints")); } });
    await storage.plugins.putPackage(old); await storage.plugins.putPackage(replacement);
    const verified = verifyPluginPackage(old);
    const registry = createSensorDefinitionRegistry([verified]);
    const sensor = createPluginRangeImageFixtureSensor();
    const vehicle = await storage.createVehicleManifest(normalizeVehicleManifest({ ...createDefaultVehicleManifest({ id: "old-plugin-car", sensors: [] }), sensors: [sensor], pluginLocks: [{ pluginId: verified.document.id, version: verified.document.version, packageHash: old.packageHash, runtimeHash: old.runtimeHash, sensorTypes: [sensor.type] }] }, { sensorRegistry: registry }));
    const manifest = createDefaultRunManifest({ version: 12, id: "closure", sensorRig: { sensors: [] }, scripts: { enabled: false }, initialState: { vehicles: [{ id: "ego", type: vehicle.id }], signals: {} }, plugins: { enabled: true, artifacts: [{ pluginId: verified.document.id, expectedHash: old.packageHash, capabilities: verified.document.capabilities }] } });
    const stored = await storage._writeRunManifest(manifest.id, manifest, { expectedRevision: 0, create: true });
    const original = structuredClone(await storage.getVehicleManifest(vehicle.id));
    const plan = await storage.planNativeRunMigration(stored.id, { pluginReplacements: { [old.packageHash]: replacement.packageHash } });
    assert.equal(plan.ok, true, JSON.stringify(plan.blocked));
    assert.equal(plan.vehiclePlans.length, 1);
    const adopted = await storage.applyNativeRunMigration(stored.id, { plan, expectedRevision: stored.revision });
    assert.notEqual(adopted.manifest.initialState.vehicles[0].type, vehicle.id);
    assert.deepEqual(await storage.getVehicleManifest(vehicle.id), original);
    const bundle = await storage.exportRunManifest(stored.id);
    verifyRunBundleIntegrity(bundle);
    assert.equal(bundle.resolved.pluginPackages[0].packageHash, replacement.packageHash);
    assert.equal(bundle.resolved.vehicles[0].manifest.pluginLocks[0].packageHash, replacement.packageHash);
});
