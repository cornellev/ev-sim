/**
 * Pure ED-08 road import pipeline. Fetching is injected; clipping and draft
 * construction never mutate an EnvironmentDocument.
 */

import { DEFAULT_EARTH_IMPORT_CONFIG, ROAD_PROVIDER_IDS, validateBounds } from "../EarthImportConfig.js";
import { geodeticToLocal, createGeoFrame } from "../GeoFrame.js";
import { createRoadNetworkProvider } from "./OverpassRoadProvider.js";

const EPSILON = 1e-12;
const WEB_MERCATOR_RADIUS = 6378137;
const HIGHWAY_WIDTHS = Object.freeze({
    motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8,
    residential: 7, unclassified: 7, service: 5, living_street: 6,
});

function issue(path, code, message, severity = "error") {
    return { path, code, message, severity };
}

function cleanNumber(value, fallback = null) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}

function positiveInteger(value) {
    const result = Number(value);
    return Number.isInteger(result) && result > 0 ? result : null;
}

function directionalLaneCount(tags, key, path, issues) {
    if (tags[key] === undefined || tags[key] === null || tags[key] === "") return null;
    const result = Number(tags[key]);
    if (Number.isInteger(result) && result >= 0) return result;
    issues.push(issue(path, "road-import.lanes.invalid", `${key} must be a non-negative integer.`));
    return null;
}

function truthyTag(value) {
    return value === "yes" || value === "true" || value === "1";
}

function gradeOf(tags = {}) {
    return {
        layer: Number.isInteger(Number(tags.layer)) ? Number(tags.layer) : 0,
        bridge: truthyTag(tags.bridge),
        tunnel: truthyTag(tags.tunnel),
    };
}

function pointEquals(left, right) {
    return Math.abs(left.lat - right.lat) <= EPSILON && Math.abs(left.lng - right.lng) <= EPSILON;
}

function interpolate(a, b, t) {
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

function boundaryPoint(way, segmentIndex, a, b, t) {
    if (t <= EPSILON) return { ...a };
    if (t >= 1 - EPSILON) return { ...b };
    const point = interpolate(a, b, t);
    const fraction = Number(t.toFixed(12)).toString();
    return {
        ...point,
        id: `boundary:${way.id}:${segmentIndex}:${fraction}`,
        boundary: { wayId: String(way.id), segmentIndex, fraction: Number(fraction) },
    };
}

/** Liang-Barsky clipping in longitude/latitude coordinates. */
function clipSegment(a, b, bounds) {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    let t0 = 0;
    let t1 = 1;
    const tests = [
        [-dx, a.lng - bounds.west],
        [dx, bounds.east - a.lng],
        [-dy, a.lat - bounds.south],
        [dy, bounds.north - a.lat],
    ];
    for (const [p, q] of tests) {
        if (Math.abs(p) <= EPSILON) {
            if (q < 0) return null;
            continue;
        }
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        if (t0 > t1 + EPSILON) return null;
    }
    return { t0: Math.max(0, t0), t1: Math.min(1, t1) };
}

function finishFragment(fragments, points) {
    const deduped = [];
    for (const point of points) {
        if (deduped.length === 0 || !pointEquals(deduped.at(-1), point)) deduped.push(point);
    }
    if (deduped.length > 1) fragments.push(deduped);
}

/** Clip all way segments and retain distinct fragments for exit/re-entry. */
export function clipRoadNetworkToArea(network, bounds) {
    const ways = [];
    for (const way of network?.ways ?? []) {
        const fragments = [];
        let current = [];
        for (let index = 0; index < way.points.length - 1; index += 1) {
            const a = way.points[index];
            const b = way.points[index + 1];
            const clipped = clipSegment(a, b, bounds);
            if (!clipped || clipped.t1 - clipped.t0 <= EPSILON) {
                finishFragment(fragments, current);
                current = [];
                continue;
            }
            const start = boundaryPoint(way, index, a, b, clipped.t0);
            const end = boundaryPoint(way, index, a, b, clipped.t1);
            if (current.length > 0 && !pointEquals(current.at(-1), start)) {
                finishFragment(fragments, current);
                current = [];
            }
            if (current.length === 0) current.push(start);
            if (!pointEquals(current.at(-1), end)) current.push(end);
            if (clipped.t1 < 1 - EPSILON) {
                finishFragment(fragments, current);
                current = [];
            }
        }
        finishFragment(fragments, current);
        fragments.forEach((points, fragmentIndex) => ways.push({
            id: `${way.id}#${fragmentIndex}`,
            sourceWayId: String(way.sourceWayId ?? way.id),
            fragmentIndex,
            tags: { ...(way.tags ?? {}) },
            points,
        }));
    }
    return {
        providerId: String(network?.providerId ?? ""),
        fetchedAt: network?.fetchedAt ?? null,
        ways,
    };
}

function localPoint(point, frame) {
    if (frame?.version) {
        const local = geodeticToLocal({ lat: point.lat, lng: point.lng, height: 0 }, frame);
        return { x: local.x, y: 0, z: local.z };
    }
    const anchor = frame?.anchor ?? frame;
    const mercator = (lat, lng) => ({
        x: WEB_MERCATOR_RADIUS * Number(lng) * Math.PI / 180,
        z: WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + Number(lat) * Math.PI / 360)),
    });
    const value = mercator(point.lat, point.lng);
    const origin = mercator(anchor.lat, anchor.lng);
    return { x: value.x - origin.x, y: 0, z: value.z - origin.z };
}

