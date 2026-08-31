import { simulationSha256 } from "../kernel/SimulationHashes.js";

export const GPU_SENSOR_BACKEND_KIND = 4;
export const GPU_SENSOR_CAPABILITY_ID = "chromium-webgl2-rendered-sensors";
export const GPU_SENSOR_BACKEND_VERSION = "1";

export const GPU_SENSOR_BACKEND_CONFIG = Object.freeze({
    kind: "cev-sim.gpu-sensor-backend-config",
    version: 1,
    renderer: "headless-chromium-webgl2-hardware",
    scene: "cev-sim.render-scene@1/provider-registry-v1",
    camera: "rgba8-brown-conrady-measured-v1",
    lidar: "metric-v2-float32-distance-incidence-semantic-instance-zero-no-hit",
    scanOrdering: "elevation-major-azimuth-minor-ceil-exclusive-end-v1",
    readback: "pixel-pack-buffer-fence-event-loop-poll-v1",
    delivery: "integer-fixed-step-capture-and-queued-delivery-v1",
    softwareFallback: false,
});

export const GPU_SENSOR_BACKEND_CONFIG_HASH = simulationSha256(GPU_SENSOR_BACKEND_CONFIG);

export function createGpuSensorBackendSelection() {
    return {
        kind: GPU_SENSOR_BACKEND_KIND,
        capabilityId: GPU_SENSOR_CAPABILITY_ID,
        version: GPU_SENSOR_BACKEND_VERSION,
        configHash: GPU_SENSOR_BACKEND_CONFIG_HASH,
    };
}

function selectedField(selection, camel, snake) {
    return selection?.[camel] ?? selection?.[snake];
}

export function assertGpuSensorBackendSelection(selection) {
    const expected = createGpuSensorBackendSelection();
    if (!selection) throw new Error(`GPU sensor backend ${GPU_SENSOR_CAPABILITY_ID} is required.`);
    for (const [camel, snake] of [["kind", "kind"], ["capabilityId", "capability_id"], ["version", "version"], ["configHash", "config_hash"]]) {
        const received = selectedField(selection, camel, snake);
        if (received !== expected[camel]) {
            throw new Error(`GPU sensor backend mismatch for ${camel}: expected ${expected[camel]}, received ${received}.`);
        }
    }
    return expected;
}

export function gpuSensorBackendCapability({ available = false, unavailableReason = "Headless Chromium GPU probe has not succeeded." } = {}) {
    return {
        id: GPU_SENSOR_CAPABILITY_ID,
        version: GPU_SENSOR_BACKEND_VERSION,
        kind: GPU_SENSOR_BACKEND_KIND,
        description: "Pooled hardware-backed headless Chromium WebGL2 camera and LiDAR sensors.",
        sensorTypes: ["camera", "lidar3d"],
        features: ["rgba8", "metric-v2", "pbo-fence-readback", "pooled-renderer", "shared-memory"],
        available: Boolean(available),
        unavailableReason: available ? "" : String(unavailableReason || "GPU sensor backend unavailable."),
        determinismScope: "same cev-sim build, Chromium/ANGLE build, GPU/driver stack, backend config, and render-scene resource",
    };
}
