import assert from "node:assert/strict";
import test from "node:test";

import { applyManualDrive } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { createSimulationRuntimeContext } from "../app/simulation/kernel/SimulationRuntimeContext.js";
import {
    deriveAxleDistances,
    longitudinalCommand,
    projectPlanarVelocity,
    stepDynamicBicycle,
} from "../app/simulation/vehicles/dynamicBicycle.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import {
    createBlankVehicleManifest,
    DEFAULT_DYNAMIC_BICYCLE,
    DYNAMIC_BICYCLE_MODEL,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";

const DT = 0.05;

function dynamicInput(overrides = {}) {
    return {
        axCommand: 0,
        delta: 0,
        pitch: 0,
        dt: DT,
        mass: DEFAULT_DYNAMIC_BICYCLE.mass,
        yawInertia: DEFAULT_DYNAMIC_BICYCLE.yawInertia,
        lf: 0.75,
        lr: 0.75,
        corneringStiffnessFront: DEFAULT_DYNAMIC_BICYCLE.corneringStiffnessFront,
        corneringStiffnessRear: DEFAULT_DYNAMIC_BICYCLE.corneringStiffnessRear,
        frictionMu: DEFAULT_DYNAMIC_BICYCLE.frictionMu,
        rollingResistance: 0,
        ...overrides,
    };
}

function dynamicPlant(overrides = {}) {
    const manifest = normalizeVehicleManifest({
        id: "dyno",
        dynamics: { model: DYNAMIC_BICYCLE_MODEL, ...overrides },
        wheels: [
            { id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, steerable: true },
            { id: "front-right", position: { x: 0.75, y: 0.25, z: -0.55 }, steerable: true },
            { id: "rear-left", position: { x: -0.75, y: 0.25, z: 0.55 } },
            { id: "rear-right", position: { x: -0.75, y: 0.25, z: -0.55 } },
        ],
    });
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego" }, { manifest }));
    plant.telemetryId = "ego";
    return plant;
}

test("axle distances use wheel positions between the origin, otherwise half the wheelbase", () => {
    assert.deepEqual(deriveAxleDistances([], 1.5), { lf: 0.75, lr: 0.75 });
    assert.deepEqual(deriveAxleDistances([
        { steerable: true, position: { x: 1 } },
    ], 1.5), { lf: 0.75, lr: 0.75 });
    assert.deepEqual(deriveAxleDistances([
        { axle: "front", position: { x: 1.2 } },
        { axle: "rear", position: { x: 0.4 } },
    ], 2), { lf: 1, lr: 1 });
    assert.deepEqual(deriveAxleDistances([
        { steerable: true, position: { x: 0.75 } },
        { steerable: true, position: { x: 0.75 } },
        { position: { x: -0.75 } },
        { position: { x: -0.75 } },
    ], 9), { lf: 0.75, lr: 0.75 });
    assert.deepEqual(deriveAxleDistances([
        { axle: "front", steerable: false, position: { x: 1.1 } },
        { axle: "rear", steerable: true, position: { x: -0.9 } },
    ], 1.5), { lf: 1.1, lr: 0.9 });
});

test("a stopped dynamic bicycle rolls downhill and stays put on a shallow grade", () => {
    const downhill = stepDynamicBicycle({ vx: 0, vy: 0, r: 0, x: 0, z: 0, yaw: 0 }, dynamicInput({
        pitch: 0.1,
        rollingResistance: 0,
    }));
    assert.ok(downhill.vx < 0);

    const facingDown = stepDynamicBicycle({ vx: 0, vy: 0, r: 0, x: 0, z: 0, yaw: 0 }, dynamicInput({
        pitch: -0.1,
        rollingResistance: 0,
    }));
    assert.ok(facingDown.vx > 0);

    const held = stepDynamicBicycle({ vx: 0, vy: 0, r: 0, x: 0, z: 0, yaw: 0 }, dynamicInput({
        pitch: 0.005,
        rollingResistance: DEFAULT_DYNAMIC_BICYCLE.rollingResistance,
    }));
    assert.equal(held.vx, 0);
});

