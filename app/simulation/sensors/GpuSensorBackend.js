import { simulationSha256 } from "../kernel/SimulationHashes.js";

export const GPU_SENSOR_BACKEND_KIND = 4;
export const GPU_SENSOR_CAPABILITY_ID = "chromium-webgl2-rendered-sensors";
export const GPU_SENSOR_BACKEND_VERSION = "1";
export const GPU_SENSOR_BACKEND_V2_VERSION = "2";

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

export const GPU_SENSOR_BACKEND_V2_CONFIG = Object.freeze({
    kind: "cev-sim.gpu-sensor-backend-config",
    version: 2,
    renderer: "headless-chromium-webgl2-hardware",
    scene: "cev-sim.render-scene@1/provider-product-routing-v2",
    camera: "provider-product-routed-rgba8-brown-conrady-measured-v1",
    lidar: "metric-v2-float32-distance-incidence-semantic-instance-zero-no-hit",
    scanOrdering: "elevation-major-azimuth-minor-ceil-exclusive-end-v1",
    readback: "pixel-pack-buffer-fence-event-loop-poll-v1",
    delivery: "integer-fixed-step-capture-and-queued-delivery-v1",
    softwareFallback: false,
    providerRouting: true,
    productRouting: true,
});

export const GPU_SENSOR_BACKEND_V2_CONFIG_HASH = simulationSha256(GPU_SENSOR_BACKEND_V2_CONFIG);
export const GPU_SENSOR_BACKEND_V2_AVAILABLE = false;
export const GPU_SENSOR_BACKEND_V2_UNAVAILABLE_REASON = "chromium-webgl2-rendered-sensors@2 is known but unavailable until provider/product routed camera capture is implemented";

export function createGpuSensorBackendSelection() {
    return {
        kind: GPU_SENSOR_BACKEND_KIND,
        capabilityId: GPU_SENSOR_CAPABILITY_ID,
        version: GPU_SENSOR_BACKEND_VERSION,
        configHash: GPU_SENSOR_BACKEND_CONFIG_HASH,
    };
}

export function createGpuSensorBackendV2Selection() {
    return {
        kind: GPU_SENSOR_BACKEND_KIND,
        capabilityId: GPU_SENSOR_CAPABILITY_ID,
        version: GPU_SENSOR_BACKEND_V2_VERSION,
        configHash: GPU_SENSOR_BACKEND_V2_CONFIG_HASH,
        available: GPU_SENSOR_BACKEND_V2_AVAILABLE,
        unavailableReason: GPU_SENSOR_BACKEND_V2_UNAVAILABLE_REASON,
    };
}

function selectedField(selection, camel, snake) {
    return selection?.[camel] ?? selection?.[snake];
}

function isGpuSensorBackendV2(selection) {
    return selectedField(selection, "capabilityId", "capability_id") === GPU_SENSOR_CAPABILITY_ID
        && String(selectedField(selection, "version", "version")) === GPU_SENSOR_BACKEND_V2_VERSION;
}

export function assertGpuSensorBackendSelection(selection) {
    if (isGpuSensorBackendV2(selection)) {
        throw new Error(GPU_SENSOR_BACKEND_V2_UNAVAILABLE_REASON);
    }
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
