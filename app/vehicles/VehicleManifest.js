import {
    createVehicleSensor,
    listSensorTypes,
    normalizeVehicleSensor,
    sensorTypeRegistry,
    validateVehicleSensorDefinition,
} from "../simulation/sensors/SensorTypeRegistry.js";
import { PLANT_DYNAMIC_BICYCLE_MODEL } from "../plugin/PlantModule.js";
import {
    collectVehiclePluginLockIssues,
    reconcileVehiclePluginLocks,
} from "../plugin/PluginSensorAuthoring.js";
import { assertAllowedBrowserResourceUrl } from "../security/BrowserResourcePolicy.js";
import { canonicalFiniteNumber } from "../simulation/kernel/SimulationHashes.js";
import {
    euler,
    finiteOr as finite,
    nonNegativeOr as nonNegative,
    plainObject as object,
    plainText as text,
    positiveOr as positive,
    vec3,
} from "../util/plainGeometry.js";
import { validateStandardAxles } from "./axle/standardAxle.js";

export const VEHICLE_MANIFEST_KIND = "cev-sim.vehicle";
export const VEHICLE_MANIFEST_VERSION = 2;
export const VEHICLE_MANIFEST_VERSION_V3 = 3;
export const LEGACY_VEHICLE_MANIFEST_VERSION = 1;
export const VEHICLE_MANIFEST_DOWNGRADE = "VEHICLE_MANIFEST_DOWNGRADE";
export const VEHICLE_BUNDLE_KIND = "cev-sim.vehicle-bundle";
export const VEHICLE_BUNDLE_VERSION = 1;

export const VEHICLE_SENSOR_TYPES = Object.freeze(listSensorTypes().map((definition) => definition.id));

/** Vehicle types implemented as hard-coded classes rather than manifests. */
export const BUILT_IN_VEHICLE_TYPES = Object.freeze(["big-car", "igvc-car", "scenario-car"]);

/** Storage ids are lowercase slugs. They are also filenames. */
export function isValidVehicleId(value) {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value ?? "").trim());
}

/** Default actuator limits for new v2 manifests (SI). */
export const DEFAULT_ACTUATOR_LIMITS = Object.freeze({
    maxSpeed: 15,
    maxAcceleration: 3,
    maxDeceleration: 5,
    maxJerk: 10,
    maxSteeringAngle: 0.6,
    maxSteeringRate: 1.2,
    responseDelayNs: 0,
});

export const KINEMATIC_BICYCLE_MODEL = "kinematic-bicycle-v1";
export const DYNAMIC_BICYCLE_MODEL = PLANT_DYNAMIC_BICYCLE_MODEL;

/** Defaults for `dynamic-bicycle-v1`. `lf`/`lr` are derived, not stored. */
export const DEFAULT_DYNAMIC_BICYCLE = Object.freeze({
    mass: 1500,
    yawInertia: 2250,
    corneringStiffnessFront: 80000,
    corneringStiffnessRear: 80000,
    frictionMu: 0.9,
    rollingResistance: 0.015,
});

const VEHICLE_MOTION_MODELS = new Set([KINEMATIC_BICYCLE_MODEL, DYNAMIC_BICYCLE_MODEL]);
const DYNAMIC_BICYCLE_FIELDS = Object.freeze([
    ["mass", false],
    ["yawInertia", false],
    ["corneringStiffnessFront", false],
    ["corneringStiffnessRear", false],
    ["frictionMu", false],
    ["rollingResistance", true],
]);
const DYNAMICS_KEYS = new Set(["plant", "model", ...DYNAMIC_BICYCLE_FIELDS.map(([key]) => key)]);

function dynamicsNumber(source, key, fallback, nonNegative) {
    if (source[key] === undefined) return fallback;
    const number = Number(source[key]);
    const valid = Number.isFinite(number) && (nonNegative ? number >= 0 : number > 0);
    if (!valid) {
        const bound = nonNegative ? "greater than or equal to 0" : "greater than 0";
        throw new Error(`vehicle manifest.dynamics.${key} must be a finite number ${bound}.`);
    }
    return canonicalFiniteNumber(number);
}

