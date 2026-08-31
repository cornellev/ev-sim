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
            spec: entry.tensor.spec,
        });
        entry.tensor.payload = { packedData: bytes };
    }
    return tensorMap;
}

export function perceptionTensorBytes(sensor) {
    if (sensor?.enabled === false) return 0;
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

function rawGpuTensorBytes(sensor) {
    if (sensor?.enabled === false) return 0;
    if (sensor?.type === "camera") {
        return Number(sensor.calibration?.height) * Number(sensor.calibration?.width) * 4;
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
    const observationBytes = isPerception ? calculatePerceptionObservationBytes(resolved, episodeSpec) : 0;
    const retainedBytes = sensors.reduce((total, sensor) => (
        total + perceptionTensorBytes(sensor) * (Math.max(1, Number(sensor.maxQueueFrames || 1)) + 1)
    ), 0);
    const rawBytes = usesGpu
        ? sensors.reduce((total, sensor) => total + rawGpuTensorBytes(sensor), 0)
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
    return (resolved.manifest?.sensorRig?.sensors || [])
        .reduce((total, sensor) => total + perceptionTensorBytes(sensor), 0);
}