function perpendicularDistance(point, start, end) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= EPSILON) return Math.hypot(point.x - start.x, point.z - start.z);
    const t = ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared;
    const x = start.x + Math.max(0, Math.min(1, t)) * dx;
    const z = start.z + Math.max(0, Math.min(1, t)) * dz;
    return Math.hypot(point.x - x, point.z - z);
}

function simplifySpan(points, start, end, tolerance, keep) {
    if (end <= start + 1) return;
    let candidate = -1;
    let distance = -1;
    for (let index = start + 1; index < end; index += 1) {
        const next = perpendicularDistance(points[index].local, points[start].local, points[end].local);
        if (next > distance) { distance = next; candidate = index; }
    }
    if (distance > tolerance) {
        keep.add(candidate);
        simplifySpan(points, start, candidate, tolerance, keep);
        simplifySpan(points, candidate, end, tolerance, keep);
    }
}

function simplifiedProtected(points, sharedIds, tolerance) {
    const protectedIndices = points.flatMap((point, index) => (
        index === 0 || index === points.length - 1 || point.boundary || (point.id && sharedIds.has(String(point.id))) ? [index] : []
    ));
    const keep = new Set(protectedIndices);
    for (let index = 0; index < protectedIndices.length - 1; index += 1) {
        simplifySpan(points, protectedIndices[index], protectedIndices[index + 1], tolerance, keep);
    }
    return points.filter((_, index) => keep.has(index));
}

function roadWidth(tags = {}) {
    const tagged = cleanNumber(String(tags.width ?? "").split(";")[0]);
    if (tagged && tagged > 0) return tagged;
    return HIGHWAY_WIDTHS[tags.highway] ?? 7;
}

