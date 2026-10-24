import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureVehicleSnapshot } from "../app/autonomy/LocalizationMeasurements.js";
import { applyManualDrive } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { assertPluginDocument } from "../app/plugin/PluginDocument.js";
import { HeadlessVehicleManager } from "../app/simulation/headless/HeadlessVehicleManager.js";
import { absorbDynamicClamp, stepDynamicBicycle } from "../app/simulation/vehicles/dynamicBicycle.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { buildLocalPlantPackage } from "../server/plugins/plantBuild.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import { CONTACT_BICYCLE_MODEL, DYNAMIC_BICYCLE_MODEL } from "../app/vehicles/VehicleManifest.js";

const wasm32 = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
const cargoReady = wasm32.status === 0 && wasm32.stdout.includes("wasm32-unknown-unknown");

function manifest(dynamics) {
    const source = getBuiltInVehicleManifest("igvc-car");
    source.dynamics = dynamics;
    return source;
}

function initial() {
    return {
        id: "ego",
        type: "igvc-car",
        pose: { position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0.2, z: 0, order: "XYZ" } },
        linearVelocity: { x: 4, y: 1, z: 2 },
        steeringAngle: 0,
    };
}

function close(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) <= 1e-9, `${label}: ${actual} vs ${expected}`);
}

function halfStepper(source) {
    const wheelbase = source.kinematics.wheelbase;
    const maximum = Math.min(source.kinematics.maxSteeringAngle, Math.PI * 0.49);
    const half = Math.max(1e-9, wheelbase) / 2;
    return {
        step(state, dt) {
            const delta = Math.max(-maximum, Math.min(maximum, state[12]));
            const stepped = stepDynamicBicycle({
                vx: state[6],
                vy: state[7],
                r: state[8],
                x: state[0],
                z: state[2],
                yaw: state[4],
            }, {
                axCommand: state[9],
                delta,
                pitch: state[5],
                dt,
                lf: half,
                lr: half,
            });
            const next = new Float64Array(state);
            next[0] = stepped.x;
            next[2] = stepped.z;
            next[4] = stepped.yaw;
            next[6] = stepped.vx;
            next[7] = stepped.vy;
            next[8] = stepped.r;
            next[9] = stepped.ax;
            next[10] = stepped.ay;
            next[11] = 0;
            return next;
        },
        reset() {},
    };
}

function runTape(plugin, javascript) {
    const tape = [
        { dt: 0.02, pitch: 0.05, drive: { mode: "acceleration", accelerationX: 1.2, steeringRad: 0 } },
        { dt: 0.02, pitch: 0.05, drive: { mode: "acceleration", accelerationX: 0.4, steeringRad: 0.08 } },
        { dt: 0.02, pitch: 0, drive: { mode: "velocity", speedMps: 6, steeringRad: 0.12 } },
        { dt: 0.02, pitch: 0, drive: { mode: "acceleration", accelerationX: 0, steeringRad: -0.05 } },
    ];
    for (const action of tape) {
        const sample = () => ({ y: 0.2, pitch: action.pitch });
        plugin.setGroundSampler(sample);
        javascript.setGroundSampler(sample);
        applyManualDrive(plugin, action.drive);
        applyManualDrive(javascript, action.drive);
        plugin.update(action.dt);
        javascript.update(action.dt);
        for (const field of ["x", "z"]) close(plugin.position[field], javascript.position[field], field);
        close(plugin.rotation.y, javascript.rotation.y, "yaw");
        close(plugin.rotation.z, javascript.rotation.z, "pitch");
        close(plugin.velocity.x, javascript.velocity.x, "vx");
        close(plugin.lateralVelocity, javascript.lateralVelocity, "vy");
        close(plugin.yawRate, javascript.yawRate, "r");
        close(plugin.acceleration.x, javascript.acceleration.x, "ax");
        close(plugin.acceleration.y, javascript.acceleration.y, "ay");
        assert.equal(plugin.velocity.y, 0);
        assert.equal(plugin.velocity.z, 0);
    }
    const pluginSample = captureVehicleSnapshot(plugin, 20_000_000);
    const javascriptSample = captureVehicleSnapshot(javascript, 20_000_000);
    for (const field of ["x", "y", "z"]) {
        close(pluginSample.bodyVelocity[field], javascriptSample.bodyVelocity[field], `imu v ${field}`);
        close(pluginSample.bodyAcceleration[field], javascriptSample.bodyAcceleration[field], `imu a ${field}`);
    }
    close(pluginSample.bodyAngularVelocity.z, javascriptSample.bodyAngularVelocity.z, "imu r");
    const from = { x: plugin.position.x - 1, y: plugin.position.y, z: plugin.position.z };
    const attempted = { x: plugin.position.x, y: plugin.position.y, z: plugin.position.z };
    const clamped = { x: from.x + 0.25, y: attempted.y, z: attempted.z };
    absorbDynamicClamp(plugin, clamped, from, attempted);
    absorbDynamicClamp(javascript, clamped, from, attempted);
    close(plugin.position.x, javascript.position.x, "clamped x");
    close(plugin.velocity.x, javascript.velocity.x, "clamped vx");
    close(plugin.lateralVelocity, javascript.lateralVelocity, "clamped vy");
    assert.equal(plugin.velocity.y, 0);
    assert.equal(plugin.velocity.z, 0);
}

