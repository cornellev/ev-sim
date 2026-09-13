import { FEATURE_GEOMETRY_BY_TYPE } from "../../3d/editor/objects/types/builtinProp.js";
import { createBuiltInIGVCEnvironmentDocument } from "../../3d/igvc/IGVCEnvironmentDocument.js";
import {
    edgeAllowsArrivalAtNode,
    edgeAllowsDepartureFromNode,
    movementRuleKey,
    validateRoadLaneLayout,
} from "../../roads/RoadLaneModel.js";
import { hashEnvironmentRoadNetwork } from "../../scenarios/route/roadGraph.js";
import { canonicalFiniteNumber, canonicalizeSimulationValue, simulationSha256 } from "../kernel/SimulationHashes.js";
import { authorRoadsFromMetric, cloneRoadGeometry, normalizeMetricRoads, roadGeometryVersionOf, validateRoadDomain } from "../../roads/RoadGeometryRecord.js";
import { compileRoadNetworkGeometry, planRoadNetworkGeometry } from "../../roads/RoadNetworkGeometry.js";
import { ROAD_GEOMETRY_POLICY_V1 } from "../../roads/RoadGeometryPolicy.js";
import { validateAssetMetricsDomain } from "../../editor-assets/AssetMetricSnapshot.js";

export const WORLD_DESCRIPTION_KIND = "cev-sim.world-description";
export const WORLD_DESCRIPTION_VERSION = 1;
export const WORLD_DESCRIPTION_V2 = 2;
export const WORLD_DESCRIPTION_V3 = 3;
export const SUPPORTED_WORLD_DESCRIPTION_VERSIONS = Object.freeze([WORLD_DESCRIPTION_VERSION, WORLD_DESCRIPTION_V2, WORLD_DESCRIPTION_V3]);

const textEncoder = new TextEncoder();
const DEFAULT_ROAD_WIDTH = 7;

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

function normalizeLanes(lanes, index) {
    if (!Array.isArray(lanes)) return null;
    return lanes.map((lane, laneIndex) => {
        const direction = Number(lane?.direction);
        if (![1, -1, 0].includes(direction)) throw new TypeError(`Road edge ${index} lane ${laneIndex} direction must be 1, -1, or 0.`);
        return {
            id: identifier(lane?.id, `Road edge ${index} lane ${laneIndex} ID`),
            direction,
            width: positive(lane?.width, `Road edge ${index} lane ${laneIndex} width`),
        };
    });
}

function normalizeEdge(edge, index, nodeIds, geometryVersion = 1) {
    const lanes = normalizeLanes(edge?.lanes, index);
    if (lanes && geometryVersion !== 2) throw new TypeError(`Road edge ${index} explicit lanes require road geometry version 2.`);
    const result = {
        id: identifier(edge?.id, `Road edge ${index} ID`),
        startNodeId: identifier(edge?.startNodeId, `Road edge ${index} startNodeId`),
        endNodeId: identifier(edge?.endNodeId, `Road edge ${index} endNodeId`),
        bidirectional: edge?.bidirectional !== false && edge?.oneWay !== true,
        direction: edge?.direction ?? edge?.oneWayDirection ?? 1,
        width: positive(edge?.width, `Road edge ${index} width`, DEFAULT_ROAD_WIDTH),
        laneCount: positive(edge?.laneCount, `Road edge ${index} laneCount`, 2),
        ...(lanes ? { lanes } : {}),
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
    const laneLayout = validateRoadLaneLayout(result, { geometryVersion });
    if (!laneLayout.ok) {
        throw new TypeError(`Road edge "${result.id}" has an invalid lane layout: ${laneLayout.error}`);
    }
    return result;
}

function normalizeTurnRules(source, nodes, edges) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
    const seen = new Set();
    const result = (Array.isArray(source) ? source : []).map((rule, index) => {
        const normalized = {
            nodeId: identifier(rule?.nodeId, `Road turn rule ${index} nodeId`),
            fromEdgeId: identifier(rule?.fromEdgeId, `Road turn rule ${index} fromEdgeId`),
            toEdgeId: identifier(rule?.toEdgeId, `Road turn rule ${index} toEdgeId`),
            allowed: rule?.allowed,
        };
        if (typeof normalized.allowed !== "boolean") {
            throw new TypeError(`Road turn rule ${index} allowed must be a boolean.`);
        }
        const fromEdge = edgeById.get(normalized.fromEdgeId);
        const toEdge = edgeById.get(normalized.toEdgeId);
        if (!nodeById.has(normalized.nodeId) || !fromEdge || !toEdge) {
            throw new TypeError(`Road turn rule ${index} references a missing node or edge.`);
        }
        if (!edgeAllowsArrivalAtNode(fromEdge, normalized.nodeId)) {
            throw new TypeError(`Road turn rule ${index} fromEdgeId cannot arrive at its node.`);
        }
        if (!edgeAllowsDepartureFromNode(toEdge, normalized.nodeId)) {
            throw new TypeError(`Road turn rule ${index} toEdgeId cannot depart from its node.`);
        }
        const key = movementRuleKey(normalized.nodeId, normalized.fromEdgeId, normalized.toEdgeId);
        if (seen.has(key)) throw new TypeError(`Duplicate road turn rule movement "${key}".`);
        seen.add(key);
        return normalized;
    });
    return result.sort((left, right) => (
        compareUtf8(
            movementRuleKey(left.nodeId, left.fromEdgeId, left.toEdgeId),
            movementRuleKey(right.nodeId, right.fromEdgeId, right.toEdgeId),
        )
    ));
}

