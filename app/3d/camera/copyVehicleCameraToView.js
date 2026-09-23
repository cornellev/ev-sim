import * as THREE from "three";

import { threeCameraLookAlongMountForwardEuler } from "../../autonomy/CoordinateFrames.js";
import { isStereoPerspectiveCamera } from "./selectVehicleCamera.js";

const _worldPosition = new THREE.Vector3();
const _worldQuaternion = new THREE.Quaternion();
const _mountQuaternion = new THREE.Quaternion();
const _opticalQuaternion = new THREE.Quaternion();
const _opticalEuler = new THREE.Euler();

function opticalQuaternion() {
    const look = threeCameraLookAlongMountForwardEuler();
    _opticalEuler.set(look.x, look.y, look.z, look.order || "XYZ");
    return _opticalQuaternion.setFromEuler(_opticalEuler);
}

function copyProjection(viewCamera, { fov, near, far, aspect }) {
    if (Number.isFinite(fov)) viewCamera.fov = fov;
    if (Number.isFinite(near)) viewCamera.near = near;
    if (Number.isFinite(far)) viewCamera.far = far;
    viewCamera.aspect = aspect;
    viewCamera.updateProjectionMatrix();
}

/**
 * Copy a vehicle camera onto the viewport camera.
 * ManifestCamera already aims along mount +X in `_applyPose`. StereoCamera
 * stores the mount pose only, so the same optical yaw is applied here without
 * changing what `StereoCamera.execute` captures.
 * The viewport aspect is preserved.
 */
export function copyVehicleCameraToView(viewCamera, device) {
    if (!viewCamera || !device) return false;
    const aspect = viewCamera.aspect;

    if (typeof device._applyPose === "function" && device.sensorCamera) {
        device._applyPose();
        const sensor = device.sensorCamera;
        viewCamera.position.copy(sensor.getWorldPosition(_worldPosition));
        viewCamera.quaternion.copy(sensor.getWorldQuaternion(_worldQuaternion));
        copyProjection(viewCamera, {
            fov: sensor.fov,
            near: sensor.near,
            far: sensor.far,
            aspect,
        });
        return true;
    }

    if (!isStereoPerspectiveCamera(device)) return false;
    const position = device.getPosition?.();
    const rotation = device.getRotation?.();
    if (!position || !rotation) return false;
    const settings = device.cameraSettings ?? {};
    const euler = rotation.isEuler
        ? rotation
        : new THREE.Euler(rotation.x || 0, rotation.y || 0, rotation.z || 0, rotation.order || "XYZ");
    _mountQuaternion.setFromEuler(euler);
    viewCamera.position.copy(position);
    viewCamera.quaternion.copy(_mountQuaternion.multiply(opticalQuaternion()));
    copyProjection(viewCamera, {
        fov: Number(settings.fov),
        near: Number(settings.near),
        far: Number(settings.far),
        aspect,
    });
    return true;
}
