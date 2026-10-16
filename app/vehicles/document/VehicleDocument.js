import { cloneJson } from "../../util/cloneJson.js";
import { normalizeVehicleManifest } from "../VehicleManifest.js";

/** One normalized vehicle manifest and a monotonic edit generation. */
export class VehicleDocument {
    constructor(manifest, normalizeOptions) {
        this.normalizeOptions = normalizeOptions;
        this.manifest = cloneJson(normalizeVehicleManifest(manifest, normalizeOptions));
        this.generation = 0;
    }

    snapshot() {
        return cloneJson(this.manifest);
    }

    commit(next) {
        const before = this.snapshot();
        this.manifest = cloneJson(normalizeVehicleManifest(next, this.normalizeOptions));
        this.generation += 1;
        return { before, after: this.snapshot(), generation: this.generation };
    }

    /** Undo, redo, and discard. Generation advances so an in-flight save can see the move. */
    restore(snapshot) {
        this.manifest = cloneJson(normalizeVehicleManifest(snapshot, this.normalizeOptions));
        this.generation += 1;
        return this.snapshot();
    }

    /** Gesture preview. The generation stays at the last commit. */
    preview(next) {
        this.manifest = cloneJson(normalizeVehicleManifest(next, this.normalizeOptions));
        return this.snapshot();
    }
}
