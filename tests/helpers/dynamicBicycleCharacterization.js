import { applyManualDrive, attachVehiclePlant, stepVehiclePlant, syncVehicleFromPlant } from "../../app/3d/vehicles/VehiclePlantAdapter.js";
import {
    buildImuMeasurement,
    buildWheelOdometryMeasurement,
    captureVehicleSnapshot,
    createMeasurementSeedState,
} from "../../app/autonomy/LocalizationMeasurements.js";
import { HeadlessVehicleManager } from "../../app/simulation/headless/HeadlessVehicleManager.js";
import { normalizeRunSensor } from "../../app/simulation/sensors/SensorTypeRegistry.js";
import { DYNAMIC_BICYCLE_MODEL, normalizeVehicleManifest } from "../../app/vehicles/VehicleManifest.js";
import { SeededRNG } from "../../app/util/SeededRNG.js";

const STEP_NS = 10_000_000;
const TOLERANCE = 1e-9;

export const DYNAMIC_BICYCLE_TAPE = Object.freeze([
    { steps: 5, dt: 0.01, mode: "hold", steering: 0, pitch: -0.1 },
    { steps: 15, dt: 0.01, mode: "acceleration", accelerationMps2: 2, steering: 0, pitch: 0 },
    { steps: 15, dt: 0.01, mode: "acceleration", accelerationMps2: 1, steering: 0.2, pitch: 0 },
]);

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(12)) : 0;
}

function zeros() {
    return { x: 0, y: 0, z: 0 };
}

