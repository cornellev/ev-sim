import { DEFAULT_ENVIRONMENT_SKY_CONFIG, skyConfigToManifest } from "../skybox/EnvironmentSkyConfig.js";
import { assetMetricDefinitionFromRevision } from "../../editor-assets/AssetMetricSnapshot.js";

function skyboxRecord() {
    return { id: "skybox", typeId: "skybox", typeVersion: 1, name: "Skybox", parentId: null, order: 0, components: { tags: [], locked: false, editorHidden: false } };
}

function base(id) {
    return {
        environmentId: String(id),
        templateId: "blank",
        roadStylePreset: "default",
        roadsAuthored: false,
        buildingsAuthored: false,
        featuresAuthored: false,
        chunkSize: 20,
        visualLayer: null,
        evidence: null,
        document: {
            environmentId: String(id), chunkSize: 20,
            roads: { nodes: [], edges: [], turnRules: [] }, buildings: [], features: [], earth: null,
            roadsAuthored: false, buildingsAuthored: false, featuresAuthored: false,
            objectGraphVersion: 1, objects: [skyboxRecord()],
        },
        sky: skyConfigToManifest(DEFAULT_ENVIRONMENT_SKY_CONFIG),
        editor: { editorMode: "scene" },
    };
}

export function createBlankInitialManifest(id) {
    return base(id);
}

export function createGoogleInitialManifest(id, { geoFrame, source, draft = null, includeRoads = true } = {}) {
    if (!geoFrame || source?.version !== 2) throw new TypeError("Google creation requires an ED-08 frame and Earth source v2.");
    const manifest = base(id);
    manifest.document.geoFrame = structuredClone(geoFrame);
    manifest.document.earth = structuredClone(source);
    manifest.document.objects.push({ id: "tile", typeId: "tile", typeVersion: 1, name: "Tile", parentId: null, order: 1, components: { tags: [], locked: false, editorHidden: false } });
    if (includeRoads) {
        if (!draft?.roads) throw new TypeError("Google road creation requires a completed road draft.");
        manifest.document.roads = structuredClone(draft.roads);
        manifest.document.roadsAuthored = true;
        manifest.roadsAuthored = true;
    }
    return manifest;
}

export function createGltfInitialManifest(id, { assetId, revision, publishedRevision, position = { x: 0, y: 0, z: 0 }, rotationY = 0, scale = { x: 1, y: 1, z: 1 } } = {}) {
    if (!assetId || !Number.isInteger(revision) || revision <= 0) throw new TypeError("GLTF creation requires an immutable catalog revision.");
    const manifest = base(id);
    const assetTypeVersion = publishedRevision?.version === 2 ? 2 : 1;
    manifest.document.objects.push({
        id: "tile", typeId: "tile", typeVersion: 2, name: "GLTF Tile", parentId: null, order: 1,
        components: {
            tags: [], locked: false, editorHidden: false,
            asset: { assetId: String(assetId), revision, position: structuredClone(position), rotationY: Number(rotationY), scale: structuredClone(scale), overrides: {} },
            tile: { provider: "gltf", assetTypeVersion },
        },
    });
    const metric = assetMetricDefinitionFromRevision(assetId, publishedRevision);
    if (metric) manifest.document.assetMetrics = { version: 1, definitions: [metric] };
    return manifest;
}
