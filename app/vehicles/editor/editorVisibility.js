/**
 * Viewport visibility for the vehicle studio. This does not write the manifest.
 * Semantic `hiddenNodeIndices` stay hidden. A bound wheel that has been
 * reparented onto a pivot follows the wheel, axle, and source-node flags.
 */

import {
    hierarchyVisibilityKey,
    modelNodeViewportHidden,
} from "./workspace/vehicleHierarchyModel.js";

export function isObjectShown(object) {
    if (!object) return false;
    const seen = new Set();
    let cursor = object;
    while (cursor && !seen.has(cursor)) {
        if (cursor.visible === false) return false;
        seen.add(cursor);
        cursor = cursor.parent;
    }
    return true;
}

function isDescendantOf(object, ancestor) {
    const seen = new Set();
    let cursor = object?.parent ?? null;
    while (cursor && !seen.has(cursor)) {
        if (cursor === ancestor) return true;
        seen.add(cursor);
        cursor = cursor.parent;
    }
    return false;
}

/** Node indexes hidden by `hiddenNodeIndices`, including descendants. */
export function semanticHiddenNodeIndices(nodes, hiddenNodeIndices) {
    const children = new Map();
    for (const node of nodes ?? []) {
        if (!Number.isInteger(node?.parentIndex)) continue;
        const list = children.get(node.parentIndex) ?? [];
        list.push(node.index);
        children.set(node.parentIndex, list);
    }
    const hidden = new Set();
    const stack = [];
    for (const index of hiddenNodeIndices ?? []) {
        if (Number.isInteger(index)) stack.push(index);
    }
    while (stack.length > 0) {
        const index = stack.pop();
        if (hidden.has(index)) continue;
        hidden.add(index);
        for (const child of children.get(index) ?? []) stack.push(child);
    }
    return hidden;
}

function axleOf(wheel) {
    return wheel?.axle === "front" || wheel?.axle === "rear" ? wheel.axle : "other";
}

/**
 * Write `visible` on the studio objects for the current session hides.
 * Call this after presentation captures rest poses and after marker rebuilds.
 */
export function applyEditorVisibility(scene, { manifest = null, nodes = [], hiddenIds = [] } = {}) {
    const hidden = hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds ?? []);
    const semantic = semanticHiddenNodeIndices(nodes, manifest?.model?.hiddenNodeIndices ?? []);
    const wheelsById = new Map((manifest?.wheels ?? []).map((wheel) => [wheel.id, wheel]));

    if (scene.bboxMesh) scene.bboxMesh.visible = !hidden.has(hierarchyVisibilityKey("body", "body"));
    if (scene.modelRoot) scene.modelRoot.visible = !hidden.has(hierarchyVisibilityKey("model", "model"));
    if (scene.zoneGroup) scene.zoneGroup.visible = !hidden.has(hierarchyVisibilityKey("lidar", "lidar"));

    const modelRoot = scene.modelRoot ?? null;
    for (const [object, mapping] of scene.nodeMappings ?? []) {
        if (!object || !modelRoot || !isDescendantOf(object, modelRoot)) continue;
        const index = mapping?.nodeIndex;
        if (!Number.isInteger(index)) continue;
        const viewportHidden = modelNodeViewportHidden(hidden, index, nodes, { includeModel: true, includeSelf: true });
        object.visible = !semantic.has(index) && !viewportHidden;
    }

    for (const child of scene.wheelsGroup?.children ?? []) {
        const id = child.userData?.pick?.id;
        const wheel = id ? wheelsById.get(id) : null;
        if (!wheel) continue;
        const axleHidden = hidden.has(hierarchyVisibilityKey("axle", `axle-${axleOf(wheel)}`));
        const wheelHidden = hidden.has(hierarchyVisibilityKey("wheel", id));
        const nodeIndex = wheel.visual?.kind === "model-node" && Number.isInteger(wheel.visual.nodeIndex)
            ? wheel.visual.nodeIndex
            : null;
        const sourceHidden = nodeIndex != null && modelNodeViewportHidden(hidden, nodeIndex, nodes, {
            includeModel: false,
            includeSelf: true,
        });
        child.visible = !wheelHidden && !axleHidden && !sourceHidden;
    }

    for (const child of scene.sensorsGroup?.children ?? []) {
        const id = child.userData?.pick?.id;
        if (!id) continue;
        child.visible = !hidden.has(hierarchyVisibilityKey("sensor", id));
    }
}
