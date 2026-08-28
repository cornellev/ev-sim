import {
    createRunSensor,
    listSensorTypes,
    normalizeRunSensor,
    validateRunSensorDefinition,
} from "../3d/devices/SensorTypeRegistry.js";
import {
    catalogMetadata,
    defaultManifestTopics,
    migrateLegacyTopic,
    schemaClosureForManifest,
    validateManifestTopicAuthority,
    validateTopicAgainstCatalog,
} from "../autonomy/AutonomyContractCatalog.js";
import { threePoseToRep103 } from "../autonomy/CoordinateFrames.js";
import { validateSensorRigFrames, validateSyncGroups } from "../simulation/TransformRuntime.js";
import { validateScalarParameterTarget } from "../scenarios/ScenarioDocument.js";

export const RUN_MANIFEST_KIND = "cev-sim.run-manifest";
export const RUN_MANIFEST_VERSION = 5;
export const LEGACY_RUN_MANIFEST_VERSION = 1;
export const RUN_MANIFEST_V2 = 2;
export const RUN_MANIFEST_V3 = 3;
export const RUN_MANIFEST_V4 = 4;
export const RUN_BUNDLE_KIND = "cev-sim.run-bundle";
export const RUN_BUNDLE_VERSION = 1;

export const RUN_LOGGING_POLICIES = Object.freeze(["required", "optional", "disabled"]);
export const RUN_PACING_MODES = Object.freeze(["realtime", "unbounded"]);
export const SENSOR_TYPES = Object.freeze(listSensorTypes().map((definition) => definition.id));
export const RUN_PARAMETER_TYPES = Object.freeze(["float64", "int32", "boolean", "string"]);
export const RUN_PARAMETER_TARGET_KINDS = Object.freeze(["scalar-field", "script-input", "scenario-signal"]);

const DEFAULT_MODULES = Object.freeze({
    inputs: true,
    scripting: true,
    vehicles: true,
    physics: true,
    sensors: true,
    assertions: true,
});

function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

function finite(value, fallback) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
    const normalized = Math.floor(finite(value, fallback));
    return normalized >= 0 ? normalized : fallback;
}

function positiveInteger(value, fallback = 1) {
    const normalized = Math.floor(finite(value, fallback));
    return normalized > 0 ? normalized : fallback;
}

function vec3(value = {}, fallback = {}) {
    const source = object(value);
    return {
        x: finite(source.x, fallback.x ?? 0),
        y: finite(source.y, fallback.y ?? 0),
        z: finite(source.z, fallback.z ?? 0),
    };
}

function euler(value = {}) {
    const source = object(value);
    return { ...vec3(source), order: text(source.order, "XYZ") };
}

function pose(value = {}) {
    const source = object(value);
    return {
        position: vec3(source.position),
        rotation: euler(source.rotation),
    };
}

function topic(value = {}, index = 0) {
    return migrateLegacyTopic(value, index);
}

function assertion(value = {}, index = 0) {
    const source = object(value);
    const assertionSource = source.source === "event" ? "event" : "signal";
    return {
        id: text(source.id, `assertion-${index + 1}`),
        name: text(source.name, text(source.id, `Assertion ${index + 1}`)),
        source: assertionSource,
        path: assertionSource === "signal" ? text(source.path) : undefined,
        selector: assertionSource === "signal" ? text(source.selector) : undefined,
        category: assertionSource === "event" ? text(source.category) : undefined,
        event: assertionSource === "event" ? text(source.event || source.name) : undefined,
        operator: text(source.operator, assertionSource === "event" ? "count" : "eq"),
        expected: source.expected ?? (assertionSource === "event" ? { min: 1, max: null } : true),
        tolerance: Math.max(0, finite(source.tolerance, 0)),
        mode: ["always", "eventually", "at-end"].includes(source.mode) ? source.mode : "at-end",
        window: {
            startStep: nonNegativeInteger(source.window?.startStep, 0),
            endStep: source.window?.endStep === null || source.window?.endStep === undefined
                ? null
                : nonNegativeInteger(source.window.endStep, 0),
        },
        severity: source.severity === "warning" ? "warning" : "error",
        onFailure: source.onFailure === "continue" ? "continue" : "stop",
    };
}