function normalizeRoads(source, geometryVersion = 1) {
    const nodes = (Array.isArray(source?.nodes) ? source.nodes : [])
        .map(normalizeNode)
        .sort((left, right) => compareUtf8(left.id, right.id));
    assertUnique(nodes, "id", "road node");
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = (Array.isArray(source?.edges) ? source.edges : [])
        .map((edge, index) => normalizeEdge(edge, index, nodeIds, geometryVersion))
        .sort((left, right) => compareUtf8(left.id, right.id));
    assertUnique(edges, "id", "road edge");
    const turnRules = normalizeTurnRules(source?.turnRules, nodes, edges);
    return {
        nodes,
        edges,
        ...(turnRules.length > 0 ? { turnRules } : {}),
    };
}

function normalizeRoadsV2(source) {
    const normalized = normalizeRoads(source, 2);
    const geometryById = new Map((source?.edges ?? []).map((edge) => [String(edge.id), cloneRoadGeometry(edge.geometry)]));
    const roads = {
        geometryVersion: 2,
        nodes: normalized.nodes,
        edges: normalized.edges.map((edge) => ({ ...edge, geometry: geometryById.get(edge.id) })),
        ...(normalized.turnRules ? { turnRules: normalized.turnRules } : {}),
    };
    const validation = validateRoadDomain(roads);
    if (!validation.ok) throw new TypeError(validation.issues[0].message);
    return roads;
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
    const geometry = FEATURE_GEOMETRY_BY_TYPE[type];
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

function transformAssetMetricPoint(point, instance, label) {
    if (!Array.isArray(point) || point.length !== 3) throw new TypeError(`${label} must be an xyz array.`);
    const c = Math.cos(finite(instance.rotationY, `${label} instance yaw`));
    const s = Math.sin(instance.rotationY);
    const sx = positive(instance.scale?.x, `${label} instance scale.x`);
    const sy = positive(instance.scale?.y, `${label} instance scale.y`);
    const sz = positive(instance.scale?.z, `${label} instance scale.z`);
    const x = finite(point[0], `${label} x`) * sx;
    const y = finite(point[1], `${label} y`) * sy;
    const z = finite(point[2], `${label} z`) * sz;
    return [
        finite(instance.position?.x, `${label} instance position.x`) + c * x + s * z,
        finite(instance.position?.y, `${label} instance position.y`) + y,
        finite(instance.position?.z, `${label} instance position.z`) - s * x + c * z,
    ];
}

function meshBounds(vertices) {
    return {
        min: { x: Math.min(...vertices.map((point) => point[0])), y: Math.min(...vertices.map((point) => point[1])), z: Math.min(...vertices.map((point) => point[2])) },
        max: { x: Math.max(...vertices.map((point) => point[0])), y: Math.max(...vertices.map((point) => point[1])), z: Math.max(...vertices.map((point) => point[2])) },
    };
}

function compileAssetProxyChannel(records, instance, instanceId, channel) {
    return records.map((record, index) => {
        const id = `${instanceId}/${identifier(record.id, `${channel} proxy ${index} ID`)}`;
        const vertices = record.vertices.map((point, vertexIndex) => transformAssetMetricPoint(point, instance, `${id} vertex ${vertexIndex}`));
        return {
            id,
            sourceId: instanceId,
            kind: channel === "collision" ? "convex" : "mesh",
            ...(channel === "lidar" ? { semantic: identifier(record.semantic, `${id} semantic class`) } : {}),
            vertices,
            triangles: record.triangles.map((triangle) => [...triangle]),
            bounds: meshBounds(vertices),
        };
    }).sort((left, right) => compareUtf8(left.id, right.id));
}

function compileAssetProxies(document) {
    const issues = validateAssetMetricsDomain(document);
    if (issues.length > 0) throw Object.assign(new TypeError(issues[0].message), { issues });
    const metrics = new Map((document.assetMetrics?.definitions ?? []).map((entry) => [`${entry.assetId}@${entry.revision}`, entry]));
    return (document.objects ?? [])
        .filter((record) => record.typeId === "asset-instance" && record.typeVersion === 2)
        .map((record) => {
            const instance = record.components.asset;
            const metric = metrics.get(`${instance.assetId}@${instance.revision}`);
            return {
                id: String(record.id),
                sourceId: String(record.id),
                collision: compileAssetProxyChannel(metric.collision, instance, String(record.id), "collision"),
                lidar: compileAssetProxyChannel(metric.lidar, instance, String(record.id), "lidar"),
            };
        })
        .filter((entry) => entry.collision.length > 0 || entry.lidar.length > 0)
        .sort((left, right) => compareUtf8(left.id, right.id));
}

function boundsWithAssetProxies(base, assetProxies) {
    const points = [base.min, base.max];
    for (const instance of assetProxies) for (const proxy of [...instance.collision, ...instance.lidar]) {
        points.push(proxy.bounds.min, proxy.bounds.max);
    }
    return {
        min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)), z: Math.min(...points.map((point) => point.z)) },
        max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)), z: Math.max(...points.map((point) => point.z)) },
    };
}

