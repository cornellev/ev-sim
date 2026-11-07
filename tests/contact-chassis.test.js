import assert from "node:assert/strict";
import test from "node:test";

import { buildImuMeasurement, captureVehicleSnapshot, createMeasurementSeedState } from "../app/autonomy/LocalizationMeasurements.js";
import { quaternionInverse, rotateVectorByQuaternion, threeToRep103Vector } from "../app/autonomy/CoordinateFrames.js";
import { applyManualDrive } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { CHASSIS_RAY_SLACK, DYNAMIC_GROUP } from "../app/physics/PhysicsEngine.js";
import { normalizeRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { createVehiclePlantDefinition, KinematicVehiclePlant } from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { SeededRNG } from "../app/util/SeededRNG.js";
import { CONTACT_BICYCLE_MODEL, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { rampSurface, runChassis, startChassis } from "./helpers/contactChassisRun.js";

const DT = 0.01;
const FLUSH_WHEELS = [
    { id: "front-left", position: { x: 1.2, y: 0.3, z: 0.7 }, radius: 0.3, steerable: true },
    { id: "front-right", position: { x: 1.2, y: 0.3, z: -0.7 }, radius: 0.3, steerable: true },
    { id: "rear-left", position: { x: -1.2, y: 0.3, z: 0.7 }, radius: 0.3 },
    { id: "rear-right", position: { x: -1.2, y: 0.3, z: -0.7 }, radius: 0.3 },
];
const HANGING_WHEELS = FLUSH_WHEELS.map((wheel) => ({ ...wheel, position: { ...wheel.position, y: 0.2 } }));

function car({ id = "ego", position = {}, yaw = 0, wheels = FLUSH_WHEELS } = {}) {
    const manifest = normalizeVehicleManifest({
        id: "contact-car",
        dynamics: { model: CONTACT_BICYCLE_MODEL },
        boundingBox: { size: { x: 4, y: 1.4, z: 1.8 }, center: { x: 0, y: 0.7, z: 0 } },
        kinematics: { wheelbase: 2.4 },
        wheels,
    });
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition({
        id,
        pose: { position: { x: 0, y: 0, z: 0, ...position }, rotation: { x: 0, y: yaw, z: 0, order: "XYZ" } },
    }, { manifest }));
    plant.telemetryId = id;
    return plant;
}

const start = startChassis;
const run = runChassis;

function wall(id, center, yaw, half = { x: 0.5, z: 5 }) {
    const corners = [[-half.x, -half.z], [half.x, -half.z], [half.x, half.z], [-half.x, half.z]];
    const footprint = corners.map(([x, z]) => ({
        x: center.x + x * Math.cos(yaw) + z * Math.sin(yaw),
        z: center.z - x * Math.sin(yaw) + z * Math.cos(yaw),
    }));
    const xs = footprint.map((point) => point.x);
    const zs = footprint.map((point) => point.z);
    return {
        id,
        footprint,
        triangles: [[0, 1, 2], [0, 2, 3]],
        minY: 0,
        maxY: 3,
        bounds: { min: { x: Math.min(...xs), y: 0, z: Math.min(...zs) }, max: { x: Math.max(...xs), y: 3, z: Math.max(...zs) } },
    };
}

test("a chassis claims its plant and releases it on dispose", async () => {
    const ego = car({ position: { y: 1 } });
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego]);
    assert.equal(ego.rapierChassis, true);
    assert.equal(physics.hasChassis(), true);
    physics.disposeRun();
    assert.equal(ego.rapierChassis, false);
});

test("a dropped chassis lands at its clearance and stays in contact with zero roll", async () => {
    for (const [wheels, clearance] of [[FLUSH_WHEELS, 0], [HANGING_WHEELS, 0.1]]) {
        const ego = car({ position: { y: 2 }, wheels });
        const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego]);
        run(physics, [ego], 200);
        const landed = { ...ego.position };
        let lost = 0;
        run(physics, [ego], 1000, null, { each: () => { if (!ego.onRoad) lost += 1; } });
        assert.equal(lost, 0, `contact lost ${lost} times`);
        assert.equal(CHASSIS_RAY_SLACK, 0.02);
        assert.ok(Math.abs(ego.position.y - clearance) < 0.01, `y ${ego.position.y}`);
        assert.ok(Math.abs(ego.verticalVelocity) < 1e-3, `vertical ${ego.verticalVelocity}`);
        const drift = Math.hypot(ego.position.x - landed.x, ego.position.z - landed.z);
        assert.ok(drift < 1e-3, `drift ${drift}`);
        assert.equal(ego.rotation.x, 0);
        assert.ok(physics.getDeterministicState().activeContacts.includes("ego|ground:floor"));
        physics.disposeRun();
    }
});

