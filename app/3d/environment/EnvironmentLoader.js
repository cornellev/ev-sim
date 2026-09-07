import { syncBuildingsFromDocument, syncRoadsFromDocument } from "../editor/document/DocumentSync.js";
import { removeBuildingMeshesFromScene, removeFeatureFromRuntime } from "../editor/map/mapRuntimeSync.js";
import { placeFusionObjectInScene } from "../editor/placement/placeFusionObject.js";
import { getEnvironmentManifest } from "./EnvironmentCatalogClient.js";
import { applyEnvironmentVisualReferences } from "./EnvironmentManifestPolicy.js";
import { VisualPreviewHost } from "./visual/VisualPreviewHost.js";
import { VisualLayerMaterializer } from "./visual/VisualLayerMaterializer.js";
import {
    VISUAL_PREVIEW_STATUS,
} from "../../simulation/visual/VisualLayer.js";
import {
    assertWorldResource,
    createWorldResource,
} from "../../simulation/world/WorldDescription.js";

/**
 * The single environment load/apply path used by both Simulation and Editor.
 *
 * The browser is a materializer for the same normalized world document used
 * by Node. No template geometry is bootstrapped outside that shared contract.
 */
export class EnvironmentLoader {
    constructor({ data, scene, materializer = undefined, previewHost = undefined }) {
        this.data = data;
        this.scene = scene;
        this.manifest = null;
        this.previewHost = previewHost === undefined && scene
            ? new VisualPreviewHost(scene)
            : previewHost ?? null;
        this.materializer = materializer === undefined && this.previewHost
            ? new VisualLayerMaterializer({
                previewRoot: this.previewHost.root,
                renderer: data?.renderer ?? data?.three?.()?.renderer ?? null,
            })
            : materializer ?? null;
        this._disposed = false;
        if (this.materializer && this.data?.setVisualPreviewStatus) {
            this.materializer.subscribe((status) => this.data.setVisualPreviewStatus(status));
        }
    }

    async load(environmentId) {
        this.manifest = await getEnvironmentManifest(environmentId);
        const definition = normalizeDefinition(environmentId, this.manifest);
        const environment = this.data.environment();

        environment.environmentId = definition.environmentId;
        environment.name = definition.name;
        environment.templateId = definition.templateId;
        environment.roadStylePreset = definition.roadStylePreset;
        environment.getDocument().environmentId = definition.environmentId;

        this.data.objects().scene(this.scene);
        environment.setup(this.scene);
        await this.apply(this.manifest ?? {
            environmentId: definition.environmentId,
            templateId: definition.templateId,
        });

        return definition;
    }

    async apply(manifest, resolvedWorld = null) {
        const environment = this.data.environment();
        const document = environment.getDocument();
        const worldResource = resolvedWorld ?? createWorldResource(manifest);
        const description = assertWorldResource(worldResource);
        const roadsAuthored = description.domainSources.roads === "authored";
        const buildingsAuthored = description.domainSources.buildings === "authored";
        const featuresAuthored = description.domainSources.features === "authored";

        document.restoreSnapshot({
            environmentId: description.environmentId,
            chunkSize: manifest.chunkSize ?? 20,
            roads: structuredClone(description.roads),
            buildings: description.buildings.map((building) => ({
                buildingId: building.id,
                footprint: structuredClone(building.footprint),
                height: building.height,
                textureId: building.textureId,
                tags: [...building.tags],
                meshName: building.meshName,
            })),
            features: description.features.map((feature) => ({
                id: feature.id,
                type: feature.type,
                x: feature.transform.position.x,
                z: feature.transform.position.z,
                dir: feature.dir,
                rotationY: feature.rotationY,
                tags: [...feature.tags],
            })),
            earth: manifest.document?.earth ?? null,
            roadsAuthored,
            buildingsAuthored,
            featuresAuthored,
        });

        syncRoadsFromDocument(this.data, this.scene, document);
        this._rebuildBuildings();
        this._rebuildFeatures();
        document.roadsAuthored = roadsAuthored;
        document.buildingsAuthored = buildingsAuthored;
        document.featuresAuthored = featuresAuthored;
        environment.setWorldDescription?.(description, worldResource.hash);

        environment.objects().registerExistingContent(this.scene, this.data);
        this._restoreSky(manifest.sky);
        this._restoreEditorState(manifest.editor);
        this._restoreVisualReferences(manifest);
        await this._materializePreview(worldResource);
        this.data.simulation()?.render?.();
        return worldResource;
    }

