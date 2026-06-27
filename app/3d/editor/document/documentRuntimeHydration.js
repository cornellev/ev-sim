import { createId } from "./EnvironmentDocument.js";
import {
    addRoadEdge,
    dedupeRoadNodes,
    getDocumentNode,
    hasEdgeBetween,
    parseGridNodePosition,
    refreshNodeKinds,
} from "./documentMutations.js";
import { fusionObjectToCatalogType } from "../placement/placementCatalogData.js";
import Unit from "../../../util/Unit.js";

function getRoadDocumentOptions(road, overrides = {}) {
    const widthMeters = road?.width?.getValue?.(Unit.Type.METER);
    const laneCount = road?.options?.laneCount;
    const bidirectional = road?.oneWay ? false : (road?.network?.bidirectional !== false);

    return {
        bidirectional,
        ...(Number.isFinite(widthMeters) && widthMeters > 0 ? { width: widthMeters } : {}),
        ...(Number.isFinite(laneCount) && laneCount > 0 ? { laneCount } : {}),
        ...overrides,
    };
}

function upsertDocumentNode(document, x, z, preferredId = null, kind = null) {
    if (preferredId) {
        const byId = getDocumentNode(document, preferredId);
        if (byId) {
            if (kind) byId.kind = kind;
            return byId;
        }
    }

    const existing = document.roads.nodes.find(
        (node) => Math.hypot(node.x - x, node.z - z) < 0.5,
    );
    if (existing) {
        if (kind) existing.kind = kind;
        return existing;
    }

    let id = preferredId ?? createId("node");
    if (getDocumentNode(document, id)) {
        id = createId("node");
    }

    const node = { id, x, z, kind: kind ?? null };
    document.roads.nodes.push(node);
    return node;
}

function upsertIntersectionNode(document, id, x, z) {
    return upsertDocumentNode(document, x, z, id, "intersection");
}

function upsertEndpointNode(document, x, z, preferredId = null) {
    return upsertDocumentNode(document, x, z, preferredId, "endpoint");
}

function upsertDocumentBuilding(document, record) {
    if (!record?.buildingId) return;
    if (document.getBuilding(record.buildingId)) return;
    document.buildings.push({
        buildingId: record.buildingId,
        footprint: record.footprint.map((point) => ({ ...point })),
        height: record.height,
        textureId: record.textureId ?? 0,
        tags: [...(record.tags ?? ["building"])],
        meshName: record.meshName ?? record.buildingId,
    });
}

function upsertDocumentFeature(document, feature) {
    if (!feature?.id || !feature?.type) return;
    if (document.getFeature(feature.id)) return;
    document.features.push({
        id: feature.id,
        type: feature.type,
        x: feature.x,
        z: feature.z,
        dir: feature.dir ?? 0,
        tags: [...(feature.tags ?? [])],
    });
}

function getFusionPosition(fusionObject) {
    const position = fusionObject?.position;
    if (!position) return null;
    return { x: position.x, z: position.z };
}

function hydrateRoadsFromNetwork(city, document) {
    const roads = city?.getRoads?.() ?? [];
    if (!roads.some((road) => road.network?.startName && road.network?.endName)) {
        return false;
    }

    let changed = false;

    for (const road of roads) {
        const network = road.network ?? {};
        if (!network.startName || !network.endName) continue;

        const startPos = parseGridNodePosition(network.startName)
            ?? { x: road.points[0].x, z: road.points[0].z };
        const endPos = parseGridNodePosition(network.endName)
            ?? {
                x: road.points[road.points.length - 1].x,
                z: road.points[road.points.length - 1].z,
            };

        const startNode = upsertIntersectionNode(
            document,
            network.startName,
            startPos.x,
            startPos.z,
        );
        const endNode = upsertIntersectionNode(
            document,
            network.endName,
            endPos.x,
            endPos.z,
        );

        if (hasEdgeBetween(document, startNode.id, endNode.id)) continue;

        const result = addRoadEdge(document, startNode.id, endNode.id, getRoadDocumentOptions(road, {
            bidirectional: network.bidirectional !== false,
        }), { notify: false });

        if (result.ok) changed = true;
    }

    refreshNodeKinds(document);
    return changed;
}

