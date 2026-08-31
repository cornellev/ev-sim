import {
    buildGnssMeasurement,
    buildImuMeasurement,
    buildWheelOdometryMeasurement,
    captureVehicleSnapshot,
    createMeasurementSeedState,
    stateSensorSampleDropped,
} from "../../autonomy/LocalizationMeasurements.js";
import { SeededRNG } from "../../util/SeededRNG.js";
import { simulationSha256 } from "../kernel/SimulationHashes.js";
import {
    resolveFixedStepSensorSchedule,
    resolveSensorDelivery,
} from "./FixedStepSensorSchedule.js";

export const STATE_SENSOR_BACKEND_KIND = 2;
export const STATE_SENSOR_CAPABILITY_ID = "deterministic-state-sensors";
export const STATE_SENSOR_BACKEND_VERSION = "1";
export const STATE_SENSOR_TYPES = Object.freeze(["gnss", "imu", "wheel-odometry"]);

export const STATE_SENSOR_BACKEND_CONFIG = Object.freeze({
    kind: "cev-sim.state-sensor-backend-config",
    version: 1,
    schedule: "integer-fixed-step-v1",
    delivery: "capture-time-plus-seeded-latency-v1",
    dropout: "capture-attempt-retains-last-delivery-v1",
    gnssOutage: "new-invalid-zero-sample-v1",
    seed: "<reset-seed>:sensor:<stable-id>:sample:<zero-based-index>",
    sensorTypes: STATE_SENSOR_TYPES,
});

export const STATE_SENSOR_BACKEND_CONFIG_HASH = simulationSha256(STATE_SENSOR_BACKEND_CONFIG);
const UTF8 = new TextEncoder();

export function createStateSensorBackendSelection() {
    return {
        kind: STATE_SENSOR_BACKEND_KIND,
        capabilityId: STATE_SENSOR_CAPABILITY_ID,
        version: STATE_SENSOR_BACKEND_VERSION,
        configHash: STATE_SENSOR_BACKEND_CONFIG_HASH,
    };
}

function selectionField(selection, camel, snake) {
    return selection?.[camel] ?? selection?.[snake];
}

export function assertStateSensorBackendSelection(selection) {
    const expected = createStateSensorBackendSelection();
    if (!selection) throw new Error(`State-sensor backend ${STATE_SENSOR_CAPABILITY_ID} is required.`);
    for (const [camel, snake] of [["kind", "kind"], ["capabilityId", "capability_id"], ["version", "version"], ["configHash", "config_hash"]]) {
        const received = selectionField(selection, camel, snake);
        if (received !== expected[camel]) {
            throw new Error(`State-sensor backend mismatch for ${camel}: expected ${expected[camel]}, received ${received}.`);
        }
    }
    return expected;
}

const SENSOR_MODELS = Object.freeze({
    imu: Object.freeze({
        dtype: "float32",
        shape: [6],
        capture: buildImuMeasurement,
        values: (measurement) => [
            measurement.angularVelocity.x,
            measurement.angularVelocity.y,
            measurement.angularVelocity.z,
            measurement.linearAcceleration.x,
            measurement.linearAcceleration.y,
            measurement.linearAcceleration.z,
        ],
    }),
    gnss: Object.freeze({
        dtype: "float64",
        shape: [3],
        capture: buildGnssMeasurement,
        values: (measurement) => measurement?.noFix
            ? [0, 0, 0]
            : [measurement.latitude, measurement.longitude, measurement.altitude],
        validity: (measurement) => !measurement?.noFix,
    }),
    "wheel-odometry": Object.freeze({
        dtype: "float32",
        shape: [13],
        capture: buildWheelOdometryMeasurement,
        values: (measurement) => [
            measurement.position.x,
            measurement.position.y,
            measurement.position.z,
            measurement.orientation.x,
            measurement.orientation.y,
            measurement.orientation.z,
            measurement.orientation.w,
            measurement.linearVelocity.x,
            measurement.linearVelocity.y,
            measurement.linearVelocity.z,
            measurement.angularVelocity.x,
            measurement.angularVelocity.y,
            measurement.angularVelocity.z,
        ],
    }),
});

