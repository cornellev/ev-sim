import assert from "node:assert/strict";
import test from "node:test";

import {
    buildImuMeasurement,
    captureVehicleSnapshot,
    createMeasurementSeedState,
} from "../app/autonomy/LocalizationMeasurements.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { resolveVehicleFootprint } from "../app/scenarios/ScenarioMetrics.js";
import {
    createStateSensorBackendSelection,
    HeadlessStateSensorManager,
    STATE_SENSOR_BACKEND_CONFIG_HASH,
} from "../app/simulation/sensors/StateSensorBackend.js";
import { SeededRNG } from "../app/util/SeededRNG.js";

const STEP_NS = 10_000_000;

function pose() {
    return {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    };
}

function baseSensor(id, type, calibration = {}) {
    return {
        id,
        type,
        enabled: true,
        parentId: "ego",
        pose: pose(),
        rateHz: 100,
        phaseNs: 0,
        calibration,
        latency: { fixedNs: 0, jitterNs: 0 },
        noise: { dropoutProbability: 0 },
        maxQueueFrames: 8,
    };
}

function imu(id = "imu") {
    return baseSensor(id, "imu", {
        gravity: 9.80665,
        noise: {},
        angularVelocityStdDev: { x: 0, y: 0, z: 0 },
        linearAccelerationStdDev: { x: 0, y: 0, z: 0 },
        angularRandomWalk: { x: 0, y: 0, z: 0 },
        accelerationRandomWalk: { x: 0, y: 0, z: 0 },
        turnOnBias: { randomize: false, angular: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 } },
    });
}

function gnss(id = "gnss") {
    return baseSensor(id, "gnss", {
        datum: { latitude: 42.443, longitude: -76.484, altitude: 200 },
        positionNoiseEnu: { x: 0, y: 0, z: 0 },
        faults: { dropoutProbability: 0, outageProbability: 0, multipathStdDev: { x: 0, y: 0, z: 0 } },
    });
}

function wheel(id = "wheel") {
    return baseSensor(id, "wheel-odometry", {
        wheelRadius: 0.15,
        ticksPerRevolution: 1024,
        trackWidth: 1.2,
        slipFactor: 0,
        poseNoise: { x: 0, y: 0, z: 0 },
        twistNoise: { x: 0, y: 0, z: 0 },
        childFrameId: "base_link",
    });
}

function vehicle() {
    return {
        telemetryId: "ego",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        velocity: { x: 2, y: 0, z: 0 },
        acceleration: { x: 0, y: 0, z: 0 },
        steeringAngle: 0.2,
        kinematics: { wheelbase: 4 },
    };
}

function managerFor(sensors, target = vehicle()) {
    const source = { vehicles: [target] };
    const manager = new HeadlessStateSensorManager(source);
    manager.configureFromManifest({ sensors }, {
        seed: "17",
        stepNs: STEP_NS,
        enabled: true,
        requireStateSensors: true,
        backendSelection: createStateSensorBackendSelection(),
    });
    return { manager, target };
}

test("state-sensor backend identity is canonical and protocol-shaped", () => {
    const selection = createStateSensorBackendSelection();
    assert.deepEqual(selection, {
        kind: 2,
        capabilityId: "deterministic-state-sensors",
        version: "1",
        configHash: STATE_SENSOR_BACKEND_CONFIG_HASH,
    });
    assert.match(selection.configHash, /^[0-9a-f]{64}$/);
});

test("headless IMU reuses browser measurement seeds and custom wheelbase", () => {
    const config = imu();
    const { manager, target } = managerFor([config]);
    manager.update(0.01, { step: 1, timeNs: STEP_NS });
    manager.deliver({ step: 1, timeNs: STEP_NS });
    const actual = manager.getObservationRecords(1)[0].sample;

    const rng = new SeededRNG("17:sensor:imu:sample:0");
    const state = createMeasurementSeedState(config, rng);
    const snapshot = captureVehicleSnapshot(target, STEP_NS, null, STEP_NS);
    const expected = buildImuMeasurement(snapshot, config, rng, state).measurement;
    assert.deepEqual(actual.value, [
        expected.angularVelocity.x,
        expected.angularVelocity.y,
        expected.angularVelocity.z,
        expected.linearAcceleration.x,
        expected.linearAcceleration.y,
        expected.linearAcceleration.z,
    ]);
    assert.equal(snapshot.wheelbase, 4);
    assert.equal(resolveVehicleFootprint({ ...target, collisionDimensions: { x: 4, y: 2, z: 2 } }).wheelbase, 4);
    manager.devices[0].config.noise.dropoutProbability = 1;
    manager.update(0.01, { step: 2, timeNs: STEP_NS * 2 });
    manager.deliver({ step: 2, timeNs: STEP_NS * 2 });
    assert.equal(manager.getObservationRecords(2)[0].sample.sequence, actual.sequence);
    assert.equal(manager.getObservationRecords(2)[0].ageSteps, 1);
});

test("GNSS dropout retains the previous sample while outage delivers invalid zeros", () => {
    const { manager } = managerFor([gnss()]);
    manager.update(0.01, { step: 1, timeNs: STEP_NS });
    manager.deliver({ step: 1, timeNs: STEP_NS });
    const first = manager.getObservationRecords(1)[0].sample;
    manager.devices[0].config.noise.dropoutProbability = 1;
    manager.update(0.01, { step: 2, timeNs: STEP_NS * 2 });
    manager.deliver({ step: 2, timeNs: STEP_NS * 2 });
    const retained = manager.getObservationRecords(2)[0];
    assert.equal(retained.sample.sequence, first.sequence);
    assert.equal(retained.ageSteps, 1);

    const outageConfig = gnss("outage");
    outageConfig.calibration.faults.outageProbability = 1;
    const outage = managerFor([outageConfig]).manager;
    outage.update(0.01, { step: 1, timeNs: STEP_NS });
    outage.deliver({ step: 1, timeNs: STEP_NS });
    assert.deepEqual(outage.getObservationRecords(1)[0].sample.value, [0, 0, 0]);
    assert.equal(outage.getObservationRecords(1)[0].sample.validity, false);
});

test("latency, reset replay, sequence, and age are deterministic", () => {
    const config = wheel();
    config.latency.fixedNs = STEP_NS * 2;
    const { manager } = managerFor([config]);
    assert.equal(manager.getObservationRecords(0)[0].sample, null);
    manager.update(0.01, { step: 1, timeNs: STEP_NS });
    manager.deliver({ step: 1, timeNs: STEP_NS });
    assert.equal(manager.getObservationRecords(1)[0].sample, null);
    manager.deliver({ step: 3, timeNs: STEP_NS * 3 });
    const first = manager.getObservationRecords(3)[0];
    assert.equal(first.sample.sequence, 0);
    assert.equal(first.ageSteps, 2);
    const golden = first.sample.value;

    manager.resetRun({ resetSeed: "17" });
    manager.update(0.01, { step: 1, timeNs: STEP_NS });
    manager.deliver({ step: 3, timeNs: STEP_NS * 3 });
    assert.deepEqual(manager.getObservationRecords(3)[0].sample.value, golden);
});

test("headless modules import without browser or graphics globals", async () => {
    const descriptors = Object.fromEntries(["window", "document", "navigator", "WebGLRenderingContext"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    try {
        for (const key of Object.keys(descriptors)) Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error(`${key} accessed`); } });
        const imported = await import(`../app/simulation/headless/HeadlessEpisode.js?node-safe=${Date.now()}`);
        assert.equal(typeof imported.HeadlessEpisode, "function");
        assert.equal(typeof SimulationKernel, "function");
    } finally {
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});
