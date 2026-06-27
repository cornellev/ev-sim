/** World units per screen pixel at zoom=1. Shared by map pan/zoom and coordinate conversion. */
export const MAP_WORLD_SCALE = 4;

/**
 * Convert world XZ to SVG view coordinates.
 * @param {{ x: number, z: number }} point
 * @param {{ centerX: number, centerZ: number, zoom: number }} viewport
 * @param {{ width: number, height: number }} size
 */
export function worldToScreen(point, viewport, size) {
    const scale = viewport.zoom * MAP_WORLD_SCALE;
    const x = size.width / 2 + (point.x - viewport.centerX) * scale;
    const y = size.height / 2 + (point.z - viewport.centerZ) * scale;
    return { x, y };
}

/**
 * Convert SVG view coordinates to world XZ.
 */
export function screenToWorld(screen, viewport, size) {
    const scale = viewport.zoom * MAP_WORLD_SCALE;
    return {
        x: viewport.centerX + (screen.x - size.width / 2) / scale,
        z: viewport.centerZ + (screen.y - size.height / 2) / scale,
    };
}

/**
 * @param {number} worldRadius
 * @param {{ zoom: number }} viewport
 */
export function worldRadiusToScreen(worldRadius, viewport) {
    return worldRadius * viewport.zoom * MAP_WORLD_SCALE;
}

/**
 * @param {number} worldSize
 * @param {{ zoom: number }} viewport
 */
export function worldSizeToScreen(worldSize, viewport) {
    return worldSize * viewport.zoom * MAP_WORLD_SCALE;
}

/**
 * @param {number} screenRadius
 * @param {{ zoom: number }} viewport
 */
export function screenRadiusToWorld(screenRadius, viewport) {
    const scale = viewport.zoom * MAP_WORLD_SCALE;
    return screenRadius / scale;
}

/** Below this zoom, map shows overview (roads, links, buildings only). */
export const MAP_DETAIL_ZOOM_THRESHOLD = 0.55;

/**
 * @param {{ zoom: number }} viewport
 */
export function isMapDetailZoom(viewport) {
    return viewport.zoom >= MAP_DETAIL_ZOOM_THRESHOLD;
}
