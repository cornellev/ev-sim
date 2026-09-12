/**
 * Browser-only projector runtime: the placement catalog and building
 * generator depend on bundler-resolved imports and DOM texture loading, so
 * they are injected into the SceneProjector by the loader rather than
 * imported by the projector itself. Node tests inject stubs.
 */

import { generateBuildings } from "../../city/BuildingGenerator.js";
import { removeBuildingMeshesFromScene, removeFeatureFromRuntime } from "../map/mapRuntimeSync.js";
import { placeFusionObjectInScene } from "../placement/placeFusionObject.js";

export function createBrowserProjectorRuntime() {
    return {
        placeFeature({ data, scene, registry, feature }) {
            return placeFusionObjectInScene({
                data,
                scene,
                registry,
                assetId: feature.type,
                point: { x: feature.x, y: 0, z: feature.z },
                sourceId: feature.id,
                dir: feature.dir ?? 0,
            });
        },
        removeFeature: removeFeatureFromRuntime,
        generateBuildings,
        removeBuildingMeshes: removeBuildingMeshesFromScene,
    };
}