function parameterDefault(type) {
    if (type === "boolean") return false;
    if (type === "string") return "";
    return 0;
}

function parameter(value = {}, index = 0) {
    const source = object(value);
    const type = RUN_PARAMETER_TYPES.includes(source.type) ? source.type : "float64";
    return {
        id: text(source.id, `parameter-${index + 1}`),
        name: text(source.name, `Parameter ${index + 1}`),
        description: text(source.description),
        type,
        default: source.default ?? parameterDefault(type),
        target: {
            ...structuredClone(object(source.target)),
            kind: RUN_PARAMETER_TARGET_KINDS.includes(source.target?.kind) ? source.target.kind : null,
            path: text(source.target?.path),
            scriptId: text(source.target?.scriptId) || null,
            input: text(source.target?.input ?? source.target?.inputId),
        },
    };
}

function syncGroup(value = {}, index = 0) {
    const source = object(value);
    return {
        id: text(source.id, `sync-${index + 1}`),
        description: text(source.description),
        topicIds: (Array.isArray(source.topicIds) ? source.topicIds : []).map((entry) => text(entry)).filter(Boolean),
    };
}

function migrateSensorToV4(sensor, sourceVersion) {
    const normalized = normalizeRunSensor(sensor);
    if (sourceVersion >= RUN_MANIFEST_VERSION) return normalized;
    const migrated = {
        ...normalized,
        pose: threePoseToRep103(normalized.pose),
    };
    if (normalized.type === "camera") {
        const optical = normalized.frameId?.includes("optical")
            ? normalized.frameId
            : `${normalized.id.replace(/-camera$/, "")}_camera_optical_frame`.replace(/^([^_]+)$/, "$1_camera_optical_frame");
        const mount = optical.replace(/_optical_frame$/, "_link").replace(/_optical$/, "_link");
        migrated.mountFrameId = text(sensor.mountFrameId, mount);
        migrated.measurementFrameId = text(sensor.measurementFrameId, optical);
        migrated.frameId = migrated.measurementFrameId;
    } else {
        const frame = text(normalized.frameId, `${normalized.id}_frame`);
        migrated.mountFrameId = text(sensor.mountFrameId, frame);
        migrated.measurementFrameId = text(sensor.measurementFrameId, frame);
        migrated.frameId = frame;
    }
    if (!migrated.syncGroupId && sourceVersion < RUN_MANIFEST_VERSION && normalized.type !== "unknown") {
        migrated.syncGroupId = "perception-primary";
    }
    return migrated;
}

function normalizeSensorRig(source = {}, sourceVersion = RUN_MANIFEST_VERSION) {
    const rig = object(source);
    const sensors = (Array.isArray(rig.sensors) ? rig.sensors : [])
        .map((entry) => migrateSensorToV4(entry, sourceVersion));
    let syncGroups = Array.isArray(rig.syncGroups) ? rig.syncGroups.map(syncGroup) : [];
    if (sourceVersion < RUN_MANIFEST_VERSION && sensors.length > 0 && syncGroups.length === 0) {
        syncGroups = defaultSyncGroups();
    }
    return {
        mapFrameId: text(rig.mapFrameId, "map"),
        odomFrameId: text(rig.odomFrameId, "odom"),
        rootFrameId: text(rig.rootFrameId, "base_link"),
        vehicleId: text(rig.vehicleId, "ego"),
        syncGroups,
        sensors,
    };
}

function defaultSyncGroups(topicIds = []) {
    return [
        {
            id: "perception-primary",
            description: "Front camera and LiDAR captured on the same simulation step.",
            topicIds: topicIds.filter((id) => ["front-camera-image", "front-camera-info", "front-lidar-points"].includes(id)),
        },
        {
            id: "localization-primary",
            description: "Localization sensors captured on the same simulation step.",
            topicIds: topicIds.filter((id) => ["imu", "gnss", "wheel-odometry"].includes(id)),
        },
    ];
}