test("contact plant packages declare the model and the kinematic fixture does not", async () => {
    for (const id of ["longitudinal", "cornering", "bicycle"]) {
        const document = JSON.parse(await fs.readFile(`examples/plugins/acme.dynamics.${id}/plugin.json`, "utf8"));
        assert.equal(assertPluginDocument(document).plants[0].model, CONTACT_BICYCLE_MODEL);
    }
    const fixture = JSON.parse(await fs.readFile("tests/fixtures/plugins/test.plant-fixture/plugin.json", "utf8"));
    assert.equal(assertPluginDocument(fixture).plants[0].model, undefined);
    fixture.plants[0].model = "pacejka";
    assert.throws(() => assertPluginDocument(fixture), /dynamic-bicycle-v1/);
});

test("a dynamic plugin host matches the built-in plant, imu, and obstacle clamp", () => {
    const pluginManifest = manifest({ plant: "acme.dynamics.bicycle.bicycle" });
    const plugin = new KinematicVehiclePlant(createVehiclePlantDefinition(initial(), { manifest: pluginManifest }, {
        plantModel: DYNAMIC_BICYCLE_MODEL,
    }), { stepper: halfStepper(pluginManifest) });
    const javascript = new KinematicVehiclePlant(createVehiclePlantDefinition(initial(), {
        manifest: manifest({ model: DYNAMIC_BICYCLE_MODEL }),
    }));
    runTape(plugin, javascript);
});

test("the compiled contact bicycle package matches the built-in plant", {
    skip: process.env.CEV_PLANT_CARGO !== "1" || !cargoReady,
}, async (t) => {
    const directory = path.resolve("examples/plugins/acme.dynamics.bicycle");
    const document = JSON.parse(await fs.readFile(path.join(directory, "plugin.json"), "utf8"));
    const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cev-dynamic-plant-"));
    t.after(() => fs.rm(storeRoot, { recursive: true, force: true }));
    const built = await buildLocalPlantPackage({
        sourceDirectory: directory,
        directoryKey: "acme.dynamics.bicycle",
        storeRoot,
        document,
    });
    t.after(() => fs.rm(built.packageDirectory, { recursive: true, force: true }));
    const wasm = new Uint8Array(await fs.readFile(path.join(built.packageDirectory, "plant.wasm")));
    const plant = document.plants[0];
    const plants = new Map([[plant.id, {
        ...plant,
        moduleBytes: wasm,
        ownership: { pluginId: document.id, packageHash: "", runtimeHash: "" },
    }]]);
    const pluginManifest = manifest({ plant: plant.id });
    const entry = initial();
    const headless = new HeadlessVehicleManager();
    await headless.configureFromManifest([entry], null, {
        plants,
        resolvedVehicles: [{ actorId: entry.id, vehicleId: entry.type, manifest: pluginManifest }],
    });
    const javascript = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, {
        manifest: manifest({ model: CONTACT_BICYCLE_MODEL }),
    }));
    runTape(headless.vehicles[0], javascript);
});
