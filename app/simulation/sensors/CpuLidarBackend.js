import { simulationSha256 } from "../kernel/SimulationHashes.js";

export const CPU_LIDAR_BACKEND_KIND = 3;
export const CPU_LIDAR_CAPABILITY_ID = "deterministic-cpu-bvh-lidar";
export const CPU_LIDAR_BACKEND_VERSION = "1";
export const CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION = "2";

export const CPU_LIDAR_BACKEND_CONFIG = Object.freeze({
    kind: "cev-sim.cpu-lidar-backend-config",
    version: 1,
    geometry: "cev-sim.lidar-geometry@1",
    packages: { three: "0.182.0", threeMeshBvh: "0.9.8" },
    bvhIndexing: "indirect-preserve-canonical-face-order-v1",
    scanOrdering: "elevation-major-azimuth-minor-ceil-exclusive-end-v1",
    nearExclusionMeters: 1e-4,
    range: "inclusive",
    sidedness: "double",
    tieBreaking: "distance-then-utf8-primitive-id-then-triangle-index-v1",
    output: "metric-v2-float32-distance-incidence-semantic-instance-zero-no-hit",
    noise: "measured-cloud-only-seeded-range-and-point-dropout-v1",
    delivery: "integer-fixed-step-instantaneous-whole-scan-v1",
});

export const CPU_LIDAR_BACKEND_CONFIG_HASH = simulationSha256(CPU_LIDAR_BACKEND_CONFIG);

export const CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_CONFIG = Object.freeze({
    kind: "cev-sim.cpu-lidar-backend-config",
    version: 2,
    geometry: "cev-sim.lidar-geometry@1",
    layout: "cev-sim.range-image-layout@1",
    packages: { three: "0.182.0", threeMeshBvh: "0.9.8" },
    bvhIndexing: "indirect-preserve-canonical-face-order-v1",
    scanOrdering: "authored-channel-major-authored-azimuth-minor-v1",
    nearExclusionMeters: 1e-4,
    range: "layout-min-inclusive-max-inclusive",
    sidedness: "double",
    tieBreaking: "distance-then-utf8-primitive-id-then-triangle-index-v1",
    output: "metric-v2-float32-distance-incidence-semantic-instance-zero-no-hit",
    measurement: "host-seeded-range-noise-and-point-dropout-once-before-plugin-v1",
    random: "sensor-host-plugin-delivery-scoped-streams-v1",
    delivery: "integer-fixed-step-instantaneous-whole-scan-v1",
});

export const CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_CONFIG_HASH = simulationSha256(
    CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_CONFIG,
);

export function createCpuLidarBackendSelection({ version = CPU_LIDAR_BACKEND_VERSION } = {}) {
    if (![CPU_LIDAR_BACKEND_VERSION, CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION].includes(String(version))) {
        throw new Error(`Unsupported CPU LiDAR backend version ${version}.`);
    }
    const explicit = String(version) === CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION;
    return {
        kind: CPU_LIDAR_BACKEND_KIND,
        capabilityId: CPU_LIDAR_CAPABILITY_ID,
        version: explicit ? CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION : CPU_LIDAR_BACKEND_VERSION,
        configHash: explicit ? CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_CONFIG_HASH : CPU_LIDAR_BACKEND_CONFIG_HASH,
    };
}

function field(selection, camel, snake) {
    return selection?.[camel] ?? selection?.[snake];
}

export function assertCpuLidarBackendSelection(selection, { requiredVersion = null } = {}) {
    const version = requiredVersion ?? field(selection, "version", "version") ?? CPU_LIDAR_BACKEND_VERSION;
    const expected = createCpuLidarBackendSelection({ version: String(version) });
    if (!selection) throw new Error(`CPU LiDAR backend ${CPU_LIDAR_CAPABILITY_ID} is required.`);
    for (const [camel, snake] of [["kind", "kind"], ["capabilityId", "capability_id"], ["version", "version"], ["configHash", "config_hash"]]) {
        const received = field(selection, camel, snake);
        if (received !== expected[camel]) {
            throw new Error(`CPU LiDAR backend mismatch for ${camel}: expected ${expected[camel]}, received ${received}.`);
        }
    }
    return expected;
}
