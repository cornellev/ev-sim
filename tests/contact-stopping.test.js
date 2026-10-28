import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyManualDrive } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { createSimulationRuntimeContext } from "../app/simulation/kernel/SimulationRuntimeContext.js";
import { axleContactForces, contactLongitudinalCommand, settleContactBody } from "../app/simulation/vehicles/contactBicycle.js";
import { createVehiclePlantDefinition, KinematicVehiclePlant } from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { CONTACT_BICYCLE_MODEL, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { replayContactRamp } from "./helpers/contactRampRegression.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/headless/contact-stopping-regression.v1.json", import.meta.url)));
const recordedSteer = 0.13089969651756864;
const timesteps = [0.01, fixture.stepNs / 1e9, 0.05, 0.1];

function car(vx = 0, steering = 0) {
    const body = new KinematicVehiclePlant(createVehiclePlantDefinition({
        ...fixture.initial,
        pose: { ...fixture.initial.pose, position: { x: 0, y: 0.0171, z: 0 } },
        linearVelocity: { x: vx, y: 0, z: 0 },
        steeringAngle: steering,
    }, { manifest: normalizeVehicleManifest({ ...fixture.vehicle, dynamics: { model: CONTACT_BICYCLE_MODEL } }) }));
    body.groundPlane = { y: 0 };
    settleContactBody(body);
    return body;
}

function step(body, dt) {
    body.update(dt);
    settleContactBody(body);
}

test("stops from both directions without reversing or hunting across timesteps and steering angles", () => {
    for (const dt of timesteps) for (const start of [-5, 5]) for (const steering of [0, recordedSteer, fixture.vehicle.kinematics.maxSteeringAngle]) {
        const body = car(start, steering);
        applyManualDrive(body, { mode: start > 0 ? "velocity" : "stop", speedMps: 0 });
        let previousCommand = 0;
        let restPosition;
        for (let index = 0; index < Math.ceil(20 / dt); index += 1) {
            step(body, dt);
            const label = `${dt}, ${start}, ${steering}, step ${index}`;
            assert.ok(body.axCommand >= -5 - 1e-12 && body.axCommand <= 3 + 1e-12, label);
            assert.ok(Math.abs(body.axCommand - previousCommand) <= 10 * dt + 1e-12, `jerk: ${label}`);
            previousCommand = body.axCommand;
            if (steering <= recordedSteer) {
                assert.ok(body.velocity.x * Math.sign(start) >= -1e-6, `uncommanded reversal: ${label}, vx=${body.velocity.x}`);
                if ((index + 1) * dt >= 5) assert.ok(Math.hypot(body.velocity.x, body.lateralVelocity) < 1e-3, `not stopped: ${label}`);
            }
            if ((index + 1) * dt >= 10) {
                assert.ok(Math.hypot(body.velocity.x, body.lateralVelocity) < 1e-3, `continued hunting: ${label}`);
                restPosition ??= { ...body.position };
                assert.ok(Math.hypot(body.position.x - restPosition.x, body.position.z - restPosition.z) < 1e-3, `creep: ${label}`);
            }
        }
    }
});

test("rolling resistance stops a small residual velocity without reversing it or overriding a grade", () => {
    for (const dt of timesteps) for (const vx of [-0.01, -0.0011, -0.0001, 0, 0.0001, 0.0011, 0.01]) {
        for (const axCommand of [-0.01, 0, 0.01]) {
            const forces = axleContactForces({ dt, vx, axCommand, normalLoad: 1500 * 9.81 });
            const next = vx + (forces.Fxf + forces.Fxr) / 1500 * dt;
            assert.ok(next * vx >= -1e-12, `${dt}, ${vx}, ${axCommand}: ${next}`);
            assert.ok(Math.abs(next) <= Math.abs(vx) + 1e-12);
        }
    }
    const steep = axleContactForces({ dt: 0.1, vx: 0, gradeX: 1, normalLoad: 1500 * 9.81 });
    assert.ok((steep.Fxf + steep.Fxr) / 1500 + 1 > 0.8, "insufficient friction must allow downhill motion");
    for (const dt of [0, -1]) {
        const forces = axleContactForces({ dt, vx: 0.0011, axCommand: 0.01, normalLoad: 1500 * 9.81 });
        assert.ok(Object.values(forces).every(Number.isFinite));
    }
});

test("nonzero speed tracking and intentional reverse commands still work", () => {
    for (const dt of timesteps) {
        const body = car();
        for (const target of [5, -5, 2, 0]) {
            applyManualDrive(body, { mode: "velocity", speedMps: target });
            for (let index = 0; index < Math.ceil(10 / dt); index += 1) step(body, dt);
            assert.ok(Math.abs(body.velocity.x - target) < 1e-3, `${dt}, target=${target}, vx=${body.velocity.x}`);
        }
    }
});