export function createWorldDescriptionV1(value = {}) {
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

function compiledRoadSurfaces(compiled) {
    const edges = compiled.edges.map((edge) => ({
        id: `road-surface:${edge.id}`,
        sourceId: edge.id,
        kind: "road-mesh",
        vertices: edge.vertices.map((point) => ({ ...point })),
        indices: [...edge.indices],
        bounds: edge.bounds,
    }));
    const junctions = compiled.junctions.map((junction) => ({
        id: `intersection-surface:${junction.id}`,
        sourceId: junction.id,
        kind: "junction-mesh",
        vertices: junction.vertices.map((point) => ({ ...point })),
        indices: [...junction.indices],
        bounds: junction.bounds,
    }));
    return [...edges, ...junctions].sort((left, right) => compareUtf8(left.id, right.id));
}

export function createWorldDescriptionV2(value = {}) {
    const manifest = sourceManifest(value) ?? {};
    const document = manifest.document ?? {};
    const environmentId = identifier(manifest.environmentId ?? document.environmentId ?? value?.environmentId, "Environment ID");
    const templateId = String(manifest.templateId ?? (environmentId === "igvc" ? "igvc" : "blank"));
    const fallbackDocument = templateId === "igvc" ? createBuiltInIGVCEnvironmentDocument() : null;
    const roadDomain = selectRoadDomain(manifest, document, fallbackDocument);
    const buildingDomain = selectArrayDomain(manifest, document, fallbackDocument, "buildings");
    const featureDomain = selectArrayDomain(manifest, document, fallbackDocument, "features");
    const authorRoads = normalizeRoadsV2(roadDomain.value);
    // Freeze the six-decimal metric record first, then compile from exactly
    // those controls. Resource validation can therefore reproduce surfaces
    // without access to editor-only knot modes or higher precision inputs.
    const roads = canonicalizeSimulationValue(normalizeMetricRoads(authorRoads));
    const compiled = compileRoadNetworkGeometry(planRoadNetworkGeometry(authorRoadsFromMetric(roads)));
    const buildings = buildingDomain.value.map(normalizeBuilding).sort((left, right) => compareUtf8(left.id, right.id));
    const features = featureDomain.value.map(normalizeFeature).sort((left, right) => compareUtf8(left.id, right.id));
    assertUnique(buildings, "id", "building");
    assertUnique(features, "id", "feature");
    const obstacles = createObstacles(buildings, features);
    const drivableSurfaces = compiledRoadSurfaces(compiled);
    return canonicalizeSimulationValue({
        kind: WORLD_DESCRIPTION_KIND,
        version: WORLD_DESCRIPTION_V2,
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
        roadGeometryPolicy: { id: compiled.policy.id, version: compiled.policy.version },
        drivableSurfaces,
        buildings,
        features,
        obstacles,
        bounds: aggregateBounds(roads, drivableSurfaces, obstacles),
    });
}

export function createWorldDescriptionV3(value = {}) {
    const manifest = sourceManifest(value) ?? {};
    const document = manifest.document ?? {};
    const geometryVersion = roadGeometryVersionOf({ roads: selectRoadDomain(manifest, document, null).value });
    const base = geometryVersion === 2 ? createWorldDescriptionV2(value) : createWorldDescriptionV1(value);
    const assetProxies = compileAssetProxies(document);
    if (assetProxies.length === 0) throw new TypeError("World description v3 requires at least one enabled asset metric product.");
    return canonicalizeSimulationValue({
        ...base,
        version: WORLD_DESCRIPTION_V3,
        assetProxies,
        metricWorldHash: simulationSha256(assetProxies),
        bounds: boundsWithAssetProxies(base.bounds, assetProxies),
    });
}

export function createWorldDescription(value = {}) {
    const manifest = sourceManifest(value) ?? {};
    const document = manifest.document ?? {};
    const fallbackDocument = String(manifest.templateId ?? "") === "igvc" || String(manifest.environmentId ?? document.environmentId ?? value?.environmentId) === "igvc"
        ? createBuiltInIGVCEnvironmentDocument()
        : null;
    const roadDomain = selectRoadDomain(manifest, document, fallbackDocument);
    const geometryVersion = roadGeometryVersionOf({ roads: roadDomain.value });
    const metricIssues = validateAssetMetricsDomain(document);
    if (metricIssues.length > 0) throw Object.assign(new TypeError(metricIssues[0].message), { issues: metricIssues });
    const hasAssetMetrics = (document.assetMetrics?.definitions ?? []).some((entry) => (
        (entry.collision?.length ?? 0) > 0 || (entry.lidar?.length ?? 0) > 0
    ));
    if (hasAssetMetrics) return createWorldDescriptionV3(value);
    if (geometryVersion === 2) return createWorldDescriptionV2(value);
    if (geometryVersion === 1) return createWorldDescriptionV1(value);
    throw new TypeError(`Unsupported road geometry version: ${String(geometryVersion)}.`);
}

export function hashWorldDescription(description) {
    if (description?.kind !== WORLD_DESCRIPTION_KIND || !SUPPORTED_WORLD_DESCRIPTION_VERSIONS.includes(description?.version)) {
        throw new TypeError(`Expected a supported ${WORLD_DESCRIPTION_KIND}.`);
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
    if (resource.description.version === WORLD_DESCRIPTION_V2 || (resource.description.version === WORLD_DESCRIPTION_V3 && resource.description.roadGeometryPolicy)) {
        if (resource.description.roadGeometryPolicy?.id !== ROAD_GEOMETRY_POLICY_V1.id
            || resource.description.roadGeometryPolicy?.version !== ROAD_GEOMETRY_POLICY_V1.version) {
            throw new Error("Resolved world uses an unsupported road geometry policy.");
        }
        const authorRoads = authorRoadsFromMetric(resource.description.roads);
        const expected = compiledRoadSurfaces(compileRoadNetworkGeometry(planRoadNetworkGeometry(authorRoads)));
        if (JSON.stringify(canonicalizeSimulationValue(expected)) !== JSON.stringify(resource.description.drivableSurfaces)) {
            throw new Error("Resolved world road surfaces do not match their canonical road inputs.");
        }
    }
    if (resource.description.version === WORLD_DESCRIPTION_V3) assertAssetProxies(resource.description);
    return resource.description;
}

function vector3Difference(left, right) {
    return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross3(left, right) {
    return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function dot3(left, right) {
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function assertProxyMesh(proxy, { convex = false } = {}) {
    if (!Array.isArray(proxy.vertices) || proxy.vertices.length < (convex ? 4 : 3)) throw new TypeError(`Asset proxy "${proxy.id}" has insufficient vertices.`);
    if (!Array.isArray(proxy.triangles) || proxy.triangles.length === 0) throw new TypeError(`Asset proxy "${proxy.id}" has no triangles.`);
    proxy.vertices.forEach((point) => {
        if (!Array.isArray(point) || point.length !== 3 || point.some((value) => !Number.isFinite(value))) throw new TypeError(`Asset proxy "${proxy.id}" contains an invalid vertex.`);
    });
    const center = proxy.vertices.reduce((sum, point) => sum.map((value, axis) => value + point[axis]), [0, 0, 0]).map((value) => value / proxy.vertices.length);
    for (const triangle of proxy.triangles) {
        if (!Array.isArray(triangle) || triangle.length !== 3 || new Set(triangle).size !== 3 || triangle.some((index) => !Number.isInteger(index) || index < 0 || index >= proxy.vertices.length)) throw new TypeError(`Asset proxy "${proxy.id}" contains invalid indices.`);
        const [a, b, c] = triangle.map((index) => proxy.vertices[index]);
        const normal = cross3(vector3Difference(b, a), vector3Difference(c, a));
        if (Math.hypot(...normal) <= 1e-12) throw new TypeError(`Asset proxy "${proxy.id}" contains a degenerate face.`);
        if (convex) {
            const faceCenter = a.map((value, axis) => (value + b[axis] + c[axis]) / 3);
            if (dot3(normal, vector3Difference(faceCenter, center)) <= 1e-12) throw new TypeError(`Asset proxy "${proxy.id}" has inconsistent winding.`);
            if (proxy.vertices.some((point) => dot3(normal, vector3Difference(point, a)) > 1e-9)) throw new TypeError(`Asset proxy "${proxy.id}" is not convex.`);
        }
    }
    if (JSON.stringify(canonicalizeSimulationValue(meshBounds(proxy.vertices))) !== JSON.stringify(proxy.bounds)) throw new TypeError(`Asset proxy "${proxy.id}" bounds do not match its vertices.`);
}

function assertAssetProxies(description) {
    if (!Array.isArray(description.assetProxies) || description.assetProxies.length === 0) throw new TypeError("World v3 requires assetProxies.");
    const instanceIds = new Set();
    for (const instance of description.assetProxies) {
        if (instanceIds.has(instance.id) || instance.sourceId !== instance.id) throw new TypeError(`Asset proxy source ID "${instance.id}" is invalid or duplicated.`);
        instanceIds.add(instance.id);
        for (const proxy of instance.collision ?? []) assertProxyMesh(proxy, { convex: true });
        for (const proxy of instance.lidar ?? []) assertProxyMesh(proxy);
    }
    if (description.metricWorldHash !== simulationSha256(description.assetProxies)) throw new TypeError("World v3 metricWorldHash does not match asset proxies.");
    if (JSON.stringify(canonicalizeSimulationValue(boundsWithAssetProxies(aggregateBounds(description.roads, description.drivableSurfaces, description.obstacles), description.assetProxies))) !== JSON.stringify(description.bounds)) throw new TypeError("World v3 bounds do not include its asset proxies.");
}