function defaultLocalizationSensors() {
    return [
        createRunSensor("imu", {
            id: "imu",
            parentId: "ego",
            mountFrameId: "imu_link",
            measurementFrameId: "imu_link",
            frameId: "imu_link",
            syncGroupId: "localization-primary",
            rateHz: 100,
            outputs: { imuTopicId: "imu" },
        }),
        createRunSensor("gnss", {
            id: "gnss",
            parentId: "ego",
            mountFrameId: "gnss_link",
            measurementFrameId: "gnss_link",
            frameId: "gnss_link",
            syncGroupId: "localization-primary",
            rateHz: 10,
            pose: { position: { x: 0, y: 0, z: 0.5 } },
            outputs: { gnssTopicId: "gnss" },
            calibration: {
                datum: { latitude: 42.4430, longitude: -76.4840, altitude: 200 },
            },
        }),
        createRunSensor("wheel-odometry", {
            id: "wheel-odometry",
            parentId: "ego",
            mountFrameId: "wheel_odom_link",
            measurementFrameId: "wheel_odom_link",
            frameId: "wheel_odom_link",
            syncGroupId: "localization-primary",
            rateHz: 50,
            outputs: { odometryTopicId: "wheel-odometry" },
            calibration: {
                odomFrameId: "odom",
                childFrameId: "base_link",
                wheelRadius: 0.15,
                ticksPerRevolution: 1024,
                trackWidth: 1.2,
            },
        }),
    ];
}

function reconcileSyncGroups(sensorRig, topics = []) {
    const declaredTopicIds = new Set((topics || []).map((topic) => topic.id));
    const sensors = sensorRig?.sensors || [];
    const sensorOutputTopicIds = [...new Set(
        sensors.flatMap((sensor) => Object.values(sensor.outputs || {}).map((id) => text(id)).filter(Boolean)),
    )].filter((id) => declaredTopicIds.has(id)).sort();

    let syncGroups = (sensorRig?.syncGroups || []).map((group) => {
        const filtered = (group.topicIds || []).map((id) => text(id)).filter((id) => declaredTopicIds.has(id));
        if (filtered.length === 0 && group.id === "perception-primary" && sensorOutputTopicIds.length > 0) {
            return { ...group, topicIds: sensorOutputTopicIds };
        }
        return { ...group, topicIds: filtered };
    });

    const groupIds = new Set(syncGroups.map((group) => group.id));
    if (!groupIds.has("perception-primary") && sensors.some((sensor) => sensor.syncGroupId === "perception-primary")) {
        syncGroups.push({
            id: "perception-primary",
            description: "Sensors captured on the same simulation step.",
            topicIds: sensorOutputTopicIds.filter((id) => ["front-camera-image", "front-camera-info", "front-lidar-points"].includes(id)),
        });
    }
    if (!groupIds.has("localization-primary") && sensors.some((sensor) => sensor.syncGroupId === "localization-primary")) {
        syncGroups.push({
            id: "localization-primary",
            description: "Localization sensors captured on the same simulation step.",
            topicIds: sensorOutputTopicIds.filter((id) => ["imu", "gnss", "wheel-odometry"].includes(id)),
        });
    }

    return { ...sensorRig, syncGroups };
}

function scenarioSelection(value) {
    if (!value || typeof value !== "object") return null;
    const source = object(value);
    const id = text(source.id || source.scenarioId);
    if (!id) return null;
    return {
        id,
        expectedHash: text(source.expectedHash) || null,
        egoVehicleId: text(source.egoVehicleId) || null,
        sensorBindings: Object.fromEntries((Array.isArray(source.sensorBindings)
            ? source.sensorBindings.map((entry) => [entry?.aliasId ?? entry?.id, entry?.sensorId])
            : Object.entries(object(source.sensorBindings)))
            .map(([aliasId, sensorId]) => [text(aliasId), text(sensorId)])
            .filter(([aliasId, sensorId]) => aliasId && sensorId)),
        parameterValues: structuredClone(object(source.parameterValues ?? source.parameterOverrides)),
    };
}

