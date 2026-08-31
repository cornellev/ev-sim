import {
    createVehicleSensor,
    listSensorTypes,
    normalizeVehicleSensor,
    validateVehicleSensorDefinition,
} from "../3d/devices/SensorTypeRegistry.js";

export const VEHICLE_MANIFEST_KIND = "cev-sim.vehicle";
export const VEHICLE_MANIFEST_VERSION = 2;
export const LEGACY_VEHICLE_MANIFEST_VERSION = 1;
export const VEHICLE_BUNDLE_KIND = "cev-sim.vehicle-bundle";
export const VEHICLE_BUNDLE_VERSION = 1;

export const VEHICLE_SENSOR_TYPES = Object.freeze(listSensorTypes().map((definition) => definition.id));

/** Vehicle types implemented as hard-coded classes rather than manifests. */
export const BUILT_IN_VEHICLE_TYPES = Object.freeze(["big-car", "igvc-car", "scenario-car"]);

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

function positive(value, fallback) {
    const normalized = finite(value, fallback);
    return normalized > 0 ? normalized : fallback;
}

function nonNegative(value, fallback) {
    const normalized = finite(value, fallback);
    return normalized >= 0 ? normalized : fallback;
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
    return normalizeVehicleManifest({ ...base, ...overrides }, { allowMissingKind: true });
}

export function normalizeVehicleManifest(value, { allowMissingKind = false } = {}) {
    const source = object(value);
    if (!allowMissingKind && source.kind !== undefined && source.kind !== VEHICLE_MANIFEST_KIND) {
        throw new Error(`Unsupported vehicle manifest kind: ${JSON.stringify(source.kind)}.`);
    }
    const sourceVersion = source.version === undefined ? VEHICLE_MANIFEST_VERSION : Number(source.version);
    if (![LEGACY_VEHICLE_MANIFEST_VERSION, VEHICLE_MANIFEST_VERSION].includes(sourceVersion)) {
        throw new Error(`Unsupported vehicle manifest version ${source.version}; expected version 1 or ${VEHICLE_MANIFEST_VERSION}.`);
    }
    const model = object(source.model);
    const boundingBox = object(source.boundingBox);
    const wheels = (Array.isArray(source.wheels) ? source.wheels : []).map(wheel);
    const size = {
        x: positive(object(boundingBox.size).x, 2.7),
        y: positive(object(boundingBox.size).y, 1.4),
        z: positive(object(boundingBox.size).z, 1.25),
    };
    const kinematics = normalizeActuatorKinematics({
        ...object(source.kinematics),
        wheelbase: object(source.kinematics).wheelbase ?? (deriveWheelbase(wheels) ?? 1.5),
    }, { migrateFromV1: sourceVersion < VEHICLE_MANIFEST_VERSION });
    return {
        kind: VEHICLE_MANIFEST_KIND,
        version: VEHICLE_MANIFEST_VERSION,
        id: text(source.id, "untitled-vehicle"),
        name: text(source.name, "Untitled Vehicle"),
        description: text(source.description),
        model: {
            asset: text(model.asset) || null,
            scale: positive(model.scale, 1),
            rotation: euler(model.rotation),
            offset: vec3(model.offset),
        },
        boundingBox: {
            size,
            center: vec3(boundingBox.center, { x: 0, y: size.y / 2, z: 0 }),
        },
        egoCenter: vec3(source.egoCenter, { x: 0, y: size.y / 2, z: 0 }),
        wheels,
        kinematics,
        sensors: (Array.isArray(source.sensors) ? source.sensors : [])
            .map((entry, index) => normalizeVehicleSensor(entry, index)),
        lidarZone: lidarZone(source.lidarZone),
    };
}

export function validateVehicleManifest(value) {
    let manifest;
    try {
        manifest = normalizeVehicleManifest(value);
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
        for (const issue of validateVehicleSensorDefinition(sensorEntry)) {
            issues.push({ path: `sensors.${index}.${issue.path}`, message: issue.message });
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
    return { ok: issues.length === 0, manifest, issues };
}

/** Browser URL for a vehicle model asset stored on the server. */
export function vehicleAssetUrl(vehicleId, fileName) {
    if (!vehicleId || !fileName) return null;
    return `/api/storage/vehicle-assets/${encodeURIComponent(vehicleId)}/${encodeURIComponent(fileName)}`;
}

/**
 * Resolve a manifest `model.asset` to a fetchable URL.
 * Absolute `/…`, `http(s)://…`, blob, or data paths are kept as-is;
 * bare file names resolve against the vehicle's storage assets.
 */
export function resolveVehicleModelUrl(vehicleId, asset, { cacheBust } = {}) {
    if (!asset) return null;
    const trimmed = String(asset).trim();
    if (!trimmed) return null;
    const absolute = trimmed.startsWith("/") || /^(?:https?:|blob:|data:)/i.test(trimmed);
    const url = absolute ? trimmed : vehicleAssetUrl(vehicleId, trimmed);
    if (!url || cacheBust == null) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${cacheBust}`;
}
