import assert from "node:assert/strict";
import test from "node:test";

import {
    SensorTypeRegistry,
    changeRunSensorType,
    getSensorType,
    listSensorTypes,
    normalizeRunSensor,
    normalizeVehicleSensor,
    ORACLE_PRODUCT_TOGGLES,
    validateRunSensorDefinition,
} from "../app/3d/devices/SensorTypeRegistry.js";
import { SensorRuntimeFactoryRegistry } from "../app/3d/devices/SensorRuntimeFactoryRegistry.js";
import { getDeviceTelemetrySignals } from "../app/3d/data/DeviceTelemetrySignals.js";
import { normalizeRunManifest, validateRunManifest } from "../app/simulation/RunManifest.js";
import { normalizeVehicleManifest, validateVehicleManifest } from "../app/vehicles/VehicleManifest.js";

test("built-in sensor definitions own defaults, fields, outputs, and determinism metadata", () => {
    assert.deepEqual(listSensorTypes().map((definition) => definition.id), ["camera", "lidar3d", "imu", "gnss", "wheel-odometry"]);

    const camera = normalizeRunSensor({ type: "camera" });
    assert.equal(camera.rateHz, 30);
    assert.equal(camera.calibration.encoding, "rgba8");
    assert.equal(camera.schema.imageTopicId, "sensor_msgs/Image");
    assert.equal(camera.schema.cameraInfoTopicId, "sensor_msgs/CameraInfo");
    assert.equal(camera.schema.depthTopicId, "sensor_msgs/Image");
    assert.equal(camera.calibration.products.depth, false);
    assert.equal(camera.calibration.distortionModel, "plumb_bob");
    assert.equal(camera.calibration.distortion.length, 5);
    assert.ok(camera.calibration.intrinsics.fx > 0);
    assert.equal(camera.determinism.comparison, "semantic-tolerance");
    assert.deepEqual(
        getSensorType("camera").run.outputs.map((output) => output.signal),
        ["image", "cameraInfo", "depth", "semantic", "instance", "detections2d", "detections3d", "lanes", "trafficControls", "diagnostics"],
    );
    assert.ok(getSensorType("camera").run.fields.some((field) => field.path.join(".") === "calibration.width"));

    const cameraFields = getSensorType("camera").run.fields;
    const lidarFields = getSensorType("lidar3d").run.fields;
    const imuFields = getSensorType("imu").run.fields;
    const gnssFields = getSensorType("gnss").run.fields;

    assert.ok(cameraFields.some((field) => field.path.join(".") === "calibration.verticalFovDeg" && !field.advanced));
    assert.ok(lidarFields.some((field) => field.path.join(".") === "calibration.range" && !field.advanced));
    assert.ok(lidarFields.some((field) => field.path.join(".") === "noise.pointDropoutProbability"));
    assert.ok(imuFields.some((field) => field.path.join(".") === "calibration.gravity" && !field.advanced));
    assert.ok(imuFields.some((field) => field.path.join(".") === "outputs.imuTopicId" && field.advanced));
    assert.ok(gnssFields.some((field) => field.path.join(".") === "calibration.datum.latitude" && !field.advanced));
    assert.ok(gnssFields.every((field) => !field.path.join(".").includes("mountFrameId")));
    assert.ok(gnssFields.every((field) => !field.path.join(".").includes("measurementFrameId")));
    assert.ok(gnssFields.every((field) => !field.path.join(".").includes("syncGroupId")));
    assert.ok(ORACLE_PRODUCT_TOGGLES.camera.some((entry) => entry.product === "depth" && entry.contractId === "front-camera-depth"));
    assert.ok(ORACLE_PRODUCT_TOGGLES.lidar3d.some((entry) => entry.product === "semanticPointCloud"));

    const lidar = normalizeRunSensor({ type: "lidar3d" });
    assert.equal(lidar.calibration.products.semanticPointCloud, false);
    assert.deepEqual(
        getSensorType("lidar3d").run.outputs.map((output) => output.signal),
        ["pointCloud", "semanticPointCloud", "diagnostics"],
    );

    const vehicleLidar = normalizeVehicleSensor({ type: "lidar3d" });
    assert.deepEqual(vehicleLidar.config.thetaRange, [-180, 180]);
    assert.ok(getSensorType("lidar3d").vehicle.fields.some((field) => field.path.join(".") === "config.phiRange.1"));
});

