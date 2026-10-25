import assert from "node:assert/strict";
import test from "node:test";

import { buildImuMeasurement, captureVehicleSnapshot, createMeasurementSeedState } from "../app/autonomy/LocalizationMeasurements.js";
import { applyManualDrive } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { normalizeRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";
import {
    axleContactForces,
    catchContactFloor,
    settleContactBody,
    tangentialGrade,
} from "../app/simulation/vehicles/contactBicycle.js";
import { supportPlanePosition } from "../app/physics/PhysicsEngine.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { SeededRNG } from "../app/util/SeededRNG.js";
import {
    CONTACT_BICYCLE_MODEL,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";

const DT = 0.01;

function manifest(overrides = {}) {
    return normalizeVehicleManifest({
        id: "contact-car",
        dynamics: { model: CONTACT_BICYCLE_MODEL, ...overrides },
        wheels: [
            { id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, steerable: true },
            { id: "front-right", position: { x: 0.75, y: 0.25, z: -0.55 }, steerable: true },
            { id: "rear-left", position: { x: -0.75, y: 0.25, z: 0.55 } },
            { id: "rear-right", position: { x: -0.75, y: 0.25, z: -0.55 } },
        ],
    });
}

function plant(overrides = {}, pose = {}) {
    const body = new KinematicVehiclePlant(createVehiclePlantDefinition({
        id: "ego",
        pose: {
            position: { x: 0, y: 0, z: 0, ...pose.position },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ", ...pose.rotation },
        },
    }, { manifest: manifest(overrides) }));
    body.telemetryId = "ego";
    return body;
}

function flatRoad(y = 0) {
    return () => ({ y, pitch: 0, normal: { x: 0, y: 1, z: 0 } });
}

function gradeRoad(pitch) {
    const normal = { x: -Math.sin(pitch), y: Math.cos(pitch), z: 0 };
    return (x) => ({ y: x * Math.tan(pitch), pitch, normal });
}

test("airborne axle forces are zero and a grounded force has no yaw moment field", () => {
    const airborne = axleContactForces({ normalLoad: 0, axCommand: 3, vx: 4, inContact: false });
    assert.deepEqual(airborne, { Fxf: 0, Fyf: 0, Fxr: 0, Fyr: 0 });
    const grounded = axleContactForces({
        normalLoad: 1500 * 9.81,
        axCommand: 1,
        vx: 8,
        delta: 0.2,
        gradeX: 0,
    });
    assert.ok(Math.abs(grounded.Fyf) > 1);
    assert.equal(grounded.yawMoment, undefined);
});

test("rolling resistance holds a gentle grade and a steep grade overpowers it", () => {
    const load = 1500 * 9.81;
    const gentle = tangentialGrade({ x: -Math.sin(0.005), y: Math.cos(0.005), z: 0 }, 0, 0.005);
    const held = axleContactForces({ normalLoad: load * Math.cos(0.005), gradeX: gentle.x, vx: 0 });
    assert.ok(Math.abs(held.Fxf + held.Fxr + 1500 * gentle.x) < 1e-6);

    const steep = tangentialGrade({ x: -Math.sin(0.1), y: Math.cos(0.1), z: 0 }, 0, 0.1);
    const loose = axleContactForces({
        normalLoad: load * Math.cos(0.1),
        gradeX: steep.x,
        vx: 0,
        rollingResistance: 0,
    });
    assert.equal(loose.Fxf, 0);
    assert.equal(loose.Fxr, 0);
});

test("a car 10 m above the road falls and then stops on it", () => {
    const body = plant({}, { position: { y: 10 } });
    body.setGroundSampler(flatRoad(0));
    assert.equal(body.position.y, 10);
    for (let step = 0; step < 5; step += 1) {
        body.update(DT);
        settleContactBody(body);
    }
    assert.ok(body.position.y > 8, `still falling at y=${body.position.y}`);
    for (let step = 0; step < 400; step += 1) {
        body.update(DT);
        settleContactBody(body);
    }
    assert.ok(Math.abs(body.position.y) < 1e-9);
    assert.ok(Math.abs(body.verticalVelocity) < 1e-9);
    const parked = body.position.y;
    body.update(DT);
    settleContactBody(body);
    assert.equal(body.position.y, parked);
});

test("an uphill grade slows the car and a flat road does not", () => {
    const uphill = plant({ rollingResistance: 0 });
    uphill.setGroundSampler(gradeRoad(0.1));
    const flat = plant({ rollingResistance: 0 });
    flat.setGroundSampler(flatRoad(0));
    for (let step = 0; step < 20; step += 1) {
        uphill.update(DT);
        settleContactBody(uphill);
        flat.update(DT);
        settleContactBody(flat);
    }
    assert.ok(uphill.velocity.x < -0.1);
    assert.equal(flat.velocity.x, 0);
    assert.ok(Math.abs(uphill.position.y - uphill.position.x * Math.tan(0.1)) < 1e-6);
});

test("a car facing across a ramp slides sideways", () => {
    const body = plant({ rollingResistance: 0 }, { rotation: { y: -Math.PI / 2 } });
    const pitch = 0.2;
    body.setGroundSampler(() => ({
        y: 0,
        pitch: 0,
        normal: { x: -Math.sin(pitch), y: Math.cos(pitch), z: 0 },
    }));
    body.update(DT);
    settleContactBody(body);
    assert.ok(body.lateralVelocity < -0.01, `vy ${body.lateralVelocity}`);
    assert.equal(body.rotation.x, 0);
});

test("a pose already above the road is not pulled down", () => {
    const body = plant({}, { position: { y: 2 } });
    body.verticalVelocity = -4;
    body.setGroundSampler(flatRoad(0));
    settleContactBody(body);
    assert.equal(body.position.y, 2);
    assert.equal(body.verticalVelocity, -4);
});

test("free fall specific force cancels and a held grade does not", () => {
    const config = normalizeRunSensor({
        type: "imu",
        calibration: {
            gravity: 9.81,
            angularVelocityStdDev: { x: 0, y: 0, z: 0 },
            linearAccelerationStdDev: { x: 0, y: 0, z: 0 },
            angularRandomWalk: { x: 0, y: 0, z: 0 },
            accelerationRandomWalk: { x: 0, y: 0, z: 0 },
            turnOnBias: { randomize: false, angular: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 } },
            noise: {},
        },
    });
    const falling = plant();
    falling.position.y = 3;
    falling.setGroundSampler(flatRoad(0));
    falling.update(DT);
    const held = plant({ rollingResistance: 1 });
    held.setGroundSampler(gradeRoad(0.4));
    held.update(DT);
    settleContactBody(held);
    const measure = (body) => buildImuMeasurement(
        captureVehicleSnapshot(body, 10_000_000),
        config,
        new SeededRNG("contact-imu"),
        createMeasurementSeedState(config, new SeededRNG("contact-imu")),
    ).measurement.linearAcceleration;
    const fall = measure(falling);
    const grade = measure(held);
    assert.ok(Math.abs(fall.z) < 0.05, `free fall z ${fall.z}`);
    assert.ok(Math.abs(grade.x) > 1, `held grade x ${grade.x}`);
});

test("a contact plugin force stepper matches the built-in plant", () => {
    const wheels = [
        { id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, steerable: true },
        { id: "front-right", position: { x: 0.75, y: 0.25, z: -0.55 }, steerable: true },
        { id: "rear-left", position: { x: -0.75, y: 0.25, z: 0.55 } },
        { id: "rear-right", position: { x: -0.75, y: 0.25, z: -0.55 } },
    ];
    const entry = {
        id: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0.2, z: 0, order: "XYZ" } },
        linearVelocity: { x: 4, y: 0, z: 0 },
        steeringAngle: 0.05,
    };
    const shared = { id: "contact-car", kinematics: { wheelbase: 1.5 }, wheels };
    const plugin = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, {
        manifest: normalizeVehicleManifest({ ...shared, dynamics: { plant: "acme.dynamics.bicycle.bicycle" } }),
    }, { plantModel: CONTACT_BICYCLE_MODEL }), {
        stepper: {
            step(state) {
                const forces = axleContactForces({
                    vx: state[6],
                    vy: state[7],
                    r: state[8],
                    delta: state[12],
                    axCommand: state[9],
                    gradeX: state[3],
                    normalLoad: state[11],
                    inContact: state[10] === 1,
                });
                const next = new Float64Array(state);
                next[6] = forces.Fxf;
                next[7] = forces.Fyf;
                next[9] = forces.Fxr;
                next[10] = forces.Fyr;
                return next;
            },
            reset() {},
        },
    });
    const javascript = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, {
        manifest: normalizeVehicleManifest({ ...shared, dynamics: { model: CONTACT_BICYCLE_MODEL } }),
    }));
    const sample = gradeRoad(0.08);
    plugin.setGroundSampler(sample);
    javascript.setGroundSampler(sample);
    plugin.position.y = 3;
    javascript.position.y = 3;
    applyManualDrive(plugin, { mode: "acceleration", accelerationX: 1.5, steeringRad: 0.1 });
    applyManualDrive(javascript, { mode: "acceleration", accelerationX: 1.5, steeringRad: 0.1 });
    plugin.update(DT);
    javascript.update(DT);
    assert.equal(plugin.velocity.x, 4);
    assert.equal(javascript.velocity.x, 4);
    plugin.position.y = 0;
    javascript.position.y = 0;
    plugin.verticalVelocity = 0;
    javascript.verticalVelocity = 0;
    for (let step = 0; step < 15; step += 1) {
        plugin.update(DT);
        javascript.update(DT);
        settleContactBody(plugin);
        settleContactBody(javascript);
    }
    for (const field of ["x", "y", "z"]) {
        assert.ok(Math.abs(plugin.position[field] - javascript.position[field]) < 1e-9, `${field} ${plugin.position[field]}`);
    }
    assert.ok(Math.abs(plugin.velocity.x - javascript.velocity.x) < 1e-9);
    assert.ok(Math.abs(plugin.lateralVelocity - javascript.lateralVelocity) < 1e-9);
    assert.ok(Math.abs(plugin.yawRate - javascript.yawRate) < 1e-9);
    assert.ok(Math.abs(plugin.verticalVelocity - javascript.verticalVelocity) < 1e-9);
    assert.ok(plugin.position.x > 0.5);
});

