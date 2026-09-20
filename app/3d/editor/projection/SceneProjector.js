/**
 * SceneProjector: the only path from a committed or transient document change
 * to runtime meshes, registry entities, chunk membership, and LiDAR truth
 * triangles. Full environment loads call {@link SceneProjector.applyFullDocument};
 * incremental edits still arrive as change sets via {@link SceneProjector.applyChanges}.
 */

import { createBuildingsProjector } from "./projectors/buildingsProjector.js";
import { createFeaturesProjector } from "./projectors/featuresProjector.js";
import { createObjectsProjector } from "./projectors/objectsProjector.js";
import { createRoadsProjector } from "./projectors/roadsProjector.js";
import { createSkyProjector } from "./projectors/skyProjector.js";
import { createAssetInstancesProjector } from "./projectors/assetInstancesProjector.js";
import { createAssetMetricsProjector } from "./projectors/assetMetricsProjector.js";
import { createOverlayMetricsProjector } from "./projectors/overlayMetricsProjector.js";
import { createTileSourceProjector } from "./projectors/tileSourceProjector.js";

export function createDefaultProjectors() {
    return [
        createRoadsProjector(),
        createBuildingsProjector(),
        createFeaturesProjector(),
        createAssetInstancesProjector(),
        createAssetMetricsProjector(),
        createObjectsProjector(),
        createOverlayMetricsProjector(),
        createTileSourceProjector(),
        createSkyProjector(),
    ];
}

export class SceneProjector {
    /**
     * @param {{ data: object, scene: object, document: import("../document/EnvironmentDocument.js").EnvironmentDocument,
     *   registry: import("../EnvironmentRegistry.js").EnvironmentRegistry, runtime?: object|null,
 *   projectors?: Array<{ id: string, apply(ctx: object): void }> }} options
     */
    constructor({ data, scene, document, registry, runtime = null, projectors = createDefaultProjectors() } = {}) {
        if (!document || typeof document.subscribe !== "function") throw new TypeError("SceneProjector requires a document.");
        this.data = data;
        this.scene = scene;
        this.document = document;
        this.registry = registry ?? data?.environment?.()?.objects?.() ?? null;
        // Browser-only helpers (placement catalog, building generator) are injected.
        this.runtime = runtime;
        this.projectors = projectors;
        this.unsubscribe = null;
        this.applied = 0;
        this.lastEvent = null;
        this.errors = [];
    }

    attach() {
        this.unsubscribe?.();
        this.unsubscribe = this.document.subscribe((snapshot, event) => {
            if (!event?.changeSet) return;
            this.applyChanges(event.changeSet, event);
        });
        return this;
    }

    /**
     * Apply one change set. Runs every projector inside a registry batch so
     * hierarchy subscribers see one notification.
     */
    applyChanges(changeSet, event = null) {
        if (!changeSet) return;
        const transient = event?.transient === true || changeSet.meta?.transient === true;
        const context = {
            data: this.data,
            scene: this.scene,
            document: this.document,
            registry: this.registry,
            changeSet,
            event,
            transient,
            runtime: this.runtime,
            source: event?.source ?? changeSet.meta?.source ?? "command",
        };
        const run = () => {
            for (const projector of this.projectors) {
                try {
                    projector.apply(context);
                } catch (error) {
                    this.errors.push({ projector: projector.id, error });
                    console.warn(`[environment] projector "${projector.id}" failed:`, error);
                }
            }
        };
        if (this.registry?.batch) this.registry.batch(run);
        else run();
        this.applied += 1;
        this.lastEvent = event;
        this.data?.simulation?.()?.render?.();
    }

    /**
     * Rebuild every domain from the current document. Used after a full load
     * (`restoreSnapshot`) instead of going around the projector.
     */
    applyFullDocument({ source = "load" } = {}) {
        const context = {
            data: this.data,
            scene: this.scene,
            document: this.document,
            registry: this.registry,
            changeSet: null,
            event: { source },
            transient: false,
            runtime: this.runtime,
            source,
        };
        const run = () => {
            for (const projector of this.projectors) {
                try {
                    if (typeof projector.rebuildAll === "function") projector.rebuildAll(context);
                } catch (error) {
                    this.errors.push({ projector: projector.id, error });
                    console.warn(`[environment] projector "${projector.id}" failed:`, error);
                }
            }
        };
        if (this.registry?.batch) this.registry.batch(run);
        else run();
        this.applied += 1;
        this.lastEvent = context.event;
        this.data?.simulation?.()?.render?.();
    }

    _context(changeSet = null, event = null) {
        return {
            data: this.data, scene: this.scene, document: this.document,
            registry: this.registry, changeSet, event, transient: false,
            runtime: this.runtime, source: event?.source ?? "asset-sync",
        };
    }

    setEditorAssetsEnabled(enabled) {
        this.projectors.find((projector) => projector.id === "asset-instances")?.setEnabled?.(enabled, this._context());
    }

    syncAssetInstances() {
        this.projectors.find((projector) => projector.id === "asset-instances")?.sync?.(this._context());
    }

    whenAssetInstancesIdle() {
        return this.projectors.find((projector) => projector.id === "asset-instances")?.whenIdle?.() ?? Promise.resolve();
    }

    resetAssetInstances() {
        this.projectors.find((projector) => projector.id === "asset-instances")?.reset?.(this._context());
    }

    syncAssetMetrics() {
        this.projectors.find((projector) => projector.id === "asset-metrics")?.sync?.(this._context());
    }

    resetAssetMetrics() {
        this.projectors.find((projector) => projector.id === "asset-metrics")?.reset?.(this._context());
    }

    syncOverlayMetrics() {
        this.projectors.find((projector) => projector.id === "overlay-metrics")?.sync?.(this._context());
    }

    resetOverlayMetrics() {
        this.projectors.find((projector) => projector.id === "overlay-metrics")?.reset?.(this._context());
    }

    overlayMetricEntries() {
        return this.projectors.find((projector) => projector.id === "overlay-metrics")?.entries ?? new Map();
    }

    assetInstanceEntries() {
        return this.projectors.find((projector) => projector.id === "asset-instances")?.entries ?? new Map();
    }

    assetMetricEntries() {
        return this.projectors.find((projector) => projector.id === "asset-metrics")?.entries ?? new Map();
    }

    dispose() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const projector of this.projectors) projector.dispose?.();
    }
}
