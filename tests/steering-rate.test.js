import assert from "node:assert/strict";
import test from "node:test";

import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { slewSteeringAngle } from "../app/simulation/vehicles/steeringLimits.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";

const LIMITS = {
    wheelbase: 2,
    maxSteeringAngle: 0.6,
    maxSteeringRate: 0.5,
    maxSpeed: 20,
    maxAcceleration: 1e6,
    maxDeceleration: 1e6,
    maxJerk: 1e6,
};

function harness(initialSteering = 0) {
    const store = new SignalStore({}, { sourceId: "steering-rate" });
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition(
        { id: "ego", type: "big-car", steeringAngle: initialSteering },
        null,
        { manifest: { id: "rate-car", kinematics: LIMITS } },
    ));
    plant.telemetryId = "ego";
    const vehicleDatabase = {
        vehicles: [plant],
        update: (dt) => plant.update(dt),
        async configureFromManifest() {},
    };
    const data = {
        bindings: () => ({
            signalStore: store,
            manifest: { enabled: false, bindings: [] },
            setTopicScheduler() {},
            applyTopicUpdate() {},
            update() {},
        }),
        vehicles: () => vehicleDatabase,
        devices: () => ({
            configureFromManifest() {},
            resetSchedule() {},
            update() {},
            deliver() {},
        }),
        physics: () => ({
            async configureRun() {},
            resetRun() {},
            step() {},
            syncAndPublishContacts() {},
        }),
        keys: () => ({ down: new Set(), update() {} }),
        client: () => ({ get: () => null }),
        baking: () => null,
        earthTilesManager: () => null,
        skyManager: () => null,
    };
    return { engine: new SimulationEngine(data), plant };
}

function resolvedRun() {
    const manifest = createDefaultRunManifest({
        controls: {},
        clock: { maxSteps: 4 },
        sensorRig: { sensors: [] },
        assertions: [],
    });
    return {
        manifest,
        definitionHash: "a".repeat(64),
        resolvedHash: "b".repeat(64),
        environment: { manifest: { environmentId: manifest.environment.id } },
        bindings: { entries: [] },
        vehicles: [{ actorId: "ego", manifest: { kinematics: LIMITS } }],
    };
}

function command(engine, steeringRad) {
    engine.controlRuntime.submitSiSpeedSteer("ego", {
        speedMps: 4,
        steeringRadRep103: steeringRad,
        captureTimeNs: engine.timeNs,
        producer: "candidate",
    });
}

test("a large steer command slews from the plant angle and the yaw uses that angle", async () => {
    const { engine, plant } = harness();
    await engine.prepare(resolvedRun());
    const dt = engine.fixedDt;
    command(engine, 0.6);
    engine.step(1);

    const first = slewSteeringAngle({
        currentRad: 0,
        targetRad: 0.6,
        maxAngleRad: LIMITS.maxSteeringAngle,
        maxRateRadPerSec: LIMITS.maxSteeringRate,
        dtSeconds: dt,
    }).angleRad;
    assert.ok(first > 0 && first < 0.6);
    assert.ok(Math.abs(plant.steeringAngle - first) < 1e-9);
    const expectedYaw = (plant.velocity.x / plant.kinematics.wheelbase) * Math.tan(first) * dt;
    assert.ok(Math.abs(plant.rotation.y - expectedYaw) < 1e-9);

    engine.step(1);
    const second = slewSteeringAngle({
        currentRad: first,
        targetRad: 0.6,
        maxAngleRad: LIMITS.maxSteeringAngle,
        maxRateRadPerSec: LIMITS.maxSteeringRate,
        dtSeconds: dt,
    }).angleRad;
    assert.ok(second > first && second < 0.6);
    assert.ok(Math.abs(plant.steeringAngle - second) < 1e-9);
    engine.dispose();
});

test("a steered plant slews from its current angle instead of from zero", async () => {
    const { engine, plant } = harness(0.2);
    await engine.prepare(resolvedRun());
    plant.steeringAngle = 0.2;
    const dt = engine.fixedDt;
    command(engine, 0.6);
    engine.step(1);
    const expected = slewSteeringAngle({
        currentRad: 0.2,
        targetRad: 0.6,
        maxAngleRad: LIMITS.maxSteeringAngle,
        maxRateRadPerSec: LIMITS.maxSteeringRate,
        dtSeconds: dt,
    }).angleRad;
    const fromZero = slewSteeringAngle({
        currentRad: 0,
        targetRad: 0.6,
        maxAngleRad: LIMITS.maxSteeringAngle,
        maxRateRadPerSec: LIMITS.maxSteeringRate,
        dtSeconds: dt,
    }).angleRad;
    assert.ok(Math.abs(expected - fromZero) > 0.1);
    assert.ok(Math.abs(plant.steeringAngle - expected) < 1e-9);
    engine.dispose();
});
