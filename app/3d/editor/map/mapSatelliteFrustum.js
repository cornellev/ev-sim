import { MAP_WORLD_SCALE, worldToScreen } from "./mapCoords.js";

/** Floor for the nadir camera height, in world meters. */
export const MAP_SATELLITE_MIN_ELEVATION = 50;

/**
 * World XZ rectangle covered by the map canvas.
 * Screen top is minZ because {@link worldToScreen} maps +Z to +Y.
 * @param {{ centerX?: number, centerZ?: number, zoom?: number }} viewport
 * @param {{ width?: number, height?: number }} size
 */
export function mapViewportWorldRect(viewport, size) {
    const scale = (Number(viewport?.zoom) || 1) * MAP_WORLD_SCALE;
    const width = Math.max(0, Number(size?.width) || 0);
    const height = Math.max(0, Number(size?.height) || 0);
    const halfW = width / 2 / scale;
    const halfH = height / 2 / scale;
    const centerX = Number(viewport?.centerX) || 0;
    const centerZ = Number(viewport?.centerZ) || 0;
    return {
        minX: centerX - halfW,
        maxX: centerX + halfW,
        minZ: centerZ - halfH,
        maxZ: centerZ + halfH,
    };
}

/**
 * Orthographic frustum whose projection matches {@link worldToScreen} after a
 * WebGL Y-flip. Three.js camera `top` is view +Y, which this maps to world −Z.
 * @param {{ centerX?: number, centerZ?: number, zoom?: number }} viewport
 * @param {{ width?: number, height?: number }} size
 * @param {{ elevation?: number }} [options]
 */
export function mapSatelliteFrustum(viewport, size, { elevation } = {}) {
    const rect = mapViewportWorldRect(viewport, size);
    const centerX = Number(viewport?.centerX) || 0;
    const centerZ = Number(viewport?.centerZ) || 0;
    const halfW = (rect.maxX - rect.minX) / 2;
    const halfH = (rect.maxZ - rect.minZ) / 2;
    const y = Number.isFinite(Number(elevation)) && Number(elevation) > 0
        ? Number(elevation)
        : MAP_SATELLITE_MIN_ELEVATION;
    return {
        left: -halfW,
        right: halfW,
        top: halfH,
        bottom: -halfH,
        near: 0.1,
        far: y + 1000,
        position: [centerX, y, centerZ],
        up: [0, 0, -1],
        lookAt: [centerX, 0, centerZ],
    };
}

/**
 * Screen rectangle of a previous capture under the current map viewport.
 * @param {{ viewport: object, size: { width: number, height: number } }} capture
 * @param {{ centerX?: number, centerZ?: number, zoom?: number }} viewport
 * @param {{ width?: number, height?: number }} size
 */
export function mapSatelliteScreenRect(capture, viewport, size) {
    const sourceViewport = capture?.viewport ?? {};
    const sourceSize = capture?.size ?? { width: 0, height: 0 };
    const rect = mapViewportWorldRect(sourceViewport, sourceSize);
    const topLeft = worldToScreen({ x: rect.minX, z: rect.minZ }, viewport, size);
    const bottomRight = worldToScreen({ x: rect.maxX, z: rect.maxZ }, viewport, size);
    return {
        x: topLeft.x,
        y: topLeft.y,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y,
    };
}

/**
 * Canvas pixel after the WebGL Y-flip blit. NDC +Y is the top of the map.
 * @param {{ x: number, y: number }} ndc
 * @param {{ width?: number, height?: number }} size
 */
export function mapSatelliteNdcToCanvas(ndc, size) {
    const width = Number(size?.width) || 0;
    const height = Number(size?.height) || 0;
    return {
        x: (Number(ndc?.x) + 1) / 2 * width,
        y: (1 - Number(ndc?.y)) / 2 * height,
    };
}

/**
 * Draw a captured nadir bitmap into the map pane in the same user space as the SVG overlay.
 * @param {HTMLCanvasElement | null} displayCanvas
 * @param {{ canvas?: CanvasImageSource, viewport?: object, size?: object } | null} capture
 * @param {{ centerX?: number, centerZ?: number, zoom?: number }} viewport
 * @param {{ width?: number, height?: number }} size
 */
export function paintMapSatelliteCanvas(displayCanvas, capture, viewport, size) {
    if (!displayCanvas) return null;
    const width = Math.max(1, Number(size?.width) || 0);
    const height = Math.max(1, Number(size?.height) || 0);
    const pixelWidth = Math.max(1, Math.round(width));
    const pixelHeight = Math.max(1, Math.round(height));
    if (displayCanvas.width !== pixelWidth) displayCanvas.width = pixelWidth;
    if (displayCanvas.height !== pixelHeight) displayCanvas.height = pixelHeight;
    const context = displayCanvas.getContext?.("2d");
    if (!context?.clearRect) return null;
    context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    context.clearRect(0, 0, width, height);
    const source = capture?.canvas;
    if (!source || !(source.width > 0) || !(source.height > 0)) {
        return { width, height, rect: null };
    }
    const rect = mapSatelliteScreenRect(capture, viewport, { width, height });
    context.drawImage(source, rect.x, rect.y, rect.width, rect.height);
    return { width, height, rect };
}
