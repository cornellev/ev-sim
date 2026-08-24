export function syncDeviceVisuals(device, objects = []) {
    const position = device.getPosition();
    const rotation = device.getRotation();
    for (const object of objects) {
        if (!object) continue;
        object.position.copy(position);
        object.rotation.copy(rotation);
        object.updateMatrixWorld?.(true);
    }
}

export function setDeviceVisualsEnabled(enabled, objects = []) {
    for (const object of objects) {
        if (object) object.visible = Boolean(enabled);
    }
}

export function disposeObject3D(root) {
    if (!root) return;
    const materials = new Set();
    root.traverse((object) => {
        object.geometry?.dispose?.();
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of objectMaterials) {
            if (material) materials.add(material);
        }
    });
    for (const material of materials) material.dispose?.();
    root.removeFromParent?.();
}
