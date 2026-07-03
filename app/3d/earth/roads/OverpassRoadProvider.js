import { DEFAULT_EARTH_IMPORT_CONFIG, ROAD_PROVIDER_IDS } from "../EarthImportConfig.js";
import { isValidGeoBounds, normalizeRoadWay } from "./RoadNetworkProvider.js";
import { defaultFetch } from "../../../util/Fetch.js";

/**
 * @typedef {import("./RoadNetworkProvider.js").GeoBounds} GeoBounds
 * @typedef {import("./RoadNetworkProvider.js").NormalizedRoadNetwork} NormalizedRoadNetwork
 */

function buildOverpassQuery(bounds) {
    const { south, west, north, east } = bounds;
    return `
[out:json][timeout:25];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street)$"](${south},${west},${north},${east});
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
    return refs
        .map((nodeId) => nodeMap.get(nodeId))
        .filter(Boolean);
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
    async fetchRoadNetwork(bounds) {
        if (!isValidGeoBounds(bounds)) {
            throw new Error("Invalid geographic bounds for Overpass query.");
        }

        const response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            },
            body: `data=${encodeURIComponent(buildOverpassQuery(bounds))}`,
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
        for (const element of elements) {
            if (element.type !== "way") continue;
            const points = wayToPoints(element, nodeMap);
            const normalized = normalizeRoadWay(element.id, points, element.tags ?? {});
            if (normalized) ways.push(normalized);
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
export function createRoadNetworkProvider(providerId, options = {}) {
    switch (providerId) {
        case ROAD_PROVIDER_IDS.OVERPASS:
        default:
            return new OverpassRoadProvider(options);
    }
}