function hydrateRoadsFromIntersections(city, document) {
    const roads = city?.getRoads?.() ?? [];
    const intersections = city?.getIntersections?.() ?? [];
    if (!roads.length || !intersections.length) return false;

    let changed = false;
    const roadLinks = new Map();

    for (let i = 0; i < intersections.length; i++) {
        const intersection = intersections[i];
        const sides = intersection.calculateSides?.() ?? [];
        if (!sides.length) continue;

        let centerX = 0;
        let centerZ = 0;
        for (const side of sides) {
            centerX += side.center.x;
            centerZ += side.center.z;
        }
        centerX /= sides.length;
        centerZ /= sides.length;

        const intersectionId = `intersection:${i}`;
        upsertIntersectionNode(document, intersectionId, centerX, centerZ);

        for (let j = 0; j < intersection.roads.length; j++) {
            const road = intersection.roads[j];
            const roadIndex = roads.indexOf(road);
            if (roadIndex < 0) continue;

            const side = sides[j];
            const useEnd = road.points[road.points.length - 1].distanceTo(side.center)
                <= road.points[0].distanceTo(side.center);

            if (!roadLinks.has(roadIndex)) roadLinks.set(roadIndex, []);
            roadLinks.get(roadIndex).push({
                intersectionId,
                arm: { x: side.center.x, z: side.center.z },
                useEnd,
            });
        }
    }

    for (const [roadIndex, links] of roadLinks.entries()) {
        const road = roads[roadIndex];

        if (links.length === 2) {
            const [a, b] = links;
            if (hasEdgeBetween(document, a.intersectionId, b.intersectionId)) continue;
            const result = addRoadEdge(document, a.intersectionId, b.intersectionId, getRoadDocumentOptions(road, {
                bidirectional: true,
                startArm: a.arm,
                endArm: b.arm,
            }), { notify: false });
            if (result.ok) changed = true;
            continue;
        }

        if (links.length === 1) {
            const link = links[0];
            const farPoint = link.useEnd
                ? road.points[0]
                : road.points[road.points.length - 1];
            const endpoint = upsertEndpointNode(
                document,
                farPoint.x,
                farPoint.z,
                `endpoint:road-${roadIndex}`,
            );

            if (hasEdgeBetween(document, link.intersectionId, endpoint.id)) continue;
            const result = addRoadEdge(document, link.intersectionId, endpoint.id, getRoadDocumentOptions(road, {
                bidirectional: true,
                startArm: link.arm,
            }), { notify: false });
            if (result.ok) changed = true;
        }
    }

    refreshNodeKinds(document);
    return changed;
}

function hydrateRoadsFromEndpoints(city, document) {
    const roads = city?.getRoads?.() ?? [];
    let changed = false;

    for (const road of roads) {
        const points = road?.points;
        if (!Array.isArray(points) || points.length < 2) continue;

        const start = points[0];
        const end = points[points.length - 1];
        const startNode = upsertEndpointNode(document, start.x, start.z);
        const endNode = upsertEndpointNode(document, end.x, end.z);

        if (hasEdgeBetween(document, startNode.id, endNode.id)) continue;

        const result = addRoadEdge(document, startNode.id, endNode.id, getRoadDocumentOptions(road), { notify: false });
        if (result.ok) changed = true;
    }

    refreshNodeKinds(document);
    return changed;
}

function hydrateRoadGraph(city, document) {
    if (document.roads.nodes.length || document.roads.edges.length) {
        refreshNodeKinds(document);
        return false;
    }

    if (hydrateRoadsFromNetwork(city, document)) return true;
    if (hydrateRoadsFromIntersections(city, document)) return true;
    return hydrateRoadsFromEndpoints(city, document);
}

/**
 * Import existing runtime content into the authoring document without removing edits.
 * @param {import("../../data/Data").Data} data
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 */
export function hydrateDocumentFromRuntime(data, document) {
    let changed = false;

    for (const record of data?.bakeRunConfig?.()?.buildings ?? []) {
        const before = document.buildings.length;
        upsertDocumentBuilding(document, record);
        if (document.buildings.length > before) changed = true;
    }

    const registry = data?.environment?.()?.objects?.();
    if (registry) {
        for (const entity of registry.entities?.values?.() ?? []) {
            if (entity.layer !== "props" || !entity.fusionObject) continue;

            const type = fusionObjectToCatalogType(entity.fusionObject);
            if (!type) continue;

            const position = getFusionPosition(entity.fusionObject);
            if (!position) continue;

            const featureId = entity.sourceId ?? entity.fusionObject._uuid;
            const before = document.features.length;
            upsertDocumentFeature(document, {
                id: featureId,
                type,
                x: position.x,
                z: position.z,
                dir: entity.fusionObject.dir ?? 0,
                tags: entity.tags ?? entity.fusionObject.tags ?? [],
            });
            if (document.features.length > before) changed = true;
        }
    }

    if (hydrateRoadGraph(data?.city?.(), document)) {
        changed = true;
    }

    const cityHasIntersections = (data?.city?.()?.getIntersections?.() ?? []).length > 0;
    const hasIntersectionNodes = document.roads.nodes.some((node) => node.kind === "intersection");
    if (cityHasIntersections && !hasIntersectionNodes && document.roads.edges.length) {
        document.roads.nodes = [];
        document.roads.edges = [];
        if (hydrateRoadGraph(data?.city?.(), document)) {
            changed = true;
        }
    }

    dedupeRoadNodes(document);
    refreshNodeKinds(document);

    if (changed) {
        document.notify();
    }

    return changed;
}

/**
 * Fit map viewport to document content bounds.
 * @param {import("../EditorState.js").EditorState} editor
 * @param {import("./EnvironmentDocument.js").EnvironmentDocument} document
 */
export function fitMapViewportToContent(editor, document) {
    const points = [];

    for (const node of document.roads.nodes) {
        points.push({ x: node.x, z: node.z });
    }
    for (const building of document.buildings) {
        for (const corner of building.footprint ?? []) {
            points.push({ x: corner.x, z: corner.z });
        }
    }
    for (const feature of document.features) {
        points.push({ x: feature.x, z: feature.z });
    }

    if (!points.length) return;

    const xs = points.map((point) => point.x);
    const zs = points.map((point) => point.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);

    const spanX = Math.max(maxX - minX, 20);
    const spanZ = Math.max(maxZ - minZ, 20);
    const span = Math.max(spanX, spanZ);
    const zoom = Math.min(4, Math.max(0.35, 120 / span));

    editor.setMapViewport({
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        zoom,
    });
}
