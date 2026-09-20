/**
 * Roads: rebuild only the local closure of a change.
 *
 *   E1 = edges changed or incident to a changed node
 *   J1 = junction nodes at E1's endpoints (and changed nodes) that are, or were,
 *        rendered as intersections
 *   E2 = E1 plus every edge incident to J1 (their trim depends on the
 *        junction inset and the Intersection needs their Road objects)
 *
 * Insets are planned over the whole graph (cheap math); only E2 and J1 are
 * materialized. Roads and intersections are torn down and re-registered by id;
 * intersections outside J1 are relinked to replaced Road objects; LiDAR
 * triangles are replaced only for the affected source ids.
 *
 * Transient gesture frames skip the compiler: uniformly transformed roads
 * follow the cumulative delta on the existing mesh (same as buildings);
 * node/knot/handle drags hide those meshes and show a straight width-strip
 * from live records. Commit, undo, redo, and cancel rematerialize once.
 */

import * as THREE from "three";
import { disposeRoadRuntimeObject, planRoadNetwork, materializeCompiledRoadNetwork, materializeRoadNetwork } from "../../../city/RoadNetwork.js";
import { planRoadNetworkGeometry } from "../../../../roads/RoadNetworkGeometry.js";
import { resolveRoadEdge, roadGeometryVersionOf } from "../../../../roads/RoadGeometryRecord.js";
import { applyDeltaToPoint, applyDeltaToVector } from "../../objects/transformDelta.js";
import { rebuildRoadRuntime } from "../../document/adapters/RoadRuntimeAdapter.js";
import { documentToRoadNetworkInputs } from "../../document/documentMutations.js";
import {
    intersectionEntityId,
    registerRoadEntities,
    removeRoadGeometryHandles,
    removeRoadNodeHandle,
    roadEntityId,
    roadHandleEntityId,
    roadKnotEntityId,
    roadNetworkOptions,
    roadNodeEntityId,
    syncRoadHandleStems,
    tagRoadTriangles,
    toVector3Map,
} from "../roadRuntimeEntities.js";

export const ROAD_GESTURE_PREVIEW_NAME = "RoadGesturePreview";

const POSITION_EPSILON = 1e-6;

function endpointsOf(edgeIds, edgeMap) {
    const result = [];
    for (const id of edgeIds) {
        const edge = edgeMap.get(String(id));
        if (edge) result.push(String(edge.startNodeId), String(edge.endNodeId));
    }
    return result;
}

function incidentEdgeIds(nodeId, index, plan) {
    const ids = [];
    const planned = plan?.adjacency?.get(nodeId);
    if (planned) {
        for (const edge of planned) {
            if (edge.id !== null && edge.id !== undefined) ids.push(String(edge.id));
        }
        return ids;
    }
    for (const edge of index.edges.values()) {
        if (String(edge.startNodeId) === nodeId || String(edge.endNodeId) === nodeId) ids.push(String(edge.id));
    }
    return ids;
}

/** Compute the local closure for a road change set. Exported for tests. */
export function computeRoadClosure({ changeSet, document, registry, plan = null }) {
    const nodesDomain = changeSet.domains?.["roads.nodes"] ?? null;
    const edgesDomain = changeSet.domains?.["roads.edges"] ?? null;
    const index = document.index();
    const changedNodeIds = new Set(nodesDomain ? [...nodesDomain.after.keys()].map(String) : []);
    const beforeEdges = new Map();
    for (const [id, record] of edgesDomain?.before ?? []) {
        if (record) beforeEdges.set(String(id), record);
    }
    const E1 = new Set(edgesDomain ? [...edgesDomain.after.keys()].map(String) : []);
    for (const edge of [...index.edges.values(), ...beforeEdges.values()]) {
        if (changedNodeIds.has(String(edge.startNodeId)) || changedNodeIds.has(String(edge.endNodeId))) E1.add(String(edge.id));
    }
    const candidates = new Set([
        ...endpointsOf(E1, index.edges),
        ...endpointsOf(E1, beforeEdges),
        ...changedNodeIds,
        ...(nodesDomain ? [...nodesDomain.before.keys()].map(String) : []),
    ]);
    const J1 = new Set();
    for (const nodeId of candidates) {
        if (
            plan?.intersectionNodes?.has(nodeId)
            || registry?.getEntity?.(intersectionEntityId(nodeId))
            || (!plan && index.junctions?.has(nodeId))
        ) J1.add(nodeId);
    }
    const E2 = new Set(E1);
    for (const nodeId of J1) {
        for (const edgeId of incidentEdgeIds(nodeId, index, plan)) E2.add(edgeId);
    }
    const touchedNodeIds = new Set([
        ...changedNodeIds,
        ...endpointsOf(E2, index.edges),
        ...endpointsOf(E1, beforeEdges),
        ...(nodesDomain ? [...nodesDomain.before.keys()].map(String) : []),
    ]);
    return { E1, J1, E2, touchedNodeIds, beforeEdges, changedNodeIds };
}

