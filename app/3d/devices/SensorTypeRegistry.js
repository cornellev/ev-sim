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
    { label: "Gravity (m/s²)", path: ["calibration", "gravity"], control: "number", min: 0, step: 0.001 },
    { label: "IMU topic ID", path: ["outputs", "imuTopicId"], control: "text", advanced: true },
    { label: "Angular velocity σ (rad/s)", path: ["calibration", "angularVelocityStdDev", "x"], control: "number", min: 0, step: 0.0001, advanced: true },
    { label: "Linear acceleration σ (m/s²)", path: ["calibration", "linearAccelerationStdDev", "z"], control: "number", min: 0, step: 0.001, advanced: true },
    { label: "Angular saturation (rad/s)", path: ["calibration", "angularVelocitySaturation"], control: "number", min: 0, advanced: true },
    { label: "Acceleration saturation (m/s²)", path: ["calibration", "linearAccelerationSaturation"], control: "number", min: 0, advanced: true },
];

const gnssRunFields = [
    { label: "Datum latitude (deg)", path: ["calibration", "datum", "latitude"], control: "number" },
    { label: "Datum longitude (deg)", path: ["calibration", "datum", "longitude"], control: "number" },
    { label: "GNSS topic ID", path: ["outputs", "gnssTopicId"], control: "text", advanced: true },
    { label: "Datum altitude (m)", path: ["calibration", "datum", "altitude"], control: "number", advanced: true },
    { label: "Position noise E (m)", path: ["calibration", "positionNoiseEnu", "x"], control: "number", min: 0, step: 0.001, advanced: true },
    { label: "Position noise N (m)", path: ["calibration", "positionNoiseEnu", "y"], control: "number", min: 0, step: 0.001, advanced: true },
    { label: "Dropout probability", path: ["calibration", "faults", "dropoutProbability"], control: "number", min: 0, max: 1, step: 0.001, advanced: true },
    { label: "Outage probability", path: ["calibration", "faults", "outageProbability"], control: "number", min: 0, max: 1, step: 0.001, advanced: true },
];

const wheelOdometryRunFields = [
    { label: "Wheel radius (m)", path: ["calibration", "wheelRadius"], control: "number", min: 0.01, step: 0.001 },
    { label: "Track width (m)", path: ["calibration", "trackWidth"], control: "number", min: 0.01, step: 0.001 },
    { label: "Odom frame", path: ["calibration", "odomFrameId"], control: "text", advanced: true },
    { label: "Odometry topic ID", path: ["outputs", "odometryTopicId"], control: "text", advanced: true },
    { label: "Ticks per revolution", path: ["calibration", "ticksPerRevolution"], control: "number", min: 1, advanced: true },
    { label: "Slip factor", path: ["calibration", "slipFactor"], control: "number", min: 0, max: 1, step: 0.001, advanced: true },
    { label: "Pose noise σ (m)", path: ["calibration", "poseNoise", "x"], control: "number", min: 0, step: 0.001, advanced: true },
    { label: "Twist noise σ (m/s)", path: ["calibration", "twistNoise", "x"], control: "number", min: 0, step: 0.001, advanced: true },
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
    { label: "Width", path: ["calibration", "width"], control: "number", min: 1 },
    { label: "Height", path: ["calibration", "height"], control: "number", min: 1 },
    { label: "Vertical FOV (deg)", path: ["calibration", "verticalFovDeg"], control: "number", min: 1, max: 179 },
    { label: "fx", path: ["calibration", "intrinsics", "fx"], control: "number", min: 0.01, advanced: true },
    { label: "fy", path: ["calibration", "intrinsics", "fy"], control: "number", min: 0.01, advanced: true },
    { label: "cx", path: ["calibration", "intrinsics", "cx"], control: "number", advanced: true },
    { label: "cy", path: ["calibration", "intrinsics", "cy"], control: "number", advanced: true },
    { label: "Distortion model", path: ["calibration", "distortionModel"], control: "text", advanced: true },
    { label: "Image topic ID", path: ["outputs", "imageTopicId"], control: "text", advanced: true },
    { label: "Image ROS schema", path: ["schema", "imageTopicId"], control: "text", advanced: true },
    { label: "CameraInfo topic ID", path: ["outputs", "cameraInfoTopicId"], control: "text", advanced: true },
    { label: "CameraInfo ROS schema", path: ["schema", "cameraInfoTopicId"], control: "text", advanced: true },
    { label: "Depth topic ID", path: ["outputs", "depthTopicId"], control: "text", advanced: true },
    { label: "Semantic topic ID", path: ["outputs", "semanticTopicId"], control: "text", advanced: true },
    { label: "Instance topic ID", path: ["outputs", "instanceTopicId"], control: "text", advanced: true },
    { label: "Detections 2D topic ID", path: ["outputs", "detections2dTopicId"], control: "text", advanced: true },
    { label: "Detections 3D topic ID", path: ["outputs", "detections3dTopicId"], control: "text", advanced: true },
    { label: "Lanes topic ID", path: ["outputs", "lanesTopicId"], control: "text", advanced: true },
    { label: "Traffic controls topic ID", path: ["outputs", "trafficControlsTopicId"], control: "text", advanced: true },
    { label: "Diagnostics topic ID", path: ["outputs", "diagnosticsTopicId"], control: "text", advanced: true },
    { label: "Encoding", path: ["calibration", "encoding"], control: "text", readOnly: true, advanced: true },
    { label: "Frame dropout probability", path: ["noise", "dropoutProbability"], control: "number", min: 0, max: 1, step: 0.001, advanced: true },
    { label: "Deadline (ns)", path: ["health", "deadlineNs"], control: "number", min: 0, advanced: true },
];

