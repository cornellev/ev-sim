import { getStateSensorModel } from "./StateSensorBackend.js";
import {
    CPU_LIDAR_BACKEND_KIND,
    CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION,
    createCpuLidarBackendSelection,
} from "./CpuLidarBackend.js";
import {
    assertRangeImageLayout,
    checkedRangeImageBytes,
    rangeImageDimensions,
} from "./RangeImageLayout.js";
import { normalizeSensorTransports } from "./SensorTransports.js";
import { sensorTypeRegistry } from "./SensorTypeRegistry.js";

export const DEFAULT_PLUGIN_SENSOR_WORKING_BYTES = 64 * 1024 * 1024;

function compareText(left, right) {
    const leftBytes = new TextEncoder().encode(String(left));
    const rightBytes = new TextEncoder().encode(String(right));
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
        if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
    }
    return leftBytes.length - rightBytes.length;
}

function pluginDefinition(registry, type) {
    return registry.get(type)?.pluginSensor ?? null;
}

function pointCloudObservationDescriptor(sensor, plugin) {
    const mapping = plugin.descriptor.observation;
    if (!mapping || sensor.calibration.products?.[mapping.productId] !== true) return null;
    const layout = sensor.calibration.scanLayout;
    const { channelCount, azimuthCount, rayCount } = rangeImageDimensions(layout);
    return Object.freeze({
        id: sensor.id,
        type: sensor.type,
        productId: mapping.productId,
        dtype: "float32",
        shape: Object.freeze([channelCount, azimuthCount, 2]),
        components: mapping.components,
        low: Object.freeze([0]),
        high: Object.freeze([layout.maxRangeM]),
        componentLow: Object.freeze([0, 0]),
        componentHigh: Object.freeze([layout.maxRangeM, 1]),
        byteLength: rayCount * 2 * Float32Array.BYTES_PER_ELEMENT,
    });
}

function validatePluginProducts(sensor, plugin, topics, producerTopics) {
    const enabledProducts = [];
    for (const product of plugin.descriptor.products) {
        if (sensor.calibration.products?.[product.productId] !== true) continue;
        if (product.kind === "pointCloud") {
            const topicId = sensor.outputs?.[product.outputKey];
            if (!topicId) {
                throw new Error(`Plugin sensor "${sensor.id}" enables product "${product.productId}" without output "${product.outputKey}".`);
            }
            const topic = topics.get(topicId);
            if (!topic) throw new Error(`Plugin sensor "${sensor.id}" references unknown topic "${topicId}".`);
            const type = topic.schema?.type || topic.type;
            if (type !== "sensor_msgs/PointCloud2" || sensor.schema?.[product.outputKey] !== type) {
                throw new Error(`Plugin sensor "${sensor.id}" product "${product.productId}" requires sensor_msgs/PointCloud2.`);
            }
            if (product.contractId && topic.contractId !== product.contractId) {
                throw new Error(`Plugin sensor "${sensor.id}" product "${product.productId}" requires contract "${product.contractId}".`);
            }
            const current = producerTopics.get(topicId);
            if (current && current !== sensor.id) throw new Error(`Topic "${topicId}" has conflicting sensor producers "${current}" and "${sensor.id}".`);
            producerTopics.set(topicId, sensor.id);
            if ((product.contractId === "front-lidar-points" || topic.contractId === "front-lidar-points")
                && plugin.descriptor.observation?.productId !== product.productId) {
                throw new Error(`Plugin product "${product.productId}" claiming front-lidar-points requires a range-image observation mapping.`);
            }
            const signal = product.contractId === "front-lidar-points" || topic.contractId === "front-lidar-points"
                ? "pointCloud" : product.productId;
            enabledProducts.push(Object.freeze({ ...product, topicId, signal }));
            continue;
        }
        const declaredBytes = product.streams.reduce((total, stream) => total + stream.maxPayloadBytes, 0);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > Number(sensor.maxQueueBytes)) {
            throw new Error(`Plugin sensor "${sensor.id}" packet product "${product.productId}" exceeds its queue-byte limit.`);
        }
        enabledProducts.push(product);
    }
    return Object.freeze(enabledProducts);
}

