/**
 * @typedef {{ lat: number, lng: number }} LatLngPoint
 * @typedef {{ id: string, tags?: Record<string, string>, points: LatLngPoint[] }} NormalizedRoadWay
 * @typedef {{ ways: NormalizedRoadWay[], providerId: string, fetchedAt?: string }} NormalizedRoadNetwork
 * @typedef {{ north: number, south: number, east: number, west: number }} GeoBounds
 */

/**
 * @typedef {Object} RoadNetworkProvider
 * @property {string} id
 * @property {string} label
 * @property {(bounds: GeoBounds, options?: Record<string, unknown>) => Promise<NormalizedRoadNetwork>} fetchRoadNetwork
 */

/**
 * @param {unknown} value
 * @returns {value is GeoBounds}
 */
export function isValidGeoBounds(value) {
    return Boolean(value)
        && Number.isFinite(value.north)
        && Number.isFinite(value.south)
        && Number.isFinite(value.east)
        && Number.isFinite(value.west)
        && value.north > value.south
        && value.east > value.west;
}

/**
 * @param {Array<{ lat: number, lng: number }>} points
 * @returns {NormalizedRoadWay|null}
 */
export function normalizeRoadWay(id, points, tags = {}) {
    const cleaned = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (cleaned.length < 2) return null;
    return {
        id: String(id),
        tags,
        points: cleaned,
    };
}
