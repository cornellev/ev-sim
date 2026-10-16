import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { attachVehiclePlant, stepVehiclePlant } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { PLUGIN_ERROR_CODES } from "../app/plugin/PluginErrors.js";
import { PluginRunSession, PLG03_RUNTIME_CAPABILITIES } from "../app/plugin/PluginRunSession.js";
import { HeadlessVehicleManager } from "../app/simulation/headless/HeadlessVehicleManager.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { compilePlantModules, createPlantStepper } from "../app/simulation/vehicles/WasmPlantStepper.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { pluginFixtureFiles, pluginFixtureResource } from "./helpers/pluginFixtures.js";
import { createPluginPackage, verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import {
    encodeCountingPlantModule,
    encodeFailingPlantModule,
    encodeNonFinitePlantModule,
} from "../scripts/plant-wasm-module.mjs";

const PLANT_ID = "test.plant-fixture.bicycle";

function entry(overrides = {}) {
    return {
        id: "ego",
        type: "big-car",
        pose: { position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0.2, z: 0, order: "XYZ" } },
        linearVelocity: { x: 3, y: 0, z: 0 },
        linearAcceleration: { x: 1, y: 0, z: 0 },
        steeringAngle: 0.1,
        ...overrides,
    };
}

function plantManifest() {
    const manifest = structuredClone(getBuiltInVehicleManifest("big-car"));
    manifest.dynamics = { plant: PLANT_ID };
    return manifest;
}

function mutableVector(source = {}, withOrder = false) {
    return {
        x: Number(source.x) || 0,
        y: Number(source.y) || 0,
        z: Number(source.z) || 0,
        ...(withOrder ? { order: source.order || "XYZ" } : {}),
        set(x, y, z, order = this.order) {
            Object.assign(this, { x, y, z });
            if (withOrder) this.order = order || "XYZ";
            return this;
        },
        copy(value) {
            return this.set(value.x, value.y, value.z, value.order);
        },
    };
}

async function loadPlants(t, mutateFiles = null) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plant-run-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new PluginStore(root);
    const resource = mutateFiles
        ? createPluginPackage(mutateFiles(await pluginFixtureFiles("test.plant-fixture")))
        : await pluginFixtureResource({ fixture: "test.plant-fixture" });
    const verified = verifyPluginPackage(resource);
    await store.putPackage(resource);
    const session = await new PluginRunSession({
        moduleSource: { async importRuntime() { throw new Error("unexpected import"); } },
        plugins: [{
            pluginId: verified.document.id,
            version: verified.document.version,
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            capabilities: ["plant.step"],
        }],
        availableCapabilities: PLG03_RUNTIME_CAPABILITIES,
    }).prepareDefinitions([resource]);
    t.after(() => session.dispose());
    return session.plants;
}

test("wasm bicycle matches the javascript plant and the browser adapter within 1e-9", async (t) => {
    const plants = await loadPlants(t);
    const manifest = plantManifest();
    const initial = entry();
    const headless = new HeadlessVehicleManager();
    await headless.configureFromManifest([initial], null, {
        plants,
        resolvedVehicles: [{ actorId: initial.id, vehicleId: initial.type, manifest }],
    });
    const javascript = new KinematicVehiclePlant(createVehiclePlantDefinition(initial, { manifest: getBuiltInVehicleManifest("big-car") }));
    const compiled = await compilePlantModules(plants);
    const browser = {
        telemetryId: initial.id,
        position: mutableVector(initial.pose.position),
        rotation: mutableVector(initial.pose.rotation, true),
        velocity: mutableVector(initial.linearVelocity),
        acceleration: mutableVector(initial.linearAcceleration),
        steeringAngle: initial.steeringAngle,
        updatePosition(value) { this.position.copy(value); },
        updateRotation(value) { this.rotation.copy(value); },
    };
    attachVehiclePlant(browser, initial, { manifest }, {
        plantPluginId: plants.get(PLANT_ID).ownership.pluginId,
        plantRuntimeHash: plants.get(PLANT_ID).ownership.runtimeHash,
        stepper: createPlantStepper(compiled.get(PLANT_ID), plants.get(PLANT_ID), manifest),
    });
    const tape = [
        { dt: 0.02, acceleration: 0.4, steering: 0.05 },
        { dt: 0.02, acceleration: -0.2, steering: -0.1 },
        { dt: 0.02, acceleration: 1, steering: 0.2 },
        { dt: 0.02, acceleration: 0, steering: 0 },
        { dt: 0.02, acceleration: 0.25, steering: 0.15 },
        { dt: 0.02, acceleration: -0.5, steering: -0.05 },
    ];
    for (const action of tape) {
        for (const plant of [headless.vehicles[0], javascript, browser.plant]) {
            plant.acceleration.x = action.acceleration;
            plant.steeringAngle = action.steering;
        }
        headless.update(action.dt);
        javascript.update(action.dt);
        stepVehiclePlant(browser, action.dt);
        for (const field of ["x", "z"]) {
            assert.ok(Math.abs(headless.vehicles[0].position[field] - javascript.position[field]) <= 1e-9);
            assert.ok(Math.abs(browser.plant.position[field] - javascript.position[field]) <= 1e-9);
        }
        assert.ok(Math.abs(headless.vehicles[0].rotation.y - javascript.rotation.y) <= 1e-9);
        assert.ok(Math.abs(browser.plant.rotation.y - javascript.rotation.y) <= 1e-9);
        assert.ok(Math.abs(headless.vehicles[0].velocity.x - javascript.velocity.x) <= 1e-9);
    }
});

