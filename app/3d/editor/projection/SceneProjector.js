/**
 * SceneProjector: the only path from a committed or transient document change
 * to runtime meshes, registry entities, chunk membership, and LiDAR truth
 * triangles. It subscribes to the document and applies every change set
 * through domain projectors; notifications without a change set (full loads,
 * hydration) are ignored because `EnvironmentLoader.apply` rebuilds the world
 * itself.
 */

import { createBuildingsProjector } from "./projectors/buildingsProjector.js";
import { createFeaturesProjector } from "./projectors/featuresProjector.js";
import { createObjectsProjector } from "./projectors/objectsProjector.js";
import { createRoadsProjector } from "./projectors/roadsProjector.js";

export function createDefaultProjectors() {
    return [
        createRoadsProjector(),
        createBuildingsProjector(),
        createFeaturesProjector(),
        createObjectsProjector(),
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

    dispose() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const projector of this.projectors) projector.dispose?.();
    }
}
