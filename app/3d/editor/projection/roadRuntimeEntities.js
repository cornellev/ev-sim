/**
 * Runtime entity helpers for roads shared by the load-time full rebuild
 * (`syncRoadsFromDocument`) and the incremental road projector. Entities are
 * keyed by document id: `road:<edgeId>`, `intersection:<nodeId>`,
 * `road-node:<nodeId>`. Index aliases (`road:<index>`) exist only after a full
 * load for legacy callers.
 */

import * as THREE from "three";
import { EDITOR_LAYERS } from "../EditorState.js";
import { canMoveNode } from "../document/documentMutations.js";
import { getRoadStylePreset } from "../../environment/road/RoadStylePresets.js";

export function getRoadRegistry(data) {
    return data?.environment?.()?.objects?.() ?? null;
}

export function roadEntityId(edgeId) {
    const id = String(edgeId);
    return id.startsWith("road:") ? id : `road:${id}`;
}

export function intersectionEntityId(nodeId) {
    const id = String(nodeId);
    return id.startsWith("intersection:") ? id : `intersection:${id}`;
}

export function roadNodeEntityId(nodeId) {
    return `road-node:${nodeId}`;
}

export function roadNetworkOptions(data) {
    const preset = getRoadStylePreset(data?.environment?.()?.roadStylePreset);
    return {
        ...(preset.networkOptions ?? {}),
        roadOptions: {
            ...(preset.roadOptions ?? {}),
        },
    };
}

export function toVector3Map(rawMap) {
    const vectors = new Map();
    for (const [id, point] of rawMap.entries()) {
        vectors.set(id, new THREE.Vector3(point.x, point.y ?? 0, point.z));
    }
    return vectors;
}

export function createEndpointHandle(node) {
    const geometry = new THREE.SphereGeometry(0.45, 12, 12);
    const material = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.35,
        roughness: 0.45,
        metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "RoadNodeHandle";
    mesh.position.set(node.x, Number.isFinite(Number(node.y)) ? Number(node.y) : 0, node.z);
    mesh.userData.bakeIgnore = true;
    mesh.userData.roadNodeId = node.id;
    return mesh;
}

/** Tag road/intersection triangles for LiDAR truth and return them. */
export function tagRoadTriangles(roads, intersections) {
    return [
        ...roads.flatMap((road) => (road.triangles ?? []).map((triangle, triangleIndex) => {
            const sourceId = road.network?.edgeId ?? "road";
            triangle.environmentGeometryType = "road";
            triangle.environmentSourceId = sourceId;
            triangle.lidarTwinId = `road:${sourceId}:${triangleIndex}`;
            triangle.lidarTriangleIndex = triangleIndex;
            return triangle;
        })),
        ...intersections.flatMap((intersection) => (intersection.triangles ?? []).map((triangle, triangleIndex) => {
            const sourceId = intersection.networkNodeId ?? "intersection";
            triangle.environmentGeometryType = "road";
            triangle.environmentSourceId = sourceId;
            triangle.lidarTwinId = `intersection:${sourceId}:${triangleIndex}`;
            triangle.lidarTriangleIndex = triangleIndex;
            return triangle;
        })),
    ];
}

export function removeRoadNodeHandle(registry, nodeId) {
    const entity = registry?.getEntity?.(roadNodeEntityId(nodeId));
    if (!entity) return false;
    entity.object3D?.parent?.remove?.(entity.object3D);
    entity.object3D?.geometry?.dispose?.();
    entity.object3D?.material?.dispose?.();
    registry.unregisterEntity(entity.id);
    return true;
}

/**
 * Register roads, intersections, and node handles. `nodeIds` limits which
 * node handles are (re)created; by default every movable node gets one.
 * `withIndexAliases` adds `road:<index>` aliases (full load only).
 */
export function registerRoadEntities(registry, result, document, scene, { nodeIds = null, withIndexAliases = false } = {}) {
    if (!registry) return;

    result.roads.forEach((road, index) => {
        if (!road?.root) return;
        const sourceId = String(road.network?.edgeId ?? `road:${index}`);
        registry.registerEntity({
            id: roadEntityId(sourceId),
            sourceId,
            ...(withIndexAliases ? { legacyIds: [`road:${index}`] } : {}),
            kind: "road",
            label: road.network?.edgeId ? `Road ${road.network.edgeId}` : `Road ${index + 1}`,
            layer: EDITOR_LAYERS.ROADS,
            object3D: road.root,
            road,
        });
    });

    result.intersections.forEach((intersection, index) => {
        if (!intersection?.root) return;
        const sourceId = String(intersection.networkNodeId ?? `intersection:${index}`);
        registry.registerEntity({
            id: intersectionEntityId(sourceId),
            sourceId,
            ...(withIndexAliases ? { legacyIds: [`intersection:${index}`] } : {}),
            kind: "intersection",
            label: intersection.networkNodeId ? `Intersection ${intersection.networkNodeId}` : `Intersection ${index + 1}`,
            layer: EDITOR_LAYERS.ROADS,
            object3D: intersection.root,
            intersection,
        });
    });

    const wanted = nodeIds ? new Set([...nodeIds].map(String)) : null;
    for (const node of document.roads.nodes) {
        if (wanted && !wanted.has(String(node.id))) continue;
        removeRoadNodeHandle(registry, node.id);
        if (!canMoveNode(document, node.id)) continue;
        const handle = createEndpointHandle(node);
        scene.add(handle);
        registry.registerEntity({
            id: roadNodeEntityId(node.id),
            sourceId: node.id,
            kind: "road-node",
            label: `Road node ${node.id}`,
            layer: EDITOR_LAYERS.ROADS,
            object3D: handle,
            node,
        });
    }
}

export function unregisterRoadEntities(registry) {
    registry?.listEntities?.()
        ?.filter((entity) => (
            entity.kind === "road"
            || entity.kind === "intersection"
            || entity.kind === "road-node"
        ))
        ?.forEach((entity) => {
            if (entity.kind === "road-node") {
                const full = registry.getEntity(entity.id);
                full?.object3D?.parent?.remove?.(full.object3D);
            }
            registry.unregisterEntity(entity.id);
        });
}
