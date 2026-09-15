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
 * Hide an asset footprint in overview when its longest screen edge is below
 * this fraction of the shorter map-pane side. Large GLB / Tile footprints stay
 * visible after the detail-zoom cutoff until they are actually small on screen.
 */
export const MAP_FOOTPRINT_MIN_VIEWPORT_FRACTION = 0.02;

/**
 * @param {{ zoom: number }} viewport
 */
export function isMapDetailZoom(viewport) {
    return viewport.zoom >= MAP_DETAIL_ZOOM_THRESHOLD;
}

/**
 * Axis-aligned screen size of an XZ polygon.
 * @param {{ x: number, z: number }[]} footprint
 * @param {{ centerX?: number, centerZ?: number, zoom: number }} viewport
 * @param {{ width: number, height: number }} [size]
 */
export function footprintScreenExtent(footprint, viewport, size = { width: 0, height: 0 }) {
    if (!Array.isArray(footprint) || footprint.length === 0) {
        return { width: 0, height: 0 };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of footprint) {
        const screen = worldToScreen(point, viewport, size);
        minX = Math.min(minX, screen.x);
        maxX = Math.max(maxX, screen.x);
        minY = Math.min(minY, screen.y);
        maxY = Math.max(maxY, screen.y);
    }
    return { width: maxX - minX, height: maxY - minY };
}

/**
 * True when the footprint is large enough on the map pane to keep in overview.
 * @param {{ x: number, z: number }[]} footprint
 * @param {{ zoom: number }} viewport
 * @param {{ width: number, height: number } | null} [size]
 */
export function isMapFootprintVisible(footprint, viewport, size) {
    const { width, height } = footprintScreenExtent(footprint, viewport, size);
    const longest = Math.max(width, height);
    const viewportMin = Math.min(Number(size?.width) || 0, Number(size?.height) || 0);
    if (!(viewportMin > 0) || !Number.isFinite(longest) || longest <= 0) return false;
    return longest >= viewportMin * MAP_FOOTPRINT_MIN_VIEWPORT_FRACTION;
}

/**
 * Asset footprints stay in Map overview while they occupy enough of the pane.
 * Point-like instances still follow `showDetail` so cones and crates do not
 * vanish at the default zoom. A selected footprint always remains.
 * @param {{ x: number, z: number }[]} footprint
 * @param {{ zoom: number }} viewport
 * @param {{ width: number, height: number } | null} [size]
 * @param {{ showDetail?: boolean, selected?: boolean }} [options]
 */
export function shouldShowMapAssetFootprint(footprint, viewport, size, options = {}) {
    if (options.selected) return true;
    if (options.showDetail) return true;
    return isMapFootprintVisible(footprint, viewport, size);
}
