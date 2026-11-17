const targets = ["scene", "map"];
const timingHooks = ["onDataUpdate", "onVehicleMove", "display", "displayMap"];

function equalFields(left, right) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]));
}

/** Sources retain immutable input references; subclasses own their display resources. */
export class Visualizer {
    constructor({ requiredInputs = [], optionalInputs = {}, now = () => performance.now() } = {}) {
        this.requiredInputs = requiredInputs;
        this.optionalInputs = optionalInputs;
        this.now = now;
        this.visible = { scene: true, map: true };
        this.layerVisibility = { scene: {}, map: {} };
        this.timings = Object.fromEntries(timingHooks.map((key) => [key, { count: 0, lastMs: 0, totalMs: 0, maxMs: 0 }]));
        this.disposed = false;
        this._clearState();
    }

    _clearState() {
        this.inputs = { ...this.optionalInputs };
        this.pose = null;
        this.metadata = {};
        this.poseMetadata = {};
        this.ready = this.requiredInputs.length === 0;
        this.status = this.ready ? "ready" : "waiting";
        this.message = this.ready ? null : "Waiting for required inputs.";
        this.dirty = Object.fromEntries(targets.map((target) => [target, { geometry: this.ready, placement: false, status: true }]));
    }

    invalidate(kind, selectedTargets = targets) {
        for (const target of selectedTargets) this.dirty[target][kind] = true;
    }

    setStatus(status, message = null) {
        if (this.status === status && this.message === message) return;
        this.status = status;
        this.message = message;
        this.invalidate("status");
    }

    _setMetadata(key, metadata) {
        const next = { ...metadata };
        if (equalFields(this[key], next)) return;
        this[key] = next;
        this.invalidate("status");
    }

    // Validation sees the merged, defaulted sample; return true, an error string, or throw.
    validateInputs() { return true; }
    validatePose() { return true; }

    acceptDataUpdate(inputs, changedKeys, metadata = {}) {
        if (this.disposed) return false;
        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new TypeError("Display inputs must be an object.");
        const next = { ...this.inputs, ...inputs };
        for (const [key, value] of Object.entries(this.optionalInputs)) {
            if (next[key] == null) next[key] = value;
        }
        const missing = this.requiredInputs.filter((key) => next[key] == null);
        if (missing.length) {
            if (this.ready) throw new TypeError(`Missing required inputs: ${missing.join(", ")}.`);
            this.inputs = next;
            this.setStatus("waiting", `Missing required inputs: ${missing.join(", ")}.`);
            return true;
        }
        const validation = this.validateInputs(next);
        if (validation !== true) throw new TypeError(typeof validation === "string" ? validation : "Invalid display inputs.");
        const changed = new Set(changedKeys);
        for (const key of Object.keys(next)) {
            if (!Object.is(this.inputs[key], next[key])) changed.add(key);
        }
        const wasReady = this.ready;
        // A throwing ingestion hook cannot replace the last accepted input record.
        if (changed.size || !wasReady) this._measure("onDataUpdate", () => this.onDataUpdate(next, [...changed], metadata));
        this.inputs = next;
        this.ready = true;
        this._setMetadata("metadata", metadata);
        this.setStatus("ready");
        if (changed.size || !wasReady) this.invalidate("geometry");
        return true;
    }

    acceptVehicleMove(pose, metadata = {}) {
        if (this.disposed) return false;
        if (!pose || typeof pose !== "object" || Array.isArray(pose)) throw new TypeError("Display pose must be an object.");
        const validation = this.validatePose(pose);
        if (validation !== true) throw new TypeError(typeof validation === "string" ? validation : "Invalid display pose.");
        this._measure("onVehicleMove", () => this.onVehicleMove(pose, metadata));
        this.pose = pose;
        this._setMetadata("poseMetadata", metadata);
        this.invalidate("placement");
        return true;
    }

    _measure(hook, callback) {
        const start = this.now();
        try {
            return callback();
        } finally {
            const elapsed = Math.max(0, this.now() - start);
            const timing = this.timings[hook];
            timing.count += 1;
            timing.lastMs = elapsed;
            timing.totalMs += elapsed;
            timing.maxMs = Math.max(timing.maxMs, elapsed);
        }
    }

    render(target, context) {
        const dirty = { ...this.dirty[target] };
        this.dirty[target].geometry = false;
        this.dirty[target].placement = false;
        const hook = target === "scene" ? "display" : "displayMap";
        return this._measure(hook, () => this[hook]({ ...context, dirty }));
    }

    setVisible(target, visible) {
        if (this.visible[target] === visible) return;
        this.visible[target] = visible;
        this.invalidate("status", [target]);
        // Subclasses use this cheap hook to hide owned roots without a display flush.
        this.onVisibilityChange(target, visible);
    }

    setLayerVisible(layerId, target, visible) {
        if (this.layerVisibility[target][layerId] === visible) return;
        this.layerVisibility[target] = { ...this.layerVisibility[target], [layerId]: visible };
        this.invalidate("placement", [target]);
        this.invalidate("status", [target]);
        this.onLayerVisibilityChange(layerId, target, visible);
    }

    onDataUpdate() {}
    onVehicleMove() {}
    onTimeAdvance() {}
    onVisibilityChange() {}
    onLayerVisibilityChange() {}
    display() {}
    displayMap() {}

    // Overrides release/reset owned resources and call super; timings cover the instance lifetime.
    reset() { this._clearState(); }
    dispose() { this._clearState(); this.disposed = true; }
    getTimings() {
        return Object.fromEntries(timingHooks.map((key) => [key, { ...this.timings[key] }]));
    }
}