test("an isolated third sensor type drives normalization and runtime factories without consumer branches", () => {
    const definitions = new SensorTypeRegistry();
    definitions.register({
        id: "radar",
        label: "Radar",
        idPrefix: "radar",
        run: {
            defaultRateHz: 20,
            fields: [{ label: "Range", path: ["calibration", "range"], control: "number" }],
            outputs: [{ key: "detectionsTopicId", signal: "detections", rosType: "example_msgs/Detections" }],
            normalize: (source) => ({
                calibration: { range: Number(source.calibration?.range ?? 100) },
                schema: { detectionsTopicId: "example_msgs/Detections" },
                determinism: { comparison: "numeric-tolerance", crossDeviceByteEquality: true },
            }),
            validate: (sensor) => sensor.calibration.range > 0 ? [] : [{ path: "calibration.range", message: "Range must be positive." }],
        },
        vehicle: {
            fields: [{ label: "Range", path: ["config", "range"], control: "number" }],
            normalize: (source) => ({ range: Number(source.config?.range ?? 100) }),
            validate: () => [],
        },
    });

    const runSensor = normalizeRunSensor({ type: "radar", calibration: { range: 75 } }, 0, definitions);
    const vehicleSensor = normalizeVehicleSensor({ type: "radar", config: { range: 80 } }, 0, definitions);
    assert.equal(runSensor.rateHz, 20);
    assert.equal(runSensor.calibration.range, 75);
    assert.equal(vehicleSensor.config.range, 80);
    assert.deepEqual(validateRunSensorDefinition(runSensor, definitions), []);

    const runtimes = new SensorRuntimeFactoryRegistry({ definitions });
    runtimes.register("radar", {
        createRunDevice: (config) => ({ source: "run", config }),
        createVehicleDevice: (entry) => ({ source: "vehicle", entry }),
        createPreview: () => ({ source: "preview" }),
        previewSignature: (sensor) => `${sensor.type}:${sensor.config.range}`,
    });
    assert.equal(runtimes.createRunDevice(runSensor).source, "run");
    assert.equal(runtimes.createVehicleDevice(vehicleSensor).source, "vehicle");
    assert.equal(runtimes.createPreview(vehicleSensor).source, "preview");
    assert.equal(runtimes.previewSignature(vehicleSensor), "radar:80");

    const signals = getDeviceTelemetrySignals({
        constructor: { name: "RadarDevice" },
        config: { type: "radar", schema: { detectionsTopicId: "custom/Detections" } },
    }, definitions);
    assert.deepEqual(signals.map((signal) => signal.suffix), [
        "enabled",
        "pose",
        "output",
        "captureAttempts",
        "capturedFrames",
        "deliveredFrames",
        "droppedFrames",
        "pointDrops",
        "missedDeadlines",
        "shaderBusyDrops",
        "queueDepth",
        "queueHighWaterMark",
        "captureTimeNs",
        "captureTimeTotalNs",
        "encodeTimeNs",
        "encodeTimeTotalNs",
        "transportTimeNs",
        "transportTimeTotalNs",
        "errors",
        "detections",
    ]);
    assert.equal(signals.at(-1).metadata.rosType, "custom/Detections");
});

test("changing sensor type resets type-specific state while preserving common run settings", () => {
    const camera = normalizeRunSensor({
        id: "front",
        type: "camera",
        parentId: "ego-2",
        frameId: "front_frame",
        rateHz: 12,
        phaseNs: 4,
        outputs: { imageTopicId: "image" },
        calibration: { width: 800 },
    });
    const lidar = changeRunSensorType(camera, "lidar3d");
    assert.equal(lidar.id, "front");
    assert.equal(lidar.parentId, "ego-2");
    assert.equal(lidar.rateHz, 12);
    assert.equal(lidar.phaseNs, 4);
    assert.equal(lidar.calibration.range, 20);
    assert.equal("width" in lidar.calibration, false);
    assert.deepEqual(lidar.outputs, {});
});

test("unknown sensor types survive normalization and fail validation explicitly", () => {
    const run = normalizeRunManifest({
        sensorRig: { sensors: [{ id: "future", type: "future-sensor", calibration: { custom: 1 }, outputs: {} }] },
    });
    assert.equal(run.sensorRig.sensors[0].type, "future-sensor");
    assert.equal(run.sensorRig.sensors[0].calibration.custom, 1);
    assert.match(validateRunManifest(run).issues.map((issue) => issue.message).join(" "), /Unsupported sensor type/);

    const vehicle = normalizeVehicleManifest({ sensors: [{ id: "future", type: "future-sensor", config: { custom: 2 } }] });
    assert.equal(vehicle.sensors[0].type, "future-sensor");
    assert.equal(vehicle.sensors[0].config.custom, 2);
    assert.match(validateVehicleManifest(vehicle).issues.map((issue) => issue.message).join(" "), /Unsupported sensor type/);
});
