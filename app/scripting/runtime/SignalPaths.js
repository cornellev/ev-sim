export const SIGNAL_NAMESPACES = Object.freeze({
    TOPICS: "topics",
    CANDIDATE: "candidate",
    REFERENCE: "reference",
    ORACLE: "oracle",
    ACTIVE: "active",
    VEHICLE: "vehicle",
    MISSION: "mission",
    SCENARIO: "scenario",
    DEBUG: "debug",
    SIMULATION: "simulation",
    DEVICES: "devices",
    OBJECTS: "objects",
    PUBLISH: "publish"
});

/**
 * Well-known signal paths used by built-in scripting blocks and the runtime.
 * Dynamic paths are added to the bindings page from the live SignalStore.
 */
export const SIGNAL_PATHS = Object.freeze({
    VEHICLE_EGO: "vehicle.ego",
    VEHICLE_EGO_POSE: "vehicle.ego.pose",
    VEHICLE_EGO_VELOCITY: "vehicle.ego.velocity",
    VEHICLE_EGO_DIMENSIONS: "vehicle.ego.dimensions",
    FRONT_CAMERA: "devices.front_camera",
    SIMULATION: "simulation",
    SIMULATION_FRAME: "simulation.frame",
    SCENARIO: "scenario",
    TARGET_OBJECT: "objects.target",
    MISSION_ROUTE: "mission.route",
    MISSION_CURRENT_WAYPOINT: "mission.currentWaypoint",
    MISSION_STATE: "mission.state",
    DEBUG_VALUE: "debug.value",
    DEBUG_RECORDED: "debug.recorded",
    DEBUG_BINDING_STATUS: "debug.bindings.default",
    ACKDRIVE_TOPIC: "topics./ackdrive",
    ACKDRIVE_COMMAND: "publish./ackdrive_cmd"
});

export const KNOWN_SIGNAL_PATHS = Object.freeze(
    [...new Set(Object.values(SIGNAL_PATHS))].sort((a, b) => a.localeCompare(b))
);

export const TOPIC_SIGNAL_PREFIX = `${SIGNAL_NAMESPACES.TOPICS}.`;

export function contractSignalPath(namespace, contractId) {
    const normalized = normalizeSignalPath(contractId);
    return normalized ? `${namespace}.topics.${normalized}` : "";
}

export function candidateTopicSignalPath(contractId) {
    return contractSignalPath(SIGNAL_NAMESPACES.CANDIDATE, contractId);
}

export function referenceTopicSignalPath(contractId) {
    return contractSignalPath(SIGNAL_NAMESPACES.REFERENCE, contractId);
}

export function oracleTopicSignalPath(contractId) {
    return contractSignalPath(SIGNAL_NAMESPACES.ORACLE, contractId);
}

export function activeTopicSignalPath(contractId) {
    return contractSignalPath(SIGNAL_NAMESPACES.ACTIVE, contractId);
}

export function normalizeSignalPath(path) {
    return String(path || "").trim();
}

export function topicSignalPath(topic) {
    const normalizedTopic = normalizeSignalPath(topic);
    return normalizedTopic ? `${TOPIC_SIGNAL_PREFIX}${normalizedTopic}` : "";
}

/**
 * Merge well-known, live, and configured paths into a stable suggestion list.
 */
export function listSignalPaths(...collections) {
    const paths = new Set(KNOWN_SIGNAL_PATHS);

    collections.flat().forEach((path) => {
        const normalizedPath = normalizeSignalPath(path);
        if (normalizedPath) paths.add(normalizedPath);
    });

    return [...paths].sort((a, b) => a.localeCompare(b));
}