const lidarRunFields = [
    { label: "Range (m)", path: ["calibration", "range"], control: "number", min: 0.01 },
    { label: "PointCloud topic ID", path: ["outputs", "pointCloudTopicId"], control: "text", advanced: true },
    { label: "PointCloud ROS schema", path: ["schema", "pointCloudTopicId"], control: "text", advanced: true },
    { label: "Semantic PointCloud topic ID", path: ["outputs", "semanticPointCloudTopicId"], control: "text", advanced: true },
    { label: "Diagnostics topic ID", path: ["outputs", "diagnosticsTopicId"], control: "text", advanced: true },
    { label: "Azimuth step (deg)", path: ["calibration", "azimuth", "stepDeg"], control: "number", min: 0.01, advanced: true },
    { label: "Elevation step (deg)", path: ["calibration", "elevation", "stepDeg"], control: "number", min: 0.01, advanced: true },
    { label: "Frame dropout probability", path: ["noise", "dropoutProbability"], control: "number", min: 0, max: 1, step: 0.001, advanced: true },
    { label: "Point dropout probability", path: ["noise", "pointDropoutProbability"], control: "number", min: 0, max: 1, step: 0.001, advanced: true },
    { label: "Deadline (ns)", path: ["health", "deadlineNs"], control: "number", min: 0, advanced: true },
];

const cameraVehicleFields = [
    { label: "Vertical FOV (deg)", path: ["config", "fov"], control: "number", min: 1, max: 179 },
    { label: "Width (px)", path: ["config", "width"], control: "number", min: 1 },
    { label: "Height (px)", path: ["config", "height"], control: "number", min: 1 },
    { label: "Range (m)", path: ["config", "range"], control: "number", min: 0.1, step: 0.1, advanced: true },
    { label: "Theta step (deg)", path: ["config", "thetaStep"], control: "number", min: 0.01, step: 0.01, advanced: true },
    { label: "Phi step (deg)", path: ["config", "phiStep"], control: "number", min: 0.01, step: 0.01, advanced: true },
];

