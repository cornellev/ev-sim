import { createBuiltInIGVCEnvironmentDocument } from "../../3d/igvc/IGVCEnvironmentDocument.js";
import { hashEnvironmentRoadNetwork } from "../../scenarios/route/roadGraph.js";
import { canonicalFiniteNumber, canonicalizeSimulationValue, simulationSha256 } from "../kernel/SimulationHashes.js";

export const WORLD_DESCRIPTION_KIND = "cev-sim.world-description";
export const WORLD_DESCRIPTION_VERSION = 1;

const textEncoder = new TextEncoder();
const DEFAULT_ROAD_WIDTH = 7;
const FEATURE_GEOMETRY = Object.freeze({
    barrel: { size: { x: 0.75, y: 1, z: 0.75 }, centerY: 0.5 },
    cone: { size: { x: 0.36, y: 0.7, z: 0.36 }, centerY: 0.35 },
    tire: { size: { x: 0.44, y: 0.12, z: 0.44 }, centerY: 0.06 },
    "stop-sign": { size: { x: 0.0508, y: 2.1336, z: 0.9144 }, centerY: 1.0668, directional: true },
    "one-way-sign": { size: { x: 0.0254, y: 0.3048, z: 0.6096 }, centerY: 1.9812, directional: true },
});

export function compareUtf8(left, right) {
    const a = textEncoder.encode(String(left));
    const b = textEncoder.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function finite(value, label) {
    const result = Number(value);
    if (!Number.isFinite(result)) throw new TypeError(`${label} must be finite.`);
    return canonicalFiniteNumber(result);
}

function positive(value, label, fallback = null) {
    const result = value === undefined || value === null ? fallback : finite(value, label);
    if (!Number.isFinite(result) || result <= 0) throw new TypeError(`${label} must be greater than zero.`);
    return result;
}

function identifier(value, label) {
    const result = String(value ?? "").trim();
    if (!result) throw new TypeError(`${label} is required.`);
    return result;
}

function assertUnique(entries, field, label) {
    const seen = new Set();
    for (const entry of entries) {
        const id = entry[field];
        if (seen.has(id)) throw new TypeError(`Duplicate ${label} ID "${id}".`);
        seen.add(id);
    }
}

function authored(manifest, document, domain) {
    const key = `${domain}Authored`;
    return manifest?.[key] === true || document?.[key] === true;
}

function selectArrayDomain(manifest, document, fallbackDocument, domain) {
    const authoredDomain = authored(manifest, document, domain);
    const persisted = Array.isArray(document?.[domain]) ? document[domain] : [];
    if (authoredDomain) return { value: persisted, source: "authored" };
    if (persisted.length > 0) return { value: persisted, source: "persisted-template" };
    return {
        value: Array.isArray(fallbackDocument?.[domain]) ? fallbackDocument[domain] : [],
        source: fallbackDocument ? "template-default" : "empty-default",
    };
}

function selectRoadDomain(manifest, document, fallbackDocument) {
    const isAuthored = authored(manifest, document, "roads");
    const persisted = document?.roads && typeof document.roads === "object"
        ? document.roads
        : { nodes: [], edges: [] };
    const hasPersisted = Array.isArray(persisted.nodes) && persisted.nodes.length > 0
        || Array.isArray(persisted.edges) && persisted.edges.length > 0;
    if (isAuthored || hasPersisted) {
        return { value: persisted, source: isAuthored ? "authored" : "persisted-template" };
    }
    return {
        value: fallbackDocument?.roads ?? { nodes: [], edges: [] },
        source: fallbackDocument ? "template-default" : "empty-default",
    };
}

function normalizeNode(node, index) {
    return {
        id: identifier(node?.id, `Road node ${index} ID`),
        x: finite(node?.x, `Road node ${index} x`),
        y: finite(node?.y ?? 0, `Road node ${index} y`),
        z: finite(node?.z, `Road node ${index} z`),
        kind: node?.kind === undefined || node?.kind === null ? null : String(node.kind),
    };
}

function pointOrNull(value, label) {
    if (value === undefined || value === null) return null;
    return {
        x: finite(value.x, `${label} x`),
        y: finite(value.y ?? 0, `${label} y`),
        z: finite(value.z, `${label} z`),
    };
}

function normalizeEdge(edge, index, nodeIds) {
    const result = {
        id: identifier(edge?.id, `Road edge ${index} ID`),
        startNodeId: identifier(edge?.startNodeId, `Road edge ${index} startNodeId`),
        endNodeId: identifier(edge?.endNodeId, `Road edge ${index} endNodeId`),
        bidirectional: edge?.bidirectional !== false && edge?.oneWay !== true,
        direction: edge?.direction ?? edge?.oneWayDirection ?? 1,
        width: positive(edge?.width, `Road edge ${index} width`, DEFAULT_ROAD_WIDTH),
        laneCount: positive(edge?.laneCount, `Road edge ${index} laneCount`, 2),
        shoulderWidth: Math.max(0, finite(edge?.shoulderWidth ?? 0, `Road edge ${index} shoulderWidth`)),
        tension: edge?.tension === undefined || edge?.tension === null
            ? null
            : finite(edge.tension, `Road edge ${index} tension`),
        borderLeft: edge?.borderLeft ?? null,
        borderRight: edge?.borderRight ?? null,
        startArm: pointOrNull(edge?.startArm, `Road edge ${index} startArm`),
        endArm: pointOrNull(edge?.endArm, `Road edge ${index} endArm`),
    };
    if (!nodeIds.has(result.startNodeId)) {
        throw new TypeError(`Road edge "${result.id}" references missing start node "${result.startNodeId}".`);
    }
    if (!nodeIds.has(result.endNodeId)) {
        throw new TypeError(`Road edge "${result.id}" references missing end node "${result.endNodeId}".`);
    }
    if (result.startNodeId === result.endNodeId) {
        throw new TypeError(`Road edge "${result.id}" cannot reference the same node twice.`);
    }
    return result;
}

function normalizeRoads(source) {
    const nodes = (Array.isArray(source?.nodes) ? source.nodes : [])
        .map(normalizeNode)
        .sort((left, right) => compareUtf8(left.id, right.id));
    assertUnique(nodes, "id", "road node");
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = (Array.isArray(source?.edges) ? source.edges : [])
        .map((edge, index) => normalizeEdge(edge, index, nodeIds))
        .sort((left, right) => compareUtf8(left.id, right.id));
    assertUnique(edges, "id", "road edge");
    return { nodes, edges };
}

function normalizeFootprint(source, label) {
    if (!Array.isArray(source) || source.length < 3) {
        throw new TypeError(`${label} must contain at least three points.`);
    }
    const points = source.map((point, index) => ({
        x: finite(point?.x, `${label} point ${index} x`),
        z: finite(point?.z, `${label} point ${index} z`),
    }));
    const area = points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point.x * next.z - next.x * point.z;
    }, 0) * 0.5;
    if (Math.abs(area) <= 1e-12) throw new TypeError(`${label} has zero area.`);
    return area > 0 ? points : [...points].reverse();
}