    async retryPreview() {
        if (!this.materializer) return idlePreview();
        const status = await this.materializer.retry();
        this.data.simulation()?.render?.();
        return status;
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this.materializer?.dispose?.();
        this.materializer = null;
        this.previewHost?.dispose?.();
        this.previewHost = null;
    }

    async _materializePreview(worldResource) {
        if (!this.materializer) return idlePreview();
        const reference = this.data.environment()?.visualLayer ?? null;
        return this.materializer.replace(reference, worldResource, {
            interest: visualInterestFromData(this.data),
        });
    }

    updateVisualInterest(interest = null) {
        if (!this.materializer?.updateInterest) return this.materializer?.status ?? idlePreview();
        return this.materializer.updateInterest(interest ?? visualInterestFromData(this.data));
    }

    _restoreVisualReferences(manifest) {
        applyEnvironmentVisualReferences(this.data.environment(), manifest);
    }

    _rebuildBuildings() {
        const environment = this.data.environment();
        const registry = environment.objects();

        for (const entity of registry.listEntities()) {
            if (entity.kind !== "building") continue;
            removeBuildingMeshesFromScene(this.scene, entity.sourceId);
            registry.unregisterEntity(entity.id);
        }

        this.data.objects().replaceTriangles?.(
            (triangle) => triangle.environmentGeometryType === "building",
            [],
        );
        syncBuildingsFromDocument(this.scene, this.data, environment.getDocument());
    }

    _rebuildFeatures() {
        const environment = this.data.environment();
        const registry = environment.objects();
        const document = environment.getDocument();

        for (const entity of registry.listEntities()) {
            if (entity.layer !== "props") continue;
            removeFeatureFromRuntime(this.data, this.scene, entity.sourceId);
        }

        const restored = [];
        for (const feature of document.features) {
            try {
                const { object } = placeFusionObjectInScene({
                    data: this.data,
                    scene: this.scene,
                    registry,
                    assetId: feature.type,
                    point: { x: feature.x, y: 0, z: feature.z },
                    sourceId: feature.id,
                    dir: feature.dir ?? 0,
                });
                if (!object) continue;

                object.dir = feature.dir ?? 0;
                if (object._mesh) {
                    object._mesh.rotation.y = feature.rotationY ?? 0;
                    object._mesh.updateMatrixWorld(true);
                }
                restored.push({
                    ...feature,
                    id: feature.id,
                    rotationY: feature.rotationY ?? 0,
                    tags: [...(feature.tags ?? [])],
                });
            } catch (error) {
                console.warn(`[environment] could not restore feature "${feature.type}":`, error);
            }
        }
        document.features = restored;
        document.featuresAuthored = true;
        document.notify();
    }

    _restoreSky(sky) {
        if (!sky) return;
        try {
            this.data.environment().sky().update(sky);
        } catch (error) {
            console.warn("[environment] failed to restore sky:", error);
        }
    }

    _restoreEditorState(editorState) {
        if (!editorState) return;
        const editor = this.data.editor();
        const registry = this.data.environment().objects();

        for (const [layer, visible] of Object.entries(editorState.layers ?? {})) {
            editor.setLayerVisible(layer, visible);
            registry.setLayerVisible(layer, visible);
        }
        const map = editorState.map;
        if (map) {
            editor.setMapViewport({ centerX: map.centerX, centerZ: map.centerZ, zoom: map.zoom });
            editor.setMapSnapEnabled(map.snapEnabled);
            editor.setMapSnapSize(map.snapSize);
            editor.setMapGridVisible(map.gridVisible);
        }
        for (const entityId of editorState.hiddenEntityIds ?? []) {
            editor.setEntityHidden(entityId, true);
            registry.setEntityVisible(entityId, false);
        }
    }
}

function normalizeDefinition(environmentId, manifest) {
    const templateId = manifest?.templateId ?? (environmentId === "igvc" ? "igvc" : "blank");
    return {
        environmentId,
        name: manifest?.name ?? (environmentId === "igvc" ? "IGVC" : environmentId),
        templateId,
        roadStylePreset: manifest?.roadStylePreset ?? (templateId === "igvc" ? "igvc" : "default"),
    };
}

function idlePreview() {
    return { status: VISUAL_PREVIEW_STATUS.idle, error: null, residency: null };
}

function visualInterestFromData(data) {
    const camera = data?.simulation?.()?.camera;
    const position = camera?.position;
    return {
        position: {
            x: Number(position?.x ?? 0) || 0,
            y: Number(position?.y ?? 0) || 0,
            z: Number(position?.z ?? 0) || 0,
        },
    };
}