test("a floor with its collider off still holds the chassis and drops a prop", async () => {
    const ego = car({ position: { y: 1 } });
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0, collider: false } }, [ego]);
    run(physics, [ego], 200);
    assert.ok(Math.abs(ego.position.y) < 0.01, `y ${ego.position.y}`);
    const prop = physics.world.createRigidBody(
        physics.RAPIER.RigidBodyDesc.dynamic().setTranslation(10, 3, 10).setCanSleep(false).setCcdEnabled(true),
    );
    prop.setEnabledRotations(false, false, false, true);
    const descriptor = physics.RAPIER.ColliderDesc.cuboid(0.25, 0.25, 0.25);
    descriptor.setCollisionGroups(((DYNAMIC_GROUP & 0xffff) << 16) | 0xffff);
    physics.world.createCollider(descriptor, prop);
    for (let step = 0; step < 180; step += 1) physics.step(DT);
    assert.ok(prop.translation().y < 0, `prop y ${prop.translation().y}`);
    physics.disposeRun();
});

test("acceleration mode drives forward at about the command", async () => {
    const ego = car({ position: { y: 0.01 } });
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego]);
    run(physics, [ego], 50);
    run(physics, [ego], 200, { mode: "acceleration", accelerationX: 2 });
    assert.ok(ego.velocity.x > 3.5 && ego.velocity.x < 4.1, `vx ${ego.velocity.x}`);
    assert.ok(Math.abs(ego.acceleration.x - 2) < 0.2, `ax ${ego.acceleration.x}`);
    assert.ok(ego.position.x > 3, `x ${ego.position.x}`);
    assert.ok(Math.abs(ego.position.z) < 1e-3, `z ${ego.position.z}`);
    physics.disposeRun();
});

test("positive steer turns the chassis positive", async () => {
    const ego = car({ position: { y: 0.01 } });
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego]);
    run(physics, [ego], 30);
    run(physics, [ego], 300, { mode: "acceleration", accelerationX: 2, steeringRad: 0.2 });
    assert.ok(ego.rotation.y > 0.1, `chassis yaw ${ego.rotation.y}`);
    assert.ok(ego.yawRate > 0);
    physics.disposeRun();
});

test("a ramp pitches the chassis with zero roll facing along it and across it", async () => {
    const pitch = 0.1;
    const along = car({ position: { x: 5, y: Math.tan(pitch) * 5 + 0.05 } });
    const across = car({ id: "across", position: { x: 30, y: Math.tan(pitch) * 30 + 0.05 }, yaw: Math.PI / 2 });
    const world = { obstacles: [], groundPlane: { y: -1 }, drivableSurfaces: [rampSurface(pitch)] };
    const first = await start(world, [along]);
    run(first.physics, [along], 100);
    assert.equal(along.onRoad, true);
    assert.ok(Math.abs(along.rotation.z - pitch) < 0.01, `along pitch ${along.rotation.z}`);
    assert.equal(along.rotation.x, 0);
    first.physics.disposeRun();

    const second = await start(world, [across]);
    run(second.physics, [across], 100);
    assert.equal(across.onRoad, true);
    assert.ok(Math.abs(across.rotation.z) < 0.01, `across pitch ${across.rotation.z}`);
    assert.equal(across.rotation.x, 0);
    assert.ok(Math.abs(across.rotation.y - Math.PI / 2) < 0.05, `across yaw ${across.rotation.y}`);
    assert.ok(across.lateralVelocity > 1e-4, `downhill vy ${across.lateralVelocity}`);
    assert.ok(across.position.x < 30, `downhill x ${across.position.x}`);
    second.physics.disposeRun();
});

