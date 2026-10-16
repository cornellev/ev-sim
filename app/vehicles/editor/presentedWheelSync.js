/**
 * Keep canonical wheel pivots in the scene across position edits.
 * A transform gizmo stays attached to the same object until radius, binding,
 * placement, or another structural field changes.
 */

function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function vec3(value) {
    return {
        x: finiteOr(value?.x, 0),
        y: finiteOr(value?.y, 0),
        z: finiteOr(value?.z, 0),
    };
}

function wheelStructure(wheel) {
    const visual = wheel?.visual;
    const bound = visual?.kind === "model-node";
    return {
        id: String(wheel?.id ?? ""),
        axle: wheel?.axle ?? null,
        side: wheel?.side ?? null,
        steerable: wheel?.steerable === true,
        radius: finiteOr(wheel?.radius, 0),
        width: finiteOr(wheel?.width, 0),
        visualKind: visual?.kind ?? null,
        nodeIndex: bound ? visual.nodeIndex : null,
    };
}

export function presentedWheelStructureKey(manifest) {
    const model = manifest?.model ?? {};
    const rotation = model.rotation ?? {};
    const box = manifest?.boundingBox ?? {};
    const wheels = (manifest?.wheels ?? [])
        .map(wheelStructure)
        .sort((left, right) => left.id.localeCompare(right.id));
    return JSON.stringify({
        wheels,
        hiddenNodeIndices: [...(model.hiddenNodeIndices ?? [])].sort((left, right) => left - right),
        scale: finiteOr(model.scale, 1),
        rotation: {
            x: finiteOr(rotation.x, 0),
            y: finiteOr(rotation.y, 0),
            z: finiteOr(rotation.z, 0),
            order: rotation.order || "XYZ",
        },
        offset: vec3(model.offset),
        boundingBox: {
            size: vec3(box.size),
            center: vec3(box.center),
        },
    });
}

export function presentedWheelPivots(wheelsGroup) {
    return (wheelsGroup?.children ?? []).filter((child) => child.userData?.presentedWheel === true);
}

export function gizmoHoldsPresentedWheel(object) {
    return object?.userData?.presentedWheel === true;
}

export function canNudgePresentedWheels(wheelsGroup, manifest, structureKey) {
    if (!structureKey || presentedWheelStructureKey(manifest) !== structureKey) return false;
    const wheels = manifest?.wheels ?? [];
    const pivots = presentedWheelPivots(wheelsGroup);
    if (pivots.length !== wheels.length) return false;
    const ids = new Set(wheels.map((wheel) => wheel.id));
    if (ids.size !== wheels.length) return false;
    return pivots.every((pivot) => ids.has(pivot.userData?.pick?.id));
}

export function nudgePresentedWheels(wheelsGroup, wheels, { skip = null } = {}) {
    const byId = new Map(presentedWheelPivots(wheelsGroup).map((pivot) => [pivot.userData?.pick?.id, pivot]));
    for (const wheel of wheels ?? []) {
        const pivot = byId.get(wheel.id);
        if (!pivot || pivot === skip || pivot.userData?.boundWheel === true) continue;
        const position = wheel.position ?? {};
        pivot.position.set(finiteOr(position.x, 0), finiteOr(position.y, 0), finiteOr(position.z, 0));
    }
}

/**
 * Detach a gizmo that holds a presented wheel, replace the pivots, then
 * attach the replacement for the current wheel selection.
 */
export function replacePresentedWheels(gizmo, wheelsGroup, selection, replace) {
    const holdsWheel = gizmoHoldsPresentedWheel(gizmo?.object);
    if (holdsWheel) gizmo.detach();
    replace();
    if (selection?.kind !== "wheel") return;
    const target = presentedWheelPivots(wheelsGroup).find((child) => child.userData?.pick?.id === selection.id) ?? null;
    if (target && gizmo) gizmo.attach(target);
}

/**
 * Write unbound wheel positions onto existing pivots when the presentation
 * structure is unchanged. Bound pivots stay on the mesh center.
 * Otherwise rebuild and keep the gizmo on a live pivot.
 */
export function syncPresentedWheelPositions({
    wheelsGroup,
    manifest,
    structureKey,
    gizmo,
    selection,
    rebuild,
} = {}) {
    const nextKey = presentedWheelStructureKey(manifest);
    if (canNudgePresentedWheels(wheelsGroup, manifest, structureKey)) {
        const skip = gizmo?.dragging && gizmoHoldsPresentedWheel(gizmo.object) ? gizmo.object : null;
        nudgePresentedWheels(wheelsGroup, manifest?.wheels, { skip });
        return { rebuilt: false, structureKey };
    }
    replacePresentedWheels(gizmo, wheelsGroup, selection, rebuild);
    return { rebuilt: true, structureKey: nextKey };
}
