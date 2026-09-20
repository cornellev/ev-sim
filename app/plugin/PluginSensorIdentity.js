import {
    canonicalExactStringify,
    sha256ExactBytes,
} from "../simulation/visual/VisualLayer.js";

export const PLUGIN_SENSORS_KIND = "cev-sim.plugin-sensors";
export const PLUGIN_SENSORS_VERSION = 1;

const textEncoder = new TextEncoder();

function compareText(left, right) {
    const a = textEncoder.encode(String(left));
    const b = textEncoder.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function exactHash(domain, value) {
    return sha256ExactBytes(textEncoder.encode(canonicalExactStringify({ domain, version: 1, value })));
}

function clone(value) {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function pluginSensorEffectiveConfigHash(record) {
    const sensor = record.sensor;
    return exactHash("cev-sim.plugin-sensor-config", {
        sensorId: sensor.id,
        type: sensor.type,
        rateHz: sensor.rateHz,
        phaseNs: sensor.phaseNs,
        parentId: sensor.parentId,
        frameId: sensor.frameId,
        mountFrameId: sensor.mountFrameId,
        measurementFrameId: sensor.measurementFrameId,
        syncGroupId: sensor.syncGroupId,
        pose: sensor.pose,
        calibration: sensor.calibration,
        enabledProducts: record.products.map((product) => product.productId),
        outputs: sensor.outputs,
        schema: sensor.schema,
        latency: sensor.latency,
        noise: sensor.noise,
        observation: record.observation ? {
            productId: record.observation.productId,
            dtype: record.observation.dtype,
            shape: record.observation.shape,
            components: record.observation.components,
        } : null,
    });
}

export function createPluginSensorsResource(admission) {
    const sensors = admission.sensors.filter((record) => record.kind === "plugin-range-image").map((record) => Object.freeze({
        sensorId: record.sensor.id,
        type: record.sensor.type,
        pluginId: record.plugin.ownership.pluginId,
        runtimeHash: record.plugin.ownership.runtimeHash,
        sensorAbi: record.plugin.descriptor.sensorAbi,
        family: record.plugin.descriptor.family,
        effectiveConfigHash: pluginSensorEffectiveConfigHash(record),
        requiredBackend: clone(record.requiredBackend),
        observationDescriptor: record.observation ? clone({
            productId: record.observation.productId,
            dtype: record.observation.dtype,
            shape: record.observation.shape,
            components: record.observation.components,
        }) : null,
    }));
    if (sensors.length === 0) return null;
    sensors.sort((left, right) => compareText(left.sensorId, right.sensorId));
    const description = Object.freeze({ sensors: Object.freeze(sensors) });
    return Object.freeze({
        kind: PLUGIN_SENSORS_KIND,
        version: PLUGIN_SENSORS_VERSION,
        description,
        hash: exactHash("cev-sim.plugin-sensors", description),
    });
}

export function assertPluginSensorsResource(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Resolved pluginSensors must be an object.");
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== 4 || keys.join(",") !== "description,hash,kind,version") {
        throw new TypeError("Resolved pluginSensors contains unknown or missing fields.");
    }
    if (value.kind !== PLUGIN_SENSORS_KIND || value.version !== PLUGIN_SENSORS_VERSION) {
        throw new TypeError(`Resolved pluginSensors must be ${PLUGIN_SENSORS_KIND} version ${PLUGIN_SENSORS_VERSION}.`);
    }
    const sensors = value.description?.sensors;
    if (!Array.isArray(sensors) || sensors.length === 0) throw new TypeError("Resolved pluginSensors must contain sensor records.");
    const sorted = [...sensors].sort((left, right) => compareText(left.sensorId, right.sensorId));
    if (canonicalExactStringify(sorted) !== canonicalExactStringify(sensors)) {
        throw new TypeError("Resolved pluginSensors records are not canonically ordered.");
    }
    if (!/^[a-f0-9]{64}$/.test(value.hash)
        || value.hash !== exactHash("cev-sim.plugin-sensors", value.description)) {
        throw new TypeError("Resolved pluginSensors hash is invalid.");
    }
    return value;
}
