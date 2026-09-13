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
import { resolveRoadEdge, roadGeometryVersionOf } from "../../../roads/RoadGeometryRecord.js";

export const ROAD_AUTHORING_HANDLES_NAME = "RoadAuthoringHandles";
export const ROAD_AUTHORING_HANDLE_STEMS_NAME = "RoadAuthoringHandleStems";
export const ROAD_AUTHORING_HANDLE_KINDS = Object.freeze(["road-node", "road-knot", "road-handle"]);

export const HANDLE_PIXEL_SIZES = Object.freeze({
    "road-node": 12,
    "road-knot": 10,
    "road-handle": 8,
});

export const HANDLE_FILL_COLORS = Object.freeze({
    "road-node": 0x38bdf8,
    "road-knot": 0xf59e0b,
    "road-handle": 0x8b5cf6,
});

export const HANDLE_HALO_COLORS = Object.freeze({
    "road-node": 0xe0f2fe,
    "road-knot": 0xe0f2fe,
    "road-handle": 0xede9fe,
});

const HANDLE_SCALE_MIN = 0.08;
const HANDLE_SCALE_MAX = 1.5;
const HANDLE_HALO_SCALE = 1.35;
const UNIT_SPHERE = new THREE.SphereGeometry(1, 12, 12);

function overlayMaterial(color) {
    return new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
        transparent: true,
    });
}

const _handleWorld = new THREE.Vector3();

/** Scale a handle group so its unit-radius fill matches `handlePixelSize` on screen. */
export function scaleHandleToPixels(object3D, camera, renderer, {
    min = HANDLE_SCALE_MIN,
    max = HANDLE_SCALE_MAX,
} = {}) {
    if (!object3D || !camera) return 0;
    const pixels = Number(object3D.userData?.handlePixelSize) || HANDLE_PIXEL_SIZES["road-knot"];
    object3D.getWorldPosition(_handleWorld);
    const distance = camera.position.distanceTo(_handleWorld);
    let worldHeight;
    if (camera.isOrthographicCamera) {
        worldHeight = Math.abs((camera.top - camera.bottom) / (camera.zoom || 1));
    } else {
        const fov = THREE.MathUtils.degToRad(Number(camera.fov) || 50);
        worldHeight = 2 * Math.tan(fov / 2) * Math.max(distance, 1e-4);
    }
    const canvasHeight = Math.max(1, Number(renderer?.domElement?.clientHeight) || 1);
    const diameter = pixels * worldHeight / canvasHeight;
    const scale = Math.min(max, Math.max(min, diameter / 2));
    object3D.scale.setScalar(scale);
    return scale;
}

function disposeHandleObject(object3D) {
    object3D?.parent?.remove?.(object3D);
    object3D?.traverse?.((child) => {
        if (child.geometry && child.geometry !== UNIT_SPHERE) child.geometry.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
        for (const material of materials) material?.dispose?.();
    });
}

function createHaloHandle({ fill, halo, pixelSize, name, position, visible = true }) {
    const group = new THREE.Group();
    group.name = name;
    group.position.set(position.x, position.y, position.z);
    group.visible = visible;
    group.userData.bakeIgnore = true;
    group.userData.editorHelper = true;
    group.userData.handlePixelSize = pixelSize;

    const haloMesh = new THREE.Mesh(UNIT_SPHERE, overlayMaterial(halo));
    haloMesh.name = `${name}:halo`;
    haloMesh.scale.setScalar(HANDLE_HALO_SCALE);
    haloMesh.renderOrder = 1000;
    haloMesh.userData.bakeIgnore = true;
    haloMesh.userData.editorHelper = true;

    const fillMesh = new THREE.Mesh(UNIT_SPHERE, overlayMaterial(fill));
    fillMesh.name = `${name}:fill`;
    fillMesh.renderOrder = 1001;
    fillMesh.userData.bakeIgnore = true;
    fillMesh.userData.editorHelper = true;
    fillMesh.onBeforeRender = (renderer, _scene, camera) => {
        scaleHandleToPixels(group, camera, renderer);
    };

    group.add(haloMesh);
    group.add(fillMesh);
    return group;
}

export function shouldShowRoadTangentHandle(entity, {
    sub = null,
    showAll = false,
    layerVisible = true,
    entityVisible = true,
} = {}) {
    if (layerVisible === false || entityVisible === false) return false;
    if (showAll) return true;
    if (!sub || !["road-knot", "road-handle"].includes(sub.kind)) return false;
    return String(sub.edgeId) === String(entity.edgeId) && String(sub.knotId) === String(entity.knotId);
}