const lidarVehicleFields = [
    { label: "Range (m)", path: ["config", "range"], control: "number", min: 0.1, step: 0.1 },
    { label: "Theta step (deg)", path: ["config", "thetaStep"], control: "number", min: 0.01, step: 0.01, advanced: true },
    { label: "Theta start (deg)", path: ["config", "thetaRange", 0], control: "number", advanced: true },
    { label: "Theta end (deg)", path: ["config", "thetaRange", 1], control: "number", advanced: true },
    { label: "Phi step (deg)", path: ["config", "phiStep"], control: "number", min: 0.01, step: 0.01, advanced: true },
    { label: "Phi start (deg)", path: ["config", "phiRange", 0], control: "number", advanced: true },
    { label: "Phi end (deg)", path: ["config", "phiRange", 1], control: "number", advanced: true },
];

export const ORACLE_PRODUCT_TOGGLES = Object.freeze({
    camera: Object.freeze([
        { product: "depth", label: "Depth", outputKey: "depthTopicId", contractId: "front-camera-depth" },
        { product: "semantic", label: "Semantic", outputKey: "semanticTopicId", contractId: "front-camera-semantic" },
        { product: "instance", label: "Instance", outputKey: "instanceTopicId", contractId: "front-camera-instance" },
        { product: "detections2d", label: "2D detections", outputKey: "detections2dTopicId", contractId: "oracle-detections-2d" },
        { product: "detections3d", label: "3D detections", outputKey: "detections3dTopicId", contractId: "oracle-detections-3d" },
        { product: "lanes", label: "Lanes", outputKey: "lanesTopicId", contractId: "oracle-lanes" },
        { product: "trafficControls", label: "Traffic controls", outputKey: "trafficControlsTopicId", contractId: "oracle-traffic-controls" },
    ]),
    lidar3d: Object.freeze([
        { product: "semanticPointCloud", label: "Semantic point cloud", outputKey: "semanticPointCloudTopicId", contractId: "front-lidar-semantic" },
    ]),
});

export function applySensorOracleProduct(sensor, productKey, enabled) {
    const toggle = (ORACLE_PRODUCT_TOGGLES[sensor?.type] || []).find((entry) => entry.product === productKey);
    if (!toggle) return sensor;
    const outputs = { ...object(sensor.outputs) };
    if (enabled && !outputs[toggle.outputKey]) outputs[toggle.outputKey] = toggle.contractId;
    return {
        ...sensor,
        calibration: {
            ...object(sensor.calibration),
            products: {
                ...object(sensor.calibration?.products),
                [productKey]: enabled === true,
            },
        },
        outputs,
    };
}

function normalizeDistortion(value) {
    if (!Array.isArray(value) || value.length === 0) return [0, 0, 0, 0, 0];
    const coeffs = value.map((entry) => finite(entry, 0)).slice(0, 8);
    while (coeffs.length < 5) coeffs.push(0);
    return coeffs;
}

function cameraIntrinsics(calibration, width, height, verticalFovDeg) {
    const source = object(calibration.intrinsics);
    const fyDefault = height / (2 * Math.tan((Number(verticalFovDeg) || 75) * Math.PI / 360));
    return {
        fx: positive(source.fx, fyDefault),
        fy: positive(source.fy, fyDefault),
        cx: finite(source.cx, (width - 1) / 2),
        cy: finite(source.cy, (height - 1) / 2),
    };
}

function validateCameraCalibration(sensor) {
    const issues = [];
    const calibration = object(sensor.calibration);
    const width = Math.floor(finite(calibration.width, 0));
    const height = Math.floor(finite(calibration.height, 0));
    if (width < 1) issues.push({ path: "calibration.width", message: "Camera width must be a positive integer." });
    if (height < 1) issues.push({ path: "calibration.height", message: "Camera height must be a positive integer." });
    const fov = finite(calibration.verticalFovDeg, 0);
    if (!(fov > 0 && fov < 180)) issues.push({ path: "calibration.verticalFovDeg", message: "Vertical FOV must be in (0, 180)." });
    const distortion = calibration.distortion;
    if (Array.isArray(distortion) && (distortion.length < 4 || distortion.length > 8)) {
        issues.push({ path: "calibration.distortion", message: "plumb_bob distortion requires 4–8 coefficients." });
    }
    if (calibration.distortionModel && calibration.distortionModel !== "plumb_bob") {
        issues.push({ path: "calibration.distortionModel", message: "Only plumb_bob distortion is supported." });
    }
    const outputs = object(sensor.outputs);
    const oracleKeys = ["depthTopicId", "semanticTopicId", "instanceTopicId", "detections2dTopicId", "detections3dTopicId", "lanesTopicId", "trafficControlsTopicId"];
    for (const key of oracleKeys) {
        if (outputs[key] && sensor.schema?.[key] && !String(sensor.schema[key]).startsWith("sensor_msgs/") && !String(sensor.schema[key]).startsWith("vision_msgs/") && !String(sensor.schema[key]).startsWith("sensor_fusion_msgs/") && !String(sensor.schema[key]).startsWith("diagnostic_msgs/")) {
            issues.push({ path: `schema.${key}`, message: `Unsupported schema for oracle camera product "${key}".` });
        }
    }
    return issues;
}