test("straight acceleration stays in lane and a right steer produces vy and yaw rate", () => {
    const straight = stepDynamicBicycle({ vx: 0, vy: 0, r: 0, x: 1, z: 2, yaw: 0 }, dynamicInput({
        axCommand: 2,
    }));
    assert.ok(straight.vx > 0);
    assert.equal(straight.vy, 0);
    assert.equal(straight.r, 0);
    assert.equal(straight.z, 2);

    const turned = stepDynamicBicycle({ vx: 8, vy: 0, r: 0, x: 0, z: 0, yaw: 0 }, dynamicInput({
        delta: 0.02,
    }));
    assert.ok(turned.vy > 0);
    assert.ok(turned.r > 0);
    assert.ok(turned.z < 0);
});

test("lateral force saturates at mu Fz and longitudinal force stays inside the friction circle", () => {
    const saturated = stepDynamicBicycle({ vx: 10, vy: 0, r: 0 }, dynamicInput({ delta: 0.4 }));
    const frontLimit = saturated.Fzf * DEFAULT_DYNAMIC_BICYCLE.frictionMu;
    assert.ok(Math.abs(Math.abs(saturated.Fyf) - frontLimit) < 1e-6);

    const combined = stepDynamicBicycle({ vx: 10, vy: 0, r: 0 }, dynamicInput({
        delta: 0.05,
        axCommand: 40,
    }));
    assert.ok(Math.abs(combined.Fyf) < frontLimit - 1);
    assert.ok(Math.abs(combined.Fxf) < DEFAULT_DYNAMIC_BICYCLE.mass * 40 / 2);
    assert.ok(Math.abs(Math.hypot(combined.Fxf, combined.Fyf) - frontLimit) < 1e-4);
    assert.ok(Math.abs(Math.hypot(combined.Fxr, combined.Fyr) - combined.Fzr * DEFAULT_DYNAMIC_BICYCLE.frictionMu) < 1e-4);
});

test("rest does not divide or invent a lateral force, and rolling does not reverse vx", () => {
    const rested = stepDynamicBicycle({ vx: 0, vy: 2, r: 0.4 }, dynamicInput({ delta: 0.5 }));
    assert.equal(rested.Fyf, 0);
    assert.equal(rested.Fyr, 0);
    assert.equal(rested.vy, 2);
    assert.equal(rested.r, 0.4);
    assert.ok(Number.isFinite(rested.x));

    const coast = stepDynamicBicycle({ vx: 0.002, vy: 0, r: 0 }, dynamicInput({
        rollingResistance: DEFAULT_DYNAMIC_BICYCLE.rollingResistance,
        dt: 0.05,
    }));
    assert.equal(coast.vx, 0);
});

test("velocity mode is a jerk-limited speed loop and acceleration mode is not jerked again", () => {
    assert.equal(longitudinalCommand({ mode: "hold", accelerationMps2: 4 }), 0);
    assert.equal(longitudinalCommand({
        mode: "acceleration",
        accelerationMps2: 100,
        previousAx: 0,
        dt: 0.01,
        maxAcceleration: 3,
        maxJerk: 0.01,
    }), 3);
    assert.equal(longitudinalCommand({
        mode: "velocity",
        speedMps: 10,
        vx: 0,
        previousAx: 0,
        dt: 0.01,
        maxAcceleration: 3,
        maxJerk: 10,
    }), 0.1);
    assert.equal(longitudinalCommand({
        mode: "stop",
        speedMps: 10,
        vx: 5,
        previousAx: 0,
        dt: 0.01,
        maxDeceleration: 5,
        maxJerk: 1000,
    }), -5);
});

