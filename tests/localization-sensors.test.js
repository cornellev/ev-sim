import assert from "node:assert/strict";
import test from "node:test";

import { SeededRNG } from "../app/util/SeededRNG.js";
import { enuOffsetToWgs84 } from "../app/3d/earth/GeospatialTransform.js";
import {
    buildGnssMeasurement,
    buildImuMeasurement,
    buildTruthOdometry,
    buildWheelOdometryMeasurement,
    captureVehicleSnapshot,
    createMeasurementSeedState,
    gaussianSample,
    quantizeTravel,
    saturateVector,
} from "../app/autonomy/LocalizationMeasurements.js";
import {
    buildImuMessage,
    buildNavSatFixMessage,
    buildOdometryMessage,
} from "../app/3d/devices/SensorMessages.js";
import { normalizeRunSensor } from "../app/3d/devices/SensorTypeRegistry.js";
import { createLocalizationTruthPublisher } from "../app/simulation/LocalizationTruthPublisher.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { createDefaultRunManifest, normalizeRunManifest } from "../app/simulation/RunManifest.js";
import { catalogSchemas } from "../app/autonomy/AutonomyContractCatalog.js";
import { registerMsgDefinition } from "../app/client/Client.js";

function mockVehicle(overrides = {}) {
    return {
        telemetryId: "ego",
        position: { x: 0, y: 0, z: 0, set() {} },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ", set() {} },
        velocity: { x: 0, y: 0, z: 0, set() {} },
        steeringAngle: 0,
        manifest: { kinematics: { wheelbase: 2.5 } },
        ...overrides,
    };
}

test("stationary IMU reports gravity on Z with unavailable orientation", () => {
    const config = normalizeRunSensor({ type: "imu", calibration: { gravity: 9.80665 } });
    const rng = new SeededRNG("imu-stationary");
    const state = createMeasurementSeedState(config, rng);
    const snapshot = captureVehicleSnapshot(mockVehicle(), 16_666_667);
    const { measurement } = buildImuMeasurement(snapshot, config, rng, state);
    assert.ok(Math.abs(measurement.linearAcceleration.z - 9.80665) < 0.05);
    assert.equal(measurement.orientationCovariance[0], -1);
});

test("pitched chassis tilts IMU specific force off the world-up axis", () => {
    const config = normalizeRunSensor({ type: "imu", calibration: { gravity: 9.80665 } });
    const rng = new SeededRNG("imu-pitch");
    const flat = captureVehicleSnapshot(mockVehicle(), 16_666_667);
    const pitched = captureVehicleSnapshot(mockVehicle({
        rotation: { x: 0, y: 0, z: 0.4, order: "XYZ" },
    }), 16_666_667);
    const flatImu = buildImuMeasurement(flat, config, rng, createMeasurementSeedState(config, rng)).measurement;
    const pitchedImu = buildImuMeasurement(pitched, config, rng, createMeasurementSeedState(config, rng)).measurement;
    assert.ok(Math.abs(flatImu.linearAcceleration.z - 9.80665) < 0.05);
    assert.ok(Math.abs(pitchedImu.linearAcceleration.x) > 0.5, "pitch couples gravity into body X");
    assert.ok(Math.abs(pitchedImu.linearAcceleration.z) < Math.abs(flatImu.linearAcceleration.z));
});

test("turning vehicle produces yaw-rate on IMU Z axis", () => {
    const config = normalizeRunSensor({ type: "imu" });
    const rng = new SeededRNG("imu-turn");
    const vehicle = mockVehicle({ velocity: { x: 2, y: 0, z: 0 }, steeringAngle: 0.2 });
    const first = captureVehicleSnapshot(vehicle, 16_666_667);
    const second = captureVehicleSnapshot(vehicle, 33_333_334, first);
    const { measurement } = buildImuMeasurement(second, config, rng, createMeasurementSeedState(config, rng));
    assert.ok(Math.abs(measurement.angularVelocity.z) > 0.01);
});

