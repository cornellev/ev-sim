import { isAssetBackedObject } from "../../../editor-assets/AssetBackedObject.js";
import { planRoadNetworkGeometry } from "../../../roads/RoadNetworkGeometry.js";
import { assetMapFootprint } from "./mapHitTest.js";

function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function documentSource(value) {
    if (!value || typeof value !== "object") return null;
    return value.document
        ?? value.manifest?.document
        ?? value.environment?.document
        ?? value;
}

/**
 * Layers-ready environment snapshot. Preserves `roads.geometryVersion`,
 * turn rules, edge geometry, and objects. Does not import scenario routing.
 * @param {object | null | undefined} value
 */
export function mapDocumentFrom(value) {
    const source = documentSource(value);
    if (!source || typeof source !== "object") {
        return {
            roads: { nodes: [], edges: [], turnRules: [] },
            buildings: [],
            features: [],
            objects: [],
        };
    }
    const nodes = source.roads?.nodes instanceof Map
        ? [...source.roads.nodes.entries()].map(([id, point]) => ({ id, ...point }))
        : source.roads?.nodes;
    return {
        ...source,
        roads: {
            ...(source.roads ?? {}),
            nodes: Array.isArray(nodes) ? nodes : [],
            edges: Array.isArray(source.roads?.edges) ? source.roads.edges : [],
            turnRules: Array.isArray(source.roads?.turnRules) ? source.roads.turnRules : [],
        },
        buildings: Array.isArray(source.buildings) ? source.buildings : [],
        features: Array.isArray(source.features) ? source.features : [],
        objects: Array.isArray(source.objects) ? source.objects : [],
    };
}

/**
 * World XZ points used to frame a map viewport.
 * @param {{ roads?: object, buildings?: object[], features?: object[], objects?: object[] } | null | undefined} document
 */
export function collectMapFitPoints(document) {
    const points = [];
    const roads = document?.roads ?? {};
    for (const node of roads.nodes ?? []) {
        points.push({ x: finite(node.x), z: finite(node.z) });
    }
    if (Number(roads.geometryVersion ?? 1) === 2) {
        for (const edge of roads.edges ?? []) {
            for (const knot of edge.geometry?.knots ?? []) {
                if (!knot.position) continue;
                points.push({ x: finite(knot.position.x), z: finite(knot.position.z) });
            }
        }
    }
    for (const building of document?.buildings ?? []) {
        for (const corner of building.footprint ?? []) {
            points.push({ x: finite(corner.x), z: finite(corner.z) });
        }
    }
    for (const feature of document?.features ?? []) {
        points.push({ x: finite(feature.x), z: finite(feature.z) });
    }
    for (const record of (document?.objects ?? []).filter(isAssetBackedObject)) {
        for (const point of assetMapFootprint(record)) {
            points.push({ x: finite(point.x), z: finite(point.z) });
        }
    }
    return points;
}

/**
 * Compiled v2 road plan for SVG layers, or null for v1 / invalid records.
 * @param {object | null | undefined} roads
 */
export function compiledMapRoadPlan(roads, { preview = false } = {}) {
    if (preview || Number(roads?.geometryVersion ?? 1) !== 2) return null;
    try {
        return planRoadNetworkGeometry(roads);
    } catch {
        return null;
    }
}