function pointInTriangle(point, a, b, c) {
    const cross = (left, middle, right) => (
        (middle.x - left.x) * (right.z - left.z)
        - (middle.z - left.z) * (right.x - left.x)
    );
    const ab = cross(a, b, point);
    const bc = cross(b, c, point);
    const ca = cross(c, a, point);
    return ab >= -1e-12 && bc >= -1e-12 && ca >= -1e-12;
}

/** Deterministic ear clipping for counter-clockwise simple XZ polygons. */
export function triangulateFootprint(footprint) {
    if (footprint.length === 3) return [[0, 1, 2]];
    const remaining = footprint.map((_, index) => index);
    const triangles = [];
    while (remaining.length > 3) {
        let ear = -1;
        for (let offset = 0; offset < remaining.length; offset += 1) {
            const previous = remaining[(offset - 1 + remaining.length) % remaining.length];
            const current = remaining[offset];
            const next = remaining[(offset + 1) % remaining.length];
            const a = footprint[previous];
            const b = footprint[current];
            const c = footprint[next];
            const convex = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x) > 1e-12;
            if (!convex) continue;
            const contains = remaining.some((candidate) => (
                candidate !== previous && candidate !== current && candidate !== next
                && pointInTriangle(footprint[candidate], a, b, c)
            ));
            if (!contains) {
                ear = offset;
                triangles.push([previous, current, next]);
                break;
            }
        }
        if (ear < 0) throw new TypeError("Building footprint must be a simple polygon.");
        remaining.splice(ear, 1);
    }
    triangles.push([remaining[0], remaining[1], remaining[2]]);
    return triangles;
}

function footprintBounds(footprint, minY, maxY) {
    return {
        min: {
            x: Math.min(...footprint.map((point) => point.x)),
            y: minY,
            z: Math.min(...footprint.map((point) => point.z)),
        },
        max: {
            x: Math.max(...footprint.map((point) => point.x)),
            y: maxY,
            z: Math.max(...footprint.map((point) => point.z)),
        },
    };
}

function normalizeBuilding(building, index) {
    const id = identifier(building?.buildingId ?? building?.id, `Building ${index} ID`);
    const footprint = normalizeFootprint(building?.footprint, `Building "${id}" footprint`);
    const height = positive(building?.height, `Building "${id}" height`);
    return {
        id,
        footprint,
        height,
        transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            scale: { x: 1, y: 1, z: 1 },
        },
        textureId: Number.isFinite(Number(building?.textureId)) ? Number(building.textureId) : 0,
        tags: [...new Set((building?.tags ?? ["building"]).map(String))].sort(compareUtf8),
        meshName: String(building?.meshName ?? id),
    };
}