test("steady turn produces centripetal acceleration on IMU Y axis", () => {
    const config = normalizeRunSensor({ type: "imu" });
    for (const steeringAngle of [0.2, -0.2]) {
        const rng = new SeededRNG("imu-centripetal");
        const vehicle = mockVehicle({ velocity: { x: 3, y: 0, z: 0 }, steeringAngle });
        const first = captureVehicleSnapshot(vehicle, 10_000_000);
        const second = captureVehicleSnapshot(vehicle, 20_000_000, first);
        const yawRate = second.bodyAngularVelocity.z;
        assert.ok(Math.abs(yawRate) > 0.1);
        // Constant body-frame velocity: the only acceleration is speed times yaw rate.
        assert.ok(Math.abs(second.bodyAcceleration.x) < 1e-12);
        assert.ok(Math.abs(second.bodyAcceleration.y - 3 * yawRate) < 1e-12);
        const { measurement } = buildImuMeasurement(second, config, rng, createMeasurementSeedState(config, rng));
        assert.ok(Math.abs(measurement.linearAcceleration.y - 3 * yawRate) < 0.2);
        assert.equal(Math.sign(measurement.linearAcceleration.y), Math.sign(yawRate));
    }
});

test("straight driving produces no lateral IMU acceleration", () => {
    const vehicle = mockVehicle({ velocity: { x: 3, y: 0, z: 0 }, steeringAngle: 0 });
    const first = captureVehicleSnapshot(vehicle, 10_000_000);
    const second = captureVehicleSnapshot(vehicle, 20_000_000, first);
    assert.equal(second.bodyAcceleration.x, 0);
    assert.equal(second.bodyAcceleration.y, 0);
});

test("saturation clamps IMU axes deterministically", () => {
    const vector = saturateVector({ x: 100, y: -100, z: 5 }, 10);
    assert.equal(vector.x, 10);
    assert.equal(vector.y, -10);
    assert.equal(vector.z, 5);
});

test("WGS84 conversion returns datum at zero ENU offset", () => {
    const datum = { lat: 42.4430, lng: -76.4840, altitude: 200 };
    const converted = enuOffsetToWgs84(0, 0, 0, datum);
    assert.ok(Math.abs(converted.lat - datum.lat) < 1e-4);
    assert.ok(Math.abs(converted.lng - datum.lng) < 1e-4);
});

test("GNSS dropout returns no sample and outage emits no-fix status", () => {
    const config = normalizeRunSensor({
        type: "gnss",
        calibration: { faults: { dropoutProbability: 1, outageProbability: 0 } },
    });
    const rng = new SeededRNG("gnss-dropout");
    const snapshot = captureVehicleSnapshot(mockVehicle(), 16_666_667);
    const dropped = buildGnssMeasurement(snapshot, config, rng, createMeasurementSeedState(config, rng));
    assert.equal(dropped.measurement, null);

    const outageConfig = normalizeRunSensor({
        type: "gnss",
        calibration: { faults: { dropoutProbability: 0, outageProbability: 1 } },
    });
    const outage = buildGnssMeasurement(snapshot, outageConfig, new SeededRNG("gnss-outage"), createMeasurementSeedState(outageConfig, rng));
    assert.equal(outage.measurement.noFix, true);
});

test("GNSS covariance includes multipath variance and matches the sampled error", () => {
    const config = normalizeRunSensor({
        type: "gnss",
        calibration: {
            positionNoiseEnu: { x: 0.05, y: 0.05, z: 0.05 },
            faults: { multipathStdDev: { x: 0.1, y: 0.1, z: 0.1 }, multipathTauSec: 1 },
        },
    });
    const rng = new SeededRNG("gnss-covariance");
    let state = createMeasurementSeedState(config, rng);
    const exactConfig = normalizeRunSensor({
        type: "gnss",
        calibration: {
            positionNoiseEnu: { x: 0, y: 0, z: 0 },
            faults: { multipathStdDev: { x: 0, y: 0, z: 0 } },
        },
    });
    const exactSnapshot = captureVehicleSnapshot(mockVehicle(), 100_000_000);
    const reference = buildGnssMeasurement(exactSnapshot, exactConfig, new SeededRNG("gnss-exact"), createMeasurementSeedState(exactConfig, rng)).measurement;
    const metersPerDegree = 111_000;
    let sumSquares = 0;
    let covariance = null;
    const samples = 20_000;
    for (let index = 1; index <= samples; index += 1) {
        const snapshot = captureVehicleSnapshot(mockVehicle(), index * 100_000_000);
        const result = buildGnssMeasurement(snapshot, config, rng, state);
        state = { ...state, ...result.nextState };
        covariance = result.measurement.positionCovariance;
        sumSquares += ((result.measurement.latitude - reference.latitude) * metersPerDegree) ** 2;
    }
    const expectedVariance = 0.05 ** 2 + 0.1 ** 2;
    assert.ok(Math.abs(covariance[4] - expectedVariance) < 1e-12);
    const sampledVariance = sumSquares / samples;
    assert.ok(Math.abs(sampledVariance / expectedVariance - 1) < 0.15, `sampled variance ${sampledVariance}`);
});

