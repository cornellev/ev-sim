const DEFAULT_SENSOR_TYPE = "lidar3d";

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

function anglePair(value, fallback) {
    if (!Array.isArray(value) || value.length !== 2) return [...fallback];
    const low = finite(value[0], fallback[0]);
    const high = finite(value[1], fallback[1]);
    return high > low ? [low, high] : [...fallback];
}

function cloneObject(value) {
    return structuredClone(object(value));
}

export class SensorTypeRegistry {
    constructor() {
        this.definitions = new Map();
    }

    register(definition) {
        const id = text(definition?.id);
        if (!id) throw new Error("Sensor type definitions require an id.");
        if (this.definitions.has(id)) throw new Error(`Sensor type "${id}" is already registered.`);
        if (!definition.run || !definition.vehicle) {
            throw new Error(`Sensor type "${id}" requires run and vehicle definitions.`);
        }
        const normalized = Object.freeze({ ...definition, id });
        this.definitions.set(id, normalized);
        return normalized;
    }

    get(id) {
        return this.definitions.get(String(id ?? "")) || null;
    }

    list() {
        return [...this.definitions.values()];
    }
}

export const sensorTypeRegistry = new SensorTypeRegistry();

export function registerSensorType(definition) {
    return sensorTypeRegistry.register(definition);
}

export function getSensorType(id) {
    return sensorTypeRegistry.get(id);
}

export function listSensorTypes() {
    return sensorTypeRegistry.list();
}

const cameraRunFields = [
    { label: "Image topic ID", path: ["outputs", "imageTopicId"], control: "text" },
    { label: "Image ROS schema", path: ["schema", "imageTopicId"], control: "text" },
    { label: "CameraInfo topic ID", path: ["outputs", "cameraInfoTopicId"], control: "text" },
    { label: "CameraInfo ROS schema", path: ["schema", "cameraInfoTopicId"], control: "text" },
    { label: "Width", path: ["calibration", "width"], control: "number", min: 1 },
    { label: "Height", path: ["calibration", "height"], control: "number", min: 1 },
    { label: "Vertical FOV (deg)", path: ["calibration", "verticalFovDeg"], control: "number", min: 1, max: 179 },
    { label: "Encoding", path: ["calibration", "encoding"], control: "text", readOnly: true },
];

const lidarRunFields = [
    { label: "PointCloud topic ID", path: ["outputs", "pointCloudTopicId"], control: "text" },
    { label: "PointCloud ROS schema", path: ["schema", "pointCloudTopicId"], control: "text" },
    { label: "Range (m)", path: ["calibration", "range"], control: "number", min: 0.01 },
    { label: "Azimuth step (deg)", path: ["calibration", "azimuth", "stepDeg"], control: "number", min: 0.01 },
    { label: "Elevation step (deg)", path: ["calibration", "elevation", "stepDeg"], control: "number", min: 0.01 },
];

const cameraVehicleFields = [
    { label: "Range (m)", path: ["config", "range"], control: "number", min: 0.1, step: 0.1 },
    { label: "Vertical FOV (deg)", path: ["config", "fov"], control: "number", min: 1, max: 179 },
    { label: "Width (px)", path: ["config", "width"], control: "number", min: 1 },
    { label: "Height (px)", path: ["config", "height"], control: "number", min: 1 },
    { label: "Theta step (deg)", path: ["config", "thetaStep"], control: "number", min: 0.01, step: 0.01 },
    { label: "Phi step (deg)", path: ["config", "phiStep"], control: "number", min: 0.01, step: 0.01 },
];