function samePoint(left, right) {
    return Math.abs(Number(left?.x ?? 0) - Number(right?.x ?? 0)) <= POSITION_EPSILON
        && Math.abs(Number(left?.y ?? 0) - Number(right?.y ?? 0)) <= POSITION_EPSILON
        && Math.abs(Number(left?.z ?? 0) - Number(right?.z ?? 0)) <= POSITION_EPSILON;
}

function nodeFollowsDelta(before, after, delta) {
    if (!before || !after || !delta?.matrix) return false;
    return samePoint(applyDeltaToPoint(delta, before), after);
}

export function edgeDeltaIsUniform(edge, changeSet, delta) {
    if (!delta?.matrix || !edge) return false;
    const nodesDomain = changeSet.domains?.["roads.nodes"];
    const startId = String(edge.startNodeId);
    const endId = String(edge.endNodeId);
    const startBefore = nodesDomain?.before?.get(startId);
    const startAfter = nodesDomain?.after?.get(startId);
    const endBefore = nodesDomain?.before?.get(endId);
    const endAfter = nodesDomain?.after?.get(endId);
    if (!startBefore || !startAfter || !endBefore || !endAfter) return false;
    if (!nodeFollowsDelta(startBefore, startAfter, delta) || !nodeFollowsDelta(endBefore, endAfter, delta)) return false;
    const edgeBefore = changeSet.domains?.["roads.edges"]?.before?.get(String(edge.id));
    const edgeAfter = changeSet.domains?.["roads.edges"]?.after?.get(String(edge.id));
    if (!edgeAfter || !edgeBefore?.geometry?.knots || !edgeAfter.geometry?.knots) return true;
    const beforeKnots = edgeBefore.geometry.knots;
    const afterKnots = edgeAfter.geometry.knots;
    if (beforeKnots.length !== afterKnots.length) return false;
    for (let index = 0; index < beforeKnots.length; index += 1) {
        const beforeKnot = beforeKnots[index];
        const afterKnot = afterKnots[index];
        if (beforeKnot.position && !samePoint(applyDeltaToPoint(delta, beforeKnot.position), afterKnot.position ?? afterKnot)) return false;
        if (beforeKnot.handleIn && afterKnot.handleIn && !samePoint(applyDeltaToVector(delta, beforeKnot.handleIn), afterKnot.handleIn)) return false;
        if (beforeKnot.handleOut && afterKnot.handleOut && !samePoint(applyDeltaToVector(delta, beforeKnot.handleOut), afterKnot.handleOut)) return false;
    }
    return true;
}

function intersectionDeltaIsUniform(nodeId, changeSet, delta, index) {
    const before = changeSet.domains?.["roads.nodes"]?.before?.get(String(nodeId));
    const after = changeSet.domains?.["roads.nodes"]?.after?.get(String(nodeId));
    if (!nodeFollowsDelta(before, after, delta)) return false;
    for (const edge of index.edges.values()) {
        if (String(edge.startNodeId) !== String(nodeId) && String(edge.endNodeId) !== String(nodeId)) continue;
        if (!edgeDeltaIsUniform(edge, changeSet, delta)) return false;
    }
    return true;
}

function setWorldMatrix(object3D, worldMatrix) {
    const parent = object3D.parent;
    if (parent) {
        parent.updateMatrixWorld(true);
        const local = parent.matrixWorld.clone().invert().multiply(worldMatrix);
        local.decompose(object3D.position, object3D.quaternion, object3D.scale);
    } else {
        worldMatrix.decompose(object3D.position, object3D.quaternion, object3D.scale);
    }
    object3D.updateMatrixWorld(true);
}