function lanePlan(tags, path, issues) {
    const forwardTagged = tags["lanes:forward"] !== undefined;
    const backwardTagged = tags["lanes:backward"] !== undefined;
    const forward = directionalLaneCount(tags, "lanes:forward", path, issues);
    const backward = directionalLaneCount(tags, "lanes:backward", path, issues);
    let total = positiveInteger(tags.lanes);
    if (tags.lanes !== undefined && total === null) {
        issues.push(issue(path, "road-import.lanes.invalid", "lanes must be a positive integer."));
    }
    const reverse = tags.oneway === "-1" || tags.oneway === "reverse";
    const oneWay = reverse || truthyTag(tags.oneway);
    if (oneWay && (forwardTagged || backwardTagged)) {
        const travel = reverse ? backward : forward;
        const opposing = reverse ? forward : backward;
        const travelKey = reverse ? "lanes:backward" : "lanes:forward";
        const opposingKey = reverse ? "lanes:forward" : "lanes:backward";
        if (travel === null || travel < 1) {
            issues.push(issue(path, "road-import.lanes.ambiguous", `${travelKey} must declare the lanes in the one-way travel direction.`));
        } else {
            if (total && total !== travel) {
                issues.push(issue(path, "road-import.lanes.mismatch", `lanes disagrees with ${travelKey}.`));
            }
            total = travel;
        }
        if (opposing !== null && opposing > 0) {
            issues.push(issue(path, "road-import.lanes.ambiguous", `${opposingKey} cannot contain travel lanes on a one-way road.`));
        }
    } else if (!oneWay && (forwardTagged || backwardTagged)) {
        if (forward === null || backward === null || forward < 1 || backward < 1) {
            issues.push(issue(path, "road-import.lanes.ambiguous", "Both lanes:forward and lanes:backward are required for an asymmetric two-way road."));
        } else if (total && total !== forward + backward) {
            issues.push(issue(path, "road-import.lanes.mismatch", "lanes disagrees with lanes:forward plus lanes:backward."));
        }
        if (forward !== null && backward !== null && forward > 0 && backward > 0) total = forward + backward;
    }
    total ??= oneWay ? 1 : tags.highway === "motorway" || tags.highway === "trunk" ? 4 : 2;
    const width = roadWidth(tags);
    const result = {
        width,
        laneCount: total,
        bidirectional: !oneWay,
        ...(reverse ? { direction: -1 } : {}),
    };
    if (!oneWay && forward > 0 && backward > 0) {
        const laneWidth = width / total;
        result.lanes = [
            ...Array.from({ length: forward }, (_, index) => ({ id: `lane-f${index}`, direction: 1, width: laneWidth })),
            ...Array.from({ length: backward }, (_, index) => ({ id: `lane-b${index}`, direction: -1, width: laneWidth })),
        ];
    } else if (!oneWay && total > 1 && total % 2 !== 0) {
        issues.push(issue(path, "road-import.lanes.ambiguous", `Two-way OSM road declares odd lane count ${total} without directional counts.`));
    }
    return result;
}

function sourceIdentity(point, tags) {
    if (!point.id || point.boundary) return String(point.id ?? "");
    return `osm:${point.id}`;
}

function safeId(value) {
    return String(value).replace(/[^A-Za-z0-9_.:-]+/g, "-");
}