test("the checker floor lifts a contact car and the next step can drive", () => {
    const body = plant({}, { position: { y: -0.2 } });
    body.verticalVelocity = -2;
    body.setGroundSampler(() => null);
    const supported = supportPlanePosition({ x: 0, y: 1, z: 0 }, body.position, 0);
    assert.equal(supported.held, true);
    catchContactFloor(body, 0, supported.held);
    assert.equal(body.position.y, 0);
    assert.equal(body.verticalVelocity, 0);
    applyManualDrive(body, { mode: "acceleration", accelerationX: 2 });
    body.update(DT);
    assert.ok(body.velocity.x > 0, `vx ${body.velocity.x}`);
    assert.ok(body.position.y >= -1e-6);
});

test("a contact car above the checker is not pulled down", () => {
    const body = plant({}, { position: { y: 2 } });
    body.floorSupport = { y: 0, normal: { x: 0, y: 1, z: 0 } };
    const supported = supportPlanePosition({ x: 0, y: 2, z: 0 }, body.position, 0);
    assert.equal(supported.held, false);
    catchContactFloor(body, 0, supported.held);
    assert.equal(body.floorSupport, null);
    body.setGroundSampler(() => null);
    body.update(DT);
    assert.ok(body.position.y < 2);
    assert.ok(body.position.y > 1);
});

test("a road sample beats the checker floor", () => {
    const body = plant();
    body.floorSupport = { y: 0, normal: { x: 0, y: 1, z: 0 } };
    body.setGroundSampler(gradeRoad(0.1));
    body.update(DT);
    assert.ok(Math.abs(body.rotation.z - 0.1) < 1e-9);
});

test("no floor and no road keeps falling", () => {
    const body = plant({}, { position: { y: 1 } });
    body.setGroundSampler(() => null);
    body.update(DT);
    assert.ok(body.position.y < 1);
    assert.equal(body.floorSupport ?? null, null);
});

test("drive force stays off while the car is in the air", () => {
    const body = plant({}, { position: { y: 4 } });
    body.setGroundSampler(flatRoad(0));
    applyManualDrive(body, { accelerationX: 3 });
    body.update(DT);
    assert.equal(body.velocity.x, 0);
    assert.ok(body.verticalVelocity < 0);
});
