import { getBuiltInVehicleManifest } from "../../app/vehicles/BuiltInVehicleManifests.js";
import {
    createPbrRenderSceneResource,
    normalizePbrAssetClosure,
    normalizePbrRenderRecipe,
    normalizePbrRunEvidence,
} from "../../app/simulation/render/PbrRenderScene.js";
import {
    hashVisualAssetUse,
    hashVisualLayer,
    hashVisualLayerAccess,
    normalizeVisualAssetReference,
    normalizeVisualAssetUse,
    normalizeVisualLayer,
    normalizeVisualLayerAccess,
} from "../../app/simulation/visual/VisualLayer.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";

function environment() {
    return {
        environmentId: "vis14-yard",
        name: "VIS-14 yard",
        schemaVersion: 2,
        templateId: "blank",
        roadStylePreset: "default",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: false,
        document: {
            environmentId: "vis14-yard",
            chunkSize: 20,
            roads: {
                nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }],
                edges: [{ id: "road", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 4, laneCount: 1 }],
            },
            buildings: [],
            features: [],
            earth: null,
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: false,
        },
    };
}

export function resolvedPbrRun({
    actorSha256 = "a".repeat(64),
    actorSizeBytes = 16,
    environmentMapSha256 = null,
    environmentMapSizeBytes = 0,
} = {}) {
    const world = createWorldResource(environment());
    const actorAsset = normalizeVisualAssetReference({
        sha256: actorSha256,
        mediaType: "model/gltf-binary",
        sizeBytes: actorSizeBytes,
        role: "actor",
    });
    const actorUse = normalizeVisualAssetUse({
        asset: actorAsset,
        sourceIds: ["owned-test"],
        dependencies: {},
    });
    const actorUseHash = hashVisualAssetUse(actorUse);
    const environmentMapAsset = environmentMapSha256 ? normalizeVisualAssetReference({
        sha256: environmentMapSha256,
        mediaType: "image/ktx2",
        sizeBytes: environmentMapSizeBytes,
        role: "environment-map",
    }) : null;
    const environmentMapUse = environmentMapAsset ? normalizeVisualAssetUse({
        asset: environmentMapAsset,
        sourceIds: ["owned-test"],
        dependencies: {},
    }) : null;
    const environmentMapUseHash = environmentMapUse ? hashVisualAssetUse(environmentMapUse) : null;
    const visualDescription = normalizeVisualLayer({
        sourceWorldHash: world.hash,
        assets: [],
        materials: [],
        chunks: [],
        instances: [],
        bindings: [],
        appearanceDependencies: [],
    });
    const visualLayer = { description: visualDescription, hash: hashVisualLayer(visualDescription) };
    const access = normalizeVisualLayerAccess({
        descriptorHash: visualLayer.hash,
        assets: [],
    });
    const recipe = normalizePbrRenderRecipe({
        background: environmentMapUse ? {
            environmentMap: {
                asset: environmentMapAsset,
                useHash: environmentMapUseHash,
                intensity: 0.75,
                rotationRadians: 0.125,
            },
        } : undefined,
        actors: [{
            actorId: "ego",
            mode: "visual-asset",
            asset: { asset: actorAsset, useHash: actorUseHash },
            material: {
                baseColorFactor: [0.2, 0.4, 0.6, 1],
                metallicFactor: 0.1,
                roughnessFactor: 0.7,
            },
        }],
    });
    const assetClosure = normalizePbrAssetClosure({
        assets: [actorAsset, environmentMapAsset].filter(Boolean),
    });
    const renderScene = createPbrRenderSceneResource({
        worldResource: world,
        vehicleDependencies: [{ actorId: "ego", manifest: getBuiltInVehicleManifest("big-car") }],
        selection: {
            provider: { id: "pbr-mesh", version: 1 },
            productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
        },
        visualLayerResource: visualLayer,
        renderRecipe: recipe,
        assetClosure,
    });
    const evidence = normalizePbrRunEvidence({
        visualAssets: {
            descriptorHash: visualLayer.hash,
            accessHash: hashVisualLayerAccess(access),
            access,
            roots: [
                { scope: "actor:ego", sha256: actorAsset.sha256, useHash: actorUseHash },
                ...(environmentMapUse ? [{
                    scope: "environment-map",
                    sha256: environmentMapAsset.sha256,
                    useHash: environmentMapUseHash,
                }] : []),
            ],
            uses: [
                { useHash: actorUseHash, use: actorUse },
                ...(environmentMapUse ? [{ useHash: environmentMapUseHash, use: environmentMapUse }] : []),
            ],
            assetClosureHash: renderScene.description.assetClosureHash,
            permissions: {
                operations: ["display", "machine-interpretation"],
                evaluatedSourceIds: ["owned-test"],
                obligations: { attribution: [], requirements: [], retentionUntil: null },
            },
        },
        correspondence: null,
    });
    return { world, visualLayer, renderScene, evidence, actorUseHash, environmentMapUseHash };
}