function directionYaw(dir) {
    const normalized = ((Math.floor(Number(dir) || 0) % 4) + 4) % 4;
    return normalized * Math.PI * 0.5;
}

function rectangleFootprint(x, z, size, yaw) {
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const halfX = size.x * 0.5;
    const halfZ = size.z * 0.5;
    return [
        { x: -halfX, z: -halfZ },
        { x: halfX, z: -halfZ },
        { x: halfX, z: halfZ },
        { x: -halfX, z: halfZ },
    ].map((point) => ({
        x: x + point.x * cosine + point.z * sine,
        z: z - point.x * sine + point.z * cosine,
    }));
}

function normalizeFeature(feature, index) {
    const id = identifier(feature?.id, `Feature ${index} ID`);
    const type = identifier(feature?.type, `Feature "${id}" type`);
    const geometry = FEATURE_GEOMETRY[type];
    if (!geometry) throw new TypeError(`Feature "${id}" has unknown type "${type}".`);
    const dir = Math.floor(finite(feature?.dir ?? 0, `Feature "${id}" direction`));
    const rotationY = finite(feature?.rotationY ?? 0, `Feature "${id}" rotationY`);
    const x = finite(feature?.x, `Feature "${id}" x`);
    const z = finite(feature?.z, `Feature "${id}" z`);
    const yaw = rotationY + (geometry.directional ? directionYaw(dir) : 0);
    return {
        id,
        type,
        transform: {
            position: { x, y: geometry.centerY, z },
            rotation: { x: 0, y: yaw, z: 0, order: "XYZ" },
            scale: { x: 1, y: 1, z: 1 },
        },
        dir,
        rotationY,
        size: { ...geometry.size },
        tags: [...new Set((feature?.tags ?? []).map(String))].sort(compareUtf8),
    };
}

function roadSurfaces(roads) {
    const nodes = new Map(roads.nodes.map((node) => [node.id, node]));
    const corridors = roads.edges.map((edge) => {
        const start = nodes.get(edge.startNodeId);
        const end = nodes.get(edge.endNodeId);
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        const nx = length > 0 ? -dz / length : 0;
        const nz = length > 0 ? dx / length : 0;
        const halfWidth = edge.width * 0.5 + edge.shoulderWidth;
        const footprint = [
            { x: start.x + nx * halfWidth, z: start.z + nz * halfWidth },
            { x: end.x + nx * halfWidth, z: end.z + nz * halfWidth },
            { x: end.x - nx * halfWidth, z: end.z - nz * halfWidth },
            { x: start.x - nx * halfWidth, z: start.z - nz * halfWidth },
        ];
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);
        return {
            id: `road-surface:${edge.id}`,
            sourceId: edge.id,
            kind: "road-corridor",
            footprint,
            minY,
            maxY,
            bounds: footprintBounds(footprint, minY, maxY),
        };
    });
    const degree = new Map();
    for (const edge of roads.edges) {
        degree.set(edge.startNodeId, (degree.get(edge.startNodeId) ?? 0) + 1);
        degree.set(edge.endNodeId, (degree.get(edge.endNodeId) ?? 0) + 1);
    }
    const intersections = roads.nodes
        .filter((node) => node.kind === "intersection" || (degree.get(node.id) ?? 0) > 1)
        .map((node) => {
            const incident = roads.edges.filter((edge) => edge.startNodeId === node.id || edge.endNodeId === node.id);
            const radius = Math.max(5, ...incident.map((edge) => edge.width * 0.5 + edge.shoulderWidth));
            return {
                id: `intersection-surface:${node.id}`,
                sourceId: node.id,
                kind: "intersection-disc",
                center: { x: node.x, y: node.y, z: node.z },
                radius,
                bounds: {
                    min: { x: node.x - radius, y: node.y, z: node.z - radius },
                    max: { x: node.x + radius, y: node.y, z: node.z + radius },
                },
            };
        });
    return [...corridors, ...intersections].sort((left, right) => compareUtf8(left.id, right.id));
}

