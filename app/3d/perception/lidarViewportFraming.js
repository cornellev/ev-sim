import * as THREE from "three";
import { buildSensorRotationMatrix } from "../environment/visualization/LidarSplatProjector.js";

/** Pixel budget for the viewport hit buffer. Matches the bake LiDAR frame. */
export const LIDAR_VIEWPORT_MAX_PIXELS = 640 * 360;

/** Depth colors compress distances beyond this, even when the camera far plane is larger. */
export const LIDAR_VIEWPORT_DISPLAY_RANGE_M = 200;

/**
 * Horizontal field of view for a perspective camera, in degrees.
 * Same conversion StereoCamera and BakeView use to frame a vertical FOV.
 * @param {number} verticalFovDegrees
 * @param {number} aspect
 * @returns {number}
 */
export function horizontalFovDegrees(verticalFovDegrees, aspect) {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    const vertical = THREE.MathUtils.degToRad(verticalFovDegrees);
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(vertical / 2) * safeAspect));
}

/**
 * Hit-buffer size that keeps `aspect` and stays within {@link LIDAR_VIEWPORT_MAX_PIXELS}.
 * @param {number} aspect
 * @returns {{ width: number, height: number }}
 */
export function lidarViewportResolution(aspect) {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    let width = Math.max(2, Math.round(Math.sqrt(LIDAR_VIEWPORT_MAX_PIXELS * safeAspect)));
    let height = Math.max(2, Math.round(width / safeAspect));
    while (width * height > LIDAR_VIEWPORT_MAX_PIXELS && (width > 2 || height > 2)) {
        if (width / Math.max(height, 1) > safeAspect && width > 2) width -= 1;
        else if (height > 2) height -= 1;
        else width -= 1;
    }
    return { width, height };
}

/**
 * Log-depth normalization distance. Rays still travel `camera.far`.
 * @param {number} rayRange
 * @returns {number}
 */
export function lidarViewportDisplayRange(rayRange) {
    const far = Number(rayRange);
    if (!Number.isFinite(far) || far <= 0) return LIDAR_VIEWPORT_DISPLAY_RANGE_M;
    return Math.min(far, LIDAR_VIEWPORT_DISPLAY_RANGE_M);
}

/**
 * Frame the analytic LiDAR shader to a perspective camera.
 * The sensor basis is the bake alignment: LiDAR +X follows the camera look direction.
 * @param {THREE.PerspectiveCamera} camera
 */
export function lidarViewportFraming(camera) {
    camera.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    camera.matrixWorld.decompose(origin, quaternion, scale);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, camera.rotation?.order || "XYZ");
    const sensorRotation = buildSensorRotationMatrix(euler);
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    const horizontalFov = horizontalFovDegrees(camera.fov, aspect);
    const { width, height } = lidarViewportResolution(aspect);
    return {
        origin,
        sensorRotation,
        thetaRange: [-horizontalFov / 2, horizontalFov / 2],
        phiRange: [-camera.fov / 2, camera.fov / 2],
        range: camera.far,
        width,
        height,
    };
}