const lidarVehicleFields = [
    { label: "Range (m)", path: ["config", "range"], control: "number", min: 0.1, step: 0.1 },
    { label: "Theta step (deg)", path: ["config", "thetaStep"], control: "number", min: 0.01, step: 0.01 },
    { label: "Theta start (deg)", path: ["config", "thetaRange", 0], control: "number" },
    { label: "Theta end (deg)", path: ["config", "thetaRange", 1], control: "number" },
    { label: "Phi step (deg)", path: ["config", "phiStep"], control: "number", min: 0.01, step: 0.01 },
    { label: "Phi start (deg)", path: ["config", "phiRange", 0], control: "number" },
    { label: "Phi end (deg)", path: ["config", "phiRange", 1], control: "number" },
];

registerSensorType({
    id: "camera",
    label: "Camera",
    addLabel: "Add camera",
    idPrefix: "camera",
    accentClass: "text-amber-300",
    color: 0xf59e0b,
    run: {
        defaultRateHz: 30,
        fields: cameraRunFields,
        outputs: [
            { key: "imageTopicId", signal: "image", rosType: "sensor_msgs/Image" },
            { key: "cameraInfoTopicId", signal: "cameraInfo", rosType: "sensor_msgs/CameraInfo" },
        ],
        normalize(source) {
            return {
                calibration: {
                    width: 320,
                    height: 180,
                    encoding: "rgba8",
                    verticalFovDeg: 75,
                    near: 0.1,
                    far: 200,
                    distortionModel: "plumb_bob",
                    distortion: [0, 0, 0, 0, 0],
                    ...object(source.calibration),
                },
                schema: {
                    imageTopicId: "sensor_msgs/Image",
                    cameraInfoTopicId: "sensor_msgs/CameraInfo",
                    ...object(source.schema),
                },
                determinism: { comparison: "semantic-tolerance", crossDeviceByteEquality: false },
            };
        },
        validate: () => [],
    },
    vehicle: {
        fields: cameraVehicleFields,
        normalize(source) {
            const config = object(source.config);
            return {
                range: positive(config.range, 20),
                thetaStep: positive(config.thetaStep, 2),
                phiStep: positive(config.phiStep, 1),
                width: Math.max(1, Math.floor(positive(config.width, 320))),
                height: Math.max(1, Math.floor(positive(config.height, 180))),
                fov: Math.min(179, positive(config.fov, 75)),
                near: positive(config.near, 0.1),
                far: positive(config.far, 200),
            };
        },
        validate: () => [],
    },
});

registerSensorType({
    id: "lidar3d",
    label: "3D LiDAR",
    addLabel: "Add LiDAR",
    idPrefix: "lidar",
    accentClass: "text-sky-300",
    color: 0x38bdf8,
    run: {
        defaultRateHz: 10,
        fields: lidarRunFields,
        outputs: [
            { key: "pointCloudTopicId", signal: "pointCloud", rosType: "sensor_msgs/PointCloud2" },
        ],
        normalize(source) {
            return {
                calibration: {
                    range: 20,
                    azimuth: { startDeg: -180, endDeg: 180, stepDeg: 2 },
                    elevation: { startDeg: -20, endDeg: 20, stepDeg: 1 },
                    ...object(source.calibration),
                },
                schema: {
                    pointCloudTopicId: "sensor_msgs/PointCloud2",
                    ...object(source.schema),
                },
                determinism: { comparison: "numeric-tolerance", crossDeviceByteEquality: true },
            };
        },
        validate: () => [],
    },
    vehicle: {
        fields: lidarVehicleFields,
        normalize(source) {
            const config = object(source.config);
            return {
                range: positive(config.range, 20),
                thetaStep: positive(config.thetaStep, 2),
                thetaRange: anglePair(config.thetaRange, [-180, 180]),
                phiStep: positive(config.phiStep, 1),
                phiRange: anglePair(config.phiRange, [-20, 20]),
            };
        },
        validate: () => [],
    },
});

function resolveType(source, registry) {
    const requested = text(source.type);
    return requested || (registry.get(DEFAULT_SENSOR_TYPE) ? DEFAULT_SENSOR_TYPE : registry.list()[0]?.id || "");
}