/** Build a deterministic geometry-v2 road draft from a clipped network. */
export function buildRoadImportDraft(network, frame, options = {}) {
    const geoFrame = frame?.version ? createGeoFrame(frame) : frame;
    const tolerance = options.simplifyToleranceMeters ?? DEFAULT_EARTH_IMPORT_CONFIG.roadSimplifyToleranceMeters;
    const importId = safeId(options.importId ?? `${network.providerId}:${network.fetchedAt ?? "draft"}`);
    const referenceCounts = new Map();
    for (const way of network.ways ?? []) for (const point of way.points ?? []) {
        if (!point.id || point.boundary) continue;
        const key = sourceIdentity(point, way.tags);
        referenceCounts.set(key, (referenceCounts.get(key) ?? 0) + 1);
    }
    const sharedIds = new Set([...referenceCounts].filter(([, count]) => count > 1).map(([id]) => id.split("osm:").at(-1)));
    const nodes = [];
    const edges = [];
    const nodeByKey = new Map();
    const issues = [];
    const degree = new Map();

    const getNode = (point, way) => {
        const identity = sourceIdentity(point, way.tags) || `${way.id}:${point.lat}:${point.lng}`;
        const key = point.boundary ? `${way.id}:${identity}` : identity;
        if (nodeByKey.has(key)) return nodeByKey.get(key);
        const local = localPoint(point, geoFrame);
        const grade = gradeOf(way.tags);
        const node = {
            id: `import:${importId}:node:${safeId(key)}`,
            ...local,
            kind: "endpoint",
            source: {
                providerId: String(network.providerId), importId,
                ...(point.boundary ? { boundaryId: String(point.id) } : { osmNodeId: String(point.id ?? "") }),
                ...grade,
            },
        };
        nodes.push(node);
        nodeByKey.set(key, node);
        return node;
    };

    for (const way of network.ways ?? []) {
        const withLocal = way.points.map((point) => ({ ...point, local: localPoint(point, geoFrame) }));
        const points = simplifiedProtected(withLocal, sharedIds, tolerance);
        const splitIndices = points.flatMap((point, index) => (
            index === 0 || index === points.length - 1 || (point.id && sharedIds.has(String(point.id))) ? [index] : []
        ));
        if (points.length > 2 && pointEquals(points[0], points.at(-1)) && splitIndices.length === 2) {
            splitIndices.splice(1, 0, Math.floor(points.length / 2));
        }
        for (let segment = 0; segment < splitIndices.length - 1; segment += 1) {
            const segmentPoints = points.slice(splitIndices[segment], splitIndices[segment + 1] + 1);
            if (segmentPoints.length < 2) continue;
            const start = getNode(segmentPoints[0], way);
            const end = getNode(segmentPoints.at(-1), way);
            if (start.id === end.id) {
                issues.push(issue(["ways", way.id], "road-import.zero-length", `OSM way ${way.sourceWayId} produced a zero-length edge.`));
                continue;
            }
            const grade = gradeOf(way.tags);
            const lane = lanePlan(way.tags, ["ways", way.id, "lanes"], issues);
            const edgeId = `import:${importId}:edge:${safeId(way.id)}:${segment}`;
            const knots = [
                { id: "start" },
                ...segmentPoints.slice(1, -1).map((point, index) => ({ id: `shape-${index}`, position: { ...point.local } })),
                { id: "end" },
            ];
            edges.push({
                id: edgeId,
                startNodeId: start.id,
                endNodeId: end.id,
                ...lane,
                shoulderWidth: null,
                startArm: null,
                endArm: null,
                geometry: { version: 1, kind: "polyline", knots },
                source: {
                    providerId: String(network.providerId), importId,
                    osmWayId: String(way.sourceWayId), fragmentId: String(way.id), ...grade,
                },
            });
            degree.set(start.id, (degree.get(start.id) ?? 0) + 1);
            degree.set(end.id, (degree.get(end.id) ?? 0) + 1);
        }
    }
    for (const node of nodes) node.kind = (degree.get(node.id) ?? 0) > 1 ? "intersection" : "endpoint";
    for (const [nodeId, count] of degree) if (count > 4) {
        issues.push(issue(["roads", "nodes", nodeId], "road-import.degree-unsupported", `Imported junction ${nodeId} has degree ${count}; the current road contract supports at most 4.`));
    }
    return {
        importId,
        providerId: String(network.providerId),
        roads: { geometryVersion: 2, nodes, edges, turnRules: [] },
        provenance: { providerId: String(network.providerId), fetchedAt: network.fetchedAt ?? null },
        statistics: { wayCount: network.ways?.length ?? 0, nodeCount: nodes.length, edgeCount: edges.length },
        issues,
    };
}

export class RoadImportService {
    constructor({ providerFactory = createRoadNetworkProvider, providerId = ROAD_PROVIDER_IDS.OVERPASS, fetchImpl } = {}) {
        this.providerFactory = providerFactory;
        this.providerId = providerId;
        this.fetchImpl = fetchImpl;
    }

    async fetch(bounds, filters = {}, signal) {
        const validation = validateBounds(bounds);
        if (!validation.ok) throw new TypeError(validation.error);
        const providerId = filters.providerId ?? this.providerId;
        const provider = this.providerFactory(providerId, { fetchImpl: this.fetchImpl });
        const { providerId: _providerId, ...providerFilters } = filters;
        return provider.fetchRoadNetwork(bounds, { filters: providerFilters, signal });
    }

    clipToArea(network, area) {
        return clipRoadNetworkToArea(network, area);
    }

    buildDraft(clippedNetwork, geoFrame, options = {}) {
        return buildRoadImportDraft(clippedNetwork, geoFrame, options);
    }
}
