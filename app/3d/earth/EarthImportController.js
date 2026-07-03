import { EDITOR_MODES } from "../editor/EditorState.js";
import { syncRoadsFromDocument } from "../editor/document/adapters/RoadRuntimeAdapter.js";
import {
    boundsCenter,
    EARTH_IMPORT_STATUS,
    validateBounds,
} from "./EarthImportConfig.js";
import { EarthImportSceneIsolation } from "./EarthImportSceneIsolation.js";
import { fetchAndImportRoads } from "./roads/RoadGraphImporter.js";

function errorMessage(error, fallback) {
    return error instanceof Error ? error.message : fallback;
}

function clearRoadGraph(document) {
    document.roads.nodes = [];
    document.roads.edges = [];
    document.notify?.();

    return {
        importedEdges: 0,
        skippedEdges: 0,
        nodeCount: 0,
        edgeCount: 0,
    };
}

function makeUnavailableRoadResult(document, providerId, warning) {
    return {
        network: {
            providerId,
            fetchedAt: new Date().toISOString(),
            ways: [],
        },
        stats: clearRoadGraph(document),
        providerId,
        warning,
    };
}

function makePreviewStatusMessage(roadResult, roadWarning) {
    if (roadWarning) {
        return `Preview ready (roads unavailable: ${roadWarning})`;
    }
    return `Preview ready (${roadResult.stats.edgeCount} roads staged)`;
}

function makeAppliedStatusMessage(roadResult, roadWarning) {
    if (roadWarning) {
        return `Imported Earth source without roads (${roadWarning})`;
    }
    return `Imported ${roadResult.stats.edgeCount} road segments`;
}

/**
 * Orchestrates preview/apply flows for Earth import mode.
 */
export class EarthImportController {
    /**
     * @param {import("../data/Data").Data} data
     * @param {import("./EarthTilesManager").EarthTilesManager} earthTilesManager
     * @param {{ fetchRoads?: typeof fetchAndImportRoads }} [options]
     */
    constructor(data, earthTilesManager, { fetchRoads = fetchAndImportRoads } = {}) {
        this.data = data;
        this.earthTilesManager = earthTilesManager;
        this.fetchRoads = fetchRoads;
        this.sceneIsolation = new EarthImportSceneIsolation();
        this.previewDocumentBackup = null;
        this.previewEarthBackup = null;
    }

    get editor() {
        return this.data.editor();
    }

    get environment() {
        return this.data.environment();
    }

    get document() {
        return this.environment.getDocument();
    }

    getScene() {
        return this.data.three()?.scene ?? this.data.scene ?? null;
    }

    getEarthImportBounds() {
        const state = this.editor.snapshot().earthImport;
        return {
            north: state.boundsNorth,
            south: state.boundsSouth,
            east: state.boundsEast,
            west: state.boundsWest,
        };
    }

    getAnchor() {
        const state = this.editor.snapshot().earthImport;
        return {
            lat: state.anchorLat,
            lng: state.anchorLng,
        };
    }

    hasPreviewBackup() {
        return Boolean(this.previewDocumentBackup);
    }

    onEnterMode() {
        const earth = this.document.earth;
        if (earth) {
            this.editor.patchEarthImport({
                anchorLat: earth.anchor.lat,
                anchorLng: earth.anchor.lng,
                boundsNorth: earth.bounds.north,
                boundsSouth: earth.bounds.south,
                boundsEast: earth.bounds.east,
                boundsWest: earth.bounds.west,
                tileProvider: earth.tileProvider,
                roadProvider: earth.roadProvider,
            });
        }

        this.sceneIsolation.activate(this.getScene());
        this.data.simulation()?.render?.();
    }

    onExitMode() {
        if (this.hasPreviewBackup()) {
            this.cancelPreview({ restoreIsolation: false });
        } else {
            this.earthTilesManager.disposeTiles();
        }

        this.sceneIsolation.deactivate(this.getScene());
        this.data.simulation()?.render?.();
    }

    /**
     * @param {boolean} preview
     */
    async runImport({ preview = false } = {}) {
        const bounds = this.getEarthImportBounds();
        const boundsValidation = validateBounds(bounds);
        if (!boundsValidation.ok) {
            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.ERROR, boundsValidation.error);
            throw new Error(boundsValidation.error);
        }

        const anchor = boundsCenter(bounds);
        this.editor.patchEarthImport({
            anchorLat: anchor.lat,
            anchorLng: anchor.lng,
            previewActive: preview,
        });