test("ramp landings retain physical body gyro and inertial acceleration at multiple headings", async () => {
    for (const yaw of [0, Math.PI / 3, -0.6]) {
        const ego = car({ position: { x: 5, y: 4 }, yaw });
        const { physics } = await start({ obstacles: [], groundPlane: { y: -5 }, drivableSurfaces: [rampSurface(0.3)] }, [ego]);
        let previous = null;
        let peakPitchRate = 0;
        try {
            for (let step = 1; step <= 180; step += 1) {
                const body = physics.vehicleStates[0].body;
                const beforeVelocity = { ...body.linvel() };
                run(physics, [ego], 1);
                const inverse = quaternionInverse(body.rotation());
                const angular = threeToRep103Vector(rotateVectorByQuaternion(body.angvel(), inverse));
                const velocity = threeToRep103Vector(rotateVectorByQuaternion(body.linvel(), inverse));
                const afterVelocity = body.linvel();
                const acceleration = threeToRep103Vector(rotateVectorByQuaternion({
                    x: (afterVelocity.x - beforeVelocity.x) / DT,
                    y: (afterVelocity.y - beforeVelocity.y) / DT,
                    z: (afterVelocity.z - beforeVelocity.z) / DT,
                }, inverse));
                const snapshot = captureVehicleSnapshot(ego, step * 10_000_000, previous);
                for (const axis of ["x", "y", "z"]) {
                    assert.ok(Math.abs(snapshot.bodyAngularVelocity[axis] - angular[axis]) < 1e-6, `gyro ${yaw}: ${axis}`);
                    assert.ok(Math.abs(snapshot.bodyVelocity[axis] - velocity[axis]) < 1e-6, `velocity ${yaw}: ${axis}`);
                    assert.ok(Math.abs(snapshot.bodyAcceleration[axis] - acceleration[axis]) < 1e-3, `acceleration ${yaw}: ${axis}`);
                    if (previous) {
                        const alpha = (snapshot.bodyAngularVelocity[axis] - previous.bodyAngularVelocity[axis]) / DT;
                        assert.ok(Math.abs(snapshot.bodyAngularAcceleration[axis] - alpha) < 1e-9);
                    }
                }
                peakPitchRate = Math.max(peakPitchRate, Math.abs(angular.y));
                previous = snapshot;
            }
            assert.ok(peakPitchRate > 0.1, `pitch rate ${yaw}: ${peakPitchRate}`);
        } finally {
            physics.disposeRun();
        }
    }
});

test("a rotated wall stops the chassis at its hull and reports the contact", async () => {
    const ego = car({ position: { y: 0.01 } });
    const world = { obstacles: [wall("wall", { x: 12, z: 0 }, 0.3)], groundPlane: { y: 0 } };
    const { physics, events } = await start(world, [ego]);
    run(physics, [ego], 30);
    run(physics, [ego], 600, { mode: "velocity", speedMps: 5 });
    const faceX = 12 - 0.5 / Math.cos(0.3) - 0.9 * Math.tan(0.3);
    assert.ok(ego.position.x + 2 < faceX + 0.3, `nose ${ego.position.x + 2}, face ${faceX}`);
    assert.ok(ego.position.x > 6, `stopped early at ${ego.position.x}`);
    assert.ok(events.some((event) => event.name === "contact-start" && event.payload.secondId === "wall"));
    run(physics, [ego], 400, { mode: "velocity", speedMps: -3 });
    assert.ok(events.some((event) => event.name === "contact-end" && event.payload.secondId === "wall"));
    physics.disposeRun();
});

test("the chassis pushes a dynamic crate", async () => {
    const ego = car({ position: { y: 0.01 } });
    const crate = {
        id: "crate",
        host: "primitive",
        bodyType: "dynamic",
        mass: 20,
        useGravity: true,
        linearDamping: 0,
        angularDamping: 0,
        constantForce: { x: 0, y: 0, z: 0 },
        position: { x: 6, y: 0.5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        parts: [{ kind: "cuboid", half: { x: 0.5, y: 0.5, z: 0.5 } }],
    };
    const world = { obstacles: [], groundPlane: { y: 0 }, rigidBodies: [crate] };
    const { physics, events } = await start(world, [ego]);
    run(physics, [ego], 400, { mode: "velocity", speedMps: 3 });
    const pose = physics.rigidBodyPoses().find((entry) => entry.id === "crate");
    assert.ok(pose.position.x > 7, `crate x ${pose.position.x}`);
    assert.ok(events.some((event) => event.name === "contact-start" && event.payload.secondId === "crate"));
    physics.disposeRun();
});

test("a kinematic car and a chassis report one sorted pair key", async () => {
    const ego = car({ position: { y: 0.01 } });
    const parked = {
        telemetryId: "a-parked",
        position: { x: 6, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        collisionDimensions: { x: 2, y: 1.4, z: 1.8 },
        collisionCenter: { x: 0, y: 0.7, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego, parked]);
    let seen = false;
    run(physics, [ego], 400, { mode: "velocity", speedMps: 3 }, {
        each: () => { seen ||= physics.getDeterministicState().activeContacts.includes("a-parked|ego"); },
    });
    assert.equal(seen, true);
    assert.ok(ego.position.x < 6 - 1 - 2 + 0.3, `ego x ${ego.position.x}`);
    physics.disposeRun();
});

test("physics off keeps the chassis stepping and skips the kinematic sweep", async () => {
    const ego = car({ position: { y: 0.01 } });
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego]);
    run(physics, [ego], 200, { mode: "acceleration", accelerationX: 2 }, { sweep: false });
    assert.ok(ego.position.x > 1, `x ${ego.position.x}`);
    physics.disposeRun();
});

