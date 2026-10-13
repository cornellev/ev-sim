import { cloneJson } from "../../util/cloneJson.js";
import { normalizeVehicleManifest } from "../VehicleManifest.js";

/** One normalized vehicle manifest and a monotonic edit generation. */
export class VehicleDocument {
    constructor(manifest) {
        this.manifest = cloneJson(normalizeVehicleManifest(manifest));
        this.generation = 0;
    }

    snapshot() {
        return cloneJson(this.manifest);
    }

    commit(next) {
        const before = this.snapshot();
        this.manifest = cloneJson(normalizeVehicleManifest(next));
        this.generation += 1;
        return { before, after: this.snapshot(), generation: this.generation };
    }

    /** Undo, redo, and discard. Generation advances so an in-flight save can see the move. */
    restore(snapshot) {
        this.manifest = cloneJson(normalizeVehicleManifest(snapshot));
        this.generation += 1;
        return this.snapshot();
    }

    /** Gesture preview. The generation stays at the last commit. */
    preview(next) {
        this.manifest = cloneJson(normalizeVehicleManifest(next));
        return this.snapshot();
    }
}
