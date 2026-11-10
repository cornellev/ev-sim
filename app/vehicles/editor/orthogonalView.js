/**
 * Perspective and orthographic framing for the vehicle studio.
 * No DOM or WebGL. The studio keeps one orbit radius and uses zoom for ortho dolly.
 */

export const ORTHOGONAL_NEAR = 0.05;
export const ORTHOGONAL_FAR = 200;

function positive(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Orthographic frustum whose view height matches a perspective camera
 * at `distance` with `fovDegrees`. `zoom` stays 1; dolly changes zoom later.
 */
export function orthographicFrustum({ distance, fovDegrees = 50, aspect = 1 } = {}) {
    const span = positive(distance, 1);
    const fov = Number.isFinite(fovDegrees) && fovDegrees > 0 && fovDegrees < 180 ? fovDegrees : 50;
    const safeAspect = positive(aspect, 1);
    const halfHeight = span * Math.tan((fov * Math.PI) / 360);
    const halfWidth = halfHeight * safeAspect;
    return {
        left: -halfWidth,
        right: halfWidth,
        top: halfHeight,
        bottom: -halfHeight,
        near: ORTHOGONAL_NEAR,
        far: ORTHOGONAL_FAR,
        zoom: 1,
    };
}

/** Map an orbit radius onto the orthographic zoom that stays inside the distance range. */
export function orthogonalZoomLimits({ distance, minDistance = 0.5, maxDistance = 60 } = {}) {
    const span = positive(distance, 1);
    const near = positive(minDistance, 0.5);
    const far = Math.max(positive(maxDistance, 60), near);
    return {
        minZoom: span / far,
        maxZoom: span / near,
    };
}

/**
 * Perspective distance that frames the same height as an orthographic camera
 * whose zoom changed while its orbit radius stayed put.
 */
export function perspectiveDistanceForZoom({ distance, zoom = 1, minDistance = 0.5, maxDistance = 60 } = {}) {
    const span = positive(distance, 1);
    const scale = positive(zoom, 1);
    const near = positive(minDistance, 0.5);
    const far = Math.max(positive(maxDistance, 60), near);
    return Math.min(far, Math.max(near, span / scale));
}
