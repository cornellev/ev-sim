import {
    boundsCenter,
    estimateBoundsEdgeMeters,
    validateBounds,
} from "../EarthImportConfig.js";

/** @typedef {{ lat: number, lng: number }} LatLng */
/** @typedef {{ north: number, south: number, east: number, west: number }} GeoBounds */

/**
 * @param {LatLng} cornerA
 * @param {LatLng} cornerB
 * @returns {GeoBounds}
 */
export function normalizeCorners(cornerA, cornerB) {
    return {
        north: Math.max(cornerA.lat, cornerB.lat),
        south: Math.min(cornerA.lat, cornerB.lat),
        east: Math.max(cornerA.lng, cornerB.lng),
        west: Math.min(cornerA.lng, cornerB.lng),
    };
}

/**
 * @param {GeoBounds} bounds
 * @returns {[[number, number], [number, number]]}
 */
export function boundsToLeafletLatLngBounds(bounds) {
    return [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
    ];
}

/**
 * Leaflet LatLngBounds-like object with getSouthWest/getNorthEast.
 * @param {{ getSouthWest: () => { lat: number, lng: number }, getNorthEast: () => { lat: number, lng: number } }} leafletBounds
 * @returns {GeoBounds}
 */
export function leafletLatLngBoundsToGeoBounds(leafletBounds) {
    const southWest = leafletBounds.getSouthWest();
    const northEast = leafletBounds.getNorthEast();
    return {
        north: northEast.lat,
        south: southWest.lat,
        east: northEast.lng,
        west: southWest.lng,
    };
}

/**
 * @param {{ boundsNorth: number, boundsSouth: number, boundsEast: number, boundsWest: number }} earthImport
 * @returns {GeoBounds}
 */
export function editorStateToGeoBounds(earthImport) {
    return {
        north: earthImport.boundsNorth,
        south: earthImport.boundsSouth,
        east: earthImport.boundsEast,
        west: earthImport.boundsWest,
    };
}

/**
 * @param {GeoBounds} bounds
 */
export function geoBoundsToEarthImportPatch(bounds) {
    const center = boundsCenter(bounds);
    return {
        boundsNorth: bounds.north,
        boundsSouth: bounds.south,
        boundsEast: bounds.east,
        boundsWest: bounds.west,
        anchorLat: center.lat,
        anchorLng: center.lng,
    };
}

/**
 * @param {GeoBounds} bounds
 * @returns {{ edgeMeters: number, valid: boolean, error: string|null }}
 */
export function summarizeBounds(bounds) {
    const edgeMeters = estimateBoundsEdgeMeters(bounds);
    const validation = validateBounds(bounds);
    return {
        edgeMeters: Math.round(edgeMeters),
        valid: validation.ok,
        error: validation.error ?? null,
    };
}

/**
 * @param {GeoBounds} a
 * @param {GeoBounds} b
 * @param {number} [epsilon=1e-7]
 */
export function geoBoundsEqual(a, b, epsilon = 1e-7) {
    return Math.abs(a.north - b.north) < epsilon
        && Math.abs(a.south - b.south) < epsilon
        && Math.abs(a.east - b.east) < epsilon
        && Math.abs(a.west - b.west) < epsilon;
}