function normalizeVehicleDynamics(value) {
    if (value == null) return undefined;
    const source = object(value);
    const unknown = Object.keys(source).find((key) => !DYNAMICS_KEYS.has(key));
    if (unknown) throw new Error(`vehicle manifest.dynamics contains unknown field "${unknown}".`);
    const plant = text(source.plant);
    const model = text(source.model);
    if (model && !VEHICLE_MOTION_MODELS.has(model)) {
        throw new Error(`vehicle manifest.dynamics.model "${model}" is not a known motion model.`);
    }
    const dynamic = model === DYNAMIC_BICYCLE_MODEL;
    if (DYNAMIC_BICYCLE_FIELDS.some(([key]) => source[key] !== undefined) && !dynamic) {
        throw new Error("vehicle manifest.dynamics physical fields require model \"dynamic-bicycle-v1\".");
    }
    if (plant && dynamic) {
        throw new Error("vehicle manifest.dynamics.plant cannot be combined with model \"dynamic-bicycle-v1\".");
    }
    if (plant) return { plant };
    if (!dynamic) return undefined;
    return {
        model: DYNAMIC_BICYCLE_MODEL,
        ...Object.fromEntries(DYNAMIC_BICYCLE_FIELDS.map(([key, nonNegative]) => [
            key,
            dynamicsNumber(source, key, DEFAULT_DYNAMIC_BICYCLE[key], nonNegative),
        ])),
    };
}

function wheel(value = {}, index = 0) {
    const source = object(value);
    return {
        id: text(source.id, `wheel-${index + 1}`),
        position: vec3(source.position),
        radius: positive(source.radius, 0.25),
        width: positive(source.width, 0.15),
        steerable: source.steerable === true,
    };
}

function geometricPositive(value, fallback) {
    return canonicalFiniteNumber(positive(value, fallback));
}

function geometricVec3(value, fallback) {
    const source = vec3(value, fallback);
    return {
        x: canonicalFiniteNumber(source.x),
        y: canonicalFiniteNumber(source.y),
        z: canonicalFiniteNumber(source.z),
    };
}

function geometricEuler(value) {
    const source = euler(value);
    return {
        x: canonicalFiniteNumber(source.x),
        y: canonicalFiniteNumber(source.y),
        z: canonicalFiniteNumber(source.z),
        order: source.order,
    };
}

/** Sibling filenames only: no directories, traversals, or empty names. */
export function isCanonicalDependencyName(value) {
    return typeof value === "string"
        && value.length > 0
        && value === value.trim()
        && value !== "."
        && value !== ".."
        && !value.includes("/")
        && !value.includes("\\")
        && !value.includes("\0");
}

function canonicalDependencies(value) {
    if (!Array.isArray(value)) return [];
    const names = [];
    for (const entry of value) {
        if (isCanonicalDependencyName(entry) && !names.includes(entry)) names.push(entry);
    }
    names.sort();
    return names;
}

function canonicalHiddenNodeIndices(value) {
    if (!Array.isArray(value)) return [];
    const indices = [];
    for (const entry of value) {
        if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && !indices.includes(entry)) {
            indices.push(entry);
        }
    }
    indices.sort((left, right) => left - right);
    return indices;
}

function wheelV3(value = {}, index = 0) {
    const source = object(value);
    const record = {
        id: text(source.id, `wheel-${index + 1}`),
        position: geometricVec3(source.position),
        radius: geometricPositive(source.radius, 0.25),
        width: geometricPositive(source.width, 0.15),
        steerable: source.steerable === true,
    };
    if (Object.hasOwn(source, "axle")) record.axle = text(source.axle);
    if (Object.hasOwn(source, "side")) record.side = text(source.side);
    if (Object.hasOwn(source, "visual") && source.visual != null) {
        const visual = object(source.visual);
        const nodeIndex = Number(visual.nodeIndex);
        record.visual = {
            kind: text(visual.kind),
            nodeIndex: Number.isInteger(nodeIndex) && nodeIndex >= 0 ? nodeIndex : -1,
        };
    }
    return record;
}

function unsupportedVersion(version) {
    return new Error(`Unsupported vehicle manifest version ${version}; expected version 1, 2, or 3.`);
}

function downgradeError() {
    const error = new Error("Refusing to downgrade a version 3 vehicle manifest to version 2.");
    error.code = VEHICLE_MANIFEST_DOWNGRADE;
    return error;
}

/**
 * Output version for a source document.
 * Missing, v1, and v2 stay on the v2 writer. v3 stays v3.
 * `{ version: 2 }` pins v2 and refuses to strip a v3 document.
 * No option upgrades a document to v3.
 */
