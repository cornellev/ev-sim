/**
 * Browser-only projector runtime: the placement catalog and building
 * generator depend on bundler-resolved imports and DOM texture loading, so
 * they are injected into the SceneProjector by the loader rather than
 * imported by the projector itself. Node tests inject stubs.
 */

import { generateBuildings } from "../../city/BuildingGenerator.js";
import { removeBuildingMeshesFromScene, removeFeatureFromRuntime } from "../map/mapRuntimeSync.js";
import { placeFusionObjectInScene } from "../placement/placeFusionObject.js";
import { AssetRepository } from "../assets/AssetRepository.js";
import { AssetModelLoader } from "../assets/AssetModelLoader.js";
import { AssetInstantiation } from "../assets/AssetInstantiation.js";
import { AssetPreviewRenderer } from "../assets/AssetPreviewRenderer.js";
import { AssetStudioSessionRegistry } from "../assets/AssetStudioSession.js";

export function createBrowserProjectorRuntime({ data = null, renderer = null } = {}) {
    const repository = new AssetRepository();
    const models = new AssetModelLoader({ renderer: renderer ?? data?.renderer ?? data?.three?.()?.renderer ?? null });
    const previews = new AssetPreviewRenderer();
    previews.models = models;
    const sessions = new AssetStudioSessionRegistry();
    return {
        editorAssets: {
            repository,
            models,
            previews,
            sessions,
            instantiation: data?.environment?.()?.getDocument
                ? new AssetInstantiation({ repository, document: data.environment().getDocument() })
                : null,
        },
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
        dispose() {
            previews.dispose();
            sessions.dispose();
            models.dispose();
        },
    };
}