test("an unresolved plugin plant does not move and a missing resolved plant fails", async (t) => {
    const plants = await loadPlants(t);
    const manifest = plantManifest();
    const initial = entry();
    const preview = new HeadlessVehicleManager();
    await preview.configureFromManifest([initial], null, {
        resolvedVehicles: [{ actorId: initial.id, vehicleId: initial.type, manifest }],
    });
    const before = preview.vehicles[0].position.x;
    preview.update(0.5);
    assert.equal(preview.vehicles[0].position.x, before);
    assert.match(preview.vehicles[0].dynamicsStatus, /resolved run/);
    const resolved = new HeadlessVehicleManager();
    await assert.rejects(() => resolved.configureFromManifest([initial], null, {
        plants: new Map(),
        resolvedVehicles: [{ actorId: initial.id, vehicleId: initial.type, manifest }],
    }), (error) => error.code === PLUGIN_ERROR_CODES.UNAVAILABLE);
    assert.ok(plants.has(PLANT_ID));
});

test("plant failures require a reset and a fresh instance drops hidden state", async (t) => {
    const failing = await loadPlants(t, (files) => {
        files["plant.wasm"] = encodeFailingPlantModule();
        return files;
    });
    const manifest = plantManifest();
    const manager = new HeadlessVehicleManager();
    await manager.configureFromManifest([entry()], null, {
        plants: failing,
        resolvedVehicles: [{ actorId: "ego", vehicleId: "big-car", manifest }],
    });
    assert.throws(() => manager.update(0.02), (error) => (
        error.code === PLUGIN_ERROR_CODES.EXECUTION && error.requiresReset === true
    ));
    const nonFinite = await loadPlants(t, (files) => {
        files["plant.wasm"] = encodeNonFinitePlantModule();
        return files;
    });
    const second = new HeadlessVehicleManager();
    await second.configureFromManifest([entry()], null, {
        plants: nonFinite,
        resolvedVehicles: [{ actorId: "ego", vehicleId: "big-car", manifest }],
    });
    assert.throws(() => second.update(0.02), (error) => error.code === PLUGIN_ERROR_CODES.EXECUTION);

    const countingFiles = await pluginFixtureFiles("test.plant-fixture");
    countingFiles["plant.wasm"] = encodeCountingPlantModule();
    const counting = await loadPlants(t, () => countingFiles);
    const compiled = await compilePlantModules(counting);
    const stepper = createPlantStepper(compiled.get(PLANT_ID), counting.get(PLANT_ID), manifest);
    const state = new Float64Array(13);
    state[0] = stepper.step(state, 0.1)[0];
    assert.equal(state[0], 1);
    state[0] = stepper.step(state, 0.1)[0];
    assert.equal(state[0], 3);
    stepper.reset();
    state[0] = 0;
    assert.equal(stepper.step(state, 0.1)[0], 1);
});