export function applyRoadTangentHandleVisibility(registry, {
    sub = null,
    showAll = false,
    layers = null,
} = {}) {
    if (!registry?.listEntities) return;
    for (const summary of registry.listEntities()) {
        if (summary.kind !== "road-handle") continue;
        const entity = registry.getEntity(summary.id);
        if (!entity?.object3D) continue;
        entity.object3D.visible = shouldShowRoadTangentHandle(entity, {
            sub,
            showAll,
            layerVisible: layers?.[entity.layer] !== false,
            entityVisible: entity.visible !== false && entity.hidden !== true,
        });
    }
}

export function getRoadAuthoringHandleStemsGroup(scene) {
    return scene?.getObjectByName?.(ROAD_AUTHORING_HANDLE_STEMS_NAME) ?? null;
}

export function ensureRoadAuthoringHandleStemsGroup(scene) {
    if (!scene) return null;
    let group = getRoadAuthoringHandleStemsGroup(scene);
    if (!group) {
        group = new THREE.Group();
        group.name = ROAD_AUTHORING_HANDLE_STEMS_NAME;
        group.userData.bakeIgnore = true;
        group.userData.editorHelper = true;
        group.userData.skipEnvironmentSelection = true;
        scene.add(group);
    }
    return group;
}

function clearStemGroup(group) {
    if (!group) return;
    for (const child of [...group.children]) {
        group.remove(child);
        child.geometry?.dispose?.();
        child.material?.dispose?.();
    }
}

function stemMaterial() {
    return new THREE.LineBasicMaterial({
        color: HANDLE_FILL_COLORS["road-handle"],
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
    });
}

export function syncRoadHandleStems(scene, registry) {
    const stems = ensureRoadAuthoringHandleStemsGroup(scene);
    if (!stems || !registry) return stems;
    clearStemGroup(stems);
    for (const summary of registry.listEntities()) {
        if (summary.kind !== "road-handle") continue;
        const handle = registry.getEntity(summary.id);
        if (!handle?.object3D || handle.object3D.visible === false) continue;
        const knot = registry.getEntity(roadKnotEntityId(handle.edgeId, handle.knotId));
        if (!knot?.object3D) continue;
        const geometry = new THREE.BufferGeometry().setFromPoints([
            knot.object3D.position.clone(),
            handle.object3D.position.clone(),
        ]);
        const line = new THREE.Line(geometry, stemMaterial());
        line.renderOrder = 999;
        line.userData.bakeIgnore = true;
        line.userData.editorHelper = true;
        line.userData.skipEnvironmentSelection = true;
        stems.add(line);
    }
    return stems;
}

export function disposeRoadHandleStems(scene) {
    const stems = getRoadAuthoringHandleStemsGroup(scene);
    if (!stems) return;
    clearStemGroup(stems);
    stems.parent?.remove?.(stems);
}

export function syncRoadAuthoringHandleOverlay({
    scene,
    registry,
    sub = null,
    showAll = false,
    layers = null,
} = {}) {
    applyRoadTangentHandleVisibility(registry, { sub, showAll, layers });
    syncRoadHandleStems(scene, registry);
}

export function isRoadAuthoringHandleKind(kind) {
    return ROAD_AUTHORING_HANDLE_KINDS.includes(kind);
}

export function getRoadAuthoringHandlesGroup(scene) {
    return scene?.getObjectByName?.(ROAD_AUTHORING_HANDLES_NAME) ?? null;
}

function authoringHelpersVisibleFrom(data) {
    return data?.environment?.()?.authoringHelpersVisible !== false;
}

export function ensureRoadAuthoringHandlesGroup(scene, { visible } = {}) {
    if (!scene) return null;
    let group = getRoadAuthoringHandlesGroup(scene);
    if (!group) {
        group = new THREE.Group();
        group.name = ROAD_AUTHORING_HANDLES_NAME;
        group.userData.bakeIgnore = true;
        group.userData.editorHelper = true;
        scene.add(group);
    }
    if (visible !== undefined) group.visible = Boolean(visible);
    return group;
}

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

export function roadKnotEntityId(edgeId, knotId) {
    return `road-knot:${edgeId}:${knotId}`;
}

export function roadHandleEntityId(edgeId, knotId, side) {
    return `road-handle:${edgeId}:${knotId}:${side}`;
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
    const group = createHaloHandle({
        fill: HANDLE_FILL_COLORS["road-node"],
        halo: HANDLE_HALO_COLORS["road-node"],
        pixelSize: HANDLE_PIXEL_SIZES["road-node"],
        name: "RoadNodeHandle",
        position: { x: node.x, y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0, z: node.z },
    });
    group.userData.roadNodeId = node.id;
    return group;
}

