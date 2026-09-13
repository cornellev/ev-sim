import { DEFAULT_EARTH_IMPORT_CONFIG, ROAD_PROVIDER_IDS } from "../EarthImportConfig.js";
import { isValidGeoBounds, normalizeRoadWay } from "./RoadNetworkProvider.js";
import { defaultFetch } from "../../../util/Fetch.js";

/**
 * @typedef {import("./RoadNetworkProvider.js").GeoBounds} GeoBounds
 * @typedef {import("./RoadNetworkProvider.js").NormalizedRoadNetwork} NormalizedRoadNetwork
 */

export const OVERPASS_HIGHWAY_CLASSES = Object.freeze([
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "service", "living_street",
]);

function normalizeHighwayClasses(filters = {}) {
    const requested = Array.isArray(filters.highwayClasses) ? filters.highwayClasses.map(String) : [];
    if (requested.length === 0) return [...OVERPASS_HIGHWAY_CLASSES];
    const supported = requested.filter((entry) => OVERPASS_HIGHWAY_CLASSES.includes(entry));
    if (supported.length !== requested.length) {
        const unknown = requested.filter((entry) => !OVERPASS_HIGHWAY_CLASSES.includes(entry));
        throw new TypeError(`Unsupported OSM highway classes: ${unknown.join(", ")}.`);
    }
    return [...new Set(supported)].sort();
}

export function buildOverpassQuery(bounds, filters = {}) {
    const { south, west, north, east } = bounds;
    const classes = normalizeHighwayClasses(filters).join("|");
    return `
[out:json][timeout:25];
(
  way["highway"~"^(${classes})$"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;
`.trim();
}

/**
 * @param {Record<string, unknown>} element
 * @param {Map<number, { lat: number, lng: number }>} nodeMap
 */
function wayToPoints(element, nodeMap) {
    const refs = Array.isArray(element.nodes) ? element.nodes : [];
    return refs.map((nodeId) => {
        const point = nodeMap.get(nodeId);
        return point ? { id: String(nodeId), ...point } : null;
    });
}

/**
 * OSM road network provider via Overpass API.
 */
export class OverpassRoadProvider {
    constructor(options = {}) {
        this.id = ROAD_PROVIDER_IDS.OVERPASS;
        this.label = "OpenStreetMap (Overpass)";
        this.endpoint = options.endpoint ?? DEFAULT_EARTH_IMPORT_CONFIG.overpassEndpoint;
        this.fetchImpl = options.fetchImpl ?? defaultFetch;
    }

    /**
     * @param {GeoBounds} bounds
     * @returns {Promise<NormalizedRoadNetwork>}
     */
    async fetchRoadNetwork(bounds, { filters = {}, signal } = {}) {
        if (!isValidGeoBounds(bounds)) {
            throw new Error("Invalid geographic bounds for Overpass query.");
        }

        const response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            },
            body: `data=${encodeURIComponent(buildOverpassQuery(bounds, filters))}`,
            signal,
        });

        if (!response.ok) {
            throw new Error(`Overpass request failed (${response.status}).`);
        }

        const payload = await response.json();
        const elements = Array.isArray(payload.elements) ? payload.elements : [];
        const nodeMap = new Map();

        for (const element of elements) {
            if (element.type === "node" && Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
                nodeMap.set(element.id, { lat: element.lat, lng: element.lon });
            }
        }

        const ways = [];
        const issues = [];
        for (const element of elements) {
            if (element.type !== "way") continue;
            const points = wayToPoints(element, nodeMap);
            const missing = points.flatMap((point, index) => point ? [] : [element.nodes[index]]);
            if (missing.length > 0) {
                issues.push({
                    path: ["ways", String(element.id), "nodes"],
                    code: "road-import.osm-node-missing",
                    message: `OSM way ${String(element.id)} is missing ${missing.length} referenced node${missing.length === 1 ? "" : "s"}.`,
                    severity: "error",
                });
                continue;
            }
            const normalized = normalizeRoadWay(element.id, points, element.tags ?? {});
            if (normalized) ways.push(normalized);
        }

        if (issues.length > 0) {
            const error = new Error(issues[0].message);
            error.code = issues[0].code;
            error.issues = issues;
            throw error;
        }

        return {
            providerId: this.id,
            fetchedAt: new Date().toISOString(),
            ways,
        };
    }
}

/**
 * @param {string} providerId
 * @param {Object} [options]
 * @returns {import("./RoadNetworkProvider.js").RoadNetworkProvider}
 */
export function createRoadNetworkProvider(providerId = ROAD_PROVIDER_IDS.OVERPASS, options = {}) {
    providerId ??= ROAD_PROVIDER_IDS.OVERPASS;
    switch (providerId) {
        case ROAD_PROVIDER_IDS.OVERPASS:
            return new OverpassRoadProvider(options);
        default:
            throw new TypeError(`Unsupported road network provider "${String(providerId)}".`);
    }
}