export function normalizeRunSensor(value = {}, index = 0, registry = sensorTypeRegistry) {
    const source = object(value);
    const type = resolveType(source, registry);
    const definition = registry.get(type);
    const id = text(source.id, `sensor-${index + 1}`);
    const specific = definition?.run.normalize(source) || {
        calibration: cloneObject(source.calibration),
        schema: cloneObject(source.schema),
        determinism: cloneObject(source.determinism),
    };
    return {
        id,
        type,
        enabled: source.enabled !== false,
        parentId: text(source.parentId, "ego"),
        frameId: text(source.frameId, `${id}_frame`),
        pose: pose(source.pose),
        rateHz: Math.max(0.001, finite(source.rateHz, definition?.run.defaultRateHz ?? 10)),
        phaseNs: nonNegativeInteger(source.phaseNs, 0),
        calibration: specific.calibration,
        latency: {
            fixedNs: nonNegativeInteger(source.latency?.fixedNs, 0),
            jitterNs: nonNegativeInteger(source.latency?.jitterNs, 0),
        },
        noise: {
            model: ["none", "gaussian"].includes(source.noise?.model) ? source.noise.model : "none",
            standardDeviation: Math.max(0, finite(source.noise?.standardDeviation, 0)),
            bias: finite(source.noise?.bias, 0),
            dropoutProbability: Math.min(1, Math.max(0, finite(source.noise?.dropoutProbability, 0))),
        },
        outputs: cloneObject(source.outputs),
        schema: specific.schema,
        determinism: specific.determinism,
        maxQueueFrames: positiveInteger(source.maxQueueFrames, 8),
    };
}

export function createRunSensor(type = DEFAULT_SENSOR_TYPE, overrides = {}, index = 0, registry = sensorTypeRegistry) {
    return normalizeRunSensor({ ...overrides, type }, index, registry);
}

export function changeRunSensorType(sensor, type, registry = sensorTypeRegistry) {
    const source = object(sensor);
    return createRunSensor(type, {
        id: source.id,
        enabled: source.enabled,
        parentId: source.parentId,
        frameId: source.frameId,
        pose: source.pose,
        rateHz: source.rateHz,
        phaseNs: source.phaseNs,
        latency: source.latency,
        noise: source.noise,
        maxQueueFrames: source.maxQueueFrames,
    }, 0, registry);
}

export function normalizeVehicleSensor(value = {}, index = 0, registry = sensorTypeRegistry) {
    const source = object(value);
    const type = resolveType(source, registry);
    const definition = registry.get(type);
    return {
        id: text(source.id, `sensor-${index + 1}`),
        type,
        pose: pose(source.pose),
        config: definition?.vehicle.normalize(source) || cloneObject(source.config),
    };
}

export function createVehicleSensor(type = DEFAULT_SENSOR_TYPE, overrides = {}, index = 0, registry = sensorTypeRegistry) {
    return normalizeVehicleSensor({ ...overrides, type }, index, registry);
}

export function changeVehicleSensorType(sensor, type, registry = sensorTypeRegistry) {
    const source = object(sensor);
    return createVehicleSensor(type, { id: source.id, pose: source.pose }, 0, registry);
}

export function getSensorFieldValue(sensor, path) {
    return path.reduce((value, key) => value?.[key], sensor);
}

export function validateRunSensorDefinition(sensor, registry = sensorTypeRegistry) {
    const definition = registry.get(sensor?.type);
    if (!definition) return [{ path: "type", message: `Unsupported sensor type "${sensor?.type}".` }];
    return definition.run.validate?.(sensor) || [];
}

export function validateVehicleSensorDefinition(sensor, registry = sensorTypeRegistry) {
    const definition = registry.get(sensor?.type);
    if (!definition) return [{ path: "type", message: `Unsupported sensor type "${sensor?.type}".` }];
    return definition.vehicle.validate?.(sensor) || [];
}
