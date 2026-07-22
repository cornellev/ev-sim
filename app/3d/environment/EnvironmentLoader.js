import { setupIGVC } from "../igvc/IGVCScene.js";
import { syncBuildingsFromDocument, syncRoadsFromDocument } from "../editor/document/DocumentSync.js";
import { removeBuildingMeshesFromScene, removeFeatureFromRuntime } from "../editor/map/mapRuntimeSync.js";
import { placeFusionObjectInScene } from "../editor/placement/placeFusionObject.js";
import { getEnvironmentManifest } from "./EnvironmentCatalogClient.js";
import { getEnvironmentApplyPolicy } from "./EnvironmentManifestPolicy.js";

/**
 * The single environment load/apply path used by both Simulation and Editor.
 *
 * Templates create their native runtime first (IGVC keeps its exact roads and
 * intersections). Persisted author edits are then overlaid by document domain:
 * only explicitly-authored roads replace template roads.
 */
export class EnvironmentLoader {
    constructor({ data, scene }) {
        this.data = data;
        this.scene = scene;
        this.manifest = null;
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

        await this._bootstrap(definition.templateId);
        // Template bootstraps add native props to ObjectDatabase. Materialize
        // them before registry hydration so editor-first and simulation-first
        // loads see the exact same objects.
        this.data.objects().scene(this.scene);
        environment.setup(this.scene);

        if (this.manifest) {
            this.apply(this.manifest);
        }

        return definition;
    }

    async _bootstrap(templateId) {
        if (templateId === "igvc") {
            await setupIGVC(this.scene, this.data);
        }
        // "blank" intentionally has no runtime content.
    }

    apply(manifest) {
        const environment = this.data.environment();
        const document = environment.getDocument();
        const current = document.snapshot();
        const saved = manifest.document ?? {};
        const policy = getEnvironmentApplyPolicy(manifest, environment.templateId);

        document.restoreSnapshot({
            ...current,
            ...saved,
            environmentId: environment.environmentId,
            roads: policy.roadsAuthored ? saved.roads : current.roads,
            buildings: policy.buildingsAuthored ? saved.buildings : current.buildings,
            features: policy.featuresAuthored ? saved.features : current.features,
            roadsAuthored: policy.roadsAuthored,
            buildingsAuthored: policy.buildingsAuthored,
            featuresAuthored: policy.featuresAuthored,
        });

        // Native IGVC roads are canonical until a user actually edits roads.
        if (policy.rebuildRoads) {
            syncRoadsFromDocument(this.data, this.scene, document);
        }
        if (policy.rebuildBuildings) this._rebuildBuildings();
        if (policy.rebuildFeatures) this._rebuildFeatures();

        environment.objects().registerExistingContent(this.scene, this.data);
        this._restoreSky(manifest.sky);
        this._restoreEditorState(manifest.editor);
        this.data.simulation()?.render?.();
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