export function createDefaultRunManifest(overrides = {}) {
    const base = {
        kind: RUN_MANIFEST_KIND,
        version: RUN_MANIFEST_VERSION,
        id: "igvc-default",
        name: "IGVC Default",
        description: "Deterministic IGVC simulation run.",
        scenario: null,
        environment: { id: "igvc", expectedHash: null },
        seed: "42",
        initialState: {
            vehicles: [{
                id: "ego",
                type: "big-car",
                pose: pose(),
                linearVelocity: vec3(),
                steeringAngle: 0,
            }],
            signals: {},
        },
        clock: {
            stepNs: 16_666_667,
            pacing: "realtime",
            speed: 1,
            maxSteps: null,
            publishClock: true,
            modules: { ...DEFAULT_MODULES },
        },
        sensorRig: {
            mapFrameId: "map",
            odomFrameId: "odom",
            rootFrameId: "base_link",
            vehicleId: "ego",
            syncGroups: defaultSyncGroups(),
            sensors: [
                createRunSensor("camera", {
                    id: "front-camera",
                    parentId: "ego",
                    mountFrameId: "front_camera_link",
                    measurementFrameId: "front_camera_optical_frame",
                    frameId: "front_camera_optical_frame",
                    syncGroupId: "perception-primary",
                    pose: { position: { x: 1.5, y: 0, z: 0.5 } },
                    outputs: { imageTopicId: "front-camera-image", cameraInfoTopicId: "front-camera-info" },
                }),
                createRunSensor("lidar3d", {
                    id: "front-lidar",
                    parentId: "ego",
                    mountFrameId: "front_lidar_frame",
                    measurementFrameId: "front_lidar_frame",
                    frameId: "front_lidar_frame",
                    syncGroupId: "perception-primary",
                    pose: { position: { x: 0.35, y: 0, z: 0.8 } },
                    outputs: { pointCloudTopicId: "front-lidar-points" },
                }),
                ...defaultLocalizationSensors(),
            ],
        },
        scripts: { enabled: true, artifacts: [], bindingIds: [], expectedBindingsHash: null, embeddedBindings: [] },
        topics: defaultManifestTopics(),
        autonomyCatalog: catalogMetadata(),
        assertions: [],
        parameters: [],
        logging: { policy: "optional", profileId: "simulation-run-full-sensors" },
    };
    return normalizeRunManifest({ ...base, ...overrides }, { allowMissingKind: true });
}

