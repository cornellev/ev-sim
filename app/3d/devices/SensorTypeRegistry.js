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

function axisCalibration(source = {}, fallback = 0) {
    if (Array.isArray(source)) {
        return { x: finite(source[0], fallback), y: finite(source[1], fallback), z: finite(source[2], fallback) };
    }
    const obj = object(source);
    return { x: finite(obj.x, fallback), y: finite(obj.y, fallback), z: finite(obj.z, fallback) };
}

const imuRunFields = [
    { label: "Mount frame", path: ["mountFrameId"], control: "text" },
    { label: "Measurement frame", path: ["measurementFrameId"], control: "text" },
    { label: "Sync group", path: ["syncGroupId"], control: "text" },
    { label: "IMU topic ID", path: ["outputs", "imuTopicId"], control: "text" },
    { label: "Gravity (m/s²)", path: ["calibration", "gravity"], control: "number", min: 0, step: 0.001 },
    { label: "Angular velocity σ (rad/s)", path: ["calibration", "angularVelocityStdDev", "x"], control: "number", min: 0, step: 0.0001 },
    { label: "Linear acceleration σ (m/s²)", path: ["calibration", "linearAccelerationStdDev", "z"], control: "number", min: 0, step: 0.001 },
    { label: "Angular saturation (rad/s)", path: ["calibration", "angularVelocitySaturation"], control: "number", min: 0 },
    { label: "Acceleration saturation (m/s²)", path: ["calibration", "linearAccelerationSaturation"], control: "number", min: 0 },
];

const gnssRunFields = [
    { label: "Frame ID", path: ["measurementFrameId"], control: "text" },
    { label: "Sync group", path: ["syncGroupId"], control: "text" },
    { label: "GNSS topic ID", path: ["outputs", "gnssTopicId"], control: "text" },
    { label: "Datum latitude (deg)", path: ["calibration", "datum", "latitude"], control: "number" },
    { label: "Datum longitude (deg)", path: ["calibration", "datum", "longitude"], control: "number" },
    { label: "Datum altitude (m)", path: ["calibration", "datum", "altitude"], control: "number" },
    { label: "Position noise E (m)", path: ["calibration", "positionNoiseEnu", "x"], control: "number", min: 0, step: 0.001 },
    { label: "Position noise N (m)", path: ["calibration", "positionNoiseEnu", "y"], control: "number", min: 0, step: 0.001 },
    { label: "Dropout probability", path: ["calibration", "faults", "dropoutProbability"], control: "number", min: 0, max: 1, step: 0.001 },
    { label: "Outage probability", path: ["calibration", "faults", "outageProbability"], control: "number", min: 0, max: 1, step: 0.001 },
];

const wheelOdometryRunFields = [
    { label: "Odom frame", path: ["calibration", "odomFrameId"], control: "text" },
    { label: "Sync group", path: ["syncGroupId"], control: "text" },
    { label: "Odometry topic ID", path: ["outputs", "odometryTopicId"], control: "text" },
    { label: "Wheel radius (m)", path: ["calibration", "wheelRadius"], control: "number", min: 0.01, step: 0.001 },
    { label: "Ticks per revolution", path: ["calibration", "ticksPerRevolution"], control: "number", min: 1 },
    { label: "Track width (m)", path: ["calibration", "trackWidth"], control: "number", min: 0.01, step: 0.001 },
    { label: "Slip factor", path: ["calibration", "slipFactor"], control: "number", min: 0, max: 1, step: 0.001 },
    { label: "Pose noise σ (m)", path: ["calibration", "poseNoise", "x"], control: "number", min: 0, step: 0.001 },
    { label: "Twist noise σ (m/s)", path: ["calibration", "twistNoise", "x"], control: "number", min: 0, step: 0.001 },
];

const imuVehicleFields = [
    { label: "Gravity (m/s²)", path: ["config", "gravity"], control: "number", min: 0, step: 0.001 },
];

const gnssVehicleFields = [
    { label: "Datum latitude (deg)", path: ["config", "datum", "latitude"], control: "number" },
    { label: "Datum longitude (deg)", path: ["config", "datum", "longitude"], control: "number" },
];

const wheelVehicleFields = [
    { label: "Wheel radius (m)", path: ["config", "wheelRadius"], control: "number", min: 0.01, step: 0.001 },
    { label: "Track width (m)", path: ["config", "trackWidth"], control: "number", min: 0.01, step: 0.001 },
];