function validateLidarCalibration(sensor) {
    const issues = [];
    const calibration = object(sensor.calibration);
    if (!(finite(calibration.range, 0) > 0)) issues.push({ path: "calibration.range", message: "LiDAR range must be positive." });
    for (const axis of ["azimuth", "elevation"]) {
        const scan = object(calibration[axis]);
        const start = finite(scan.startDeg, NaN);
        const end = finite(scan.endDeg, NaN);
        const step = finite(scan.stepDeg, NaN);
        if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
            issues.push({ path: `calibration.${axis}`, message: `${axis} bounds must satisfy endDeg > startDeg.` });
        }
        if (!(step > 0)) issues.push({ path: `calibration.${axis}.stepDeg`, message: `${axis} stepDeg must be positive.` });
    }
    return issues;
}

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
            { key: "imageTopicId", signal: "image", rosType: "sensor_msgs/Image", measured: true },
            { key: "cameraInfoTopicId", signal: "cameraInfo", rosType: "sensor_msgs/CameraInfo", measured: true },
            { key: "depthTopicId", signal: "depth", rosType: "sensor_msgs/Image", oracle: true },
            { key: "semanticTopicId", signal: "semantic", rosType: "sensor_msgs/Image", oracle: true },
            { key: "instanceTopicId", signal: "instance", rosType: "sensor_msgs/Image", oracle: true },
            { key: "detections2dTopicId", signal: "detections2d", rosType: "vision_msgs/Detection2DArray", oracle: true },
            { key: "detections3dTopicId", signal: "detections3d", rosType: "vision_msgs/Detection3DArray", oracle: true },
            { key: "lanesTopicId", signal: "lanes", rosType: "sensor_fusion_msgs/StampedLanes", oracle: true },
            { key: "trafficControlsTopicId", signal: "trafficControls", rosType: "sensor_fusion_msgs/TrafficControlStates", oracle: true },
            { key: "diagnosticsTopicId", signal: "diagnostics", rosType: "diagnostic_msgs/DiagnosticArray", measured: true },
        ],
        normalize(source) {
            const calibrationSource = object(source.calibration);
            const width = Math.max(1, Math.floor(positive(calibrationSource.width, 320)));
            const height = Math.max(1, Math.floor(positive(calibrationSource.height, 180)));
            const verticalFovDeg = Math.min(179, positive(calibrationSource.verticalFovDeg, 75));
            const products = object(calibrationSource.products);
            return {
                calibration: {
                    width,
                    height,
                    encoding: "rgba8",
                    verticalFovDeg,
                    near: positive(calibrationSource.near, 0.1),
                    far: positive(calibrationSource.far, 200),
                    distortionModel: text(calibrationSource.distortionModel, "plumb_bob"),
                    distortion: normalizeDistortion(calibrationSource.distortion),
                    intrinsics: cameraIntrinsics(calibrationSource, width, height, verticalFovDeg),
                    products: {
                        rgb: products.rgb !== false,
                        cameraInfo: products.cameraInfo !== false,
                        depth: products.depth === true,
                        semantic: products.semantic === true,
                        instance: products.instance === true,
                        detections2d: products.detections2d === true,
                        detections3d: products.detections3d === true,
                        lanes: products.lanes === true,
                        trafficControls: products.trafficControls === true,
                        diagnostics: products.diagnostics !== false,
                    },
                    labelCatalogVersion: positiveInteger(calibrationSource.labelCatalogVersion, 1),
                },
                schema: {
                    imageTopicId: "sensor_msgs/Image",
                    cameraInfoTopicId: "sensor_msgs/CameraInfo",
                    depthTopicId: "sensor_msgs/Image",
                    semanticTopicId: "sensor_msgs/Image",
                    instanceTopicId: "sensor_msgs/Image",
                    detections2dTopicId: "vision_msgs/Detection2DArray",
                    detections3dTopicId: "vision_msgs/Detection3DArray",
                    lanesTopicId: "sensor_fusion_msgs/StampedLanes",
                    trafficControlsTopicId: "sensor_fusion_msgs/TrafficControlStates",
                    diagnosticsTopicId: "diagnostic_msgs/DiagnosticArray",
                    ...object(source.schema),
                },
                health: {
                    deadlineNs: nonNegativeInteger(source.health?.deadlineNs, Math.round(1e9 / 30)),
                    observationalOracle: source.health?.observationalOracle !== false,
                },
                determinism: { comparison: "semantic-tolerance", crossDeviceByteEquality: false },
            };
        },
        validate: validateCameraCalibration,
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
            { key: "pointCloudTopicId", signal: "pointCloud", rosType: "sensor_msgs/PointCloud2", measured: true },
            { key: "semanticPointCloudTopicId", signal: "semanticPointCloud", rosType: "sensor_msgs/PointCloud2", oracle: true },
            { key: "diagnosticsTopicId", signal: "diagnostics", rosType: "diagnostic_msgs/DiagnosticArray", measured: true },
        ],
        normalize(source) {
            const calibrationSource = object(source.calibration);
            const products = object(calibrationSource.products);
            return {
                calibration: {
                    range: positive(calibrationSource.range, 20),
                    azimuth: {
                        startDeg: finite(calibrationSource.azimuth?.startDeg, -180),
                        endDeg: finite(calibrationSource.azimuth?.endDeg, 180),
                        stepDeg: positive(calibrationSource.azimuth?.stepDeg, 2),
                    },
                    elevation: {
                        startDeg: finite(calibrationSource.elevation?.startDeg, -20),
                        endDeg: finite(calibrationSource.elevation?.endDeg, 20),
                        stepDeg: positive(calibrationSource.elevation?.stepDeg, 1),
                    },
                    products: {
                        pointCloud: products.pointCloud !== false,
                        semanticPointCloud: products.semanticPointCloud === true,
                        diagnostics: products.diagnostics !== false,
                    },
                    labelCatalogVersion: positiveInteger(calibrationSource.labelCatalogVersion, 1),
                },
                schema: {
                    pointCloudTopicId: "sensor_msgs/PointCloud2",
                    semanticPointCloudTopicId: "sensor_msgs/PointCloud2",
                    diagnosticsTopicId: "diagnostic_msgs/DiagnosticArray",
                    ...object(source.schema),
                },
                health: {
                    deadlineNs: nonNegativeInteger(source.health?.deadlineNs, Math.round(1e9 / 10)),
                    observationalOracle: source.health?.observationalOracle !== false,
                },
                determinism: { comparison: "numeric-tolerance", crossDeviceByteEquality: true },
            };
        },
        validate: validateLidarCalibration,
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
            pointDropoutProbability: Math.min(1, Math.max(0, finite(source.noise?.pointDropoutProbability, 0))),
        },
        outputs: cloneObject(source.outputs),
        schema: specific.schema,
        health: specific.health || {
            deadlineNs: nonNegativeInteger(source.health?.deadlineNs, Math.round(1e9 / Math.max(0.001, finite(source.rateHz, definition?.run.defaultRateHz ?? 10)))),
            observationalOracle: source.health?.observationalOracle !== false,
        },
        determinism: specific.determinism,
        maxQueueFrames: positiveInteger(source.maxQueueFrames, 8),
        maxQueueBytes: positiveInteger(source.maxQueueBytes, 64 * 1024 * 1024),
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
