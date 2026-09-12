/**
 * Buildings: during a gesture the existing mesh follows the cumulative world
 * delta (footprints are baked into world-space geometry, so an affine delta on
 * the mesh matches the footprint exactly). Every non-transient change (commit,
 * undo, redo, cancel, MCP) regenerates that one building from its record and
 * refreshes its LiDAR triangles and the bake building set.
 */

import * as THREE from "three";
import { generateBuildings } from "../../../city/BuildingGenerator.js";
import { removeBuildingMeshesFromScene } from "../../map/mapRuntimeSync.js";
import { syncBakeBuildingsFromDocument } from "../../map/bakeBuildingSync.js";
import { EDITOR_LAYERS } from "../../EditorState.js";

export function buildingEntityId(buildingId) {
    return `building:${buildingId}`;
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

function findBuildingMesh(scene, buildingId) {
    let found = null;
    scene?.traverse?.((object) => {
        if (!found && object.isMesh && object.userData?.buildingId === buildingId) found = object;
    });
    return found;
}

export function removeBuildingRuntime({ data, scene, registry, buildingId, runtime = null }) {
    (runtime?.removeBuildingMeshes ?? removeBuildingMeshesFromScene)(scene, buildingId);
    data.objects?.()?.replaceTriangles?.(
        (triangle) => triangle.environmentGeometryType === "building" && triangle.environmentSourceId === buildingId,
        [],
    );
    registry?.unregisterEntity(buildingEntityId(buildingId));
}

export function regenerateBuildingRuntime({ data, scene, registry, record, runtime = null }) {
    removeBuildingRuntime({ data, scene, registry, buildingId: record.buildingId, runtime });
    (runtime?.generateBuildings ?? generateBuildings)(scene, data, { records: [record] });
    const mesh = findBuildingMesh(scene, record.buildingId);
    if (mesh && registry) {
        registry.registerEntity({
            id: buildingEntityId(record.buildingId),
            sourceId: record.buildingId,
            kind: "building",
            layer: EDITOR_LAYERS.BUILDINGS,
            object3D: mesh,
            record: { ...record },
        });
    }
    return mesh;
}

export function createBuildingsProjector() {
    /** @type {Map<string, THREE.Matrix4>} pristine world matrices per `${gestureId}:${buildingId}` */
    const gestureStarts = new Map();
    return {
        id: "buildings",
        apply({ changeSet, data, scene, registry, document, transient, runtime }) {
            const domain = changeSet.domains?.buildings;
            if (!domain) return;
            const delta = changeSet.meta?.delta ?? null;
            const gestureId = changeSet.meta?.gestureId ?? null;
            let regenerated = false;
            for (const [id, after] of domain.after) {
                if (!after) {
                    removeBuildingRuntime({ data, scene, registry, buildingId: id, runtime });
                    regenerated = true;
                    continue;
                }
                const entity = registry?.getEntity(buildingEntityId(id));
                if (transient && delta && gestureId && entity?.object3D) {
                    const key = `${gestureId}:${id}`;
                    let start = gestureStarts.get(key);
                    if (!start) {
                        entity.object3D.updateMatrixWorld(true);
                        start = entity.object3D.matrixWorld.clone();
                        gestureStarts.set(key, start);
                    }
                    const world = new THREE.Matrix4().fromArray(delta.matrix).multiply(start);
                    setWorldMatrix(entity.object3D, world);
                    registry.updateEntityTransform(entity.id);
                    continue;
                }
                regenerateBuildingRuntime({ data, scene, registry, record: after, runtime });
                regenerated = true;
            }
            if (!transient) gestureStarts.clear();
            if (regenerated) syncBakeBuildingsFromDocument(data, document);
        },
        dispose() {
            gestureStarts.clear();
        },
    };
}
