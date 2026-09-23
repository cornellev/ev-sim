import { validateSharedTensorReference } from "./SharedTensorArena.js";

export const SHARED_TENSOR_INLINE_THRESHOLD_BYTES = 64 * 1024;

function packedBytes(payload) {
    const value = payload?.packedData;
    if (Buffer.isBuffer(value)) return value;
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return null;
}

export async function externalizeTensorMap(tensorMap, arena, {
    generation,
    sequence,
    thresholdBytes = SHARED_TENSOR_INLINE_THRESHOLD_BYTES,
} = {}) {
    if (!arena) return tensorMap;
    for (const entry of tensorMap?.entries || []) {
        const bytes = packedBytes(entry.tensor?.payload);
        if (!bytes || bytes.byteLength < thresholdBytes) continue;
        const reference = await arena.publishTensor(bytes, entry.tensor.spec, { generation, sequence });
        entry.tensor.payload = { sharedMemory: reference };
    }
    return tensorMap;
}

export async function materializeTensorMap(tensorMap, arena) {
    if (!arena) return tensorMap;
    for (const entry of tensorMap?.entries || []) {
        const reference = entry.tensor?.payload?.sharedMemory;
        if (!reference) continue;
        const bytes = await validateSharedTensorReference(reference, {
            environmentToken: arena.environmentToken,
            expectedRegion: arena.regionName,
            spec: entry.tensor.spec,
        });
        entry.tensor.payload = { packedData: bytes };
    }
    return tensorMap;
}

export function perceptionTensorBytes(sensor, pluginObservation = null) {
    if (sensor?.enabled === false) return 0;
    if (pluginObservation) {
        return pluginObservation.shape.reduce((total, size) => total * Number(size), 1) * 4;
    }
    const products = sensor?.calibration?.products || {};
    if (sensor?.type === "camera" && products.rgb === true) {
        return Number(sensor.calibration.height) * Number(sensor.calibration.width) * 4;
    }
    if (sensor?.type === "lidar3d" && products.pointCloud === true) {
        const azimuth = sensor.calibration.azimuth;
        const elevation = sensor.calibration.elevation;
        const width = Math.ceil((azimuth.endDeg - azimuth.startDeg) / azimuth.stepDeg);
        const height = Math.ceil((elevation.endDeg - elevation.startDeg) / elevation.stepDeg);
        return width * height * 2 * 4;
    }
    return 0;
}

function rawGpuTensorBytes(sensor, { pbr = false } = {}) {
    if (sensor?.enabled === false) return 0;
    if (sensor?.type === "camera") {
        const pixels = Number(sensor.calibration?.height) * Number(sensor.calibration?.width);
        if (!pbr) {
            const products = sensor.calibration?.products || {};
            const rgb = products.rgb !== false ? pixels * 4 : 0;
            const depth = products.depth === true ? pixels * 4 : 0;
            return rgb + depth || pixels * 4;
        }
        const products = sensor.calibration?.products || {};
        return pixels * (
            (products.rgb === true ? 4 : 0)
            + (products.depth === true ? 4 : 0)
            + (products.semantic === true ? 2 : 0)
            + (products.instance === true ? 4 : 0)
        );
    }
    if (sensor?.type === "lidar3d") {
        const azimuth = sensor.calibration?.azimuth;
        const elevation = sensor.calibration?.elevation;
        const width = Math.ceil((azimuth.endDeg - azimuth.startDeg) / azimuth.stepDeg);
        const height = Math.ceil((elevation.endDeg - elevation.startDeg) / elevation.stepDeg);
        return width * height * 4 * 4;
    }
    return 0;
}

export function calculateSharedTensorArenaBytes(resolved, episodeSpec = {}) {
    const isPerception = String(episodeSpec.observationProfile?.id || episodeSpec.observation_profile?.id || "")
        === "measured-perception";
    const sensors = (resolved.manifest?.sensorRig?.sensors || []).filter((sensor) => sensor.enabled !== false);
    const usesGpu = (episodeSpec.backendSelections || episodeSpec.backend_selections || [])
        .some((entry) => Number(entry.kind) === 4);
    const pbr = resolved.renderScene?.description?.provider?.id === "pbr-mesh";
    const pluginObservations = new Map((resolved.pluginSensors?.description?.sensors ?? [])
        .filter((entry) => entry.observationDescriptor)
        .map((entry) => [entry.sensorId, entry.observationDescriptor]));
    const observationBytes = isPerception ? calculatePerceptionObservationBytes(resolved, episodeSpec) : 0;
    const retainedBytes = sensors.reduce((total, sensor) => (
        total + perceptionTensorBytes(sensor, pluginObservations.get(sensor.id))
            * (Math.max(1, Number(sensor.maxQueueFrames || 1)) + 1)
    ), 0);
    const rawBytes = usesGpu
        ? sensors.reduce((total, sensor) => total + rawGpuTensorBytes(sensor, { pbr }), 0)
        : 0;
    if (observationBytes === 0 && rawBytes === 0) return 0;
    const retainedSlots = sensors.reduce(
        (total, sensor) => total + Math.max(1, Number(sensor.maxQueueFrames || 1)) + 1,
        0,
    );
    const headerAllowance = (sensors.length * 6 + retainedSlots) * 256;
    return Math.ceil(((observationBytes + rawBytes) * 3 + retainedBytes + headerAllowance) / 64) * 64;
}

export function calculatePerceptionObservationBytes(resolved, episodeSpec = {}) {
    const isPerception = String(episodeSpec.observationProfile?.id || episodeSpec.observation_profile?.id || "")
        === "measured-perception";
    if (!isPerception) return 0;
    const pluginObservations = new Map((resolved.pluginSensors?.description?.sensors ?? [])
        .filter((entry) => entry.observationDescriptor)
        .map((entry) => [entry.sensorId, entry.observationDescriptor]));
    return (resolved.manifest?.sensorRig?.sensors || [])
        .reduce((total, sensor) => total + perceptionTensorBytes(sensor, pluginObservations.get(sensor.id)), 0);
}
