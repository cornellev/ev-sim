import assert from "node:assert/strict";
import test from "node:test";

import {
    composeRep103Poses,
    eulerToQuaternion,
    lidarDirectionRep103,
    lidarShaderDirectionToRep103,
    quaternionInverse,
    quaternionMultiply,
    quaternionToEuler,
    cameraLinkToOpticalRotation,
    rep103PoseToThree,
    rep103ToThreeVector,
    rotateVectorByQuaternion,
    simulationStamp,
    stampToTimeNs,
    threeCameraLookAlongMountForwardRotation,
    threePoseToRep103,
    threeToRep103Vector,
} from "../app/autonomy/CoordinateFrames.js";
import { buildCalibrationBundle, calibrationBundleHash } from "../app/autonomy/CalibrationBundle.js";
import { createDefaultRunManifest, normalizeRunManifest } from "../app/simulation/RunManifest.js";

test("Three.js and REP-103 basis conversion preserves forward placement", () => {
    const threePose = { position: { x: 1.5, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } };
    const rep103 = threePoseToRep103(threePose);
    assert.deepEqual(rep103.position, { x: 1.5, y: 0, z: 0.5 });
    assert.deepEqual(rep103PoseToThree(rep103).position, threePose.position);
});

test("Three.js camera looks along mount forward instead of ROS optical in scene space", () => {
    const look = rotateVectorByQuaternion({ x: 0, y: 0, z: -1 }, threeCameraLookAlongMountForwardRotation());
    assert.ok(Math.abs(look.x - 1) < 1e-10);
    assert.ok(Math.abs(look.y) < 1e-10);
    assert.ok(Math.abs(look.z) < 1e-10);
    const up = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, threeCameraLookAlongMountForwardRotation());
    assert.ok(Math.abs(up.y - 1) < 1e-10);

    const rosAppliedInThree = rotateVectorByQuaternion({ x: 0, y: 0, z: -1 }, cameraLinkToOpticalRotation());
    // ROS optical maps optical +Z to mount +X, so Three's look (-Z) maps to -X.
    assert.ok(rosAppliedInThree.x < -0.5);
});

test("vector basis mapping matches vehicle axis conventions", () => {
    assert.deepEqual(threeToRep103Vector({ x: 1, y: 2, z: 3 }), { x: 1, y: -3, z: 2 });
    assert.deepEqual(rep103ToThreeVector({ x: 1, y: 2, z: 3 }), { x: 1, y: 3, z: -2 });
    assert.deepEqual(rep103ToThreeVector(threeToRep103Vector({ x: 1, y: 2, z: 3 })), { x: 1, y: 2, z: 3 });
});

test("basis conversion is a rotation, not a reflection", () => {
    // Three.js is right-handed with +X forward and +Y up, so +Z is the vehicle's
    // right and REP-103 +Y (left) is Three.js -Z.
    assert.deepEqual(threeToRep103Vector({ x: 0, y: 0, z: 1 }), { x: 0, y: -1, z: 0 });
    const cross = (a, b) => ({
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    });
    const forward = threeToRep103Vector({ x: 1, y: 0, z: 0 });
    const up = threeToRep103Vector({ x: 0, y: 1, z: 0 });
    const right = threeToRep103Vector({ x: 0, y: 0, z: 1 });
    // Three.js x cross y = z must still hold after conversion.
    assert.deepEqual(cross(forward, up), right);
    // Zero stays +0 so strict equality and canonical hashes are unaffected.
    assert.ok(Object.is(threeToRep103Vector({ x: 0, y: 0, z: 0 }).y, 0));
    assert.ok(Object.is(rep103ToThreeVector({ x: 0, y: 0, z: 0 }).z, 0));
});

test("REP-103 yaw matches the direction of travel", () => {
    // Positive Three.js rotation about +Y turns +X toward -Z.
    for (const yaw of [0.4, -1.2, 2.5]) {
        const facing = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
        const pose = threePoseToRep103({
            position: facing,
            rotation: { x: 0, y: yaw, z: 0, order: "XYZ" },
        });
        const course = Math.atan2(pose.position.y, pose.position.x);
        assert.ok(Math.abs(course - pose.rotation.z) < 1e-12, `yaw ${yaw}: course ${course}`);
    }
});

test("LiDAR rays toward the vehicle's right have negative REP-103 y", () => {
    // Ray casters use Three.js directions (cos phi cos theta, sin phi, cos phi sin theta).
    const right = lidarShaderDirectionToRep103(Math.PI / 2, 0);
    assert.ok(Math.abs(right.x) < 1e-10);
    assert.ok(Math.abs(right.y + 1) < 1e-10);
    const ahead = lidarShaderDirectionToRep103(0, 0);
    assert.deepEqual(ahead, { x: 1, y: 0, z: 0 });
});