const cameraRunFields = [
    { label: "Mount frame", path: ["mountFrameId"], control: "text" },
    { label: "Measurement frame", path: ["measurementFrameId"], control: "text" },
    { label: "Sync group", path: ["syncGroupId"], control: "text" },
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
    { label: "Frame ID", path: ["mountFrameId"], control: "text" },
    { label: "Sync group", path: ["syncGroupId"], control: "text" },
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

registerSensorType({
    id: "imu",
    label: "IMU",
    addLabel: "Add IMU",
    idPrefix: "imu",
    accentClass: "text-violet-300",
    color: 0xa78bfa,
    run: {
        defaultRateHz: 100,
        fields: imuRunFields,
        outputs: [{ key: "imuTopicId", signal: "imu", rosType: "sensor_msgs/Imu" }],
        normalize(source) {
            const calibration = object(source.calibration);
            return {
                calibration: {
                    gravity: 9.80665,
                    angularVelocityStdDev: axisCalibration(calibration.angularVelocityStdDev, 0.002),
                    linearAccelerationStdDev: axisCalibration(calibration.linearAccelerationStdDev, 0.02),
                    angularVelocitySaturation: positive(calibration.angularVelocitySaturation, 35),
                    linearAccelerationSaturation: positive(calibration.linearAccelerationSaturation, 156),
                    angularDriftTauSec: positive(calibration.angularDriftTauSec, 100),
                    accelerationDriftTauSec: positive(calibration.accelerationDriftTauSec, 100),
                    angularRandomWalk: axisCalibration(calibration.angularRandomWalk, 0.0001),
                    accelerationRandomWalk: axisCalibration(calibration.accelerationRandomWalk, 0.001),
                    turnOnBias: {
                        angular: axisCalibration(calibration.turnOnBias?.angular, 0),
                        acceleration: axisCalibration(calibration.turnOnBias?.acceleration, 0),
                    },
                    noise: object(calibration.noise),
                    ...calibration,
                },
                schema: { imuTopicId: "sensor_msgs/Imu", ...object(source.schema) },
                determinism: { comparison: "numeric-tolerance", crossDeviceByteEquality: true },
            };
        },
        validate: () => [],
    },
    vehicle: {
        fields: imuVehicleFields,
        normalize: (source) => ({ gravity: positive(object(source.config).gravity, 9.80665) }),
        validate: () => [],
    },
});

registerSensorType({
    id: "gnss",
    label: "GNSS",
    addLabel: "Add GNSS",
    idPrefix: "gnss",
    accentClass: "text-emerald-300",
    color: 0x34d399,
    run: {
        defaultRateHz: 10,
        fields: gnssRunFields,
        outputs: [{ key: "gnssTopicId", signal: "gnss", rosType: "sensor_msgs/NavSatFix" }],
        normalize(source) {
            const calibration = object(source.calibration);
            return {
                calibration: {
                    datum: {
                        latitude: finite(calibration.datum?.latitude, 42.4430),
                        longitude: finite(calibration.datum?.longitude, -76.4840),
                        altitude: finite(calibration.datum?.altitude, 200),
                    },
                    positionNoiseEnu: axisCalibration(calibration.positionNoiseEnu, 0.05),
                    faults: {
                        dropoutProbability: Math.min(1, Math.max(0, finite(calibration.faults?.dropoutProbability, 0))),
                        outageProbability: Math.min(1, Math.max(0, finite(calibration.faults?.outageProbability, 0))),
                        multipathTauSec: positive(calibration.faults?.multipathTauSec, 30),
                        multipathStdDev: axisCalibration(calibration.faults?.multipathStdDev, 0.1),
                        ...object(calibration.faults),
                    },
                    ...calibration,
                },
                schema: { gnssTopicId: "sensor_msgs/NavSatFix", ...object(source.schema) },
                determinism: { comparison: "numeric-tolerance", crossDeviceByteEquality: true },
            };
        },
        validate: () => [],
    },
    vehicle: {
        fields: gnssVehicleFields,
        normalize(source) {
            const config = object(source.config);
            return {
                datum: {
                    latitude: finite(config.datum?.latitude, 42.4430),
                    longitude: finite(config.datum?.longitude, -76.4840),
                },
            };
        },
        validate: () => [],
    },
});

registerSensorType({
    id: "wheel-odometry",
    label: "Wheel odometry",
    addLabel: "Add wheel odometry",
    idPrefix: "wheel",
    accentClass: "text-orange-300",
    color: 0xfb923c,
    run: {
        defaultRateHz: 50,
        fields: wheelOdometryRunFields,
        outputs: [{ key: "odometryTopicId", signal: "odometry", rosType: "nav_msgs/Odometry" }],
        normalize(source) {
            const calibration = object(source.calibration);
            return {
                calibration: {
                    odomFrameId: text(calibration.odomFrameId, "odom"),
                    childFrameId: text(calibration.childFrameId, "base_link"),
                    wheelRadius: positive(calibration.wheelRadius, 0.15),
                    ticksPerRevolution: positiveInteger(calibration.ticksPerRevolution, 1024),
                    trackWidth: positive(calibration.trackWidth, 1.2),
                    slipFactor: Math.min(1, Math.max(0, finite(calibration.slipFactor, 0))),
                    poseNoise: axisCalibration(calibration.poseNoise, 0.01),
                    twistNoise: axisCalibration(calibration.twistNoise, 0.02),
                    ...calibration,
                },
                schema: { odometryTopicId: "nav_msgs/Odometry", ...object(source.schema) },
                determinism: { comparison: "numeric-tolerance", crossDeviceByteEquality: true },
            };
        },
        validate: (sensor) => (sensor.calibration.wheelRadius > 0 ? [] : [{ path: "calibration.wheelRadius", message: "Wheel radius must be positive." }]),
    },
    vehicle: {
        fields: wheelVehicleFields,
        normalize(source) {
            const config = object(source.config);
            return {
                wheelRadius: positive(config.wheelRadius, 0.15),
                trackWidth: positive(config.trackWidth, 1.2),
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
    const isCamera = type === "camera";
    const defaultMount = isCamera
        ? `${id.replace(/-camera$/, "")}_camera_link`.replace(/^([^-]+)$/, "$1_camera_link")
        : text(source.frameId, `${id}_frame`);
    const defaultMeasurement = isCamera
        ? text(source.frameId, `${defaultMount.replace(/_link$/, "")}_optical_frame`)
        : defaultMount;
    return {
        id,
        type,
        enabled: source.enabled !== false,
        parentId: text(source.parentId, "ego"),
        frameId: text(source.frameId, defaultMeasurement),
        mountFrameId: text(source.mountFrameId, defaultMount),
        measurementFrameId: text(source.measurementFrameId, defaultMeasurement),
        syncGroupId: text(source.syncGroupId) || null,
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