function applyAffine(object3D, gestureStarts, key, delta, registry, entityId) {
    let start = gestureStarts.get(key);
    if (!start) {
        object3D.updateMatrixWorld(true);
        start = object3D.matrixWorld.clone();
        gestureStarts.set(key, start);
    }
    const world = new THREE.Matrix4().fromArray(delta.matrix).multiply(start);
    setWorldMatrix(object3D, world);
    if (entityId) registry?.updateEntityTransform(entityId);
}

function edgePreviewPoints(edge, index) {
    const knots = edge?.geometry?.knots;
    if (Array.isArray(knots) && knots.length >= 2) {
        return knots.map((knot, knotIndex) => {
            if (knot.position) return knot.position;
            if (knotIndex === 0) return index.nodes.get(String(edge.startNodeId));
            if (knotIndex === knots.length - 1) return index.nodes.get(String(edge.endNodeId));
            return null;
        }).filter(Boolean);
    }
    const start = index.nodes.get(String(edge.startNodeId));
    const end = index.nodes.get(String(edge.endNodeId));
    return start && end ? [start, end] : [];
}

function stripBufferGeometry(points, width) {
    if (!points || points.length < 2) return null;
    const half = Math.max(0.25, Number(width) || 7) / 2;
    const left = [];
    const right = [];
    for (let index = 0; index < points.length; index += 1) {
        const previous = points[Math.max(0, index - 1)];
        const next = points[Math.min(points.length - 1, index + 1)];
        let dx = next.x - previous.x;
        let dz = next.z - previous.z;
        const length = Math.hypot(dx, dz);
        if (length <= 1e-9) {
            dx = 1;
            dz = 0;
        } else {
            dx /= length;
            dz /= length;
        }
        const y = (Number.isFinite(Number(points[index].y)) ? Number(points[index].y) : 0) + 0.04;
        left.push(points[index].x - dz * half, y, points[index].z + dx * half);
        right.push(points[index].x + dz * half, y, points[index].z - dx * half);
    }
    const vertices = [...left, ...right];
    const indices = [];
    const offset = points.length;
    for (let index = 0; index < points.length - 1; index += 1) {
        indices.push(index, index + 1, offset + index, index + 1, offset + index + 1, offset + index);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

function createStripMesh(points, width) {
    const geometry = stripBufferGeometry(points, width);
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0x52525b,
        side: THREE.DoubleSide,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
    }));
    mesh.name = "RoadGestureStrip";
    mesh.userData.bakeIgnore = true;
    mesh.userData.editorHelper = true;
    mesh.userData.skipEnvironmentSelection = true;
    mesh.renderOrder = 2;
    return mesh;
}

function ensurePreviewGroup(scene) {
    let group = scene?.getObjectByName?.(ROAD_GESTURE_PREVIEW_NAME) ?? null;
    if (!group && scene) {
        group = new THREE.Group();
        group.name = ROAD_GESTURE_PREVIEW_NAME;
        group.userData.bakeIgnore = true;
        group.userData.editorHelper = true;
        group.userData.skipEnvironmentSelection = true;
        scene.add(group);
    }
    return group;
}

function clearPreviewChildren(group) {
    if (!group) return;
    for (const child of [...group.children]) {
        group.remove(child);
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach((material) => material?.dispose?.());
        else child.material?.dispose?.();
    }
}

function clearTransientPreview(scene, gestureStarts, hiddenRoots) {
    for (const root of hiddenRoots) {
        if (root) root.visible = true;
    }
    hiddenRoots.clear();
    gestureStarts.clear();
    const group = scene?.getObjectByName?.(ROAD_GESTURE_PREVIEW_NAME) ?? null;
    clearPreviewChildren(group);
    group?.parent?.remove?.(group);
}

function roadRootFor(edgeId, city, registry) {
    const entity = registry?.getEntity?.(roadEntityId(edgeId));
    return entity?.object3D ?? entity?.road?.root ?? city.roads.find((road) => String(road.network?.edgeId ?? "") === String(edgeId))?.root ?? null;
}