test("quaternion composition and inversion are consistent", () => {
    const a = eulerToQuaternion({ x: 0.1, y: -0.2, z: 0.3, order: "XYZ" });
    const b = eulerToQuaternion({ x: -0.4, y: 0.1, z: 0.05, order: "XYZ" });
    const product = quaternionMultiply(a, b);
    const restored = quaternionMultiply(product, quaternionInverse(b));
    assert.ok(Math.abs(restored.x - a.x) < 1e-12);
    assert.ok(Math.abs(restored.w - a.w) < 1e-12);
});

test("XYZ euler round-trips through quaternion", () => {
    const euler = { x: 0.2, y: -0.3, z: 0.4, order: "XYZ" };
    const back = quaternionToEuler(eulerToQuaternion(euler));
    assert.ok(Math.abs(back.x - euler.x) < 1e-10);
    assert.ok(Math.abs(back.y - euler.y) < 1e-10);
    assert.ok(Math.abs(back.z - euler.z) < 1e-10);
});

test("LiDAR cardinal directions use REP-103 axes", () => {
    assert.deepEqual(lidarDirectionRep103(0, 0), { x: 1, y: 0, z: 0 });
    assert.ok(Math.abs(lidarDirectionRep103(Math.PI / 2, 0).x) < 1e-10);
    assert.ok(Math.abs(lidarDirectionRep103(Math.PI / 2, 0).y - 1) < 1e-10);
    const up = lidarDirectionRep103(0, Math.PI / 2);
    assert.ok(Math.abs(up.x) < 1e-10);
    assert.ok(Math.abs(up.y) < 1e-10);
    assert.ok(Math.abs(up.z - 1) < 1e-10);
});

test("simulation stamps round-trip through nanoseconds", () => {
    const stamp = simulationStamp(1_500_000_007);
    assert.equal(stampToTimeNs(stamp), 1_500_000_007);
});

test("v3 manifests migrate sensor poses to REP-103 without changing physical placement", () => {
    const migrated = normalizeRunManifest({
        ...createDefaultRunManifest(),
        version: 3,
        sensorRig: {
            rootFrameId: "base_link",
            sensors: [{
                id: "front-camera",
                type: "camera",
                parentId: "ego",
                frameId: "front_camera_optical_frame",
                pose: { position: { x: 1.5, y: 0.5, z: 0 } },
                outputs: { imageTopicId: "front-camera-image", cameraInfoTopicId: "front-camera-info" },
                schema: { imageTopicId: "sensor_msgs/Image", cameraInfoTopicId: "sensor_msgs/CameraInfo" },
            }],
        },
    });
    assert.equal(migrated.version, 11);
    assert.deepEqual(migrated.sensorRig.sensors[0].pose.position, { x: 1.5, y: 0, z: 0.5 });
    assert.equal(migrated.sensorRig.sensors[0].mountFrameId, "front_camera_link");
});

test("calibration bundles are deterministic and hash-stable", () => {
    const manifest = createDefaultRunManifest();
    const left = buildCalibrationBundle(manifest);
    const right = buildCalibrationBundle(manifest);
    assert.equal(left.hash, right.hash);
    assert.equal(left.hash, calibrationBundleHash(left));
    assert.ok(left.staticTransforms.some((entry) => entry.childFrameId === "front_camera_optical_frame"));
});

test("camera_link to optical maps optical +Z to mount forward", () => {
    const q = cameraLinkToOpticalRotation();
    const forward = rotateVectorByQuaternion({ x: 0, y: 0, z: 1 }, q);
    const right = rotateVectorByQuaternion({ x: 1, y: 0, z: 0 }, q);
    const down = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, q);
    assert.ok(Math.abs(forward.x - 1) < 1e-10);
    assert.ok(Math.abs(forward.y) < 1e-10);
    assert.ok(Math.abs(forward.z) < 1e-10);
    assert.ok(Math.abs(right.y + 1) < 1e-10);
    assert.ok(Math.abs(down.z + 1) < 1e-10);
});

test("camera mount and optical transforms compose to measurement pose", () => {
    const mount = {
        position: { x: 1, y: 0, z: 0.5 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    };
    const optical = {
        position: { x: 0, y: 0, z: 0 },
        rotation: cameraLinkToOpticalRotation(),
    };
    const composed = composeRep103Poses(mount, optical);
    assert.ok(composed.position.x > 0.99 && composed.position.x < 1.01);
});
