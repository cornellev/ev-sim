/** Analytic GPU camera pose shared by the headless renderer and pose-parity tests. */

import { eulerToQuaternion, threePoseToRep103 } from "../../autonomy/CoordinateFrames.js";
import { snapshotRep103CameraPose } from "../../3d/environment/visual/VisualCapturePipeline.js";

const IDENTITY_WORLD = Object.freeze({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
});

function worldPoseFor(sensor, vehicles) {
    if (sensor.poseReference === "map") return IDENTITY_WORLD;
    const parent = vehicles.find((vehicle) => vehicle.id === sensor.parentId || vehicle.telemetryId === sensor.parentId);
    if (!parent) throw new Error(`GPU sensor parent ${sensor.parentId} is missing.`);
    const rep103 = threePoseToRep103({
        position: parent.position || {},
        rotation: parent.rotation || {},
    });
    return {
        position: rep103.position,
        rotation: eulerToQuaternion(rep103.rotation),
    };
}

export function analyticGpuCameraPose({ sensor, vehicles = [], width, height, captureTimeNs = 0 } = {}) {
    if (!sensor) throw new Error("An analytic GPU camera requires a sensor.");
    const snapshot = snapshotRep103CameraPose({
        captureTimeNs,
        worldPose: worldPoseFor(sensor, vehicles),
        mountPose: sensor.pose || {},
    });
    const frameWidth = Number(width || sensor.calibration?.width || 1);
    const frameHeight = Number(height || sensor.calibration?.height || 1);
    return {
        origin: [snapshot.position.x, snapshot.position.y, snapshot.position.z],
        inverseQ: [-snapshot.quaternion.x, -snapshot.quaternion.y, -snapshot.quaternion.z, snapshot.quaternion.w],
        projection: [
            1 / Math.tan(Number(sensor.calibration?.verticalFovDeg || 75) * Math.PI / 360),
            frameWidth / frameHeight,
            sensor.calibration?.near,
            sensor.calibration?.far,
        ],
    };
}
