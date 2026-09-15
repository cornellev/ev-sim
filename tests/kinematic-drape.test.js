import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { createRoadGroundSampler, sampleRoadGround } from "../app/simulation/vehicles/roadGroundSampler.js";
import { buildDirectedRoadGraph } from "../app/scenarios/route/roadGraph.js";
import { HeadlessVehicleManager } from "../app/simulation/headless/HeadlessVehicleManager.js";
import { attachVehiclePlant, stepVehiclePlant } from "../app/3d/vehicles/VehiclePlantAdapter.js";

function rampEnvironment(endY = 5) {
    return {
        environmentId: "drape-ramp",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 10, y: endY, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "ab",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
                width: 8,
                laneCount: 2,
            }],
        },
    };
}

function bicycleEntry(overrides = {}) {
    return {
        id: "ego",
        type: "big-car",
        pose: { position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        linearVelocity: { x: 2, y: 0, z: 0 },
        linearAcceleration: { x: 0, y: 0, z: 0 },
        steeringAngle: 0,
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

function presentationVehicle(initial, manifest, options = {}) {
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
    attachVehiclePlant(vehicle, initial, { manifest }, options);
    return vehicle;
}

test("bicycle drape tracks paved y and pitch while XZ/yaw match an undraped plant", () => {
    const env = rampEnvironment(5);
    const graph = buildDirectedRoadGraph(env);
    const sampler = createRoadGroundSampler(env);
    const draped = new KinematicVehiclePlant(createVehiclePlantDefinition(bicycleEntry()));
    const control = new KinematicVehiclePlant(createVehiclePlantDefinition(bicycleEntry()));
    draped.setGroundSampler((x, z, yaw) => sampler.sample(x, z, yaw));

    for (let step = 0; step < 8; step += 1) {
        draped.update(0.1);
        control.update(0.1);
        const expected = sampleRoadGround(draped.position, graph, draped.rotation.y);
        assert.ok(expected, `still on pavement at x=${draped.position.x}`);
        assert.ok(Math.abs(draped.position.y - expected.y) <= 1e-12);
        assert.ok(Math.abs(draped.rotation.z - expected.pitch) <= 1e-12);
        assert.equal(draped.rotation.x, 0);
        assert.ok(Math.abs(draped.position.x - control.position.x) <= 1e-12);
        assert.ok(Math.abs(draped.position.z - control.position.z) <= 1e-12);
        assert.ok(Math.abs(draped.rotation.y - control.rotation.y) <= 1e-12);
        assert.equal(control.position.y, 0);
        assert.equal(control.rotation.z, 0);
    }
});

test("off-road drape holds the last on-road y and pitch", () => {
    const env = rampEnvironment(5);
    const sampler = createRoadGroundSampler(env);
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition(bicycleEntry({
        pose: { position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
    })));
    plant.setGroundSampler((x, z, yaw) => sampler.sample(x, z, yaw));
    const heldY = plant.position.y;
    const heldPitch = plant.rotation.z;
    assert.ok(heldY > 0);
    plant.position.z = 40;
    plant.drapeToGround();
    assert.equal(plant.position.y, heldY);
    assert.equal(plant.rotation.z, heldPitch);
});

test("scenario-car ignores a ground sampler", () => {
    const scenarioEntry = bicycleEntry({
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
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition(scenarioEntry));
    plant.setGroundSampler(() => ({ y: 99, pitch: 1, kind: "road", edgeId: "ab" }));
    plant.update(1);
    assert.deepEqual(plant.position, { x: 5, y: 0, z: 2 });
    assert.equal(plant.rotation.z, 0);
});

test("browser adapter and headless manager match on an elevated ramp within 1e-9", async () => {
    const env = rampEnvironment(5);
    const initial = bicycleEntry();
    const manifest = getBuiltInVehicleManifest("big-car");
    const browser = presentationVehicle(initial, manifest, { environment: env });
    const headless = new HeadlessVehicleManager();
    await headless.configureFromManifest([initial], null, {
        resolvedVehicles: [{ actorId: initial.id, vehicleId: initial.type, manifest }],
        environment: env,
    });
    const plant = headless.vehicles[0];
    for (const dt of [0.05, 0.05, 0.1]) {
        stepVehiclePlant(browser, dt);
        headless.update(dt);
        const left = browser.plant.getDeterministicState();
        const right = plant.getDeterministicState();
        for (const field of ["position", "rotation"]) {
            for (const axis of ["x", "y", "z"]) {
                assert.ok(Math.abs(left[field][axis] - right[field][axis]) <= 1e-9, `${field}.${axis}`);
            }
        }
        assert.ok(left.position.y > 0);
    }
});

test("v2 elevated curve drape stays on the compiled centerline height", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/environment-editor/curved-elevated-network.v2.json", import.meta.url)));
    const env = { environmentId: fixture.environmentId, roads: fixture.roads };
    const sampler = createRoadGroundSampler(env);
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition(bicycleEntry({
        pose: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        linearVelocity: { x: 3, y: 0, z: 0 },
    })));
    plant.setGroundSampler((x, z, yaw) => sampler.sample(x, z, yaw));
    for (let step = 0; step < 10; step += 1) plant.update(0.05);
    const expected = sampler.sample(plant.position.x, plant.position.z, plant.rotation.y);
    assert.ok(expected);
    assert.ok(Math.abs(plant.position.y - expected.y) <= 1e-9);
});