export function resolveVehicleManifestVersion(source, { version } = {}) {
    const raw = source?.version;
    const sourceVersion = raw === undefined || raw === null ? undefined : Number(raw);
    if (version !== undefined && Number(version) !== VEHICLE_MANIFEST_VERSION && Number(version) !== VEHICLE_MANIFEST_VERSION_V3) {
        throw unsupportedVersion(version);
    }
    if (Number(version) === VEHICLE_MANIFEST_VERSION && sourceVersion === VEHICLE_MANIFEST_VERSION_V3) {
        throw downgradeError();
    }
    if (sourceVersion === undefined
        || sourceVersion === LEGACY_VEHICLE_MANIFEST_VERSION
        || sourceVersion === VEHICLE_MANIFEST_VERSION) {
        return VEHICLE_MANIFEST_VERSION;
    }
    if (sourceVersion === VEHICLE_MANIFEST_VERSION_V3) return VEHICLE_MANIFEST_VERSION_V3;
    throw unsupportedVersion(raw);
}

/**
 * Reject a legacy writer that would replace a stored v3 document.
 * Callers pass the stored record and the raw request body, before normalization.
 */
export function assertNoVehicleManifestDowngrade(current, incoming) {
    if (Number(current?.version) !== VEHICLE_MANIFEST_VERSION_V3) return;
    if (Number(incoming?.version) === VEHICLE_MANIFEST_VERSION_V3) return;
    const error = new Error("Refusing to overwrite a version 3 vehicle manifest with a legacy writer.");
    error.code = VEHICLE_MANIFEST_DOWNGRADE;
    throw error;
}

function lidarZone(value = {}) {
    const source = object(value);
    const vertices = (Array.isArray(source.vertices) ? source.vertices : [])
        .filter((entry) => Array.isArray(entry) && entry.length === 3)
        .map((entry) => [finite(entry[0], 0), finite(entry[1], 0), finite(entry[2], 0)]);
    const triangles = (Array.isArray(source.triangles) ? source.triangles : [])
        .filter((entry) => Array.isArray(entry) && entry.length === 3)
        .map((entry) => [
            Math.floor(finite(entry[0], -1)),
            Math.floor(finite(entry[1], -1)),
            Math.floor(finite(entry[2], -1)),
        ]);
    return {
        params: {
            voxelSize: positive(object(source.params).voxelSize, 0.2),
        },
        vertices,
        triangles,
    };
}

/** Derive a bicycle-model wheelbase from wheel placement when possible. */
export function deriveWheelbase(wheels = []) {
    const steerable = wheels.filter((entry) => entry.steerable);
    const fixed = wheels.filter((entry) => !entry.steerable);
    if (steerable.length === 0 || fixed.length === 0) return null;
    const mean = (entries) => entries.reduce((sum, entry) => sum + entry.position.x, 0) / entries.length;
    const distance = Math.abs(mean(steerable) - mean(fixed));
    return distance > 0.01 ? distance : null;
}

/**
 * Normalize actuator kinematics. v1 manifests migrate with permissive zero-delay
 * defaults so recorded replays remain compatible until authors opt into dynamics.
 */
export function normalizeActuatorKinematics(source = {}, { migrateFromV1 = false } = {}) {
    const kinematics = object(source);
    const defaults = migrateFromV1
        ? {
            ...DEFAULT_ACTUATOR_LIMITS,
            maxSpeed: 40,
            maxAcceleration: 40,
            maxDeceleration: 40,
            maxJerk: 1e6,
            maxSteeringRate: 1e6,
            responseDelayNs: 0,
        }
        : DEFAULT_ACTUATOR_LIMITS;
    return {
        wheelbase: positive(kinematics.wheelbase, 1.5),
        maxSteeringAngle: positive(kinematics.maxSteeringAngle, defaults.maxSteeringAngle),
        maxSpeed: positive(kinematics.maxSpeed, defaults.maxSpeed),
        maxAcceleration: positive(kinematics.maxAcceleration, defaults.maxAcceleration),
        maxDeceleration: positive(kinematics.maxDeceleration, defaults.maxDeceleration),
        maxJerk: positive(kinematics.maxJerk, defaults.maxJerk),
        maxSteeringRate: positive(kinematics.maxSteeringRate, defaults.maxSteeringRate),
        responseDelayNs: Math.floor(nonNegative(kinematics.responseDelayNs, defaults.responseDelayNs)),
    };
}

