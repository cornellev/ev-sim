/**
 * Props: move in place, add through the placement catalog, remove from the
 * runtime. Entities are `fusion:<featureId>` because placement pins the
 * fusion object uuid to the document id.
 */

import { removeFeatureFromRuntime } from "../../map/mapRuntimeSync.js";

export function featureEntityId(featureId) {
    return `fusion:${featureId}`;
}

/**
 * Place a feature through the injected runtime (`runtime.placeFeature`),
 * then apply its facing and yaw. The placement catalog itself is
 * browser-only, so it never loads here.
 */
export function placeFeatureRuntime({ data, scene, registry, feature, runtime }) {
    if (typeof runtime?.placeFeature !== "function") {
        console.warn(`[environment] no placement runtime; feature "${feature.id}" was not placed.`);
        return { object: null, entity: null };
    }
    const placed = runtime.placeFeature({ data, scene, registry, feature }) ?? {};
    const { object = null, entity = null } = placed;
    if (object) {
        object.dir = feature.dir ?? 0;
        if (object._mesh) {
            object._mesh.rotation.y = feature.rotationY ?? 0;
            object._mesh.updateMatrixWorld(true);
        }
        if (entity) registry.updateEntityTransform(entity.id);
    }
    return { object, entity };
}

export function applyFeatureTransform(registry, entity, feature) {
    const mesh = entity.object3D ?? entity.fusionObject?._mesh ?? null;
    if (entity.fusionObject) {
        entity.fusionObject.setPosition?.(feature.x, 0, feature.z);
        entity.fusionObject.dir = feature.dir ?? entity.fusionObject.dir;
    }
    if (mesh) {
        mesh.position.set(feature.x, 0, feature.z);
        mesh.rotation.y = feature.rotationY ?? 0;
        mesh.updateMatrixWorld(true);
    }
    registry.updateEntityTransform(entity.id);
}

export function createFeaturesProjector() {
    return {
        id: "features",
        apply({ changeSet, data, scene, registry, runtime }) {
            const domain = changeSet.domains?.features;
            if (!domain || !registry) return;
            const removeFeature = runtime?.removeFeature ?? removeFeatureFromRuntime;
            for (const [id, after] of domain.after) {
                const before = domain.before.get(id) ?? null;
                if (!after) {
                    removeFeature(data, scene, id);
                    continue;
                }
                const entity = registry.getEntity(featureEntityId(id));
                // Placement geometry depends on the asset type and facing; both re-place.
                if (!entity || !before || before.type !== after.type || (before.dir ?? 0) !== (after.dir ?? 0)) {
                    if (entity) removeFeature(data, scene, id);
                    placeFeatureRuntime({ data, scene, registry, feature: after, runtime });
                    continue;
                }
                applyFeatureTransform(registry, entity, after);
            }
        },
    };
}