test("encoder quantization is deterministic and slip reduces travel", () => {
    const q1 = quantizeTravel(0.123, 0.15, 1024);
    const q2 = quantizeTravel(0.123, 0.15, 1024);
    assert.equal(q1, q2);
    assert.ok(q1 > 0);
});

test("wheel odometry carries partial ticks so distance does not drift with speed", () => {
    const config = normalizeRunSensor({
        type: "wheel-odometry",
        rateHz: 50,
        calibration: { poseNoise: { x: 0, y: 0, z: 0 }, twistNoise: { x: 0, y: 0, z: 0 } },
    });
    const tickLength = (2 * Math.PI * config.calibration.wheelRadius) / config.calibration.ticksPerRevolution;
    const stepNs = 20_000_000;
    const captures = 1500;
    // 0.01 m/s moves less than half a tick per sample, which rounded to zero
    // when each sample was quantized on its own.
    for (const speed of [0.01, 0.2, 1, 3]) {
        const rng = new SeededRNG(`wheel-ticks-${speed}`);
        const vehicle = mockVehicle({ velocity: { x: speed, y: 0, z: 0 } });
        let measurementState = createMeasurementSeedState(config, rng);
        let lastSnapshot = null;
        let position = null;
        for (let step = 1; step <= captures; step += 1) {
            const snapshot = captureVehicleSnapshot(vehicle, step * stepNs, lastSnapshot, stepNs);
            lastSnapshot = snapshot;
            const result = buildWheelOdometryMeasurement(snapshot, config, rng.fork(`sample-${step}`), measurementState);
            measurementState = { ...measurementState, ...result.nextState };
            position = result.measurement.position;
        }
        const truth = speed * captures * (stepNs / 1e9);
        const traveled = Math.hypot(position.x, position.y);
        assert.ok(Math.abs(traveled - truth) <= tickLength, `${speed} m/s: traveled ${traveled} m, truth ${truth} m`);
    }
});

test("wheel odometry integrates independently from truth pose", () => {
    const config = normalizeRunSensor({ type: "wheel-odometry", rateHz: 50 });
    const rng = new SeededRNG("wheel");
    const state = createMeasurementSeedState(config, rng);
    const vehicle = mockVehicle({ velocity: { x: 1, y: 0, z: 0 } });
    let measurementState = state;
    let lastSnapshot = null;
    for (let step = 1; step <= 5; step += 1) {
        const captureTimeNs = step * 20_000_000;
        const snapshot = captureVehicleSnapshot(vehicle, captureTimeNs, lastSnapshot, 20_000_000);
        lastSnapshot = snapshot;
        const result = buildWheelOdometryMeasurement(snapshot, config, rng.fork(`sample-${step}`), measurementState);
        measurementState = { ...measurementState, ...result.nextState };
        if (step === 5) {
            assert.ok(result.measurement.position.x > 0 || result.measurement.position.y > 0);
        }
    }
});

test("wheel odometry integrates over the real capture interval, not 1 / rateHz", () => {
    // 50 Hz on a 60 Hz step: the schedule rounds the period to one step, so
    // captures arrive every 16.67 ms instead of every 20 ms.
    const config = normalizeRunSensor({ type: "wheel-odometry", rateHz: 50 });
    const rng = new SeededRNG("wheel-interval");
    const vehicle = mockVehicle({ velocity: { x: 3, y: 0, z: 0 } });
    const stepNs = 16_666_667;
    const captures = 180;
    let measurementState = createMeasurementSeedState(config, rng);
    let lastSnapshot = null;
    let position = null;
    for (let step = 1; step <= captures; step += 1) {
        const snapshot = captureVehicleSnapshot(vehicle, step * stepNs, lastSnapshot, stepNs);
        lastSnapshot = snapshot;
        const result = buildWheelOdometryMeasurement(snapshot, config, rng.fork(`sample-${step}`), measurementState);
        measurementState = { ...measurementState, ...result.nextState };
        position = result.measurement.position;
    }
    // The first capture has no previous one and integrates over 1 / rateHz.
    const truth = 3 * (1 / 50 + ((captures - 1) * stepNs) / 1e9);
    const traveled = Math.hypot(position.x, position.y);
    assert.ok(Math.abs(traveled / truth - 1) < 0.01, `traveled ${traveled} m, truth ${truth} m`);
});