export function createDefaultVehicleManifest(overrides = {}) {
    const base = {
        kind: VEHICLE_MANIFEST_KIND,
        version: VEHICLE_MANIFEST_VERSION,
        id: "untitled-vehicle",
        name: "Untitled Vehicle",
        description: "",
        model: { asset: null, scale: 1, rotation: euler(), offset: vec3() },
        boundingBox: {
            size: { x: 2.7, y: 1.4, z: 1.25 },
            center: { x: 0, y: 0.7, z: 0 },
        },
        egoCenter: { x: 0, y: 0.5, z: 0 },
        wheels: [
            wheel({ id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, steerable: true }),
            wheel({ id: "front-right", position: { x: 0.75, y: 0.25, z: -0.55 }, steerable: true }),
            wheel({ id: "rear-left", position: { x: -0.75, y: 0.25, z: 0.55 } }),
            wheel({ id: "rear-right", position: { x: -0.75, y: 0.25, z: -0.55 } }),
        ],
        kinematics: {
            wheelbase: 1.5,
            ...DEFAULT_ACTUATOR_LIMITS,
        },
        sensors: [
            createVehicleSensor("lidar3d", { id: "roof-lidar", pose: { position: { x: 0.35, y: 0.8, z: 0 } } }),
        ],
        lidarZone: lidarZone(),
    };
    return normalizeVehicleManifest(
        { ...base, ...overrides, version: VEHICLE_MANIFEST_VERSION },
        { allowMissingKind: true, version: VEHICLE_MANIFEST_VERSION },
    );
}

function withStandardAxleRoles(wheels) {
    return wheels.map((wheel) => {
        const match = /^(front|rear)-(left|right)$/.exec(wheel.id);
        if (!match || wheel.axle || wheel.side) return wheel;
        return {
            ...wheel,
            axle: match[1],
            side: match[2],
            steerable: match[1] === "front",
        };
    });
}

/**
 * Version 3 blank used by transactional publication.
 * `createDefaultVehicleManifest()` stays version 2 so its pinned hash does not move.
 * The blank's named wheels are a standard front and rear axle. Dependencies and
 * hidden nodes start empty.
 */
export function createBlankVehicleManifest(overrides = {}) {
    const base = createDefaultVehicleManifest(overrides);
    return normalizeVehicleManifest({
        ...base,
        version: VEHICLE_MANIFEST_VERSION_V3,
        wheels: withStandardAxleRoles(base.wheels),
        model: {
            asset: null,
            dependencies: [],
            hiddenNodeIndices: [],
            scale: base.model.scale,
            rotation: base.model.rotation,
            offset: base.model.offset,
        },
    });
}

export function normalizeVehicleManifest(value, {
    allowMissingKind = false,
    sensorRegistry = sensorTypeRegistry,
    version,
} = {}) {
    const source = object(value);
    if (!allowMissingKind && source.kind !== undefined && source.kind !== VEHICLE_MANIFEST_KIND) {
        throw new Error(`Unsupported vehicle manifest kind: ${JSON.stringify(source.kind)}.`);
    }
    const outputVersion = resolveVehicleManifestVersion(source, { version });
    const declaredVersion = source.version === undefined ? VEHICLE_MANIFEST_VERSION : Number(source.version);
    const model = object(source.model);
    const boundingBox = object(source.boundingBox);
    const v3 = outputVersion === VEHICLE_MANIFEST_VERSION_V3;
    const wheels = (Array.isArray(source.wheels) ? source.wheels : [])
        .map((entry, index) => (v3 ? wheelV3(entry, index) : wheel(entry, index)));
    const size = v3
        ? {
            x: geometricPositive(object(boundingBox.size).x, 2.7),
            y: geometricPositive(object(boundingBox.size).y, 1.4),
            z: geometricPositive(object(boundingBox.size).z, 1.25),
        }
        : {
            x: positive(object(boundingBox.size).x, 2.7),
            y: positive(object(boundingBox.size).y, 1.4),
            z: positive(object(boundingBox.size).z, 1.25),
        };
    const kinematicsSource = normalizeActuatorKinematics({
        ...object(source.kinematics),
        wheelbase: object(source.kinematics).wheelbase ?? (deriveWheelbase(wheels) ?? 1.5),
    }, { migrateFromV1: declaredVersion < VEHICLE_MANIFEST_VERSION });
    const kinematics = v3
        ? {
            ...kinematicsSource,
            wheelbase: canonicalFiniteNumber(kinematicsSource.wheelbase),
            maxSteeringAngle: canonicalFiniteNumber(kinematicsSource.maxSteeringAngle),
        }
        : kinematicsSource;
    const sensors = (Array.isArray(source.sensors) ? source.sensors : [])
        .map((entry, index) => normalizeVehicleSensor(entry, index, sensorRegistry));
    const dynamics = normalizeVehicleDynamics(source.dynamics);
    const pluginLocks = source.pluginLocks === undefined || source.pluginLocks === null
        ? undefined
        : reconcileVehiclePluginLocks(source.pluginLocks, sensors, { sensorRegistry, dynamics });
    const asset = text(model.asset) || null;
    const normalizedModel = v3
        ? {
            asset,
            dependencies: asset ? canonicalDependencies(model.dependencies) : [],
            hiddenNodeIndices: asset ? canonicalHiddenNodeIndices(model.hiddenNodeIndices) : [],
            scale: geometricPositive(model.scale, 1),
            rotation: geometricEuler(model.rotation),
            offset: geometricVec3(model.offset),
        }
        : {
            asset,
            scale: positive(model.scale, 1),
            rotation: euler(model.rotation),
            offset: vec3(model.offset),
        };
    return {
        kind: VEHICLE_MANIFEST_KIND,
        version: outputVersion,
        id: text(source.id, "untitled-vehicle"),
        name: text(source.name, "Untitled Vehicle"),
        description: text(source.description),
        model: normalizedModel,
        boundingBox: {
            size,
            center: v3
                ? geometricVec3(boundingBox.center, { x: 0, y: size.y / 2, z: 0 })
                : vec3(boundingBox.center, { x: 0, y: size.y / 2, z: 0 }),
        },
        egoCenter: v3
            ? geometricVec3(source.egoCenter, { x: 0, y: size.y / 2, z: 0 })
            : vec3(source.egoCenter, { x: 0, y: size.y / 2, z: 0 }),
        wheels,
        kinematics,
        sensors,
        ...(pluginLocks ? { pluginLocks } : {}),
        ...(dynamics ? { dynamics } : {}),
        lidarZone: lidarZone(source.lidarZone),
    };
}

