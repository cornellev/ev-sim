/**
 * Human-editable defaults for Google Earth import mode.
 * Secrets (API keys) are read from environment variables only.
 */

export const TILE_PROVIDER_IDS = Object.freeze({
    GOOGLE_PHOTOREALISTIC: "google-photorealistic",
});

export const ROAD_PROVIDER_IDS = Object.freeze({
    OVERPASS: "overpass",
    GOOGLE: "google",
    MESH: "mesh",
});

export const EARTH_IMPORT_STATUS = Object.freeze({
    IDLE: "idle",
    LOADING_TILES: "loading-tiles",
    LOADING_ROADS: "loading-roads",
    PREVIEW: "preview",
    APPLIED: "applied",
    ERROR: "error",
});

/** @typedef {{ lat: number, lng: number }} LatLng */
/** @typedef {{ north: number, south: number, east: number, west: number }} GeoBounds */

export const EARTH_IMPORT_ENV_KEYS = Object.freeze({
    GOOGLE_MAPS_API_KEY: "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
});

export const DEFAULT_EARTH_IMPORT_CONFIG = Object.freeze({
    tileProvider: TILE_PROVIDER_IDS.GOOGLE_PHOTOREALISTIC,
    roadProvider: ROAD_PROVIDER_IDS.OVERPASS,
    maxScreenSpaceError: 1,
    maxTileDepth: Infinity,
    cacheSize: 2000,
    cacheMinSize: 1500,
    minCacheBytes: 512 * 1024 * 1024,
    maxCacheBytes: 1024 * 1024 * 1024,
    googleAttributionLogoUrl: "https://www.gstatic.com/images/branding/googlelogo/svg/googlelogo_clr_74x24px.svg",
    /** Max bounding box edge length in meters before import is rejected. */
    maxBoundsEdgeMeters: 5000,
    /** Height above sampled tile geometry for the preview bounds outline. */
    boundsOutlineClearanceMeters: 100,
    /** Douglas-Peucker simplification tolerance in meters for road centerlines. */
    roadSimplifyToleranceMeters: 2,
    /** Default anchor: Ithaca, NY area (near existing IGVC content). */
    defaultAnchor: Object.freeze({ lat: 42.443, lng: -76.502 }),
    /** Default import bounds (~1 km square) around anchor. */
    defaultBoundsDeltaDegrees: 0.005,
    overpassEndpoint: "https://overpass-api.de/api/interpreter",
    googleTilesRootUrl: "https://tile.googleapis.com/v1/3dtiles/root.json",
});

/**
 * @returns {string|null}
 */
export function getGoogleMapsApiKey() {
    // Next.js only inlines NEXT_PUBLIC_* vars for static property access
    // (e.g. process.env.NEXT_PUBLIC_FOO). Dynamic keys are undefined in the browser.
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey || apiKey.length === 0) return null;
    if (/your[_-]?google/i.test(apiKey) || apiKey.includes("YOUR_API_KEY")) {
        return null;
    }
    return apiKey;
}

/**
 * @param {LatLng} anchor
 * @param {number} [deltaDegrees]
 * @returns {GeoBounds}
 */
export function makeDefaultBounds(anchor, deltaDegrees = DEFAULT_EARTH_IMPORT_CONFIG.defaultBoundsDeltaDegrees) {
    return {
        north: anchor.lat + deltaDegrees,
        south: anchor.lat - deltaDegrees,
        east: anchor.lng + deltaDegrees,
        west: anchor.lng - deltaDegrees,
    };
}

/**
 * @param {GeoBounds} bounds
 * @returns {LatLng}
 */
export function boundsCenter(bounds) {
    return {
        lat: (bounds.north + bounds.south) / 2,
        lng: (bounds.east + bounds.west) / 2,
    };
}

/**
 * Approximate max edge length of a bounding box in meters.
 * @param {GeoBounds} bounds
 */
export function estimateBoundsEdgeMeters(bounds) {
    const latSpan = Math.abs(bounds.north - bounds.south);
    const lngSpan = Math.abs(bounds.east - bounds.west);
    const metersPerDegreeLat = 111_320;
    const centerLat = (bounds.north + bounds.south) / 2;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos(centerLat * Math.PI / 180);
    return Math.max(latSpan * metersPerDegreeLat, lngSpan * metersPerDegreeLng);
}

/**
 * @param {GeoBounds} bounds
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateBounds(bounds) {
    if (!bounds || !Number.isFinite(bounds.north) || !Number.isFinite(bounds.south)
        || !Number.isFinite(bounds.east) || !Number.isFinite(bounds.west)) {
        return { ok: false, error: "Bounds must include north, south, east, and west values." };
    }
    if (bounds.north <= bounds.south) {
        return { ok: false, error: "North must be greater than south." };
    }
    if (bounds.east <= bounds.west) {
        return { ok: false, error: "East must be greater than west." };
    }
    const edgeMeters = estimateBoundsEdgeMeters(bounds);
    if (edgeMeters > DEFAULT_EARTH_IMPORT_CONFIG.maxBoundsEdgeMeters) {
        return {
            ok: false,
            error: `Bounds exceed ${DEFAULT_EARTH_IMPORT_CONFIG.maxBoundsEdgeMeters}m limit (${Math.round(edgeMeters)}m).`,
        };
    }
    return { ok: true };
}

/**
 * @param {Record<string, unknown>} [state]
 */
export function normalizeEarthImportEditorState(state = {}) {
    const anchor = {
        lat: Number(state.anchorLat) || DEFAULT_EARTH_IMPORT_CONFIG.defaultAnchor.lat,
        lng: Number(state.anchorLng) || DEFAULT_EARTH_IMPORT_CONFIG.defaultAnchor.lng,
    };
    const hasBounds = Number.isFinite(state.boundsNorth)
        && Number.isFinite(state.boundsSouth)
        && Number.isFinite(state.boundsEast)
        && Number.isFinite(state.boundsWest);

    return {
        anchorLat: anchor.lat,
        anchorLng: anchor.lng,
        boundsNorth: hasBounds ? state.boundsNorth : makeDefaultBounds(anchor).north,
        boundsSouth: hasBounds ? state.boundsSouth : makeDefaultBounds(anchor).south,
        boundsEast: hasBounds ? state.boundsEast : makeDefaultBounds(anchor).east,
        boundsWest: hasBounds ? state.boundsWest : makeDefaultBounds(anchor).west,
        tileProvider: state.tileProvider ?? DEFAULT_EARTH_IMPORT_CONFIG.tileProvider,
        roadProvider: state.roadProvider ?? DEFAULT_EARTH_IMPORT_CONFIG.roadProvider,
        maxScreenSpaceError: Math.max(
            1,
            Number(state.maxScreenSpaceError) || DEFAULT_EARTH_IMPORT_CONFIG.maxScreenSpaceError,
        ),
        status: state.status ?? EARTH_IMPORT_STATUS.IDLE,
        statusMessage: state.statusMessage ?? null,
        previewActive: Boolean(state.previewActive),
        tilesVisible: state.tilesVisible !== false,
        roadsVisible: state.roadsVisible !== false,
    };
}