function validateTransportBindings(transports, admitted, { execution = false, host = null } = {}) {
    if (!transports) return Object.freeze([]);
    const descriptor = host && typeof host === "object" && !Array.isArray(host)
        ? host
        : { adapters: [], endpoints: [] };
    const adapters = new Set(descriptor.adapters ?? []);
    const endpoints = new Map((descriptor.endpoints ?? []).map((entry) => [entry.id, entry]));
    const resolved = [];
    for (const binding of transports.bindings) {
        const sensor = admitted.get(binding.sensorId);
        const product = sensor?.products.find((entry) => entry.productId === binding.productId);
        const stream = product?.kind === "vendor-packets"
            ? product.streams.find((entry) => entry.streamId === binding.streamId) : null;
        if (!sensor || !product || !stream) {
            throw new Error(`Sensor transport binding references unavailable stream ${binding.sensorId}/${binding.productId}/${binding.streamId}.`);
        }
        if (!execution) {
            resolved.push(Object.freeze({ ...binding, stream }));
            continue;
        }
        if (!adapters.has(binding.adapter)) {
            throw Object.assign(
                new Error(`Sensor transport adapter "${binding.adapter}" is unavailable.`),
                { code: "UNSUPPORTED_CAPABILITY" },
            );
        }
        const endpoint = endpoints.get(binding.endpointId);
        if (!endpoint || endpoint.adapter !== binding.adapter) {
            throw Object.assign(
                new Error(`Sensor transport endpoint "${binding.endpointId}" is unavailable for adapter "${binding.adapter}".`),
                { code: "UNSUPPORTED_CAPABILITY" },
            );
        }
        const maxPayloadBytes = Number(endpoint.maxPayloadBytes ?? (Number(endpoint.mtu) - 28));
        if (!Number.isSafeInteger(maxPayloadBytes) || stream.maxPayloadBytes > maxPayloadBytes) {
            throw Object.assign(
                new Error(
                    `Sensor transport stream ${binding.sensorId}/${binding.productId}/${binding.streamId} maxPayloadBytes ${stream.maxPayloadBytes} exceeds endpoint "${binding.endpointId}" capacity ${maxPayloadBytes}.`,
                ),
                { code: "UNSUPPORTED_CAPABILITY" },
            );
        }
        resolved.push(Object.freeze({ ...binding, stream, endpoint }));
    }
    return Object.freeze(resolved);
}

export function packetOffsetClockCompatible(clock) {
    return clock?.pacing === "realtime" && Number(clock?.speed) === 1;
}

export function combinedQueueBytes(left = 0, right = 0) {
    const first = Math.max(0, Number(left) || 0);
    const second = Math.max(0, Number(right) || 0);
    if (first <= 0) return second;
    if (second <= 0) return first;
    return Math.min(first, second);
}

export function admitUdpTransportBindings(bindings = [], {
    clock = null,
    maxQueueBytes = 0,
    udpMaxQueueBytes = 0,
    endpoints = [],
} = {}) {
    const requested = (bindings ?? []).filter((entry) => entry.adapter === "udp");
    if (requested.length === 0) {
        return Object.freeze({
            bindings: Object.freeze([]),
            maxQueueBytes: 0,
        });
    }
    const byId = new Map((endpoints ?? []).map((entry) => [entry.id, entry]));
    const resolved = [];
    for (const binding of requested) {
        const endpoint = byId.get(binding.endpointId);
        if (!endpoint || endpoint.adapter !== "udp") {
            throw Object.assign(
                new Error(`Sensor transport endpoint "${binding.endpointId}" is unavailable for adapter "udp".`),
                { code: "UNSUPPORTED_CAPABILITY" },
            );
        }
        const maxPayloadBytes = Number(endpoint.maxPayloadBytes ?? (Number(endpoint.mtu) - 28));
        const streamLimit = Number(binding.stream?.maxPayloadBytes);
        if (Number.isSafeInteger(streamLimit) && (!Number.isSafeInteger(maxPayloadBytes) || streamLimit > maxPayloadBytes)) {
            throw Object.assign(
                new Error(
                    `Sensor transport stream ${binding.sensorId}/${binding.productId}/${binding.streamId} maxPayloadBytes ${streamLimit} exceeds endpoint "${binding.endpointId}" capacity ${maxPayloadBytes}.`,
                ),
                { code: "UNSUPPORTED_CAPABILITY" },
            );
        }
        if ((endpoint.pacing?.mode ?? "burst") === "packet-offset" && !packetOffsetClockCompatible(clock)) {
            throw Object.assign(
                new Error("UDP packet-offset pacing requires a realtime clock at speed 1."),
                { code: "UNSUPPORTED_CAPABILITY" },
            );
        }
        resolved.push(Object.freeze({ ...binding, endpoint }));
    }
    return Object.freeze({
        bindings: Object.freeze(resolved),
        maxQueueBytes: combinedQueueBytes(udpMaxQueueBytes, maxQueueBytes),
    });
}

