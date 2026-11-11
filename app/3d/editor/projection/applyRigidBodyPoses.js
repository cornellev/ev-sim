/**
 * Copy live rigid-body poses onto viewport meshes. The environment document stays at
 * the authored spawn pose. Stop, reset, and the environment editor write
 * that authored pose back with `restoreAuthoredRigidBodyPoses`.
 */

import { readAssetBinding } from "../../../editor-assets/AssetBackedObject.js";
import { normalizePrimitiveRecord } from "../../../simulation/world/PrimitiveRecords.js";
import { entityIdForObject } from "../selection/selectionIds.js";
import { applyFeatureTransform } from "./projectors/featuresProjector.js";
import { syncRigidBodyLidarSolids } from "./rigidBodyLidarSolids.js";

function list(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.values === "function") return [...value.values()];
    return [];
}

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function registryOf(data) {
    return data?.environment?.()?.registry ?? null;
}

function viewportMesh(data, record) {
    const registry = registryOf(data);
    const entityId = entityIdForObject(record, registry);
    return (entityId && registry?.getEntity?.(entityId)?.object3D)
        ?? data?.scene?.getObjectByName?.(`primitive:${record.id}`)
        ?? data?.scene?.getObjectByName?.(`asset:${record.id}`)
        ?? null;
}

export function applyRigidBodyViewportPoses(data, poses = []) {
    if (!poses?.length) return;
    if (data?.scene) {
        for (const pose of poses) {
            const mesh = viewportMesh(data, { id: pose.id, typeId: pose.host });
            if (!mesh?.position?.set || !mesh?.quaternion?.set) continue;
            if (mesh.position.x === pose.position.x && mesh.position.y === pose.position.y && mesh.position.z === pose.position.z
                && mesh.quaternion.x === pose.rotation.x && mesh.quaternion.y === pose.rotation.y
                && mesh.quaternion.z === pose.rotation.z && mesh.quaternion.w === pose.rotation.w) continue;
            mesh.position.set(pose.position.x, pose.position.y, pose.position.z);
            mesh.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
            mesh.updateMatrixWorld?.(true);
        }
    }
}

/** Put rigid-body meshes back on the document transform. Does not write the document. */
export function restoreAuthoredRigidBodyPoses(data) {
    const document = data?.environment?.()?.getDocument?.();
    if (document && data?.scene) restoreAuthoredMeshes(data, document);
    syncRigidBodyLidarSolids(data, null);
}

function restoreAuthoredMeshes(data, document) {
    const registry = registryOf(data);
    for (const record of list(document.objects)) {
        if (record?.components?.rigidBody === undefined) continue;
        if (record.typeId === "builtin-prop") {
            const feature = list(document.features).find((entry) => String(entry.id) === String(record.id));
            const entityId = entityIdForObject(record, registry);
            const entity = entityId ? registry?.getEntity?.(entityId) : null;
            if (feature && entity) applyFeatureTransform(registry, entity, feature);
            continue;
        }
        const mesh = viewportMesh(data, record);
        if (!mesh?.position?.set) continue;
        if (record.typeId === "primitive") {
            const raw = list(document.primitives).find((entry) => String(entry.id) === String(record.id));
            if (!raw) continue;
            const primitive = normalizePrimitiveRecord(raw);
            mesh.position.set(primitive.position.x, primitive.position.y, primitive.position.z);
            mesh.rotation?.set?.(0, primitive.rotationY, 0);
        } else if (record.typeId === "asset-instance") {
            const asset = readAssetBinding(record);
            if (!asset) continue;
            const scale = asset.scale ?? { x: 1, y: 1, z: 1 };
            mesh.position.set(
                finite(asset.position?.x, 0),
                finite(asset.position?.y, 0),
                finite(asset.position?.z, 0),
            );
            mesh.rotation?.set?.(0, finite(asset.rotationY, 0), 0);
            mesh.scale?.set?.(finite(scale.x, 1), finite(scale.y, 1), finite(scale.z, 1));
        } else {
            continue;
        }
        mesh.updateMatrixWorld?.(true);
    }
}