function intersectionRootFor(nodeId, city, registry) {
    const entity = registry?.getEntity?.(intersectionEntityId(nodeId));
    return entity?.object3D ?? entity?.intersection?.root
        ?? city.intersections.find((intersection) => String(intersection.networkNodeId ?? "") === String(nodeId))?.root
        ?? null;
}

function updateHandlesFromDocument(registry, document, closure, scene) {
    const index = document.index();
    for (const nodeId of closure.touchedNodeIds) {
        const node = index.nodes.get(String(nodeId));
        const entity = registry?.getEntity?.(roadNodeEntityId(nodeId));
        if (!node || !entity?.object3D) continue;
        entity.object3D.position.set(node.x, Number.isFinite(Number(node.y)) ? Number(node.y) : 0, node.z);
        registry.updateEntityTransform(entity.id);
    }
    if (roadGeometryVersionOf(document) === 2) {
        for (const edgeId of closure.E2) {
            const edge = index.edges.get(String(edgeId));
            if (!edge) continue;
            const resolved = resolveRoadEdge(edge, index.nodes);
            for (const knot of resolved.geometry.knots) {
                const knotEntity = registry?.getEntity?.(roadKnotEntityId(edge.id, knot.id));
                if (knotEntity?.object3D) {
                    knotEntity.object3D.position.set(knot.position.x, knot.position.y, knot.position.z);
                    registry.updateEntityTransform(knotEntity.id);
                }
                for (const [side, vector] of [["in", knot.handleIn], ["out", knot.handleOut]]) {
                    if (!vector) continue;
                    const handle = registry?.getEntity?.(roadHandleEntityId(edge.id, knot.id, side));
                    if (!handle?.object3D) continue;
                    handle.object3D.position.set(
                        knot.position.x + vector.x,
                        knot.position.y + vector.y,
                        knot.position.z + vector.z,
                    );
                    registry.updateEntityTransform(handle.id);
                }
            }
        }
    }
    syncRoadHandleStems(scene, registry);
}

function applyTransientRoadPreview({
    changeSet,
    document,
    registry,
    scene,
    city,
    delta,
    gestureId,
    gestureStarts,
    hiddenRoots,
}) {
    const index = document.index();
    const closure = computeRoadClosure({ changeSet, document, registry, plan: null });
    const previewGroup = ensurePreviewGroup(scene);
    clearPreviewChildren(previewGroup);
    for (const root of hiddenRoots) {
        if (root) root.visible = true;
    }
    hiddenRoots.clear();

    for (const edgeId of closure.E2) {
        const edge = index.edges.get(edgeId);
        const root = roadRootFor(edgeId, city, registry);
        if (!root) continue;
        const entityId = roadEntityId(edgeId);
        if (edge && edgeDeltaIsUniform(edge, changeSet, delta)) {
            root.visible = true;
            applyAffine(root, gestureStarts, `${gestureId}:${entityId}`, delta, registry, entityId);
        } else {
            root.visible = false;
            hiddenRoots.add(root);
            if (edge) {
                const strip = createStripMesh(edgePreviewPoints(edge, index), edge.width);
                if (strip) previewGroup?.add(strip);
            }
        }
    }

    for (const nodeId of closure.J1) {
        const root = intersectionRootFor(nodeId, city, registry);
        if (!root) continue;
        const entityId = intersectionEntityId(nodeId);
        if (intersectionDeltaIsUniform(nodeId, changeSet, delta, index)) {
            root.visible = true;
            applyAffine(root, gestureStarts, `${gestureId}:${entityId}`, delta, registry, entityId);
        } else {
            root.visible = false;
            hiddenRoots.add(root);
        }
    }

    updateHandlesFromDocument(registry, document, closure, scene);
}