function quietCalibration() {
    return {
        angularVelocityStdDev: zeros(),
        linearAccelerationStdDev: zeros(),
        angularRandomWalk: zeros(),
        accelerationRandomWalk: zeros(),
        poseNoise: zeros(),
        twistNoise: zeros(),
        turnOnBias: { randomize: false, angular: zeros(), acceleration: zeros() },
        noise: {},
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

function close(left, right, label) {
    if (Math.abs(left - right) > TOLERANCE) {
        throw new Error(`${label} differs by ${left - right}`);
    }
}

function assertPlantMatch(left, right) {
    for (const field of ["position", "rotation", "velocity", "acceleration"]) {
        for (const axis of ["x", "y", "z"]) {
            close(left[field][axis], right[field][axis], `${field}.${axis}`);
        }
    }
    close(left.steeringAngle, right.steeringAngle, "steeringAngle");
    close(left.lateralVelocity, right.lateralVelocity, "lateralVelocity");
    close(left.yawRate, right.yawRate, "yawRate");
}

function assertVectorMatch(left, right, label) {
    for (const axis of ["x", "y", "z"]) close(left[axis], right[axis], `${label}.${axis}`);
}

function sampleSensors(vehicle, captureTimeNs, previous, imuState, wheelState, imuConfig, wheelConfig, step) {
    const snapshot = captureVehicleSnapshot(vehicle, captureTimeNs, previous, STEP_NS);
    const imu = buildImuMeasurement(snapshot, imuConfig, new SeededRNG(`dyn-imu:${step}`), imuState);
    const wheel = buildWheelOdometryMeasurement(snapshot, wheelConfig, new SeededRNG(`dyn-wheel:${step}`), wheelState);
    return { snapshot, imu, wheel };
}

function recordStep(state, imu, wheel, step, timeNs) {
    return {
        step,
        timeNs,
        vx: finite(state.velocity.x),
        vy: finite(state.lateralVelocity),
        r: finite(state.yawRate),
        x: finite(state.position.x),
        y: finite(state.position.y),
        z: finite(state.position.z),
        yaw: finite(state.rotation.y),
        ax: finite(state.acceleration.x),
        ay: finite(state.acceleration.y),
        imu: {
            angularZ: finite(imu.measurement.angularVelocity.z),
            linearX: finite(imu.measurement.linearAcceleration.x),
            linearY: finite(imu.measurement.linearAcceleration.y),
            linearZ: finite(imu.measurement.linearAcceleration.z),
        },
        wheel: {
            x: finite(wheel.measurement.position.x),
            y: finite(wheel.measurement.position.y),
            linearX: finite(wheel.measurement.linearVelocity.x),
            angularZ: finite(wheel.measurement.angularVelocity.z),
        },
    };
}

async function createPair() {
    const manifest = normalizeVehicleManifest({
        id: "dynamic-bicycle-v1",
        dynamics: { model: DYNAMIC_BICYCLE_MODEL },
    });
    const initial = {
        id: "ego",
        type: "big-car",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        linearVelocity: { x: 0, y: 0, z: 0 },
        linearAcceleration: { x: 0, y: 0, z: 0 },
        steeringAngle: 0,
    };
    const browser = {
        telemetryId: initial.id,
        position: mutableVector(initial.pose.position),
        rotation: mutableVector(initial.pose.rotation, true),
        velocity: mutableVector(initial.linearVelocity),
        acceleration: mutableVector(initial.linearAcceleration),
        steeringAngle: initial.steeringAngle,
        updatePosition(value) { this.position.copy(value); },
        updateRotation(value) { this.rotation.copy(value); },
    };
    attachVehiclePlant(browser, initial, { manifest });
    const headless = new HeadlessVehicleManager();
    await headless.configureFromManifest([initial], null, {
        resolvedVehicles: [{ actorId: initial.id, vehicleId: initial.type, manifest }],
    });
    return { browser, headless: headless.vehicles[0] };
}

export async function replayDynamicBicycleCharacterization() {
    const { browser, headless } = await createPair();
    const pitch = { value: DYNAMIC_BICYCLE_TAPE[0].pitch };
    const sample = () => ({ y: 0, pitch: pitch.value });
    browser.plant.setGroundSampler(sample);
    headless.setGroundSampler(sample);
    syncVehicleFromPlant(browser);

    const imuConfig = normalizeRunSensor({ type: "imu", calibration: quietCalibration() });
    const wheelConfig = normalizeRunSensor({ type: "wheel-odometry", calibration: quietCalibration() });
    let browserImu = createMeasurementSeedState(imuConfig, new SeededRNG("dyn-imu"));
    let headlessImu = createMeasurementSeedState(imuConfig, new SeededRNG("dyn-imu"));
    let browserWheel = createMeasurementSeedState(wheelConfig, new SeededRNG("dyn-wheel"));
    let headlessWheel = createMeasurementSeedState(wheelConfig, new SeededRNG("dyn-wheel"));
    let browserPrevious = null;
    let headlessPrevious = null;
    const steps = [];
    let step = 0;

    for (const segment of DYNAMIC_BICYCLE_TAPE) {
        pitch.value = segment.pitch;
        for (let index = 0; index < segment.steps; index += 1) {
            step += 1;
            const command = {
                mode: segment.mode,
                accelerationX: segment.accelerationMps2,
                steeringRad: segment.steering,
            };
            applyManualDrive(browser, command);
            applyManualDrive(headless, command);
            stepVehiclePlant(browser, segment.dt);
            headless.update(segment.dt);
            const left = browser.plant.getDeterministicState();
            const right = headless.getDeterministicState();
            assertPlantMatch(left, right);

            const timeNs = step * STEP_NS;
            const browserSample = sampleSensors(browser, timeNs, browserPrevious, browserImu, browserWheel, imuConfig, wheelConfig, step);
            const headlessSample = sampleSensors(headless, timeNs, headlessPrevious, headlessImu, headlessWheel, imuConfig, wheelConfig, step);
            assertVectorMatch(browserSample.imu.measurement.angularVelocity, headlessSample.imu.measurement.angularVelocity, "imu.angular");
            assertVectorMatch(browserSample.imu.measurement.linearAcceleration, headlessSample.imu.measurement.linearAcceleration, "imu.linear");
            assertVectorMatch(browserSample.wheel.measurement.position, headlessSample.wheel.measurement.position, "wheel.position");
            assertVectorMatch(browserSample.wheel.measurement.linearVelocity, headlessSample.wheel.measurement.linearVelocity, "wheel.linear");
            assertVectorMatch(browserSample.wheel.measurement.angularVelocity, headlessSample.wheel.measurement.angularVelocity, "wheel.angular");
            browserPrevious = browserSample.snapshot;
            headlessPrevious = headlessSample.snapshot;
            browserImu = { ...browserImu, ...browserSample.imu.nextState, vehicleSnapshot: browserPrevious };
            headlessImu = { ...headlessImu, ...headlessSample.imu.nextState, vehicleSnapshot: headlessPrevious };
            browserWheel = { ...browserWheel, ...browserSample.wheel.nextState };
            headlessWheel = { ...headlessWheel, ...headlessSample.wheel.nextState };
            steps.push(recordStep(right, headlessSample.imu, headlessSample.wheel, step, timeNs));
        }
    }
    return steps;
}

export async function generateDynamicBicycleCharacterization() {
    const steps = await replayDynamicBicycleCharacterization();
    return {
        kind: "cev-sim.vehicle.dynamic-bicycle-characterization",
        version: 1,
        id: "dynamic-bicycle-v1",
        model: DYNAMIC_BICYCLE_MODEL,
        dt: 0.01,
        steps,
    };
}