function modelListIssues(value) {
    const source = object(value);
    let outputVersion;
    try {
        outputVersion = resolveVehicleManifestVersion(source);
    } catch {
        return [];
    }
    if (outputVersion !== VEHICLE_MANIFEST_VERSION_V3) return [];
    const model = object(source.model);
    const issues = [];
    const asset = text(model.asset) || null;
    if (model.dependencies !== undefined && !Array.isArray(model.dependencies)) {
        issues.push({ code: "vehicle.model.dependencies", path: "model.dependencies", message: "dependencies must be an array of filenames." });
    } else if (Array.isArray(model.dependencies)) {
        const seen = new Set();
        model.dependencies.forEach((entry, index) => {
            if (!isCanonicalDependencyName(entry)) {
                issues.push({ code: "vehicle.model.dependencies", path: `model.dependencies.${index}`, message: "Dependency names must be canonical sibling filenames." });
            } else if (seen.has(entry)) {
                issues.push({ code: "vehicle.model.dependencies", path: `model.dependencies.${index}`, message: `Duplicate dependency "${entry}".` });
            } else {
                seen.add(entry);
            }
        });
        if (!asset && model.dependencies.length > 0) {
            issues.push({ code: "vehicle.model.dependencies", path: "model.dependencies", message: "A model-free vehicle cannot declare dependencies." });
        }
    }
    if (model.hiddenNodeIndices !== undefined && !Array.isArray(model.hiddenNodeIndices)) {
        issues.push({ code: "vehicle.model.hidden-nodes", path: "model.hiddenNodeIndices", message: "hiddenNodeIndices must be an array of node indices." });
    } else if (Array.isArray(model.hiddenNodeIndices)) {
        const seen = new Set();
        model.hiddenNodeIndices.forEach((entry, index) => {
            if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
                issues.push({ code: "vehicle.model.hidden-nodes", path: `model.hiddenNodeIndices.${index}`, message: "Hidden node indices must be non-negative integers." });
            } else if (seen.has(entry)) {
                issues.push({ code: "vehicle.model.hidden-nodes", path: `model.hiddenNodeIndices.${index}`, message: `Duplicate hidden node index ${entry}.` });
            } else {
                seen.add(entry);
            }
        });
        if (!asset && model.hiddenNodeIndices.length > 0) {
            issues.push({ code: "vehicle.model.hidden-nodes", path: "model.hiddenNodeIndices", message: "A model-free vehicle cannot hide model nodes." });
        }
    }
    return issues;
}

