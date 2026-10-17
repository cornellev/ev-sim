import { promises as fs } from "node:fs";

import { compileAssetDefinition } from "../../app/editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition } from "../../app/editor-assets/AssetDefinition.js";
import { assetMetricDefinitionFromRevision } from "../../app/editor-assets/AssetMetricSnapshot.js";
import { createGeoFrame } from "../../app/geography/GeoFrame.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import {
    hashVisualLayer,
    hashVisualLayerAccess,
    normalizeVisualLayer,
    normalizeVisualLayerAccess,
    VISUAL_ASSET_PROFILE,
} from "../../app/simulation/visual/VisualLayer.js";
import { createDefaultVehicleManifest } from "../../app/vehicles/VehicleManifest.js";
import { StorageService } from "../../server/storage/StorageService.js";
import { makeNamedMaterialGlb, ownedGrant, publishAsset, writeRegistry } from "./visual-assets.js";

export const CORRIDOR_ENVIRONMENT_ID = "corridor";
export const CORRIDOR_VEHICLE_ID = "corridor-car";
export const CORRIDOR_ASSET_ID = "corridor-cone";

const FRAME = createGeoFrame({ origin: { lat: 42.443, lng: -76.502, height: 0 } });
const MODEL_GEOMETRY = {
    0: {
        vertices: [[-1, 0, -1], [1, 0, -1], [0, 2, 0]],
        triangles: [[0, 1, 2]],
    },
};

/**
 * A short road, one pinned cone on the first pose, one box beside the centerline,
 * and a plugin-free vehicle. The visual-layer closure is an empty-of-instances
 * descriptor over the cone's published model so bundle admission copies it.
 */
export async function buildPlanningCorridor(dir) {
    await fs.mkdir(dir, { recursive: true });
    await writeRegistry(dir, [ownedGrant()]);
    const service = new StorageService(dir);
    await service.visualAssets.initialize();
    const source = await publishAsset(service.visualAssets, makeNamedMaterialGlb("corridor-cone"), {
        mediaType: "model/gltf-binary",
        role: "mesh",
    });
    const definition = createEmptyAssetDefinition({ modelUseHash: source.useHash, name: "Cone" });
    definition.collisionProxies.push({
        id: "body",
        kind: "box",
        enabled: true,
        transform: { position: [0, 0.2, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        size: [0.4, 0.4, 0.4],
    });
    const compiled = compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } });
    if (!compiled.metric.collision?.length) {
        throw new Error("Corridor cone compiled without a collision mesh.");
    }
    const published = await service.editorAssets.publishRevision({
        assetId: CORRIDOR_ASSET_ID,
        name: "Corridor cone",
        publicationId: "corridor-cone",
        expectedAssetRevision: 0,
        modelUseHash: source.useHash,
        definition,
        metric: compiled.metric,
        metricHash: compiled.metricHash,
        appearance: compiled.materials,
    }, 0);
    const metric = assetMetricDefinitionFromRevision(CORRIDOR_ASSET_ID, published.revision);
    const created = await service.createEnvironment({
        id: CORRIDOR_ENVIRONMENT_ID,
        name: "Corridor",
    });
    const withGeometry = {
        ...created,
        name: "Corridor",
        roadsAuthored: true,
        document: {
            ...created.document,
            roadsAuthored: true,
            geoFrame: FRAME,
            roads: {
                geometryVersion: 2,
                nodes: [
                    { id: "a", x: 0, z: 0 },
                    { id: "b", x: 30, z: 0 },
                ],
                edges: [{
                    id: "road",
                    startNodeId: "a",
                    endNodeId: "b",
                    width: 8,
                    laneCount: 1,
                    bidirectional: true,
                    geometry: {
                        version: 1,
                        kind: "polyline",
                        knots: [{ id: "start" }, { id: "end" }],
                    },
                }],
                turnRules: [],
            },
            primitives: [{
                id: "crate",
                shape: "box",
                position: { x: 12, y: 0.5, z: 2 },
                rotationY: 0,
                size: { x: 1.2, y: 1, z: 1.2 },
                color: "#c4a574",
                tags: ["unknown"],
            }],
            objects: [
                ...created.document.objects,
                {
                    id: "cone",
                    typeId: "asset-instance",
                    typeVersion: 2,
                    name: "Cone",
                    parentId: null,
                    order: 1,
                    components: {
                        tags: [],
                        locked: false,
                        editorHidden: false,
                        asset: {
                            assetId: CORRIDOR_ASSET_ID,
                            revision: published.revision.revision,
                            position: { x: 0, y: 0, z: 0 },
                            rotationY: 0,
                            scale: { x: 1, y: 1, z: 1 },
                            overrides: {},
                        },
                    },
                },
            ],
            assetMetrics: { version: 1, definitions: [metric] },
        },
    };
    const write = {
        supportedAssetMetricVersions: [1],
        supportedEditorSourceVersions: [1],
        supportedRoadGeometryVersions: [1, 2],
        supportedScenePrimitiveVersions: [1],
    };
    const saved = await service.putEnvironment(CORRIDOR_ENVIRONMENT_ID, {
        manifest: withGeometry,
        expectedRevision: created.revision,
        ...write,
    });
    const descriptor = normalizeVisualLayer({
        kind: "cev-sim.visual-layer",
        version: 1,
        sourceWorldHash: createWorldResource(saved).hash,
        assetProfile: VISUAL_ASSET_PROFILE,
        assets: [source.use.asset],
        materials: [],
        chunks: [],
        instances: [],
        bindings: [],
        appearanceDependencies: [],
    });
    const access = normalizeVisualLayerAccess({
        kind: "cev-sim.visual-layer-access",
        version: 1,
        descriptorHash: hashVisualLayer(descriptor),
        assets: [{ sha256: source.use.asset.sha256, useHash: source.useHash }],
    });
    await service._visualLayerDescriptors.put(descriptor);
    await service._visualLayerAccess.put(access);
    await service.putEnvironment(CORRIDOR_ENVIRONMENT_ID, {
        manifest: {
            ...saved,
            visualLayer: {
                descriptorHash: access.descriptorHash,
                accessHash: hashVisualLayerAccess(access),
            },
        },
        expectedRevision: saved.revision,
        ...write,
    });
    await service.createVehicleManifest(createDefaultVehicleManifest({
        id: CORRIDOR_VEHICLE_ID,
        name: "Corridor Car",
    }));
    return {
        environmentId: CORRIDOR_ENVIRONMENT_ID,
        vehicleId: CORRIDOR_VEHICLE_ID,
    };
}
