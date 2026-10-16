/**
 * Horizontal and vertical scan limits for a vehicle-document camera.
 * StereoCamera and the coverage census both use this so the editor grid
 * cannot drift from the runtime device.
 *
 * @param {{
 *   width?: number,
 *   height?: number,
 *   fov?: number,
 *   thetaRange?: [number, number],
 *   phiRange?: [number, number],
 * }} [config]
 */
export function cameraScanAngles(config = {}) {
    const width = finiteOr(config.width, 320);
    const height = Math.max(1, finiteOr(config.height, 180));
    const verticalFov = finiteOr(config.fov, 75);
    const aspect = Math.max(1, width) / height;
    const horizontalFov = radToDeg(2 * Math.atan(Math.tan(degToRad(verticalFov) / 2) * aspect));
    return {
        verticalFov,
        horizontalFov,
        thetaRange: anglePair(config.thetaRange, [-horizontalFov / 2, horizontalFov / 2]),
        phiRange: anglePair(config.phiRange, [-verticalFov / 2, verticalFov / 2]),
    };
}

function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function anglePair(value, fallback) {
    if (!Array.isArray(value) || value.length !== 2) return [...fallback];
    const low = Number(value[0]);
    const high = Number(value[1]);
    if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low)) return [...fallback];
    return [low, high];
}

function degToRad(degrees) {
    return degrees * Math.PI / 180;
}

function radToDeg(radians) {
    return radians * 180 / Math.PI;
}
