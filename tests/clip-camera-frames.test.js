import assert from "node:assert/strict";
import test from "node:test";

import { buildCalibrationBundle } from "../app/autonomy/CalibrationBundle.js";
import {
    quaternionToEuler,
    rep103MountToThreeCameraPose,
    rep103PoseRelativeTo,
    threeCameraPoseToRep103Mount,
    threePoseToRep103,
} from "../app/autonomy/CoordinateFrames.js";
import { snapshotViewportClipCamera } from "../app/3d/camera/ClipCameraSnapshot.js";
import { analyticGpuCameraPose } from "../app/simulation/sensors/AnalyticGpuCameraPose.js";
import { createRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { snapshotRep103CameraPose } from "../app/3d/environment/visual/VisualCapturePipeline.js";
import { TransformRuntime, validateSensorRigFrames } from "../app/simulation/TransformRuntime.js";

function nearly(actual, expected, epsilon = 1e-6) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not near ${expected}`);
}

test("viewport mount conversion round-trips the optical look", () => {
    const mount = {
        position: { x: 2, y: -0.4, z: 1.25 },
        rotation: { x: 0.1, y: 0.2, z: -0.3, order: "XYZ" },
    };
    const camera = rep103MountToThreeCameraPose(mount);
    const recovered = threeCameraPoseToRep103Mount(camera);
    nearly(recovered.position.x, mount.position.x);
    nearly(recovered.position.y, mount.position.y);
    nearly(recovered.position.z, mount.position.z);
    nearly(recovered.rotation.x, mount.rotation.x);
    nearly(recovered.rotation.y, mount.rotation.y);
    nearly(recovered.rotation.z, mount.rotation.z);
});

test("map and vehicle cameras share browser and analytic poses without changing vehicle calibration", () => {
    const vehicleManifest = createDefaultRunManifest();
    const vehicleCalibration = buildCalibrationBundle(vehicleManifest);
    const mapManifest = structuredClone(vehicleManifest);
    mapManifest.sensorRig.sensors = mapManifest.sensorRig.sensors.map((sensor) => (
        sensor.id === "front-camera"
            ? createRunSensor("camera", { ...sensor, poseReference: "map", parentId: undefined })
            : sensor
    ));
    assert.equal(validateSensorRigFrames(mapManifest).length, 0);
    assert.equal(validateSensorRigFrames(vehicleManifest).length, 0);
    const mapCalibration = buildCalibrationBundle(mapManifest);
    const vehicleCamera = vehicleCalibration.sensors.find((sensor) => sensor.id === "front-camera");
    const mapCamera = mapCalibration.sensors.find((sensor) => sensor.id === "front-camera");
    assert.equal(vehicleCamera.poseReference, undefined);
    assert.equal(mapCamera.poseReference, "map");
    assert.equal(mapCalibration.staticTransforms.some((entry) => entry.childFrameId === mapCamera.mountFrameId && entry.parentFrameId === "map"), true);
    assert.notEqual(mapCalibration.hash, vehicleCalibration.hash);

    const repeated = buildCalibrationBundle(createDefaultRunManifest());
    assert.equal(repeated.hash, vehicleCalibration.hash);

    const vehicle = { id: "ego", telemetryId: "ego", position: { x: 4, y: 1, z: -2 }, rotation: { x: 0, y: 0.3, z: 0, order: "XYZ" } };
    const runtime = new TransformRuntime(vehicleCalibration, null);
    const mapRuntime = new TransformRuntime(mapCalibration, null);
    const vehicleFrames = runtime.resolveCaptureFrames(vehicleManifest.sensorRig.sensors.find((sensor) => sensor.id === "front-camera"), [vehicle], 0);
    const mapFrames = mapRuntime.resolveCaptureFrames(mapManifest.sensorRig.sensors.find((sensor) => sensor.id === "front-camera"), [vehicle], 0);
    assert.equal(vehicleFrames.ok, true);
    assert.equal(mapFrames.ok, true);
    assert.deepEqual(mapFrames.mapPose.position, { x: 0, y: 0, z: 0 });
    const browserVehicle = snapshotRep103CameraPose({ captureTimeNs: 0, worldPose: vehicleFrames.mapPose, mountPose: vehicleCamera.pose });
    const browserMap = snapshotRep103CameraPose({ captureTimeNs: 0, worldPose: mapFrames.mapPose, mountPose: mapCamera.pose });
    const analyticVehicle = analyticGpuCameraPose({ sensor: vehicleManifest.sensorRig.sensors.find((sensor) => sensor.id === "front-camera"), vehicles: [vehicle] });
    const analyticMap = analyticGpuCameraPose({ sensor: mapManifest.sensorRig.sensors.find((sensor) => sensor.id === "front-camera"), vehicles: [vehicle] });
    nearly(browserVehicle.position.x, analyticVehicle.origin[0], 1e-5);
    nearly(browserVehicle.position.y, analyticVehicle.origin[1], 1e-5);
    nearly(browserVehicle.position.z, analyticVehicle.origin[2], 1e-5);
    nearly(browserMap.position.x, analyticMap.origin[0], 1e-5);
    nearly(browserMap.position.y, analyticMap.origin[1], 1e-5);
    nearly(browserMap.position.z, analyticMap.origin[2], 1e-5);
    assert.notDeepEqual(analyticMap.origin, analyticVehicle.origin);
});

test("viewport snapshots keep a fixed world mount and a vehicle-relative mount", () => {
    const cameraPose = rep103MountToThreeCameraPose({
        position: { x: 3, y: 1, z: 2 },
        rotation: { x: 0, y: 0.4, z: 0, order: "XYZ" },
    });
    const vehicleThree = { position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } };
    const session = {
        data: {
            camera: {
                position: cameraPose.position,
                quaternion: cameraPose.rotation,
                fov: 75,
                near: 0.1,
                far: 1000,
            },
            environment: () => ({ environmentId: "duffy-test-env" }),
            vehicles: () => ({ vehicles: [{ telemetryId: "ego", position: vehicleThree.position, rotation: vehicleThree.rotation }] }),
        },
    };
    const fixed = snapshotViewportClipCamera(session, { attachment: "map" });
    assert.equal(fixed.attachment, "map");
    assert.equal(fixed.environmentId, "duffy-test-env");
    nearly(fixed.mountPose.position.x, 3);
    nearly(fixed.mountPose.position.y, 1);
    nearly(fixed.mountPose.position.z, 2);
    const follow = snapshotViewportClipCamera(session, { attachment: "vehicle", parentId: "ego" });
    const relative = rep103PoseRelativeTo(threePoseToRep103(vehicleThree), {
        position: fixed.mountPose.position,
        rotation: fixed.mountPose.rotation,
    });
    const relativeEuler = quaternionToEuler(relative.rotation);
    nearly(follow.mountPose.position.x, relative.position.x);
    nearly(follow.mountPose.position.y, relative.position.y);
    nearly(follow.mountPose.position.z, relative.position.z);
    nearly(follow.mountPose.rotation.x, relativeEuler.x);
    nearly(follow.mountPose.rotation.y, relativeEuler.y);
    nearly(follow.mountPose.rotation.z, relativeEuler.z);
});