/** Tag road/intersection triangles for LiDAR truth and return them. */
export function tagRoadTriangles(roads, intersections) {
    return [
        ...roads.flatMap((road) => (road.triangles ?? []).map((triangle, triangleIndex) => {
            const sourceId = road.network?.edgeId ?? "road";
            triangle.environmentGeometryType = "road";
            triangle.environmentSourceId = sourceId;
            triangle.lidarTwinId = road.network?.geometryVersion === 2
                ? `road-surface:${sourceId}:${triangleIndex}`
                : `road:${sourceId}:${triangleIndex}`;
            triangle.lidarTriangleIndex = triangleIndex;
            return triangle;
        })),
        ...intersections.flatMap((intersection) => (intersection.triangles ?? []).map((triangle, triangleIndex) => {
            const sourceId = intersection.networkNodeId ?? "intersection";
            triangle.environmentGeometryType = "road";
            triangle.environmentSourceId = sourceId;
            triangle.lidarTwinId = intersection.networkGeometryVersion === 2
                ? `intersection-surface:${sourceId}:${triangleIndex}`
                : `intersection:${sourceId}:${triangleIndex}`;
            triangle.lidarTriangleIndex = triangleIndex;
            return triangle;
        })),
    ];
}

export function removeRoadNodeHandle(registry, nodeId) {
    const entity = registry?.getEntity?.(roadNodeEntityId(nodeId));
    if (!entity) return false;
    disposeHandleObject(entity.object3D);
    registry.unregisterEntity(entity.id);
    return true;
}

export function removeRoadGeometryHandles(registry, edgeId) {
    const prefix = `${edgeId}:`;
    const entities = registry?.listEntities?.()?.filter((entity) => (
        ["road-knot", "road-handle"].includes(entity.kind)
        && `${entity.edgeId ?? entity.sourceId ?? ""}:`.startsWith(prefix)
    )) ?? [];
    for (const entity of entities) {
        const full = registry.getEntity(entity.id);
        disposeHandleObject(full?.object3D);
        registry.unregisterEntity(entity.id);
    }
}

function createSubHandle(position, kind, { visible = true } = {}) {
    return createHaloHandle({
        fill: HANDLE_FILL_COLORS[kind],
        halo: HANDLE_HALO_COLORS[kind],
        pixelSize: HANDLE_PIXEL_SIZES[kind],
        name: kind === "road-handle" ? "RoadTangentHandle" : "RoadKnotHandle",
        position,
        visible,
    });
}

/**
 * Register roads, intersections, and node handles. `nodeIds` limits which
 * node handles are (re)created; by default every movable node gets one.
 * `withIndexAliases` adds `road:<index>` aliases (full load only).
 */
export function registerRoadEntities(registry, result, document, scene, { nodeIds = null, withIndexAliases = false, data = null } = {}) {
    if (!registry) return;
    const handles = ensureRoadAuthoringHandlesGroup(scene, { visible: authoringHelpersVisibleFrom(data) });

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
        handles?.add(handle);
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

    if (roadGeometryVersionOf(document) === 2) {
        const nodeById = document.index().nodes;
        for (const edge of document.roads.edges) {
            if (!result.roadByEdge?.has?.(String(edge.id))) continue;
            removeRoadGeometryHandles(registry, edge.id);
            const resolved = resolveRoadEdge(edge, nodeById);
            for (const knot of resolved.geometry.knots) {
                const knotHandle = createSubHandle(knot.position, "road-knot");
                handles?.add(knotHandle);
                registry.registerEntity({
                    id: roadKnotEntityId(edge.id, knot.id),
                    sourceId: edge.id,
                    edgeId: edge.id,
                    knotId: knot.id,
                    kind: "road-knot",
                    label: `Road knot ${knot.id}`,
                    layer: EDITOR_LAYERS.ROADS,
                    object3D: knotHandle,
                });
                for (const [side, vector] of [["in", knot.handleIn], ["out", knot.handleOut]]) {
                    if (!vector) continue;
                    const position = { x: knot.position.x + vector.x, y: knot.position.y + vector.y, z: knot.position.z + vector.z };
                    const handle = createSubHandle(position, "road-handle", { visible: false });
                    handles?.add(handle);
                    registry.registerEntity({
                        id: roadHandleEntityId(edge.id, knot.id, side),
                        sourceId: edge.id,
                        edgeId: edge.id,
                        knotId: knot.id,
                        side,
                        kind: "road-handle",
                        label: `Road handle ${knot.id} ${side}`,
                        layer: EDITOR_LAYERS.ROADS,
                        object3D: handle,
                    });
                }
            }
        }
    }
}

export function unregisterRoadEntities(registry) {
    registry?.listEntities?.()
        ?.filter((entity) => (
            entity.kind === "road"
            || entity.kind === "intersection"
            || entity.kind === "road-node"
            || entity.kind === "road-knot"
            || entity.kind === "road-handle"
        ))
        ?.forEach((entity) => {
            if (["road-node", "road-knot", "road-handle"].includes(entity.kind)) {
                const full = registry.getEntity(entity.id);
                disposeHandleObject(full?.object3D);
            }
            registry.unregisterEntity(entity.id);
        });
}