export function normalizeRunManifest(value, { allowMissingKind = false } = {}) {
    const source = object(value);
    if (!allowMissingKind && source.kind !== undefined && source.kind !== RUN_MANIFEST_KIND) {
        throw new Error(`Unsupported run manifest kind: ${JSON.stringify(source.kind)}.`);
    }
    const sourceVersion = source.version === undefined ? RUN_MANIFEST_VERSION : Number(source.version);
    if (![LEGACY_RUN_MANIFEST_VERSION, RUN_MANIFEST_V2, RUN_MANIFEST_V3, RUN_MANIFEST_V4, RUN_MANIFEST_VERSION].includes(sourceVersion)) {
        throw new Error(`Unsupported run manifest version ${source.version}; expected version 1, 2, 3, 4, or ${RUN_MANIFEST_VERSION}.`);
    }
    const initial = object(source.initialState);
    const clock = object(source.clock);
    const scripts = object(source.scripts);
    const topics = (Array.isArray(source.topics) ? source.topics : []).map(topic);
    const sensorRig = reconcileSyncGroups(normalizeSensorRig(source.sensorRig, sourceVersion), topics);
    return {
        kind: RUN_MANIFEST_KIND,
        version: RUN_MANIFEST_VERSION,
        id: text(source.id, "untitled-run"),
        name: text(source.name, "Untitled Run"),
        description: text(source.description),
        scenario: scenarioSelection(source.scenario),
        environment: {
            id: text(source.environment?.id, "igvc"),
            expectedHash: text(source.environment?.expectedHash) || null,
        },
        seed: typeof source.seed === "number" ? source.seed : text(source.seed, "42"),
        initialState: {
            vehicles: (Array.isArray(initial.vehicles) ? initial.vehicles : []).map((vehicle, index) => ({
                ...object(vehicle),
                id: text(vehicle?.id, `vehicle-${index + 1}`),
                type: text(vehicle?.type, "big-car"),
                pose: pose(vehicle?.pose),
                linearVelocity: vec3(vehicle?.linearVelocity),
                steeringAngle: finite(vehicle?.steeringAngle, 0),
            })),
            signals: object(initial.signals),
        },
        clock: {
            stepNs: positiveInteger(clock.stepNs, 16_666_667),
            pacing: RUN_PACING_MODES.includes(clock.pacing) ? clock.pacing : "realtime",
            speed: Math.max(0, finite(clock.speed, 1)),
            maxSteps: clock.maxSteps === null || clock.maxSteps === undefined ? null : positiveInteger(clock.maxSteps),
            publishClock: clock.publishClock !== false,
            modules: { ...DEFAULT_MODULES, ...object(clock.modules) },
        },
        sensorRig,
        scripts: {
            enabled: scripts.enabled !== false,
            artifacts: (Array.isArray(scripts.artifacts) ? scripts.artifacts : []).map((entry) => ({
                scriptId: text(entry?.scriptId),
                expectedHash: text(entry?.expectedHash) || null,
            })).filter((entry) => entry.scriptId),
            bindingIds: (Array.isArray(scripts.bindingIds) ? scripts.bindingIds : []).map((id) => text(id)).filter(Boolean),
            expectedBindingsHash: text(scripts.expectedBindingsHash) || null,
            embeddedBindings: Array.isArray(scripts.embeddedBindings) ? structuredClone(scripts.embeddedBindings) : [],
        },
        topics,
        assertions: (Array.isArray(source.assertions) ? source.assertions : []).map(assertion),
        parameters: (Array.isArray(source.parameters) ? source.parameters : []).map(parameter),
        logging: {
            policy: RUN_LOGGING_POLICIES.includes(source.logging?.policy) ? source.logging.policy : "optional",
            profileId: text(source.logging?.profileId, "simulation-run-full-sensors"),
        },
        autonomyCatalog: source.autonomyCatalog?.version
            ? { ...catalogMetadata(), ...object(source.autonomyCatalog) }
            : catalogMetadata(),
    };
}