        if (preview) {
            this.previewDocumentBackup = this.document.snapshot();
            this.previewEarthBackup = this.document.earth ? { ...this.document.earth } : null;
        }

        try {
            this.sceneIsolation.activate(this.getScene());

            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.LOADING_TILES, "Loading Google Earth tiles…");
            await this.earthTilesManager.load({
                lat: anchor.lat,
                lng: anchor.lng,
                maxScreenSpaceError: this.editor.snapshot().earthImport.maxScreenSpaceError,
            });
            this.sceneIsolation.registerPreservedRoot(this.earthTilesManager.group);

            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.LOADING_ROADS, "Fetching road network…");
            const roadProviderId = this.editor.snapshot().earthImport.roadProvider;
            let roadWarning = null;
            let roadResult = null;
            try {
                roadResult = await this.fetchRoads(this.document, bounds, {
                    anchor,
                    providerId: roadProviderId,
                    replaceExisting: true,
                });
            } catch (error) {
                roadWarning = errorMessage(error, "Road network fetch failed.");
                console.warn("Earth Import road fetch failed; continuing without roads:", error);
                roadResult = makeUnavailableRoadResult(this.document, roadProviderId, roadWarning);
            }

            const importedLayerIds = [
                "google-earth-tiles",
            ];
            if (!roadWarning) {
                importedLayerIds.push(`roads:${roadResult.providerId}`);
            }

            this.document.setEarthSource({
                anchor,
                bounds,
                tileProvider: this.editor.snapshot().earthImport.tileProvider,
                roadProvider: roadResult.providerId,
                importedLayerIds,
                importedAt: new Date().toISOString(),
            });

            this.editor.markDirty(true);
            this.editor.setEarthImportStatus(
                preview ? EARTH_IMPORT_STATUS.PREVIEW : EARTH_IMPORT_STATUS.APPLIED,
                preview
                    ? makePreviewStatusMessage(roadResult, roadWarning)
                    : makeAppliedStatusMessage(roadResult, roadWarning),
            );
            this.data.simulation()?.render?.();

            return roadResult;
        } catch (error) {
            const message = error instanceof Error ? error.message : "Earth import failed.";
            if (preview) {
                this.restorePreviewDocument();
                this.earthTilesManager.disposeTiles();
            }
            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.ERROR, message);
            this.data.simulation()?.render?.();
            throw error;
        }
    }

    async preview() {
        return this.runImport({ preview: true });
    }

    async apply() {
        let roadResult = null;
        if (this.hasPreviewBackup()) {
            this.previewDocumentBackup = null;
            this.previewEarthBackup = null;
            this.editor.patchEarthImport({ previewActive: false });
            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.APPLIED, "Imported staged preview");
        } else {
            roadResult = await this.runImport({ preview: false });
        }

        const scene = this.getScene();
        if (scene) {
            syncRoadsFromDocument(this.data, scene, this.document);
        }

        this.earthTilesManager.disposeTiles();
        this.editor.setEditorMode(EDITOR_MODES.SCENE);
        this.data.simulation()?.render?.();

        return roadResult;
    }

    /**
     * @param {{ restoreIsolation?: boolean, resetStatus?: boolean }} [options]
     */
    cancelPreview({ restoreIsolation = false, resetStatus = true } = {}) {
        if (this.previewDocumentBackup) {
            this.document.restoreSnapshot(this.previewDocumentBackup);
            if (this.previewEarthBackup) {
                this.document.setEarthSource(this.previewEarthBackup);
            } else {
                this.document.clearEarthSource();
            }
        }

        this.previewDocumentBackup = null;
        this.previewEarthBackup = null;

        const patch = { previewActive: false };
        if (resetStatus) {
            patch.status = EARTH_IMPORT_STATUS.IDLE;
            patch.statusMessage = null;
        }
        this.editor.patchEarthImport(patch);

        this.earthTilesManager.disposeTiles();

        if (restoreIsolation) {
            this.sceneIsolation.deactivate(this.getScene());
        }

        this.data.simulation()?.render?.();
    }

    restorePreviewDocument() {
        if (!this.previewDocumentBackup) return;

        this.document.restoreSnapshot(this.previewDocumentBackup);
        if (this.previewEarthBackup) {
            this.document.setEarthSource(this.previewEarthBackup);
        } else {
            this.document.clearEarthSource();
        }

        this.previewDocumentBackup = null;
        this.previewEarthBackup = null;
        this.editor.patchEarthImport({ previewActive: false });
    }

    dispose() {
        this.cancelPreview({ restoreIsolation: true });
        this.sceneIsolation.deactivate(this.getScene());
    }
}