test("measurement reset reproduces identical streams for the same seed", () => {
    const config = normalizeRunSensor({ type: "imu", calibration: { angularVelocityStdDev: { x: 0.01, y: 0.01, z: 0.01 } } });
    const run = (seed) => {
        const rng = new SeededRNG(seed);
        let state = createMeasurementSeedState(config, rng);
        const values = [];
        for (let step = 1; step <= 3; step += 1) {
            const snapshot = captureVehicleSnapshot(mockVehicle(), step * 10_000_000);
            const { measurement, nextState } = buildImuMeasurement(snapshot, config, rng.fork(`sample-${step}`), state);
            state = { ...state, ...nextState };
            values.push(measurement.linearAcceleration.z);
        }
        return values;
    };
    assert.deepEqual(run("repeat-a"), run("repeat-a"));
    assert.notDeepEqual(run("repeat-a"), run("repeat-b"));
});

test("oracle truth publisher stays isolated from measured sensors", () => {
    for (const [type, definition] of Object.entries(catalogSchemas())) {
        registerMsgDefinition(type, definition);
    }
    const store = new SignalStore({}, { sourceId: "truth-test" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const publisher = createLocalizationTruthPublisher(manifest, router);
    const vehicle = mockVehicle({ velocity: { x: 1.5, y: 0, z: 0 } });
    publisher.publish(16_666_667, 1, [vehicle]);
    const oracle = store.read("oracle.topics.truth-odometry")?.value;
    assert.ok(oracle?.twist?.twist?.linear?.x > 0);
    assert.ok(!store.read("topics./sensors/imu/data")?.value);
});

test("localization estimate loopback routes through candidate namespace", () => {
    for (const [type, definition] of Object.entries(catalogSchemas())) {
        registerMsgDefinition(type, definition);
    }
    const store = new SignalStore({}, { sourceId: "ekf-loopback" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const topic = manifest.topics.find((entry) => entry.contractId === "localization-estimate");
    const payload = buildOdometryMessage({
        timeNs: 16_666_667,
        frameId: "odom",
        childFrameId: "base_link",
        position: { x: 1, y: 2, z: 0 },
        linearVelocity: { x: 0.5, y: 0, z: 0 },
    });
    const routed = router.routeInbound({
        name: topic.name,
        typeStr: topic.schema.type,
        value: payload,
    }, { applyStep: 1, applyTimeNs: 16_666_667, arrivalTimeNs: 16_666_667 });
    assert.equal(routed.ok, true);
    assert.equal(store.read("candidate.topics.localization-estimate")?.value?.pose?.pose?.position?.x, 1);
});

test("default manifest v6 includes localization sensors without migrating v4 runs", () => {
    const defaults = createDefaultRunManifest();
    assert.equal(defaults.version, 11);
    assert.ok(defaults.sensorRig.sensors.some((sensor) => sensor.type === "imu"));
    assert.ok(defaults.topics.some((topic) => topic.contractId === "truth-odometry"));
    const migrated = normalizeRunManifest({ ...createDefaultRunManifest({ sensorRig: { sensors: [] } }), version: 4 });
    assert.equal(migrated.version, 11);
    assert.equal(migrated.sensorRig.sensors.length, 0);
});

test("gaussian sampling is deterministic for a fixed seed", () => {
    const left = gaussianSample(new SeededRNG("gauss"));
    const right = gaussianSample(new SeededRNG("gauss"));
    assert.equal(left, right);
});

test("truth odometry matches vehicle state without sensor noise", () => {
    const vehicle = mockVehicle({ velocity: { x: 2, y: 0, z: 0 }, position: { x: 3, y: 0, z: 0.1 } });
    const snapshot = captureVehicleSnapshot(vehicle, 16_666_667);
    const truth = buildTruthOdometry(snapshot, { odom: "odom", baseLink: "base_link" });
    assert.equal(truth.linearVelocity.x, 2);
    assert.equal(truth.position.x, 3);
});
