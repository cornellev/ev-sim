import * as THREE from "three";
import { resolveTransformTargets } from "./TransformTool.js";

/** Frame the camera on a set of runtime objects (F key, inspector Focus). */
export function focusCameraOnObjects({ data, object3Ds }) {
    const camera = data?.three?.()?.camera;
    if (!camera || !object3Ds?.length) return false;
    const box = new THREE.Box3();
    for (const object3D of object3Ds) {
        object3D.updateMatrixWorld(true);
        const objectBox = new THREE.Box3().setFromObject(object3D);
        if (objectBox.isEmpty()) {
            const position = new THREE.Vector3();
            object3D.getWorldPosition(position);
            objectBox.setFromCenterAndSize(position, new THREE.Vector3(1, 1, 1));
        }
        box.union(objectBox);
    }
    if (box.isEmpty()) return false;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const distance = Math.max(size.x, size.y, size.z, 4) * 1.8;
    camera.position.set(center.x + distance, center.y + distance, center.z + distance);
    camera.lookAt(center);
    const controls = data.simulation?.()?.controls;
    controls?.target?.copy?.(center);
    controls?.update?.();
    data.simulation?.()?.render?.();
    return true;
}

/** Frame the current selection (or the given object ids). */
export function focusCameraOnSelection({ data, objectIds = null }) {
    const selection = data?.selection?.();
    const document = data?.environment?.()?.getDocument?.();
    const registry = data?.environment?.()?.objects?.();
    if (!selection || !document || !registry) return false;
    const snapshot = objectIds ? { ids: [...objectIds], sub: null } : selection.snapshot();
    const targets = resolveTransformTargets({ selectionSnapshot: snapshot, document, registry });
    return focusCameraOnObjects({ data, object3Ds: targets.object3Ds });
}