function createObstacles(buildings, features) {
    const buildingObstacles = buildings.map((building) => {
        const bounds = footprintBounds(building.footprint, 0, building.height);
        return {
            id: `building:${building.id}`,
            sourceId: building.id,
            sourceType: "building",
            shape: "extruded-footprint",
            footprint: building.footprint.map((point) => ({ ...point })),
            triangles: triangulateFootprint(building.footprint),
            minY: 0,
            maxY: building.height,
            bounds,
        };
    });
    const featureObstacles = features.map((feature) => {
        const { x, y, z } = feature.transform.position;
        const footprint = rectangleFootprint(x, z, feature.size, feature.transform.rotation.y);
        const minY = y - feature.size.y * 0.5;
        const maxY = y + feature.size.y * 0.5;
        return {
            id: `feature:${feature.id}`,
            sourceId: feature.id,
            sourceType: feature.type,
            shape: "oriented-box-prism",
            footprint,
            triangles: [[0, 1, 2], [0, 2, 3]],
            minY,
            maxY,
            bounds: footprintBounds(footprint, minY, maxY),
        };
    });
    return [...buildingObstacles, ...featureObstacles]
        .sort((left, right) => compareUtf8(left.id, right.id));
}

function aggregateBounds(roads, drivableSurfaces, obstacles) {
    const points = roads.nodes.map((node) => ({ x: node.x, y: node.y, z: node.z }));
    for (const surface of drivableSurfaces) {
        points.push(surface.bounds.min, surface.bounds.max);
    }
    for (const obstacle of obstacles) {
        points.push(obstacle.bounds.min, obstacle.bounds.max);
    }
    if (points.length === 0) {
        return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    }
    return {
        min: {
            x: Math.min(...points.map((point) => point.x)),
            y: Math.min(...points.map((point) => point.y)),
            z: Math.min(...points.map((point) => point.z)),
        },
        max: {
            x: Math.max(...points.map((point) => point.x)),
            y: Math.max(...points.map((point) => point.y)),
            z: Math.max(...points.map((point) => point.z)),
        },
    };
}

function sourceManifest(value) {
    return value?.manifest?.document ? value.manifest : value;
}

export function createWorldDescription(value = {}) {
    const manifest = sourceManifest(value) ?? {};
    const document = manifest.document ?? {};
    const environmentId = identifier(
        manifest.environmentId ?? document.environmentId ?? value?.environmentId,
        "Environment ID",
    );
    const templateId = String(manifest.templateId ?? (environmentId === "igvc" ? "igvc" : "blank"));
    const fallbackDocument = templateId === "igvc" ? createBuiltInIGVCEnvironmentDocument() : null;
    const roadDomain = selectRoadDomain(manifest, document, fallbackDocument);
    const buildingDomain = selectArrayDomain(manifest, document, fallbackDocument, "buildings");
    const featureDomain = selectArrayDomain(manifest, document, fallbackDocument, "features");
    const roads = normalizeRoads(roadDomain.value);
    const buildings = buildingDomain.value
        .map(normalizeBuilding)
        .sort((left, right) => compareUtf8(left.id, right.id));
    const features = featureDomain.value
        .map(normalizeFeature)
        .sort((left, right) => compareUtf8(left.id, right.id));
    assertUnique(buildings, "id", "building");
    assertUnique(features, "id", "feature");
    const obstacles = createObstacles(buildings, features);
    const drivableSurfaces = roadSurfaces(roads);
    const description = {
        kind: WORLD_DESCRIPTION_KIND,
        version: WORLD_DESCRIPTION_VERSION,
        environmentId,
        templateId,
        roadStylePreset: String(manifest.roadStylePreset ?? (templateId === "igvc" ? "igvc" : "default")),
        coordinateFrame: {
            handedness: "right",
            units: "meters",
            upAxis: "+Y",
            forwardAxis: "+X",
            heading: "(cos(yaw),0,-sin(yaw))",
        },
        domainSources: {
            roads: roadDomain.source,
            buildings: buildingDomain.source,
            features: featureDomain.source,
        },
        roads,
        roadNetworkHash: hashEnvironmentRoadNetwork({ environmentId, roads }),
        drivableSurfaces,
        buildings,
        features,
        obstacles,
        bounds: aggregateBounds(roads, drivableSurfaces, obstacles),
    };
    return canonicalizeSimulationValue(description);
}

export function hashWorldDescription(description) {
    if (description?.kind !== WORLD_DESCRIPTION_KIND || description?.version !== WORLD_DESCRIPTION_VERSION) {
        throw new TypeError(`Expected ${WORLD_DESCRIPTION_KIND} v${WORLD_DESCRIPTION_VERSION}.`);
    }
    return simulationSha256(description);
}

export function createWorldResource(value) {
    const description = value?.kind === WORLD_DESCRIPTION_KIND ? value : createWorldDescription(value);
    return { description, hash: hashWorldDescription(description) };
}

export function assertWorldResource(resource) {
    if (!resource?.description || !resource?.hash) throw new TypeError("Resolved world resource is required.");
    const hash = hashWorldDescription(resource.description);
    if (hash !== resource.hash) throw new Error(`Resolved world hash mismatch: expected ${resource.hash}, computed ${hash}.`);
    return resource.description;
}