export function validateVehicleManifest(value, {
    sensorRegistry = sensorTypeRegistry,
    allowUnknownSensors = false,
    plants = null,
} = {}) {
    let manifest;
    try {
        manifest = normalizeVehicleManifest(value, { sensorRegistry });
    } catch (error) {
        return { ok: false, manifest: null, issues: [{ path: "", message: error.message }] };
    }
    const issues = [];
    if (BUILT_IN_VEHICLE_TYPES.includes(manifest.id)) {
        issues.push({ path: "id", message: `"${manifest.id}" is reserved for a built-in vehicle type.` });
    }
    const duplicateIssues = (entries, path) => {
        const seen = new Set();
        for (const [index, entry] of entries.entries()) {
            if (!entry.id) issues.push({ path: `${path}.${index}.id`, message: "A stable id is required." });
            if (seen.has(entry.id)) issues.push({ path: `${path}.${index}.id`, message: `Duplicate id "${entry.id}".` });
            seen.add(entry.id);
        }
    };
    duplicateIssues(manifest.wheels, "wheels");
    duplicateIssues(manifest.sensors, "sensors");
    for (const [index, sensorEntry] of manifest.sensors.entries()) {
        const definition = sensorRegistry.get(sensorEntry.type);
        const sensorIssues = allowUnknownSensors && !definition
            ? [] : validateVehicleSensorDefinition(sensorEntry, sensorRegistry);
        for (const issue of sensorIssues) {
            issues.push({ path: `sensors.${index}.${issue.path}`, message: issue.message });
        }
    }
    issues.push(...collectVehiclePluginLockIssues(manifest, { sensorRegistry }));
    if (manifest.dynamics?.plant && plants) {
        const known = typeof plants.has === "function"
            ? plants.has(manifest.dynamics.plant)
            : Boolean(plants[manifest.dynamics.plant]);
        if (!known) {
            issues.push({
                path: "dynamics.plant",
                message: `Plant "${manifest.dynamics.plant}" is not declared by the resolved plugins.`,
            });
        }
    }
    const vertexCount = manifest.lidarZone.vertices.length;
    for (const [index, triangle] of manifest.lidarZone.triangles.entries()) {
        if (triangle.some((vertexIndex) => vertexIndex < 0 || vertexIndex >= vertexCount)) {
            issues.push({ path: `lidarZone.triangles.${index}`, message: "Triangle references a vertex outside the vertices array." });
        }
    }
    const k = manifest.kinematics;
    if (!(k.maxSpeed > 0)) issues.push({ path: "kinematics.maxSpeed", message: "maxSpeed must be positive." });
    if (!(k.maxAcceleration > 0)) issues.push({ path: "kinematics.maxAcceleration", message: "maxAcceleration must be positive." });
    if (!(k.maxDeceleration > 0)) issues.push({ path: "kinematics.maxDeceleration", message: "maxDeceleration must be positive." });
    if (!(k.maxJerk > 0)) issues.push({ path: "kinematics.maxJerk", message: "maxJerk must be positive." });
    if (!(k.maxSteeringRate > 0)) issues.push({ path: "kinematics.maxSteeringRate", message: "maxSteeringRate must be positive." });
    if (k.responseDelayNs < 0) issues.push({ path: "kinematics.responseDelayNs", message: "responseDelayNs must be non-negative." });
    if (manifest.version === VEHICLE_MANIFEST_VERSION_V3) {
        issues.push(...modelListIssues(value));
        issues.push(...validateStandardAxles(manifest));
    }
    return { ok: issues.length === 0, manifest, issues };
}

/** Browser URL for a vehicle model asset stored on the server. */
export function vehicleAssetUrl(vehicleId, fileName) {
    if (!vehicleId || !fileName) return null;
    return `/api/storage/vehicle-assets/${encodeURIComponent(vehicleId)}/${encodeURIComponent(fileName)}`;
}

/**
 * Resolve a manifest `model.asset` to a fetchable URL.
 * Same-origin paths and explicitly configured HTTP(S) origins are preserved;
 * bare file names resolve against the vehicle's storage assets.
 */
export function resolveVehicleModelUrl(vehicleId, asset, { cacheBust } = {}) {
    if (!asset) return null;
    const trimmed = String(asset).trim();
    if (!trimmed) return null;
    const absolute = trimmed.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
    const url = absolute
        ? assertAllowedBrowserResourceUrl(trimmed)
        : vehicleAssetUrl(vehicleId, trimmed);
    if (!url || cacheBust == null) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${cacheBust}`;
}