export function planSensorAdmission({
    manifest,
    sensorRegistry = sensorTypeRegistry,
    backendSelections = [],
    execution = false,
    host = null,
    availableTransports = undefined,
    maxPluginSensorWorkingBytes = DEFAULT_PLUGIN_SENSOR_WORKING_BYTES,
} = {}) {
    if (!manifest?.sensorRig || !Array.isArray(manifest.sensorRig.sensors)) {
        throw new TypeError("A normalized run manifest sensor rig is required.");
    }
    const topics = new Map((manifest.topics ?? []).map((entry) => [entry.id, entry]));
    const producerTopics = new Map();
    const admitted = new Map();
    const sensors = [];
    const observations = [];
    let requiresLidarGeometry = false;
    let requiresCpuV2 = false;
    for (const sensor of manifest.sensorRig.sensors.filter((entry) => entry.enabled !== false)) {
        const definition = sensorRegistry.get(sensor.type);
        if (!definition) throw new Error(`Unsupported sensor type "${sensor.type}".`);
        const plugin = pluginDefinition(sensorRegistry, sensor.type);
        if (!plugin) {
            const kind = getStateSensorModel(sensor.type)
                ? "state" : sensor.type === "camera" ? "camera" : sensor.type === "lidar3d" ? "lidar3d" : "builtin";
            if (sensor.type === "lidar3d") requiresLidarGeometry = true;
            const record = Object.freeze({ sensor, kind, plugin: null, products: Object.freeze([]), observation: null });
            sensors.push(record);
            admitted.set(sensor.id, record);
            continue;
        }
        if (!plugin.ownership || !plugin.descriptor) throw new Error(`Plugin sensor type "${sensor.type}" has incomplete registry ownership.`);
        const layout = assertRangeImageLayout(sensor.calibration?.scanLayout, {
            path: `sensorRig.sensors.${sensor.id}.calibration.scanLayout`,
            maxBytes: maxPluginSensorWorkingBytes,
        });
        const rawBytes = checkedRangeImageBytes(layout, { strideFloats: 4, maxBytes: maxPluginSensorWorkingBytes });
        const measuredBytes = checkedRangeImageBytes(layout, { strideFloats: 4, maxBytes: maxPluginSensorWorkingBytes });
        const observationBytes = checkedRangeImageBytes(layout, { strideFloats: 2, maxBytes: maxPluginSensorWorkingBytes });
        const workingBytes = rawBytes + measuredBytes + observationBytes;
        if (!Number.isSafeInteger(workingBytes) || workingBytes > maxPluginSensorWorkingBytes) {
            throw new Error(`Plugin sensor "${sensor.id}" requires ${workingBytes} working bytes, exceeding ${maxPluginSensorWorkingBytes}.`);
        }
        const products = validatePluginProducts(sensor, plugin, topics, producerTopics);
        const observation = pointCloudObservationDescriptor(sensor, plugin);
        const record = Object.freeze({
            sensor,
            kind: "plugin-range-image",
            plugin,
            products,
            observation,
            layout,
            workingBytes,
            requiredBackend: createCpuLidarBackendSelection({ version: CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION }),
        });
        sensors.push(record);
        admitted.set(sensor.id, record);
        if (observation) observations.push(observation);
        requiresLidarGeometry = true;
        requiresCpuV2 = true;
    }
    const transports = normalizeSensorTransports(manifest.sensorTransports);
    const hostDescriptor = host ?? (
        availableTransports === undefined
            ? null
            : { adapters: availableTransports, endpoints: [] }
    );
    const transportBindings = validateTransportBindings(transports, admitted, {
        execution,
        host: hostDescriptor,
    });
    if (requiresCpuV2 && backendSelections.length > 0) {
        const selected = backendSelections.filter((entry) => Number(entry.kind) === CPU_LIDAR_BACKEND_KIND);
        if (selected.length !== 1 || String(selected[0].version) !== CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION) {
            throw new Error("Plugin range-image sensors require deterministic-cpu-bvh-lidar version 2.");
        }
    }
    return Object.freeze({
        sensors: Object.freeze(sensors.sort((left, right) => compareText(left.sensor.id, right.sensor.id))),
        observations: Object.freeze(observations.sort((left, right) => compareText(left.id, right.id))),
        requiresLidarGeometry,
        requiresCpuV2,
        requiredCpuBackend: requiresCpuV2
            ? createCpuLidarBackendSelection({ version: CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION }) : null,
        transports,
        transportBindings,
    });
}