export function getStateSensorModel(type) {
    return SENSOR_MODELS[String(type)] ?? null;
}

export class StateSensorBackendRegistry {
    constructor() {
        this.backends = new Map([[STATE_SENSOR_CAPABILITY_ID, Object.freeze({
            ...createStateSensorBackendSelection(),
            sensorTypes: STATE_SENSOR_TYPES,
        })]]);
    }

    get(capabilityId) {
        return this.backends.get(capabilityId) ?? null;
    }

    list() {
        return [...this.backends.values()];
    }

    validate(selection) {
        return assertStateSensorBackendSelection(selection);
    }
}

function clone(value) {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function compareUtf8(left, right) {
    const a = UTF8.encode(String(left));
    const b = UTF8.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

class HeadlessStateSensorDevice {
    constructor(config, model) {
        this.telemetryId = config.id;
        this.id = config.id;
        this.type = config.type;
        this.config = clone(config);
        this.model = model;
        this.enabled = config.enabled !== false;
        this.schedule = null;
        this.queue = [];
        this.sampleIndex = 0;
        this.measurementState = null;
        this.latest = null;
        this.deliveryGeneration = 0;
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }
}

export class HeadlessStateSensorManager {
    constructor(vehicleSource, options = {}) {
        this.vehicleSource = vehicleSource;
        this.registry = options.registry ?? new StateSensorBackendRegistry();
        this.devices = [];
        this.seed = "0";
        this.stepNs = 16_666_667;
        this.requireStateSensors = false;
    }

    configureFromManifest(sensorRig = {}, options = {}) {
        this.seed = String(options.seed ?? "0");
        this.stepNs = Math.max(1, Math.round(Number(options.stepNs) || 16_666_667));
        this.requireStateSensors = Boolean(options.requireStateSensors);
        if (options.enabled === false) {
            if (this.requireStateSensors) throw new Error("The measured-state observation profile requires the sensors module.");
            this.devices = [];
            return this.devices;
        }
        if (options.backendSelection) this.registry.validate(options.backendSelection);
        const enabled = (Array.isArray(sensorRig?.sensors) ? sensorRig.sensors : [])
            .filter((sensor) => sensor?.enabled !== false);
        const unsupported = enabled.filter((sensor) => !getStateSensorModel(sensor.type));
        if (unsupported.length > 0) {
            const ids = unsupported.map((sensor) => `${sensor.id}:${sensor.type}`).sort(compareUtf8);
            throw new Error(`Unsupported headless sensor request(s): ${ids.join(", ")}.`);
        }
        if (this.requireStateSensors && enabled.length === 0) {
            throw new Error("The measured-state observation profile requires at least one enabled state sensor.");
        }
        const ids = new Set();
        this.devices = enabled
            .sort((left, right) => compareUtf8(left.id, right.id))
            .map((config) => {
                if (!config.id || ids.has(config.id)) throw new Error(`State sensor IDs must be unique and non-empty: ${config.id || "<empty>"}.`);
                ids.add(config.id);
                return new HeadlessStateSensorDevice(config, getStateSensorModel(config.type));
            });
        const vehicleIds = new Set(this._vehicles().map((vehicle) => vehicle.telemetryId || vehicle.id));
        const missingParent = this.devices.find((device) => !vehicleIds.has(device.config.parentId));
        if (missingParent) {
            throw new Error(`Sensor "${missingParent.id}" references unknown parent vehicle "${missingParent.config.parentId}".`);
        }
        this.resetRun({ resetSeed: this.seed });
        return this.devices;
    }

    resetSchedule() {
        return this.resetRun({ resetSeed: this.seed });
    }

    resetRun({ resetSeed = this.seed } = {}) {
        this.seed = String(resetSeed);
        for (const device of this.devices) {
            device.schedule = null;
            device.queue = [];
            device.sampleIndex = 0;
            device.latest = null;
            device.deliveryGeneration = 0;
            device.measurementState = null;
        }
        return this.getDeterministicState();
    }

    _vehicles() {
        const source = typeof this.vehicleSource === "function" ? this.vehicleSource() : this.vehicleSource;
        return source?.vehicles ?? [];
    }

    _vehicle(device) {
        const vehicles = this._vehicles();
        return vehicles.find((vehicle) => (vehicle.telemetryId || vehicle.id) === device.config.parentId) ?? null;
    }

    update(_dt, clock) {
        for (const device of this.devices) {
            if (!device.enabled) continue;
            if (!device.schedule) {
                device.schedule = resolveFixedStepSensorSchedule(device.config, clock, this.stepNs);
            }
            while (clock.step >= device.schedule.nextCaptureStep) {
                const captureStep = device.schedule.nextCaptureStep;
                const captureTimeNs = captureStep * device.schedule.stepNs;
                const sampleIndex = device.sampleIndex++;
                const rng = new SeededRNG(`${this.seed}:sensor:${device.id}:sample:${sampleIndex}`);
                const vehicle = this._vehicle(device);
                if (vehicle) {
                    if (!device.measurementState) {
                        device.measurementState = createMeasurementSeedState(device.config, rng);
                    }
                    const snapshot = captureVehicleSnapshot(
                        vehicle,
                        captureTimeNs,
                        device.measurementState.vehicleSnapshot,
                        device.schedule.stepNs,
                    );
                    device.measurementState.vehicleSnapshot = snapshot;
                    const result = device.model.capture(snapshot, device.config, rng, device.measurementState);
                    device.measurementState = { ...device.measurementState, ...result.nextState };
                    const dropped = device.type !== "gnss" && stateSensorSampleDropped(device.config, rng);
                    if (result.measurement && !dropped) {
                        const delivery = resolveSensorDelivery(device.config, captureTimeNs, rng, device.schedule.stepNs);
                        if (device.queue.length < Math.max(1, Number(device.config.maxQueueFrames || 8))) {
                            device.queue.push({
                                ...delivery,
                                captureTimeNs,
                                captureStep,
                                sampleIndex,
                                sequence: sampleIndex,
                                value: device.model.values(result.measurement).map(Number),
                                validity: device.model.validity ? device.model.validity(result.measurement) : true,
                            });
                        }
                    }
                }
                device.schedule.nextCaptureStep += device.schedule.periodSteps;
            }
        }
    }

    deliver(clock) {
        for (const device of this.devices) {
            const ready = device.queue
                .filter((sample) => sample.deliveryTimeNs <= clock.timeNs)
                .sort((left, right) => left.deliveryTimeNs - right.deliveryTimeNs || left.sequence - right.sequence);
            device.queue = device.queue.filter((sample) => sample.deliveryTimeNs > clock.timeNs);
            for (const sample of ready) {
                device.deliveryGeneration += 1;
                device.latest = { ...sample, deliveryStep: clock.step, generation: device.deliveryGeneration };
            }
        }
    }

    getObservationRecords(step) {
        return this.devices.map((device) => ({
            id: device.id,
            type: device.type,
            dtype: device.model.dtype,
            shape: [...device.model.shape],
            sample: device.latest ? clone(device.latest) : null,
            ageSteps: device.latest ? Math.max(0, Number(step) - device.latest.captureStep) : 0,
        }));
    }

    finalizeRun() {
        return this.getDeterministicState();
    }

    disposeRun() {
        this.devices = [];
    }

    getDeterministicState() {
        return this.devices.map((device) => ({
            id: device.id,
            type: device.type,
            enabled: device.enabled,
            sampleIndex: device.sampleIndex,
            schedule: device.schedule ? { ...device.schedule } : null,
            queue: clone(device.queue),
            latest: clone(device.latest),
            measurementState: clone(device.measurementState),
        }));
    }
}