test("a dynamic plant tracks a speed command without snapping velocity", () => {
    const plant = dynamicPlant();
    applyManualDrive(plant, { speedMps: 5 });
    assert.equal(plant.velocity.x, 0);
    assert.equal(plant.longitudinal.mode, "velocity");
    for (let step = 0; step < 500; step += 1) plant.update(0.01);
    assert.ok(plant.velocity.x > 4.9 && plant.velocity.x < 5.01);

    const accelerated = dynamicPlant();
    applyManualDrive(accelerated, { accelerationX: 1, speedMps: 50 });
    assert.equal(accelerated.velocity.x, 0);
    assert.equal(accelerated.longitudinal.mode, "acceleration");
    accelerated.update(0.01);
    assert.ok(accelerated.velocity.x > 0 && accelerated.velocity.x < 0.05);

    const kinematic = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego", type: "big-car" }));
    applyManualDrive(kinematic, { speedMps: 4 });
    assert.equal(kinematic.velocity.x, 4);
});

test("setpoints pass acceleration mode only for the dynamic bicycle", () => {
    const plant = dynamicPlant();
    const context = createSimulationRuntimeContext({ vehicles: { vehicles: [plant] } });
    context.controls.applySetpoints(new Map([
        ["ego", {
            speedMps: 9,
            steeringRadThree: 0.1,
            accelerationMps2: 1.5,
            command: { mode: "acceleration" },
        }],
    ]));
    assert.equal(plant.velocity.x, 0);
    assert.equal(plant.longitudinal.mode, "acceleration");
    assert.equal(plant.longitudinal.accelerationMps2, 1.5);
    assert.equal(plant.steeringAngle, 0.1);

    const kinematic = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego", type: "big-car" }));
    kinematic.telemetryId = "ego";
    const kinematicContext = createSimulationRuntimeContext({ vehicles: { vehicles: [kinematic] } });
    kinematicContext.controls.applySetpoints(new Map([
        ["ego", {
            speedMps: 3,
            steeringRadThree: 0.2,
            accelerationMps2: 9,
            command: { mode: "acceleration" },
        }],
    ]));
    assert.equal(kinematic.velocity.x, 3);
    assert.equal(kinematic.acceleration.x, 0);
    assert.equal(kinematic.steeringAngle, 0.2);
});

test("the dynamic plant drapes height and pitch and reset clears planar slip", () => {
    const plant = dynamicPlant({ rollingResistance: 0 });
    plant.setGroundSampler(() => ({ y: 2, pitch: 0.2 }));
    assert.equal(plant.position.y, 2);
    assert.equal(plant.rotation.z, 0.2);
    plant.lateralVelocity = 1;
    plant.yawRate = 0.5;
    plant.longitudinal = { mode: "velocity", speedMps: 4 };
    plant.resetRunState();
    assert.equal(plant.lateralVelocity, 0);
    assert.equal(plant.yawRate, 0);
    assert.equal(plant.axCommand, 0);
    assert.equal(plant.longitudinal.mode, "hold");
    assert.equal(plant.position.y, 2);
});

test("planar projection removes only the into-wall component", () => {
    const stopped = projectPlanarVelocity(8, 0.4, 0, { x: 0, z: 0 }, { x: 5, z: 0 });
    assert.ok(Math.abs(stopped.vx) < 1e-12);
    assert.ok(Math.abs(stopped.vy - 0.4) < 1e-12);
    const leaving = projectPlanarVelocity(-2, 0.4, 0, { x: 0, z: 0 }, { x: 5, z: 0 });
    assert.equal(leaving.vx, -2);
    assert.equal(leaving.vy, 0.4);
});

test("an empty IGVC wheel list still builds a dynamic plant", () => {
    const manifest = normalizeVehicleManifest({
        ...getBuiltInVehicleManifest("igvc-car"),
        dynamics: { model: DYNAMIC_BICYCLE_MODEL },
    });
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego" }, { manifest }));
    assert.deepEqual(plant.definition.axle, { lf: 0.75, lr: 0.75 });
    plant.update(0.01);
    assert.equal(plant.velocity.x, 0);
});

test("the version 3 blank helper stays kinematic", () => {
    assert.equal(createBlankVehicleManifest().dynamics, undefined);
});