function rematerializeRoadClosure({ changeSet, data, scene, registry, document }) {
    const city = data.city();
    const index = document.index();
    const { vectorMap, connections } = documentToRoadNetworkInputs(document);
    const options = roadNetworkOptions(data);
    const v2 = roadGeometryVersionOf(document) === 2;
    const plan = v2
        ? planRoadNetworkGeometry(document.roads)
        : planRoadNetwork(toVector3Map(vectorMap), connections, options);
    const { J1, E2, touchedNodeIds, beforeEdges } = computeRoadClosure({ changeSet, document, registry, plan });

    const removedRoads = city.roads.filter((road) => {
        const edgeId = String(road.network?.edgeId ?? "");
        return E2.has(edgeId) || beforeEdges.has(edgeId) || !index.edges.has(edgeId);
    });
    for (const road of removedRoads) {
        road.root?.parent?.remove?.(road.root);
        disposeRoadRuntimeObject(road);
        registry?.unregisterEntity(roadEntityId(road.network?.edgeId ?? ""));
        removeRoadGeometryHandles(registry, String(road.network?.edgeId ?? ""));
    }
    city.roads = city.roads.filter((road) => !removedRoads.includes(road));
    const removedIntersections = city.intersections.filter((intersection) => {
        const nodeId = String(intersection.networkNodeId ?? "");
        return J1.has(nodeId) || !index.nodes.has(nodeId) || !plan.intersectionNodes.has(nodeId);
    });
    for (const intersection of removedIntersections) {
        intersection.root?.parent?.remove?.(intersection.root);
        disposeRoadRuntimeObject(intersection);
        registry?.unregisterEntity(intersectionEntityId(intersection.networkNodeId ?? ""));
        J1.add(String(intersection.networkNodeId ?? ""));
    }
    city.intersections = city.intersections.filter((intersection) => !removedIntersections.includes(intersection));
    for (const nodeId of touchedNodeIds) removeRoadNodeHandle(registry, nodeId);

    const existingRoads = new Map(city.roads.map((road) => [String(road.network?.edgeId ?? ""), road]));
    const built = (v2 ? materializeCompiledRoadNetwork : materializeRoadNetwork)(scene, plan, {
        edgeIds: E2,
        nodeIds: [...J1].filter((nodeId) => plan.intersectionNodes.has(nodeId)),
        existingRoads,
        ...(v2 ? { roadOptions: options.roadOptions } : {}),
    });
    city.addRoads(built.roads);
    for (const intersection of built.intersections) city.addIntersection(intersection);

    for (const intersection of city.intersections) {
        if (J1.has(String(intersection.networkNodeId ?? ""))) continue;
        intersection.roads = intersection.roads.map((road) => built.roadByEdge.get(String(road.network?.edgeId ?? "")) ?? road);
    }

    const affected = new Set([
        ...E2,
        ...beforeEdges.keys(),
        ...J1,
        ...removedRoads.map((road) => String(road.network?.edgeId ?? "")),
    ]);
    data.objects?.()?.replaceTriangles?.(
        (triangle) => triangle.environmentGeometryType === "road" && affected.has(String(triangle.environmentSourceId)),
        tagRoadTriangles(built.roads, built.intersections),
    );
    registerRoadEntities(registry, built, document, scene, { nodeIds: touchedNodeIds, data });
}

export function createRoadsProjector() {
    /** @type {Map<string, THREE.Matrix4>} */
    const gestureStarts = new Map();
    /** @type {Set<THREE.Object3D>} */
    const hiddenRoots = new Set();
    return {
        id: "roads",
        apply({ changeSet, data, scene, registry, document, transient }) {
            const versionChanged = Boolean(changeSet.scalars?.roadGeometryVersion);
            if (!changeSet.domains?.["roads.nodes"] && !changeSet.domains?.["roads.edges"] && !versionChanged) return;
            if (versionChanged) {
                clearTransientPreview(scene, gestureStarts, hiddenRoots);
                rebuildRoadRuntime(data, scene, document);
                return;
            }
            if (transient) {
                applyTransientRoadPreview({
                    changeSet,
                    document,
                    registry,
                    scene,
                    city: data.city(),
                    delta: changeSet.meta?.delta ?? null,
                    gestureId: changeSet.meta?.gestureId ?? "gesture",
                    gestureStarts,
                    hiddenRoots,
                });
                return;
            }
            clearTransientPreview(scene, gestureStarts, hiddenRoots);
            rematerializeRoadClosure({ changeSet, data, scene, registry, document });
        },
        rebuildAll({ data, scene, document }) {
            clearTransientPreview(scene, gestureStarts, hiddenRoots);
            rebuildRoadRuntime(data, scene, document);
        },
        dispose() {
            gestureStarts.clear();
            hiddenRoots.clear();
        },
    };
}
