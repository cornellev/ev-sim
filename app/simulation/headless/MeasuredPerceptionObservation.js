import {
    MeasuredStateObservationBuilder,
    createMeasuredStateObservationSpace,
    metadataSpaces,
} from "./MeasuredStateObservation.js";
import {
    boxSpace,
    dictionarySpace,
    namedSharedTensor,
    namedTensor,
    tensorMap,
} from "./TensorProtocol.js";

const FLOAT_BOUND = Number.MAX_VALUE;
const UINT64_BOUND = Number.MAX_SAFE_INTEGER;

export function perceptionSensorDescriptor(sensor) {
    const products = sensor.calibration?.products || {};
    if (sensor.type === "camera" && products.rgb === true) {
        return {
            id: sensor.id,
            type: sensor.type,
            dtype: "uint8",
            shape: [Number(sensor.calibration.height), Number(sensor.calibration.width), 4],
            low: [0],
            high: [255],
        };
    }
    if (sensor.type === "lidar3d" && products.pointCloud === true) {
        const azimuth = sensor.calibration.azimuth;
        const elevation = sensor.calibration.elevation;
        return {
            id: sensor.id,
            type: sensor.type,
            dtype: "float32",
            shape: [
                Math.ceil((elevation.endDeg - elevation.startDeg) / elevation.stepDeg),
                Math.ceil((azimuth.endDeg - azimuth.startDeg) / azimuth.stepDeg),
                2,
            ],
            low: [0],
            high: [FLOAT_BOUND],
        };
    }
    return null;
}

export function createMeasuredPerceptionObservationSpace(stateDescriptors = [], perceptionDescriptors = []) {
    const base = createMeasuredStateObservationSpace(stateDescriptors);
    const entries = [...base.dictionary.entries];
    for (const descriptor of perceptionDescriptors) {
        const prefix = `sensors/${descriptor.id}`;
        entries.push({
            key: `${prefix}/value`,
            space: boxSpace(`${prefix}/value`, 1, descriptor.dtype, descriptor.shape, descriptor.low, descriptor.high),
        });
        entries.push(...metadataSpaces(prefix));
    }
    return dictionarySpace("measured-perception", 1, entries);
}

export class MeasuredPerceptionObservationBuilder {
    constructor(sensorManager, route, vehicleSource) {
        this.state = new MeasuredStateObservationBuilder(sensorManager, route, vehicleSource);
        this.sensorManager = sensorManager;
        this.lastGenerations = new Map();
    }

    reset() {
        this.state.reset();
        this.lastGenerations.clear();
    }

    build(options = {}) {
        const base = this.state.build(options);
        const entries = [...base.entries];
        for (const record of this.sensorManager.getPerceptionObservationRecords?.(options.step ?? 0) ?? []) {
            const prefix = `sensors/${record.id}`;
            const generation = Number(record.generation || 0);
            const isNew = generation > 0 && generation !== (this.lastGenerations.get(record.id) ?? 0);
            if (generation > 0) this.lastGenerations.set(record.id, generation);
            const value = record.sharedMemory
                ? namedSharedTensor(`${prefix}/value`, record.dtype, record.shape, record.sharedMemory)
                : namedTensor(`${prefix}/value`, record.dtype, record.shape, record.value ?? new Array(record.shape.reduce((total, size) => total * size, 1)).fill(0));
            entries.push(value);
            entries.push(namedTensor(`${prefix}/validity`, "bool", [1], [record.validity === true]));
            entries.push(namedTensor(`${prefix}/sequence`, "uint64", [1], [BigInt(record.sequence ?? 0)]));
            entries.push(namedTensor(`${prefix}/is_new`, "bool", [1], [isNew]));
            entries.push(namedTensor(`${prefix}/age_steps`, "uint64", [1], [BigInt(record.ageSteps ?? UINT64_BOUND)]));
        }
        return tensorMap(entries);
    }
}
