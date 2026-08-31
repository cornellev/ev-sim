import assert from "node:assert/strict";
import test from "node:test";

import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { HeadlessVehicleManager } from "../app/simulation/headless/HeadlessVehicleManager.js";
import { attachVehiclePlant, stepVehiclePlant } from "../app/3d/vehicles/VehiclePlantAdapter.js";

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

function presentationVehicle(initial, manifest) {
    const vehicle = {
        telemetryId: initial.id,
        position: mutableVector(initial.pose.position),
        rotation: mutableVector(initial.pose.rotation, true),
        velocity: mutableVector(initial.linearVelocity),
        acceleration: mutableVector(initial.linearAcceleration),
        steeringAngle: initial.steeringAngle,
        updatePosition(value) { this.position.copy(value); },
        updateRotation(value) { this.rotation.copy(value); },
    };
    attachVehiclePlant(vehicle, initial, { manifest });
    return vehicle;
}

test("built-in bicycle plant uses local +X and explicit Euler ordering", () => {
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition(entry()));
    plant.update(0.5);
    const speed = 3.5;
    assert.equal(plant.velocity.x, speed);
    assert.ok(Math.abs(plant.position.x - (1 + Math.cos(0.2) * speed * 0.5)) <= 1e-12);
    assert.ok(Math.abs(plant.position.z - (2 - Math.sin(0.2) * speed * 0.5)) <= 1e-12);
    const expectedYaw = 0.2 + (speed / getBuiltInVehicleManifest("big-car").kinematics.wheelbase) * Math.tan(0.1) * 0.5;
    assert.ok(Math.abs(plant.rotation.y - expectedYaw) <= 1e-12);
});

test("custom manifests use their pinned wheelbase and steering limit", async () => {
    const custom = getBuiltInVehicleManifest("big-car");
    custom.id = "custom-plant";
    custom.kinematics.wheelbase = 4;
    custom.kinematics.maxSteeringAngle = 0.2;
    const manager = new HeadlessVehicleManager();
    await manager.configureFromManifest([entry({ type: "custom-plant", steeringAngle: 1 })], null, {
        resolvedVehicles: [{ actorId: "ego", vehicleId: "custom-plant", manifest: custom }],
    });
    manager.update(0.25);
    const state = manager.vehicles[0];
    const expected = 0.2 + (3.25 / 4) * Math.tan(0.2) * 0.25;
    assert.ok(Math.abs(state.rotation.y - expected) <= 1e-12);
});

test("ScenarioCar plant interpolates deterministically and reset equals fresh construction", () => {
    const scenarioEntry = entry({
        type: "scenario-car",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
        linearVelocity: {},
        linearAcceleration: {},
        steeringAngle: 0,
        keyframes: [
            { t: 0, x: 0, y: 0, yaw: 0, velocity: 0 },
            { t: 2, x: 10, y: 4, yaw: Math.PI / 2, velocity: 6 },
        ],
    });
    const definition = createVehiclePlantDefinition(scenarioEntry);
    const plant = new KinematicVehiclePlant(definition);
    plant.update(1);
    assert.deepEqual(plant.position, { x: 5, y: 0, z: 2 });
    assert.equal(plant.velocity.x, 3);
    plant.resetRunState(scenarioEntry);
    const fresh = new KinematicVehiclePlant(definition);
    assert.deepEqual(plant.getDeterministicState(), fresh.getDeterministicState());
});

test("browser presentation adapter and headless manager match a vehicle tape within 1e-9", async () => {
    const initial = entry();
    const manifest = getBuiltInVehicleManifest("big-car");
    const browser = presentationVehicle(initial, manifest);
    const headless = new HeadlessVehicleManager();
    await headless.configureFromManifest([initial], null, {
        resolvedVehicles: [{ actorId: initial.id, vehicleId: initial.type, manifest }],
    });
    const plant = headless.vehicles[0];
    const tape = [
        { dt: 0.01, acceleration: 0.5, steering: 0.15 },
        { dt: 0.02, acceleration: -0.25, steering: -0.3 },
        { dt: 0.05, acceleration: 1.25, steering: 1 },
    ];
    for (const action of tape) {
        browser.acceleration.x = action.acceleration;
        browser.steeringAngle = action.steering;
        plant.acceleration.x = action.acceleration;
        plant.steeringAngle = action.steering;
        stepVehiclePlant(browser, action.dt);
        headless.update(action.dt);
        const left = browser.plant.getDeterministicState();
        const right = headless.getDeterministicState()[0];
        assert.equal(left.id, right.id);
        for (const field of ["position", "rotation", "velocity", "acceleration"]) {
            for (const axis of ["x", "y", "z"]) {
                assert.ok(Math.abs(left[field][axis] - right[field][axis]) <= 1e-9);
            }
        }
        assert.ok(Math.abs(left.steeringAngle - right.steeringAngle) <= 1e-9);
    }
});