export function validateRunManifest(value) {
    let manifest;
    try {
        manifest = normalizeRunManifest(value);
    } catch (error) {
        return { ok: false, manifest: null, issues: [{ path: "", message: error.message }] };
    }
    const issues = [];
    const duplicateIssues = (entries, path) => {
        const seen = new Set();
        for (const [index, entry] of entries.entries()) {
            if (!entry.id) issues.push({ path: `${path}.${index}.id`, message: "A stable id is required." });
            if (seen.has(entry.id)) issues.push({ path: `${path}.${index}.id`, message: `Duplicate id \"${entry.id}\".` });
            seen.add(entry.id);
        }
    };
    duplicateIssues(manifest.initialState.vehicles, "initialState.vehicles");
    duplicateIssues(manifest.sensorRig.sensors, "sensorRig.sensors");
    duplicateIssues(manifest.topics, "topics");
    duplicateIssues(manifest.assertions, "assertions");
    duplicateIssues(manifest.parameters, "parameters");
    const topics = new Map(manifest.topics.map((entry) => [entry.id, entry]));
    for (const [index, sensorEntry] of manifest.sensorRig.sensors.entries()) {
        for (const issue of validateRunSensorDefinition(sensorEntry)) {
            issues.push({ path: `sensorRig.sensors.${index}.${issue.path}`, message: issue.message });
        }
        for (const [key, topicId] of Object.entries(sensorEntry.outputs)) {
            if (topicId && !topics.has(topicId)) {
                issues.push({ path: `sensorRig.sensors.${index}.outputs.${key}`, message: `Unknown topic id \"${topicId}\".` });
            }
            const linked = topics.get(topicId);
            const linkedType = linked?.schema?.type || linked?.type;
            if (topicId && linked && sensorEntry.schema[key] !== linkedType) {
                issues.push({ path: `sensorRig.sensors.${index}.schema.${key}`, message: `Schema must match topic type "${linkedType}".` });
            }
        }
    }
    issues.push(...validateSensorRigFrames(manifest));
    issues.push(...validateSyncGroups(manifest));
    for (const [index, topicEntry] of manifest.topics.entries()) {
        issues.push(...validateTopicAgainstCatalog(topicEntry, index));
    }
    issues.push(...validateManifestTopicAuthority(manifest));
    for (const [index, assertionEntry] of manifest.assertions.entries()) {
        if (assertionEntry.source === "signal" && !assertionEntry.path) {
            issues.push({ path: `assertions.${index}.path`, message: "Signal assertions require a path." });
        }
        if (assertionEntry.source === "event" && (!assertionEntry.category || !assertionEntry.event)) {
            issues.push({ path: `assertions.${index}`, message: "Event assertions require category and event names." });
        }
        if (assertionEntry.window.endStep !== null && assertionEntry.window.endStep < assertionEntry.window.startStep) {
            issues.push({ path: `assertions.${index}.window`, message: "endStep must not precede startStep." });
        }
    }
    if (manifest.scenario && !manifest.scenario.egoVehicleId) {
        issues.push({ path: "scenario.egoVehicleId", message: "Scenario runs require an Ego vehicle assignment." });
    }
    const valueMatchesType = (type, value) => {
        if (type === "boolean") return typeof value === "boolean";
        if (type === "string") return typeof value === "string";
        if (type === "int32") return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
        return typeof value === "number" && Number.isFinite(value);
    };
    for (const [index, entry] of manifest.parameters.entries()) {
        if (!valueMatchesType(entry.type, entry.default)) {
            issues.push({ path: `parameters.${index}.default`, message: `Default value does not match ${entry.type}.` });
        }
        if (!RUN_PARAMETER_TARGET_KINDS.includes(entry.target?.kind)) {
            issues.push({ path: `parameters.${index}.target.kind`, message: "Target must be a scalar field, script input, or scenario signal." });
        } else if (["scalar-field", "scenario-signal"].includes(entry.target.kind) && !entry.target.path) {
            issues.push({ path: `parameters.${index}.target.path`, message: `${entry.target.kind} target requires a path.` });
        } else if (entry.target.kind === "scalar-field") {
            const target = validateScalarParameterTarget(manifest, entry, { owner: "run" });
            if (!target.ok) issues.push({ path: `parameters.${index}.target.path`, message: target.message });
        } else if (entry.target.kind === "script-input" && (!entry.target.scriptId || !entry.target.input)) {
            issues.push({ path: `parameters.${index}.target`, message: "Script-input target requires a script and input port." });
        }
    }
    return { ok: issues.length === 0, manifest, issues };
}

export function canonicalStringify(value) {
    const normalize = (entry) => {
        if (Array.isArray(entry)) return entry.map(normalize);
        if (!entry || typeof entry !== "object") return entry;
        return Object.fromEntries(
            Object.keys(entry).sort().map((key) => [key, normalize(entry[key])])
        );
    };
    return JSON.stringify(normalize(value));
}

export function stripRunMetadata(value) {
    const volatile = new Set(["createdAt", "updatedAt", "exportedAt", "clientRevision", "revision", "definitionHash", "resolvedHash"]);
    const visit = (entry) => {
        if (Array.isArray(entry)) return entry.map(visit);
        if (!entry || typeof entry !== "object") return entry;
        return Object.fromEntries(
            Object.entries(entry)
                .filter(([key]) => !volatile.has(key))
                .map(([key, nested]) => [key, visit(nested)])
        );
    };
    return visit(value);
}
