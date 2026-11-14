import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { createRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { proposeSensorWiring } from "../app/simulation/sensors/SensorWiring.js";
import { RunSessionController } from "../app/simulation/RunSessionController.js";
import { HeadlessExternalSession } from "../server/headless/HeadlessExternalSession.js";
import { verifyRunBundle, verifyRunBundleIntegrity } from "../server/headless/RunBundle.js";
import { StorageService } from "../server/storage/StorageService.js";
import { createPlanningBundle } from "../server/headless/PlanningBundle.js";
import { createPortableHeadlessBundle } from "./helpers/headlessRunnerBundle.js";

test("native defaults write v13/scenario v2 and historical imports require reviewed migration", async (t) => {
    assert.equal(createDefaultRunManifest().version, 13);
    assert.equal(createDefaultScenario().version, 2);
    const root = await mkdtemp(path.join(os.tmpdir(), "cev-native-cutover-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = new StorageService(root);
    const bundle = await createPortableHeadlessBundle({ native: false });
    verifyRunBundleIntegrity(bundle);
    assert.throws(() => verifyRunBundle(bundle), /reviewed native migration/);
    await assert.rejects(storage.createRunManifest(bundle.manifest), /reviewed native migration/);
    const imported = await storage.importRunBundle(bundle);
    await assert.rejects(storage.putRunManifest(imported.id, { manifest: imported }), /reviewed native migration/);
    await assert.rejects(storage.duplicateRunManifest(imported.id), /reviewed native migration/);
    const plan = await storage.planNativeRunMigration(imported.id);
    assert.equal(plan.ok, true, JSON.stringify(plan.blocked));
    await storage.applyNativeRunMigration(imported.id, { plan, expectedRevision: plan.baseRevision });
    verifyRunBundle(await storage.exportRunManifest(imported.id));
});

test("sensor wiring removes registry schemas even when outputs are already assigned", () => {
    const manifest = createDefaultRunManifest();
    manifest.sensorRig.sensors.push(createRunSensor("imu", { id: "new-imu", outputs: { imuTopicId: "imu" } }));
    const proposed = proposeSensorWiring(manifest).manifest;
    assert.equal(proposed.sensorRig.sensors.at(-1).schema, undefined);
    assert.ok(manifest.sensorRig.sensors.at(-1).schema);
});

test("new planning bundles use a native template and explicit historical templates require adoption", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cev-native-planning-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = new StorageService(root);
    await storage._writeRunManifest("igvc-default", createDefaultRunManifest({ version: 12 }));
    const bundle = await createPlanningBundle({ dataDir: root, finish: "none" });
    assert.equal(bundle.resolved.version, 13);
    await assert.rejects(createPlanningBundle({ dataDir: root, sourceManifestId: "igvc-default" }), /reviewed native migration/);
});

test("ownership loss pauses browser and headless execution before optional control ports", () => {
    let paused = 0;
    const controller = new RunSessionController();
    controller.pause = async () => { paused++; };
    controller.data = { simulation: () => ({ inputQueue: { reset() { throw new Error("port failed"); } } }) };
    controller._beginControlOwnership({ leaseId: "lease", runId: null, remainingMs: 750, status: "active", mode: "autonomous", target: { vehicleId: "ego" } });
    try {
        assert.throws(() => controller.ownershipGuard._lose("test"), /port failed/);
        assert.equal(paused, 1);
    } finally { controller.ownershipGuard.close(); }
    const headless = {
        state: "running", pause: async () => { paused++; },
        ownershipGuard: { lease: { vehicleId: "ego" } },
        kernel: { pause() { paused++; }, inputQueue: { reset() { throw new Error("port failed"); } } },
    };
    assert.throws(() => HeadlessExternalSession.prototype._ownershipStop.call(headless), /port failed/);
    assert.equal(paused, 3);
});
