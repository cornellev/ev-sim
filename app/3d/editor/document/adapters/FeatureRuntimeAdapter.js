import * as THREE from "three";
import { placeFusionObjectInScene } from "../../placement/placeFusionObject.js";

/**
 * Sync feature placements from document into fusion objects and registry.
 * Used when bulk-hydrating runtime from a saved document.
 */
export function syncFeaturesFromDocument(scene, data, document, registry) {
    const created = [];

    for (const feature of document.features) {
        const placed = placeFeatureFromRecord(scene, data, registry, feature);
        if (placed) {
            created.push({ feature, ...placed });
        }
    }

    return created;
}

/**
 * Place a single feature from a document record.
 */
export function placeFeatureFromRecord(scene, data, registry, feature) {
    const point = new THREE.Vector3(feature.x, 0, feature.z);
    const placed = placeFusionObjectInScene({
        data,
        scene,
        registry,
        assetId: feature.type,
        point,
    });

    return placed ? { entity: placed.entity, object: placed.object } : null;
}
