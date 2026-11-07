import assert from "node:assert/strict";
import test from "node:test";

import { applyManualDrive } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { createHeadlessRuntimeContext } from "../app/simulation/headless/HeadlessRuntimeContext.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { PLANT_CONTACT_BICYCLE_MODEL } from "../app/plugin/PlantModule.js";
import { createVehiclePlantDefinition, KinematicVehiclePlant } from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { CONTACT_BICYCLE_MODEL, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";

const DT = 0.01;

function car(position = {}) {
    const manifest = normalizeVehicleManifest({ id: "contact-car", dynamics: { model: CONTACT_BICYCLE_MODEL } });
    return new KinematicVehiclePlant(createVehiclePlantDefinition({
        id: "ego", pose: { position: { x: 0, y: 0.01, z: 0, ...position }, rotation: {} },
    }, { manifest }));
}

function crate(position = { x: 10, y: 3, z: 0 }, useGravity = true) {
    return {
        id: "crate", host: "primitive", bodyType: "dynamic", mass: 20, useGravity,
        linearDamping: 0, angularDamping: 0, constantForce: { x: 0, y: 0, z: 0 },
        position, rotation: { x: 0, y: 0, z: 0, w: 1 },
        parts: [{ kind: "cuboid", half: { x: 0.5, y: 0.5, z: 0.5 } }],
    };
}

async function startKernel(testContext, ego, rigidBodies = [crate()]) {
    const runtime = createHeadlessRuntimeContext();
    runtime.vehicles.vehicles = [ego];
    const world = { obstacles: [], groundPlane: { y: 0 }, rigidBodies };
    await runtime.physics.configureRun({ manifest: {}, worldDescription: world, backendSelection: createPhysicsBackendSelection(world) });
    const kernel = new SimulationKernel(runtime.context, { fixedDt: DT });
    for (const name of ["controls", "sensors", "scripting"]) kernel.setModule(name, false);
    kernel.setModule("physics", true);
    testContext.after(() => kernel.dispose());
    return { kernel, physics: runtime.physics };
}

function advance(kernel, steps = 100) {
    for (let step = 0; step < steps; step += 1) kernel.advanceStep();
}

for (const vehicles of [false, true]) {
    for (const physicsEnabled of [false, true]) {
        test(`real kernel contact admission: vehicles=${vehicles}, physics=${physicsEnabled}`, async (testContext) => {
            const ego = car();
            const { kernel, physics } = await startKernel(testContext, ego);
            kernel.setModule("vehicles", vehicles);
            kernel.setModule("physics", physicsEnabled);
            const initial = structuredClone(ego.position);
            applyManualDrive(ego, { mode: "acceleration", accelerationX: 2 });
            advance(kernel);
            if (vehicles) {
                assert.ok(ego.position.x > 0.5, `displacement ${ego.position.x}`);
                assert.ok(ego.velocity.x > 1);
            } else {
                assert.deepEqual(ego.position, initial);
                assert.equal(ego.velocity.x, 0);
                assert.equal(ego.axCommand, 0);
                assert.equal(ego.contactControlActive, false);
            }
            const prop = physics.rigidBodyById.get("crate").body;
            assert.equal(prop.translation().y < 3, vehicles || physicsEnabled);
        });
    }
}

test("disabled contact chassis preserves airborne motion for resume while a prop falls", async (testContext) => {
    const ego = car({ y: 3 });
    const { kernel, physics } = await startKernel(testContext, ego);
    const state = physics.vehicleStates[0];
    state.body.setLinvel({ x: 3, y: 1, z: -2 }, true);
    state.body.setAngvel({ x: 0, y: 1, z: 2 }, true);
    advance(kernel, 1);
    const before = ego.getDeterministicState();
    const linear = { ...state.body.linvel() };
    const angular = { ...state.body.angvel() };
    applyManualDrive(ego, { mode: "acceleration", accelerationX: 2 });
    kernel.setModule("vehicles", false);
    advance(kernel);
    assert.deepEqual(ego.getDeterministicState(), before);
    assert.deepEqual(state.chassis.pausedMotion, { linearVelocity: linear, angularVelocity: angular });
    assert.equal(state.body.isKinematic(), true);
    assert.equal(physics.rigidBodyById.get("crate").body.translation().y < 3, true);
    const snapshot = physics.getDeterministicState();
    snapshot.vehicles[0].pausedMotion.linearVelocity.x = 99;
    assert.equal(state.chassis.pausedMotion.linearVelocity.x, linear.x);
    kernel.setModule("vehicles", true);
    advance(kernel, 1);
    assert.equal(state.body.isDynamic(), true);
    assert.equal(state.chassis.pausedMotion, null);
    assert.ok(Math.abs(ego.position.x - before.position.x - linear.x * DT) < 1e-5);
    assert.ok(Math.abs(ego.position.z - before.position.z - linear.z * DT) < 1e-5);
    assert.ok(Math.abs(ego.bodyAcceleration.z + 9.81) < 1);
});

test("a disabled chassis remains a collider for a moving prop", async (testContext) => {
    const ego = car({ y: 0 });
    const { kernel, physics } = await startKernel(testContext, ego, [crate({ x: -8, y: 0.7, z: 0 }, false)]);
    kernel.setModule("vehicles", false);
    physics.rigidBodyById.get("crate").body.setLinvel({ x: 8, y: 0, z: 0 }, true);
    const before = ego.getDeterministicState();
    let touching = false;
    for (let step = 0; step < 150; step += 1) {
        kernel.advanceStep();
        touching ||= physics.activeContacts.has("ego|crate");
    }
    assert.equal(touching, true);
    assert.deepEqual(ego.getDeterministicState(), before);
    const face = -ego.collisionDimensions.x / 2 - 0.5;
    assert.ok(physics.rigidBodyById.get("crate").body.translation().x < face + 0.05);
});

test("disabled vehicle admission does not execute a contact plugin", async (testContext) => {
    let calls = 0;
    const manifest = normalizeVehicleManifest({ id: "contact-plugin", dynamics: { plant: "contact" } });
    const ego = new KinematicVehiclePlant(createVehiclePlantDefinition({
        id: "ego", pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
    }, { manifest }, { plantModel: PLANT_CONTACT_BICYCLE_MODEL }), {
        stepper: { step() { calls += 1; throw new Error("Disabled contact plugin executed."); } },
    });
    const { kernel } = await startKernel(testContext, ego);
    kernel.setModule("vehicles", false);
    applyManualDrive(ego, { mode: "acceleration", accelerationX: 2 });
    advance(kernel);
    assert.equal(calls, 0);
    assert.deepEqual(ego.position, { x: 0, y: 0, z: 0 });
});

test("a frozen chassis accepts teleports and reset clears its saved motion", async (testContext) => {
    const ego = car({ y: 3 });
    const { kernel, physics } = await startKernel(testContext, ego);
    kernel.setModule("vehicles", false);
    advance(kernel, 1);
    ego.updatePosition({ x: 10, y: 5, z: 1 });
    ego.updateRotation({ x: 0, y: 0.4, z: 0.2 });
    advance(kernel, 2);
    const state = physics.vehicleStates[0];
    assert.deepEqual({ ...state.body.translation() }, ego.position);
    assert.deepEqual(ego.bodyAcceleration, { x: 0, y: 0, z: 0 });
    kernel.setModule("vehicles", true);
    advance(kernel, 1);
    assert.ok(Math.hypot(...Object.values(ego.bodyAcceleration)) < 10);
    kernel.setModule("vehicles", false);
    advance(kernel, 1);
    ego.resetRunState();
    physics.resetRun();
    const fresh = physics.vehicleStates[0];
    assert.equal(fresh.chassis.pausedMotion, null);
    assert.equal(fresh.body.isDynamic(), true);
    assert.deepEqual(ego.bodyAngularVelocity, { x: 0, y: 0, z: 0 });
    assert.deepEqual(ego.bodyAcceleration, { x: 0, y: 0, z: 0 });
    advance(kernel, 1);
    assert.equal(fresh.body.isKinematic(), true);
    kernel.dispose();
    assert.equal(ego.rapierChassis, false);
    assert.deepEqual(physics.vehicleStates, []);
});
