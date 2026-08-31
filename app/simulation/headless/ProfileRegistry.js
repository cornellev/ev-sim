import { simulationSha256 } from "../kernel/SimulationHashes.js";
import { HeadlessEpisodeError } from "./HeadlessErrors.js";

export const MEASURED_STATE_PROFILE_ID = "measured-state";
export const MEASURED_STATE_PROFILE_VERSION = 1;
export const MEASURED_PERCEPTION_PROFILE_ID = "measured-perception";
export const MEASURED_PERCEPTION_PROFILE_VERSION = 1;
export const ROUTE_SAFETY_PROFILE_ID = "route-safety";
export const ROUTE_SAFETY_PROFILE_VERSION = 1;

export const MEASURED_STATE_CONFIG = Object.freeze({
    kind: "cev-sim.observation-profile-config",
    version: 1,
    sensors: "all-enabled-state-sensors-by-stable-id",
    task: "verified-ego-route-v1",
});
export const MEASURED_STATE_CONFIG_HASH = simulationSha256(MEASURED_STATE_CONFIG);
export const MEASURED_STATE_SCHEMA_HASH = simulationSha256({
    id: MEASURED_STATE_PROFILE_ID,
    version: MEASURED_STATE_PROFILE_VERSION,
    fields: ["sensors/*/{value,validity,sequence,is_new,age_steps}", "task/{value,validity,sequence,is_new,age_steps}"],
});

export const MEASURED_PERCEPTION_CONFIG = Object.freeze({
    kind: "cev-sim.observation-profile-config",
    version: 1,
    state: "measured-state@1",
    camera: "enabled-measured-rgb-rgba8-by-stable-id",
    lidar: "enabled-measured-range-incidence-float32-by-stable-id",
    metadata: "validity-sequence-is-new-age-steps-v1",
    oracleProducts: "excluded",
});
export const MEASURED_PERCEPTION_CONFIG_HASH = simulationSha256(MEASURED_PERCEPTION_CONFIG);
export const MEASURED_PERCEPTION_SCHEMA_HASH = simulationSha256({
    id: MEASURED_PERCEPTION_PROFILE_ID,
    version: MEASURED_PERCEPTION_PROFILE_VERSION,
    fields: [
        "sensors/state/*/{value,validity,sequence,is_new,age_steps}",
        "sensors/camera/*/rgba8",
        "sensors/lidar3d/*/range-incidence-float32",
        "task/{value,validity,sequence,is_new,age_steps}",
    ],
});

function routeSafetyConfig(flags) {
    return Object.freeze({
        kind: "cev-sim.reward-profile-config",
        version: 1,
        terminateOnCollision: Boolean(flags.terminateOnCollision),
        terminateOnOffRoad: Boolean(flags.terminateOnOffRoad),
        terminateOnWrongWay: Boolean(flags.terminateOnWrongWay),
        smoothness: Boolean(flags.smoothness),
    });
}

export const ROUTE_SAFETY_PRESETS = Object.freeze(
    Array.from({ length: 16 }, (_, bits) => {
        const config = routeSafetyConfig({
            terminateOnCollision: bits & 1,
            terminateOnOffRoad: bits & 2,
            terminateOnWrongWay: bits & 4,
            smoothness: bits & 8,
        });
        return Object.freeze({ config, configHash: simulationSha256(config) });
    }),
);

export const DEFAULT_ROUTE_SAFETY_CONFIG = ROUTE_SAFETY_PRESETS.find(({ config }) => (
    config.terminateOnCollision
    && config.terminateOnOffRoad
    && !config.terminateOnWrongWay
    && !config.smoothness
)).config;
export const DEFAULT_ROUTE_SAFETY_CONFIG_HASH = simulationSha256(DEFAULT_ROUTE_SAFETY_CONFIG);
export const ROUTE_SAFETY_SCHEMA_HASH = simulationSha256({
    id: ROUTE_SAFETY_PROFILE_ID,
    version: ROUTE_SAFETY_PROFILE_VERSION,
    booleans: ["terminateOnCollision", "terminateOnOffRoad", "terminateOnWrongWay", "smoothness"],
});

export function measuredStateProfileRef() {
    return { id: MEASURED_STATE_PROFILE_ID, version: 1, configHash: MEASURED_STATE_CONFIG_HASH };
}

export function measuredPerceptionProfileRef() {
    return { id: MEASURED_PERCEPTION_PROFILE_ID, version: 1, configHash: MEASURED_PERCEPTION_CONFIG_HASH };
}

export function routeSafetyProfileRef(config = DEFAULT_ROUTE_SAFETY_CONFIG) {
    const preset = ROUTE_SAFETY_PRESETS.find((entry) => (
        entry.config.terminateOnCollision === Boolean(config.terminateOnCollision)
        && entry.config.terminateOnOffRoad === Boolean(config.terminateOnOffRoad)
        && entry.config.terminateOnWrongWay === Boolean(config.terminateOnWrongWay)
        && entry.config.smoothness === Boolean(config.smoothness)
    ));
    return { id: ROUTE_SAFETY_PROFILE_ID, version: 1, configHash: preset.configHash };
}

function normalizedRef(ref = {}) {
    return { id: String(ref.id || ""), version: Number(ref.version || 0), configHash: String(ref.configHash || ref.config_hash || "") };
}

export function resolveObservationProfile(ref) {
    const actual = normalizedRef(ref);
    if (actual.id === MEASURED_STATE_PROFILE_ID
        && actual.version === MEASURED_STATE_PROFILE_VERSION
        && actual.configHash === MEASURED_STATE_CONFIG_HASH) return MEASURED_STATE_CONFIG;
    if (actual.id === MEASURED_PERCEPTION_PROFILE_ID
        && actual.version === MEASURED_PERCEPTION_PROFILE_VERSION
        && actual.configHash === MEASURED_PERCEPTION_CONFIG_HASH) return MEASURED_PERCEPTION_CONFIG;
    throw new HeadlessEpisodeError("UNSUPPORTED_CAPABILITY", `Unsupported observation profile ${actual.id}@${actual.version} (${actual.configHash}).`);
}

export function resolveRewardProfile(ref) {
    const actual = normalizedRef(ref);
    if (actual.id !== ROUTE_SAFETY_PROFILE_ID || actual.version !== ROUTE_SAFETY_PROFILE_VERSION) {
        throw new HeadlessEpisodeError("UNSUPPORTED_CAPABILITY", `Unsupported reward profile ${actual.id}@${actual.version}.`);
    }
    const preset = ROUTE_SAFETY_PRESETS.find((entry) => entry.configHash === actual.configHash);
    if (!preset) throw new HeadlessEpisodeError("UNSUPPORTED_CAPABILITY", `Unknown route-safety config hash ${actual.configHash}.`);
    return preset.config;
}

export function getHeadlessProfileCapabilities() {
    return {
        observationProfiles: [
            { id: MEASURED_STATE_PROFILE_ID, version: 1, description: "Measured state sensors and route task signals.", configSchemaHash: MEASURED_STATE_SCHEMA_HASH },
            { id: MEASURED_PERCEPTION_PROFILE_ID, version: 1, description: "Measured state, RGB camera, and range/incidence LiDAR tensors.", configSchemaHash: MEASURED_PERCEPTION_SCHEMA_HASH },
        ],
        rewardProfiles: [{ id: ROUTE_SAFETY_PROFILE_ID, version: 1, description: "Route progress, completion, safety, and optional smoothness.", configSchemaHash: ROUTE_SAFETY_SCHEMA_HASH }],
    };
}