test("an outside teleport moves the body to the plant pose", async () => {
    const ego = car({ position: { y: 0.01 } });
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego]);
    run(physics, [ego], 20);
    ego.position.x = 40;
    run(physics, [ego], 5);
    assert.ok(Math.abs(ego.position.x - 40) < 1e-3, `x ${ego.position.x}`);
    physics.disposeRun();
});

test("a steady turn does not count the centripetal term twice in the IMU snapshot", async () => {
    const ego = car({ position: { y: 0.01 } });
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego]);
    run(physics, [ego], 30);
    run(physics, [ego], 400, { mode: "velocity", speedMps: 4, steeringRad: 0.15 });
    run(physics, [ego], 300, { mode: "velocity", speedMps: 4, steeringRad: 0.15 });
    const snapshot = captureVehicleSnapshot(ego, 1, null, 10_000_000);
    const centripetal = ego.yawRate * ego.velocity.x;
    assert.ok(Math.abs(centripetal) > 0.5, `centripetal ${centripetal}`);
    assert.ok(Math.abs(Math.abs(snapshot.bodyAcceleration.y) - Math.abs(centripetal)) < 0.15 * Math.abs(centripetal),
        `imu ay ${snapshot.bodyAcceleration.y}, r*vx ${centripetal}`);
    physics.disposeRun();
});

test("a stop command does not reverse the chassis and it stays parked", async () => {
    const ego = car({ position: { y: 0.01 } });
    const { physics } = await start({ obstacles: [], groundPlane: { y: 0 } }, [ego]);
    run(physics, [ego], 300, { mode: "velocity", speedMps: 5 });
    let reversed = false;
    run(physics, [ego], 700, { mode: "stop" }, { each: () => { reversed ||= ego.velocity.x < -1e-6; } });
    assert.equal(reversed, false);
    const parked = { ...ego.position };
    run(physics, [ego], 1000, { mode: "stop" });
    assert.ok(Math.abs(ego.velocity.x) < 1e-3, `vx ${ego.velocity.x}`);
    assert.ok(Math.hypot(ego.position.x - parked.x, ego.position.z - parked.z) < 1e-3, "creep");
    physics.disposeRun();
});

test("a contact plant without a chassis does not integrate", () => {
    const ego = car({ position: { y: 0 } });
    applyManualDrive(ego, { mode: "acceleration", accelerationX: 2 });
    for (let index = 0; index < 20; index += 1) ego.update(DT);
    assert.equal(ego.rapierChassis, undefined);
    assert.equal(ego.velocity.x, 0);
    assert.equal(ego.longitudinal.mode, "acceleration");
    assert.equal(ego.longitudinal.accelerationMps2, 2);
});

test("free fall specific force cancels and a held grade does not", async () => {
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
    const measure = (body) => buildImuMeasurement(
        captureVehicleSnapshot(body, 10_000_000),
        config,
        new SeededRNG("contact-imu"),
        createMeasurementSeedState(config, new SeededRNG("contact-imu")),
    ).measurement.linearAcceleration;

    const falling = car({ position: { y: 3 } });
    const airborne = await start({ obstacles: [], groundPlane: { y: 0 } }, [falling]);
    run(airborne.physics, [falling], 1);
    const fall = measure(falling);
    assert.ok(Math.abs(fall.z) < 0.05, `free fall z ${fall.z}`);
    airborne.physics.disposeRun();

    const pitch = 0.4;
    const held = car({ position: { x: 5, y: Math.tan(pitch) * 5 + 0.05 } });
    held.definition.dynamics.rollingResistance = 1;
    const grounded = await start({ obstacles: [], groundPlane: { y: -5 }, drivableSurfaces: [rampSurface(pitch)] }, [held]);
    run(grounded.physics, [held], 80);
    const grade = measure(held);
    assert.ok(Math.abs(grade.x) > 1, `held grade x ${grade.x}`);
    assert.ok(Math.abs(held.velocity.x) < 0.05, `held vx ${held.velocity.x}`);
    grounded.physics.disposeRun();
});
