/**
 * Present bound wheel meshes on vehicle-frame pivots.
 * A bound pivot sits at the placed geometric center of that node.
 * Placement is applied to the full source hierarchy before any wheel is moved.
 */

export function captureModelRest(root, nodeMappings) {
    const entries = [];
    for (const [object, mapping] of nodeMappings ?? []) {
        if (!object || object === root) continue;
        entries.push({
            nodeIndex: mapping.nodeIndex,
            object,
            parent: object.parent,
            childIndex: object.parent ? object.parent.children.indexOf(object) : -1,
            position: object.position.clone(),
            quaternion: object.quaternion.clone(),
            scale: object.scale.clone(),
            visible: object.visible,
        });
    }
    return entries;
}

export function restoreModelRest(capture = []) {
    for (const entry of capture) entry.object.removeFromParent();
    const grouped = new Map();
    for (const entry of capture) {
        if (!entry.parent) continue;
        const list = grouped.get(entry.parent) ?? [];
        list.push(entry);
        grouped.set(entry.parent, list);
    }
    for (const [parent, entries] of grouped) {
        entries.sort((left, right) => left.childIndex - right.childIndex);
        for (const entry of entries) {
            const index = Math.max(0, Math.min(entry.childIndex, parent.children.length));
            parent.children.splice(index, 0, entry.object);
            entry.object.parent = parent;
        }
    }
    for (const entry of capture) {
        entry.object.position.copy(entry.position);
        entry.object.quaternion.copy(entry.quaternion);
        entry.object.scale.copy(entry.scale);
        entry.object.visible = entry.visible;
        entry.object.matrixAutoUpdate = true;
        entry.object.updateMatrix();
    }
}

/** Write a measured placement onto the model root. Does not remeasure the live graph. */
export function applyMeasuredPlacement(root, placement = {}) {
    const scale = Number(placement.scale);
    root.scale.setScalar(Number.isFinite(scale) && scale > 0 ? scale : 1);
    const rotation = placement.rotation ?? {};
    root.rotation.order = rotation.order || "XYZ";
    root.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
    const alignment = placement.alignment ?? { x: 0, y: 0, z: 0 };
    const offset = placement.offset ?? { x: 0, y: 0, z: 0 };
    root.position.set(
        (alignment.x || 0) + (offset.x || 0),
        (alignment.y || 0) + (offset.y || 0),
        (alignment.z || 0) + (offset.z || 0),
    );
    root.updateMatrixWorld(true);
}

export function clearPresentedWheels(wheelsGroup) {
    if (!wheelsGroup) return;
    for (const child of [...wheelsGroup.children]) {
        if (!child.userData?.presentedWheel) continue;
        child.traverse((object) => {
            if (!object.userData?.generatedWheel) return;
            object.geometry?.dispose?.();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach((material) => material?.dispose?.());
        });
        wheelsGroup.remove(child);
    }
}

function objectByNode(nodeMappings) {
    const map = new Map();
    for (const [object, mapping] of nodeMappings ?? []) {
        if (Number.isInteger(mapping?.nodeIndex)) map.set(mapping.nodeIndex, object);
    }
    return map;
}

function hideSubtree(object) {
    if (!object) return;
    object.visible = false;
}

function component(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

/** Placed center of a bound node, in wheelsGroup local space. */
function placedMeshCenter(object, wheelsGroup, THREE) {
    wheelsGroup.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    wheelsGroup.worldToLocal(center);
    return center;
}

/**
 * Hide suppressed subtrees, reparent bound meshes onto pivots, and build
 * cylinders for wheels that are not bound to a source node.
 */
export function presentBoundWheels({
    root,
    wheelsGroup,
    manifest,
    nodeMappings,
    THREE,
    materials = null,
} = {}) {
    const byIndex = objectByNode(nodeMappings);
    const hidden = manifest?.model?.hiddenNodeIndices ?? [];
    for (const nodeIndex of hidden) hideSubtree(byIndex.get(nodeIndex));
    const pivots = [];
    const cylinders = [];
    clearPresentedWheels(wheelsGroup);
    for (const wheel of manifest?.wheels ?? []) {
        const bound = wheel.visual?.kind === "model-node" ? byIndex.get(wheel.visual.nodeIndex) : null;
        if (bound && bound !== root) {
            bound.visible = true;
            bound.updateWorldMatrix(true, true);
            const world = bound.matrixWorld.clone();
            const center = placedMeshCenter(bound, wheelsGroup, THREE) ?? wheel.position;
            bound.removeFromParent();
            const pivot = new THREE.Group();
            pivot.name = `wheel-pivot-${wheel.id}`;
            pivot.position.set(component(center.x), component(center.y), component(center.z));
            pivot.userData.presentedWheel = true;
            pivot.userData.boundWheel = true;
            pivot.userData.pick = { kind: "wheel", id: wheel.id };
            wheelsGroup.add(pivot);
            pivot.updateMatrixWorld(true);
            const local = new THREE.Matrix4().copy(pivot.matrixWorld).invert().multiply(world);
            pivot.add(bound);
            local.decompose(bound.position, bound.quaternion, bound.scale);
            bound.matrixAutoUpdate = true;
            bound.updateMatrix();
            bound.traverse((child) => { child.userData.pick = pivot.userData.pick; });
            pivots.push({
                wheelId: wheel.id,
                pivot,
                steerable: wheel.steerable === true,
                nodeIndex: wheel.visual.nodeIndex,
            });
            continue;
        }
        const geometry = new THREE.CylinderGeometry(wheel.radius, wheel.radius, wheel.width, 24);
        geometry.rotateX(Math.PI / 2);
        const material = wheel.steerable
            ? (materials?.steerable ?? new THREE.MeshStandardMaterial({ color: 0x0c4a6e, roughness: 0.8 }))
            : (materials?.fixed ?? new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.8 }));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.userData.generatedWheel = true;
        const pivot = new THREE.Group();
        pivot.name = `wheel-cylinder-${wheel.id}`;
        pivot.position.set(wheel.position.x, wheel.position.y, wheel.position.z);
        pivot.userData.presentedWheel = true;
        pivot.userData.pick = { kind: "wheel", id: wheel.id };
        pivot.add(mesh);
        mesh.userData.pick = pivot.userData.pick;
        wheelsGroup.add(pivot);
        cylinders.push({
            wheelId: wheel.id,
            mesh,
            pivot,
            steerable: wheel.steerable === true,
        });
    }
    return { pivots, cylinders, hiddenNodeIndices: [...hidden] };
}
