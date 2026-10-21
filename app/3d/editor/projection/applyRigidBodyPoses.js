/**
 * Copy live rigid-body poses onto viewport meshes. The environment document
 * stays at the authored spawn pose.
 */

import { entityIdForObject } from "../selection/selectionIds.js";

export function applyRigidBodyViewportPoses(data, poses = []) {
    if (!poses?.length || !data?.scene) return;
    const registry = data.environment?.()?.registry ?? null;
    for (const pose of poses) {
        const entityId = entityIdForObject({ id: pose.id, typeId: pose.host }, registry);
        const mesh = (entityId && registry?.getEntity?.(entityId)?.object3D)
            ?? data.scene.getObjectByName?.(`primitive:${pose.id}`)
            ?? data.scene.getObjectByName?.(`asset:${pose.id}`)
            ?? null;
        if (!mesh?.position?.set || !mesh?.quaternion?.set) continue;
        mesh.position.set(pose.position.x, pose.position.y, pose.position.z);
        mesh.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
        mesh.updateMatrixWorld?.(true);
    }
}
