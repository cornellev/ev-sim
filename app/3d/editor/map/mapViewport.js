import { MAP_WORLD_SCALE, screenToWorld } from "./mapCoords.js";

export const MAP_MIN_ZOOM = 0.25;
export const MAP_MAX_ZOOM = 8;
export const MAP_FIT_PADDING = 48;

export const DEFAULT_MAP_VIEWPORT = Object.freeze({
    centerX: 0,
    centerZ: 0,
    zoom: 1,
    gridVisible: true,
});

function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function clampZoom(zoom) {
    return Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, finite(zoom, 1)));
}

/**
 * @param {{ centerX?: number, centerZ?: number, zoom?: number }} viewport
 * @param {number} deltaX
 * @param {number} deltaY
 */
export function panMapViewport(viewport, deltaX, deltaY) {
    const scale = Math.max(Number.EPSILON, clampZoom(viewport?.zoom) * MAP_WORLD_SCALE);
    return {
        ...viewport,
        centerX: finite(viewport?.centerX) - finite(deltaX) / scale,
        centerZ: finite(viewport?.centerZ) - finite(deltaY) / scale,
    };
}

/**
 * @param {{ centerX?: number, centerZ?: number, zoom?: number }} viewport
 * @param {{ x: number, y: number }} screen
 * @param {{ width: number, height: number }} size
 * @param {number} factor
 */
export function zoomMapViewport(viewport, screen, size, factor) {
    const current = clampZoom(viewport?.zoom);
    const nextZoom = clampZoom(current * finite(factor, 1));
    if (nextZoom === current) return viewport;
    const width = Math.max(1, finite(size?.width, 800));
    const height = Math.max(1, finite(size?.height, 600));
    const nextSize = { width, height };
    const anchor = screenToWorld(screen, { ...viewport, zoom: current }, nextSize);
    const nextScale = nextZoom * MAP_WORLD_SCALE;
    return {
        ...viewport,
        zoom: nextZoom,
        centerX: anchor.x - (finite(screen?.x) - width / 2) / nextScale,
        centerZ: anchor.z - (finite(screen?.y) - height / 2) / nextScale,
    };
}

/**
 * Continuous wheel zoom factor shared by editor and scenario maps.
 * @param {number} deltaY
 */
export function mapWheelZoomFactor(deltaY) {
    return Math.exp(-finite(deltaY) * 0.0015);
}

/**
 * Fit a viewport to world XZ points using the pane size.
 * @param {{ x?: number, z?: number }[]} points
 * @param {{ width?: number, height?: number } | null | undefined} size
 * @param {{ padding?: number }} [options]
 */
export function fitMapViewport(points, size, { padding = MAP_FIT_PADDING } = {}) {
    const normalized = (points || [])
        .map((point) => ({ x: finite(point?.x), z: finite(point?.z) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
    if (normalized.length === 0) return { ...DEFAULT_MAP_VIEWPORT };
    const xs = normalized.map((point) => point.x);
    const zs = normalized.map((point) => point.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const inset = Math.max(0, finite(padding, MAP_FIT_PADDING));
    const width = Math.max(1, finite(size?.width, 800) - inset * 2);
    const height = Math.max(1, finite(size?.height, 600) - inset * 2);
    return {
        ...DEFAULT_MAP_VIEWPORT,
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        zoom: clampZoom(Math.min(width / (spanX * MAP_WORLD_SCALE), height / (spanZ * MAP_WORLD_SCALE))),
    };
}