test("landing and reset discard airborne controller feedback without changing hold or acceleration modes", () => {
    const body = car(2);
    applyManualDrive(body, { mode: "velocity", speedMps: 5 });
    step(body, 0.01);
    assert.equal(body.contactControlActive, true);
    body.position.y = 10;
    step(body, 0.01);
    assert.equal(body.axCommand, 0);
    assert.equal(body.contactControlActive, false);
    body.position.y = 0.0171;
    body.acceleration.x = -1e6;
    step(body, 0.01);
    assert.equal(body.axCommand, 0.1, "landing must ignore the airborne acceleration sample");
    applyManualDrive(body, { mode: "acceleration", accelerationX: 1.25 });
    step(body, 0.01);
    assert.equal(body.axCommand, 1.25);
    applyManualDrive(body, { mode: "hold" });
    step(body, 0.01);
    assert.equal(body.axCommand, 0);
    const state = body.getDeterministicState();
    body.update(0);
    assert.deepEqual(body.getDeterministicState(), state);
    body.resetRunState();
    assert.equal(body.axCommand, 0);
    assert.equal(body.contactControlActive, false);
    assert.equal(body.longitudinal.mode, "hold");
});

test("the contact controller respects zero and nondefault actuator limits", () => {
    assert.equal(contactLongitudinalCommand({ mode: "velocity", speedMps: 5, maxJerk: 0 }), 0);
    assert.equal(contactLongitudinalCommand({ mode: "velocity", speedMps: 5, previousAx: 0.2, dt: 0 }), 0.2);
    assert.equal(contactLongitudinalCommand({ mode: "acceleration", accelerationMps2: 9, maxAcceleration: 1 }), 1);
    for (const dt of timesteps) {
        const body = car(2);
        Object.assign(body.kinematics, { maxAcceleration: 1, maxDeceleration: 2, maxJerk: 0.5 });
        applyManualDrive(body, { mode: "stop" });
        let previous = 0;
        for (let index = 0; index < Math.ceil(30 / dt); index += 1) {
            step(body, dt);
            assert.ok(body.axCommand >= -2 && body.axCommand <= 1);
            assert.ok(Math.abs(body.axCommand - previous) <= 0.5 * dt + 1e-12);
            previous = body.axCommand;
        }
        assert.ok(Math.abs(body.velocity.x) < 1e-3);
    }
});

test("browser canonical state retains contact controller feedback and matches the headless plant", () => {
    const body = car(2);
    applyManualDrive(body, { mode: "stop" });
    step(body, 0.01);
    const full = body.getDeterministicState();
    const { axCommand, contactControlActive, lateralVelocity, yawRate, verticalVelocity, ...view } = full;
    const presented = { telemetryId: body.telemetryId, plant: body };
    const context = createSimulationRuntimeContext({
        vehicles: () => ({ vehicles: [presented], getDeterministicState: () => [view] }),
    });
    assert.deepEqual(context.vehicles.getDeterministicState(), [full]);
    assert.equal(context.vehicles.getDeterministicState()[0].contactControlActive, true);
    body.resetRunState();
    assert.equal(context.vehicles.getDeterministicState()[0].contactControlActive, false);
    assert.equal(context.vehicles.getDeterministicState()[0].axCommand, 0);
    const fallback = createSimulationRuntimeContext({ vehicles: () => ({ vehicles: [presented] }) });
    assert.deepEqual(fallback.vehicles.getDeterministicState(), [body.getDeterministicState()]);
    const legacy = createSimulationRuntimeContext({
        vehicles: () => ({ vehicles: [{ telemetryId: "legacy" }], getDeterministicState: () => [view] }),
    });
    assert.deepEqual(legacy.vehicles.getDeterministicState(), [view]);
    assert.equal(typeof axCommand, "number");
    assert.equal(typeof contactControlActive, "boolean");
    assert.ok([lateralVelocity, yawRate, verticalVelocity].every(Number.isFinite));
});

test("the reported keyboard recording stays supported and stops identically in browser and headless adapters", async () => {
    const options = { fixture, releaseSeconds: 15 };
    const numeric = await replayContactRamp(options);
    const browser = await replayContactRamp({ ...options, browser: true });
    assert.deepEqual(numeric.states, browser.states);
    assert.ok(numeric.floorSteps > 0);
    assert.ok(numeric.maxLateralSpeed < 6, `sideways runaway: ${numeric.maxLateralSpeed}`);
    for (const state of numeric.states) assert.ok(state.position.y >= 0.0171 - 1e-9, "tread below floor");
    const rest = numeric.states.slice(-Math.floor(10e9 / fixture.stepNs));
    for (const state of rest) {
        assert.ok(Math.hypot(state.velocity.x, state.lateralVelocity) < 1e-3, `continued hunting: ${state.velocity.x}`);
        assert.ok(Math.hypot(state.position.x - rest[0].position.x, state.position.z - rest[0].position.z) < 1e-3, "creep after release");
    }
});
