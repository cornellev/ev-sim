import * as THREE from "three";

/**
 * Place a loaded model inside the vehicle-local frame.
 * When `boundingBox` is provided, shifts the mesh so its AABB center equals
 * `boundingBox.center` in **parent-local** space, then adds `model.offset`.
 * @returns {{ x: number, y: number, z: number }} AABB alignment translation (before offset).
 */
export function applyModelPlacement(object3d, model, boundingBox = null) {
    const scale = Number(model?.scale);
    object3d.scale.setScalar(Number.isFinite(scale) && scale > 0 ? scale : 1);
    const rotation = model?.rotation || {};
    object3d.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
    if (rotation.order) object3d.rotation.order = rotation.order;
    object3d.position.set(0, 0, 0);
    object3d.updateMatrixWorld(true);

    let alignX = 0;
    let alignY = 0;
    let alignZ = 0;
    if (boundingBox?.center) {
        const box = new THREE.Box3().setFromObject(object3d);
        const localCenter = box.getCenter(new THREE.Vector3());
        // setFromObject is world-space; convert to parent-local before writing position.
        if (object3d.parent) {
            object3d.parent.worldToLocal(localCenter);
        }
        alignX = Number(boundingBox.center.x || 0) - localCenter.x;
        alignY = Number(boundingBox.center.y || 0) - localCenter.y;
        alignZ = Number(boundingBox.center.z || 0) - localCenter.z;
    }

    const offset = model?.offset || {};
    object3d.position.set(
        alignX + Number(offset.x || 0),
        alignY + Number(offset.y || 0),
        alignZ + Number(offset.z || 0),
    );
    return { x: alignX, y: alignY, z: alignZ };
}
