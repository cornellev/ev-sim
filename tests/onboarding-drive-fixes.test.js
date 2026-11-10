import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { topicFromContract } from "../app/autonomy/AutonomyContractCatalog.js";
import { CandidateOutputRuntime } from "../app/autonomy/CandidateOutputRuntime.js";
import { ControlRuntime } from "../app/autonomy/ControlRuntime.js";
import { newContactRunDefaults } from "../app/config/simpleRunModel.js";
import { applyManualDrive } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { createDefaultRunManifest, normalizeRunManifest, validateRunManifest } from "../app/simulation/RunManifest.js";
import { computeSimulationSemanticHash } from "../app/simulation/kernel/SimulationHashes.js";
import { createSimulationRuntimeContext } from "../app/simulation/kernel/SimulationRuntimeContext.js";
import { assertZeroSpeedResponse } from "../app/simulation/vehicles/ContactHostContract.js";
import { createVehiclePlantDefinition, KinematicVehiclePlant } from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { assertSensorWiringReviewCurrent, proposeSensorWiring } from "../app/simulation/sensors/SensorWiring.js";
import { recentObstacleContacts } from "../app/autonomy/AutonomyVisualizationModel.js";
import { SeededRNG } from "../app/util/SeededRNG.js";
import { createRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { buildLidarCapture } from "../app/simulation/sensors/LidarProducts.js";
import { contactTireStep } from "../app/simulation/vehicles/contactBicycle.js";
import { rcVehicleManifest } from "./helpers/rcVehicle.js";
import { placeChassis, rampSurface, runChassis, startChassis } from "./helpers/contactChassisRun.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));
await import("../app/3d/data/VehicleDatabase.js");
const { ManifestImu } = await import("../app/3d/devices/ManifestImu.js");
const { ManifestWheelOdometry } = await import("../app/3d/devices/ManifestWheelOdometry.js");
const { ManifestLidar3d } = await import("../app/3d/devices/ManifestLidar3d.js");

test("sensor wiring is reviewed, typed, deterministic, and preserves existing mappings", () => {
    const manifest = createDefaultRunManifest();
    manifest.sensorRig.sensors = manifest.sensorRig.sensors.filter((sensor) => ["imu", "wheel-odometry", "lidar3d"].includes(sensor.type));
    for (const sensor of manifest.sensorRig.sensors) sensor.outputs = {};
    const before = JSON.stringify(manifest);
    const proposal = proposeSensorWiring(manifest);
    assert.equal(JSON.stringify(manifest), before);
    assert.equal(proposal.issues.length, 0);
    assert.equal(proposal.changes.length, manifest.sensorRig.sensors.length);
    assert.equal(validateRunManifest(proposal.manifest).ok, true);
    assert.deepEqual(proposeSensorWiring(proposal.manifest).changes, []);
    const preserved = structuredClone(proposal.manifest);
    preserved.sensorRig.sensors[0].outputs.custom = "existing-custom";
    assert.equal(proposeSensorWiring(preserved).manifest.sensorRig.sensors[0].outputs.custom, "existing-custom");
});

test("ambiguous topic repair requires an explicit choice and never overwrites a mapping", () => {
    const manifest = createDefaultRunManifest();
    manifest.sensorRig.sensors = manifest.sensorRig.sensors.filter((sensor) => sensor.type === "imu");
    manifest.sensorRig.sensors[0].outputs = {};
    manifest.topics = [topicFromContract("imu", { id: "one", name: "/one" }), topicFromContract("imu", { id: "two", name: "/two" })];
    const proposal = proposeSensorWiring(manifest);
    assert.equal(proposal.issues.length, 1);
    const selected = proposeSensorWiring(manifest, { selections: { [proposal.issues[0].key]: "two" } });
    assert.equal(selected.issues.length, 0);
    assert.equal(selected.manifest.sensorRig.sensors[0].outputs.imuTopicId, "two");
    assert.deepEqual(proposeSensorWiring(manifest, { sensorIds: [] }).manifest, manifest);
});

test("review guards reject stale drafts, vehicles, and catalog changes without applying anything", () => {
    const manifest = createDefaultRunManifest();
    const vehicle = rcVehicleManifest();
    const review = { source: JSON.stringify(manifest), vehicle, catalogRevision: 1 };
    assert.doesNotThrow(() => assertSensorWiringReviewCurrent(review, manifest, { vehicle, catalogRevision: 1 }));
    assert.throws(() => assertSensorWiringReviewCurrent(review, { ...manifest, name: "changed" }, { vehicle, catalogRevision: 1 }), /changed/);
    assert.throws(() => assertSensorWiringReviewCurrent(review, manifest, { vehicle: structuredClone(vehicle), catalogRevision: 1 }), /changed/);
    assert.throws(() => assertSensorWiringReviewCurrent(review, manifest, { vehicle, catalogRevision: 2 }), /changed/);
    assert.equal(review.source, JSON.stringify(manifest));
});

test("observation-only IMU and odometry never emit undefined topics", () => {
    const vehicle = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego" }, { manifest: rcVehicleManifest() }));
    for (const [type, Device, size] of [["imu", ManifestImu, 6], ["wheel-odometry", ManifestWheelOdometry, 13]]) {
        const sensor = createRunSensor(type, { id: type, parentId: "ego" });
        sensor.outputs = {};
        const device = new Device(sensor);
        device.getParent = () => ({ getParent: () => ({ vehicles: () => ({ vehicles: [vehicle] }) }) });
        const captured = device.captureAt({ captureTimeNs: 0, sampleIndex: 0, rng: new SeededRNG("unmapped") });
        assert.deepEqual(captured.messages, []);
        assert.equal(captured.observation.value.length, size);
        assert.ok([...captured.observation.value].every(Number.isFinite));
        assert.equal(device.contractPublisher.errors, 0);
        device.contractPublisher.dispose();
    }
});

test("LiDAR callback creates measured products and requested observations in one noise pass", () => {
    const sensor = createRunSensor("lidar3d", { id: "lidar" });
    sensor.calibration.azimuth = { startDeg: 0, endDeg: 1, stepDeg: 1 };
    sensor.calibration.elevation = { startDeg: 0, endDeg: 1, stepDeg: 1 };
    sensor.outputs = { pointCloudTopicId: "points" };
    const device = new ManifestLidar3d(sensor, { includeObservation: true });
    device.config.noise = { ...device.config.noise, model: "gaussian", standardDeviation: 0.1 };
    const rng = new SeededRNG("lidar");
    const expectedRng = new SeededRNG("lidar");
    const buffer = new Float32Array([2, 0.5, 8, 17]);
    const expected = buildLidarCapture({ buffer, config: device.config, captureTimeNs: 0, rng: expectedRng, includeObservation: true });
    device.captureContext = { captureTimeNs: 0, rng };
    device.onShaderUpdate(buffer);
    assert.equal(device.captureMessages.length, 1);
    assert.equal(device.captureMessages[0].topicId, "points");
    assert.deepEqual(device.captureObservation.shape, [1, 1, 2]);
    assert.equal(device.captureObservation.value.length, 2);
    assert.deepEqual(device.captureObservation, expected.observation);
    assert.equal(rng.next(), expectedRng.next());
    device.resetRunState();
    assert.equal(device.captureObservation, null);
    device.config.outputs = {};
    device.includeObservation = false;
    device.captureContext = { captureTimeNs: 0, rng: new SeededRNG("lidar") };
    device.onShaderUpdate(new Float32Array(4));
    assert.equal(device.captureMessages.length, 0);
    assert.equal(device.captureObservation, null);
    device.contractPublisher.dispose();
});

test("async LiDAR delivers the issued capture timestamp and never fabricates a busy frame", (context) => {
    const sensor = createRunSensor("lidar3d", { id: "async-lidar" });
    sensor.calibration.azimuth = { startDeg: 0, endDeg: 1, stepDeg: 1 };
    sensor.calibration.elevation = { startDeg: 0, endDeg: 1, stepDeg: 1 };
    sensor.outputs = {};
    const device = new ManifestLidar3d(sensor, { includeObservation: true, perceptionTruthIndex: { refresh() {} } });
    context.mock.method(Object.getPrototypeOf(ManifestLidar3d.prototype), "execute", () => true);
    let ready = true;
    device.shader = { usesAsyncReadback: true, completePending() {
        if (!ready) return false;
        if (device._issuedCapture) device.onShaderUpdate(new Float32Array([2, 0.5, 8, 17]));
        return true;
    } };
    const capture = (sampleIndex) => device.captureAt({ captureTimeNs: sampleIndex * 10_000_000, sampleIndex, rng: new SeededRNG(sampleIndex) });
    assert.deepEqual(capture(0).messages, []);
    ready = false;
    const busy = capture(1);
    assert.deepEqual(busy.messages, []);
    assert.equal(busy.observation, undefined);
    ready = true;
    const delivered = capture(2);
    assert.equal(delivered.captureTimeNs, 0);
    assert.equal(delivered.sampleIndex, 0);
    assert.ok(delivered.observation);
    device.contractPublisher.dispose();
});

test("contact diagnostics distinguish obstacles and other vehicles from floor support", () => {
    const events = ["ground:floor", "ground:road", "barrel", "car"].map((secondId) => ({ category: "contacts", name: "contact-start", payload: { firstId: "ego", secondId } }));
    assert.deepEqual(recentObstacleContacts(events, "ego"), ["barrel", "car"]);
    assert.deepEqual(recentObstacleContacts(events, "other"), []);
});

test("candidate status starts waiting or inactive and reset never reports missing localization as ok", () => {
    const waiting = new CandidateOutputRuntime({ manifest: createDefaultRunManifest() });
    assert.equal(waiting.lastLocalization.status, "waiting");
    waiting.reset();
    assert.equal(waiting.lastLocalization.status, "waiting");
    assert.equal(waiting.lastLocalization.estimate, null);
    const inactive = new CandidateOutputRuntime({ manifest: { topics: [] } });
    assert.equal(inactive.lastLocalization.status, "inactive");
    assert.equal(inactive.lastPerception.status, "inactive");
});

test("brake profile is explicit, semantic, and rejects unsupported or unusable targets", () => {
    const legacy = createDefaultRunManifest();
    assert.equal(normalizeRunManifest(legacy).controls.zeroSpeedResponse, undefined);
    const enabled = createDefaultRunManifest({ controls: { zeroSpeedResponse: "brake-v1" } });
    assert.notEqual(computeSimulationSemanticHash({ manifest: legacy }), computeSimulationSemanticHash({ manifest: enabled }));
    assert.throws(() => createDefaultRunManifest({ controls: { zeroSpeedResponse: "typo" } }), /zeroSpeedResponse/);
    assert.throws(() => assertZeroSpeedResponse({ manifest: enabled, vehicles: [] }), /contact-v2/);
    const vehicle = rcVehicleManifest();
    assert.doesNotThrow(() => assertZeroSpeedResponse({ manifest: enabled, vehicles: [{ actorId: "ego", manifest: vehicle }] }));
    assert.throws(() => assertZeroSpeedResponse({ manifest: { ...enabled, controls: { ...enabled.controls, actuatorOverrides: { maxJerk: 0 } } }, vehicles: [{ actorId: "ego", manifest: vehicle }] }), /positive/);
    assert.equal(newContactRunDefaults(legacy, vehicle).controls.zeroSpeedResponse, "brake-v1");
    assert.equal(newContactRunDefaults(enabled, { dynamics: {} }).controls.zeroSpeedResponse, undefined);
});

test("accepted control metadata carries actual source, profile, and effective overrides", () => {
    const control = new ControlRuntime();
    control.configure({ controls: { targetVehicleId: "ego", authority: "candidate", zeroSpeedResponse: "brake-v1", actuatorOverrides: { maxDeceleration: 5, maxJerk: 10 } }, vehicleLimits: { ego: rcVehicleManifest().kinematics } });
    control.submitSiSpeedSteer("ego", { mode: "velocity", speedMps: 0, steeringRadRep103: 0, captureTimeNs: 0, producer: "candidate", source: "keyboard" });
    const applied = control.step({ step: 1, timeNs: 10_000_000, dt: 0.01 }).get("ego");
    assert.equal(applied.zeroSpeedResponse, "brake-v1");
    assert.equal(applied.actuatorLimits.maxDeceleration, 5);
    assert.equal(control.getSnapshot("ego").commandSource, "keyboard");
    const body = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego" }, { manifest: rcVehicleManifest() }));
    const runtime = createSimulationRuntimeContext({ vehicles: { vehicles: [body] } });
    runtime.controls.applySetpoints(new Map([["ego", applied]]));
    assert.equal(body.longitudinal.zeroSpeedResponse, "brake-v1");
    assert.equal(body.longitudinal.actuatorLimits.maxDeceleration, 5);
});

test("brake-v1 zero targets use deceleration limits for reverse too, without changing legacy tracking", () => {
    const control = new ControlRuntime();
    const limits = { ...rcVehicleManifest().kinematics, maxDeceleration: 5, maxJerk: 10 };
    const previous = { mode: "velocity", speedMps: -1, steeringRadThree: 0, steeringRadRep103: 0 };
    const desired = { ...previous, speedMps: 0 };
    assert.equal(control._applyLimits(previous, desired, limits, 0.1, 0, "brake-v1").command.speedMps, -0.5);
    assert.equal(control._applyLimits(previous, desired, limits, 0.1, 0).command.speedMps, -0.95);
    const moving = { ...desired, speedMps: 1 };
    assert.deepEqual(control._applyLimits(previous, moving, limits, 0.1, 0, "brake-v1"), control._applyLimits(previous, moving, limits, 0.1, 0));
});

test("brake-v1 RC stops within budget in both directions across fixed timesteps", async () => {
    for (const dt of [0.01, 1 / 60, 0.05, 0.1]) for (const direction of [-1, 1]) {
        const manifest = rcVehicleManifest();
        Object.assign(manifest.dynamics, { mass: 2, yawInertia: 0.016, corneringStiffnessFront: 40, corneringStiffnessRear: 40 });
        Object.assign(manifest.kinematics, { maxDeceleration: 5, maxJerk: 10 });
        const body = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego", pose: { position: { x: 0, y: 0, z: 0 } }, linearVelocity: { x: direction, y: 0, z: 0 } }, { manifest }));
        const { physics } = await startChassis({ obstacles: [], groundPlane: { y: 0 } }, [body]);
        try {
            placeChassis(physics, body);
            applyManualDrive(body, { mode: "velocity", speedMps: 0, zeroSpeedResponse: "brake-v1", actuatorLimits: manifest.kinematics });
            let previous = 0;
            let settledAt = null;
            let restPosition = null;
            runChassis(physics, [body], Math.ceil(3 / dt), null, { dt, each: (index) => {
                assert.ok(Math.abs(body.axCommand - previous) <= 10 * dt + 1e-9, `jerk ${dt} ${direction}`);
                assert.ok(direction * body.axCommand >= -5 - 1e-9);
                assert.ok(direction * body.velocity.x >= -0.001, `reversal ${dt} ${direction}: ${body.velocity.x}`);
                previous = body.axCommand;
                if (Math.abs(body.velocity.x) <= 0.001) {
                    settledAt ??= (index + 1) * dt;
                    restPosition ??= { ...body.position };
                }
                if ((index + 1) * dt > 1) assert.ok(Math.abs(body.velocity.x) <= 0.001, `hunting ${dt} ${direction}`);
            } });
            assert.ok(settledAt !== null && settledAt <= 0.8 + dt, `settling ${dt} ${direction}: ${settledAt}`);
            assert.ok(Math.abs(body.position.x) <= 0.4 + dt, `distance ${dt} ${direction}: ${body.position.x}`);
            assert.ok(Math.hypot(body.position.x - restPosition.x, body.position.z - restPosition.z) < 0.002);
            assert.ok(body.getDeterministicState().brakeState);
            applyManualDrive(body, { mode: "velocity", speedMps: direction, zeroSpeedResponse: "brake-v1" });
            runChassis(physics, [body], 1, null, { dt });
            assert.equal(body.brakeState, undefined);
            body.resetRunState();
            assert.equal(body.brakeState, undefined);
        } finally { physics.disposeRun(); }
    }
});

test("brake-v1 respects friction and steering, holds a gentle grade, and resets on contact loss", async () => {
    for (const [frictionMu, steering, pitch] of [[0.9, 0.15, 0], [0.05, 0, 0], [0.9, 0, 0.02]]) {
        const manifest = rcVehicleManifest();
        Object.assign(manifest.dynamics, { frictionMu, mass: 2, yawInertia: 0.016, corneringStiffnessFront: 40, corneringStiffnessRear: 40 });
        Object.assign(manifest.kinematics, { maxDeceleration: 5, maxJerk: 10 });
        const body = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego", linearVelocity: { x: 1, y: 0, z: 0 }, steeringAngle: steering }, { manifest }));
        const world = pitch ? { obstacles: [], groundPlane: { y: -10 }, contactSurfaces: [rampSurface(pitch)] } : { obstacles: [], groundPlane: { y: 0 } };
        const { physics } = await startChassis(world, [body]);
        try {
            applyManualDrive(body, { mode: "velocity", speedMps: 0, zeroSpeedResponse: "brake-v1", actuatorLimits: manifest.kinematics });
            let previous = 0;
            runChassis(physics, [body], 500, null, { each: () => {
                assert.ok(Number.isFinite(body.velocity.x));
                assert.ok(Math.abs(body.axCommand - previous) <= 0.1 + 1e-8);
                assert.ok(body.axCommand >= -5 - 1e-8 && body.axCommand <= manifest.kinematics.maxAcceleration + 1e-8);
                previous = body.axCommand;
            } });
            assert.ok(Math.abs(body.velocity.x) < 0.001, `friction/grade settling ${frictionMu} ${pitch}: ${body.velocity.x}`);
            const position = { ...body.position };
            runChassis(physics, [body], 200);
            assert.ok(Math.hypot(body.position.x - position.x, body.position.z - position.z) < 0.003);
            contactTireStep(body, false, { x: 0, y: 1, z: 0 }, 0.01);
            assert.equal(body.brakeState, undefined);
            assert.equal(body.axCommand, 0);
            contactTireStep(body, true, { x: 0, y: 1, z: 0 }, 0.01);
            assert.ok(body.brakeState);
        } finally { physics.disposeRun(); }
    }
});
