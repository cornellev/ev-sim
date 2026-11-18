import { normalizeSignalPath } from "../../scripting/runtime/SignalPaths.js";
import { ZenohVisualizationSource } from "./ZenohVisualizationSource.js";
import { PlanOccupancySampler } from "../../spatial/planview/occupancy/oracleSample.js";
import { PlanLidarSampler } from "../../spatial/planview/occupancy/lidarSample.js";
import { occupancyImportStatus } from "../../spatial/planview/occupancy/stackImport.js";

export const OCCUPANCY_SIGNAL_PREFIX = "visualization.occupancy.";

function metadataFor(entry, runId) {
    const value = entry?.value;
    const metadata = { ...value?.metadata, ...entry?.metadata };
    for (const key of ["runId", "captureTimeNs", "sequenceId", "frameId"]) {
        const field = metadata[key] ?? value?.[key];
        if (field !== undefined && field !== null) metadata[key] = field;
    }
    if (metadata.runId == null && runId != null) metadata.runId = runId;
    if (metadata.captureTimeNs == null && entry?.timeUs != null && Number.isSafeInteger(entry.timeUs * 1000)) metadata.captureTimeNs = entry.timeUs * 1000;
    if (metadata.sequenceId == null && value?.sequence != null) metadata.sequenceId = value.sequence;
    return metadata;
}

function samePose(left, right) {
    if (!left || !right) return left === right;
    for (const key of ["x", "y", "z", "yaw", "pitch", "roll"]) {
        if (!Object.is(left[key], right[key])) return false;
    }
    for (const key of ["position", "rotation", "orientation", "quaternion"]) {
        for (const field of ["x", "y", "z", "w", "order"]) {
            if (!Object.is(left[key]?.[field], right[key]?.[field])) return false;
        }
    }
    return Object.is(left.frameId, right.frameId);
}

/**
 * Runtime bindings: { id, kind: "runtime", signalPath, eventType?: "data" | "pose", project? }.
 * project(value, metadata) is trusted code; scalar signals need a projection into input keys.
 * Pose paths infer eventType for direct callers. The engine supplies default actor pose paths.
 * Signal callbacks only retain samples. releasePending() runs after a completed transition.
 */
export class LiveVisualizationSource {
    constructor({ signalStore = null, runId = null, getTimeNs = () => 0, getPose = () => null, getData = () => null, getOccupancySources = () => null, subscribeRuntimeChanges = () => () => {}, isStepInFlight = () => false, seedInitial = true, zenoh = null } = {}) {
        this.signalStore = signalStore;
        this.runId = runId;
        this.getTimeNs = getTimeNs;
        this.getPose = getPose;
        this.getData = getData;
        this.getOccupancySources = getOccupancySources;
        this.subscribeRuntimeChanges = subscribeRuntimeChanges;
        this.occupancySamplers = {};
        this.occupancySamples = new Map();
        this.runtimeChanged = null;
        this.isStepInFlight = isStepInFlight;
        this.seedInitial = seedInitial;
        this.zenoh = zenoh;
        this.zenohSource = null;
        this.latest = new Map();
        this.subscriptions = new Set();
        this.disposed = false;
    }

    subscribe(bindings, onEvent) {
        if (this.disposed) return () => {};
        if (!Array.isArray(bindings) || typeof onEvent !== "function") throw new TypeError("Invalid live visualization subscription.");
        const routes = new Map();
        for (const binding of bindings.filter((binding) => binding?.kind !== "zenoh")) {
            const path = normalizeSignalPath(binding?.signalPath);
            const type = binding?.eventType ?? (path.endsWith(".pose") ? "pose" : "data");
            if (typeof binding?.id !== "string" || !binding.id || binding.kind !== "runtime" || !path || !["data", "pose"].includes(type)
                || (binding.project !== undefined && typeof binding.project !== "function")) {
                throw new TypeError("Runtime visualization bindings require an id, signalPath, and optional function projection.");
            }
            if (!routes.has(path)) routes.set(path, []);
            routes.get(path).push({ binding, type, previousPose: null, poseRevision: 0 });
        }
        const zenohBindings = bindings.filter((binding) => binding?.kind === "zenoh");
        let cancelZenoh = () => {};
        if (zenohBindings.length) {
            this.zenohSource ??= new ZenohVisualizationSource(this.zenoh ?? {});
            cancelZenoh = this.zenohSource.subscribe(zenohBindings, onEvent);
        }
        const subscription = { routes, onEvent, pending: new Map(), active: true, needsInitial: this.isStepInFlight(), timeNs: undefined, cancel: null };
        try {
            const cancelRuntime = routes.size ? this.signalStore?.subscribeSignals({ paths: [...routes.keys()], includeEvents: false, includeCatalog: false }, (message) => {
                if (!subscription.active || this.disposed || message.kind !== "update") return;
                subscription.pending.set(message.path, { entry: message.entry, revision: this.signalStore.revision(message.path) });
            }) : null;
            subscription.cancel = () => { cancelRuntime?.(); cancelZenoh(); };
        } catch (error) { cancelZenoh(); throw error; }
        const cancel = () => {
            subscription.active = false;
            subscription.pending.clear();
            this.subscriptions.delete(subscription);
            subscription.cancel();
            for (const path of routes.keys()) {
                if (![...this.subscriptions].some((active) => active.routes.has(path))) this.latest.delete(path);
            }
            if (![...this.subscriptions].some((active) => active.routes.size)) {
                this.runtimeChanged?.(); this.runtimeChanged = null;
                this.occupancySamplers = {}; this.occupancySamples.clear();
            }
        };
        this.subscriptions.add(subscription);
        try {
            if (!this.runtimeChanged && routes.size) {
                let active = true, pendingChange = false;
                const cancelChanges = this.subscribeRuntimeChanges(() => {
                    if (pendingChange) return;
                    pendingChange = true;
                    // Let SceneProjector finish this document notification before reading runtime transforms.
                    queueMicrotask(() => { pendingChange = false; if (active && !this.disposed && !this.isStepInFlight()) this.releasePending(); });
                });
                this.runtimeChanged = () => { active = false; cancelChanges?.(); };
            }
            if (!subscription.needsInitial) this._release(subscription, this.getTimeNs(), true);
        } catch (error) { cancel(); throw error; }
        return cancel;
    }

    _emit(subscription, event) {
        if (!subscription.active || this.disposed) return;
        try { subscription.onEvent(event); } catch { /* Display listeners cannot interrupt a kernel transition. */ }
    }

    _occupancyData(path) {
        const id = path.slice(OCCUPANCY_SIGNAL_PREFIX.length);
        if (!["oracle", "lidar", "stack"].includes(id)) return null;
        const sources = this.getOccupancySources();
        if (!sources) return null;
        const previous = this.occupancySamples.get(id);
        let grid, importedMetadata, message = "";
        if (id === "stack") {
            const status = occupancyImportStatus(sources.resolvedRun);
            const imported = sources.runtime?.lastOccupancy;
            message = status.message || (imported && imported.status !== "ok" ? imported.message ?? imported.status : "");
            grid = status.configured && imported?.status === "ok" ? imported : null;
            if (previous?.original === grid && previous.message === message) return previous.inputs;
            if (grid) {
                const topics = new Set((sources.resolvedRun?.manifest?.topics ?? []).filter((topic) => topic.enabled !== false && topic.direction === "input" && topic.valueContract?.id === "cev.occupancy").map((topic) => topic.id));
                const route = sources.resolvedRun?.protobufInterface?.document?.routes?.find((entry) => entry.direction === "subscribe" && topics.has(entry.target?.topicId));
                const matching = [...(sources.topicRouter?.lastProducer?.values() ?? [])].filter((entry) => entry.topicId === route?.target?.topicId
                    && entry.valueContract?.id === "cev.occupancy" && entry.value?.data === grid.cells
                    && entry.metadata?.captureTimeNs === grid.captureTimeNs && (entry.metadata?.frameId ?? "") === grid.frameId);
                if (matching.length === 1) importedMetadata = matching[0].metadata;
            }
        } else {
            this.occupancySamplers[id] ??= id === "oracle" ? new PlanOccupancySampler() : new PlanLidarSampler();
            grid = this.occupancySamplers[id].sample(sources);
            if (previous && ((grid && !grid.changed && previous.original) || (!grid && !previous.original))) return previous.inputs;
        }
        // Samplers reuse their mutable windows. Accepted records must survive the next transition.
        const owned = grid ? { ...grid, cells: grid.cells.slice(),
            ...(id !== "stack" ? { frameId: sources.resolvedRun?.manifest?.sensorRig?.frames?.map ?? "map", captureTimeNs: this.getTimeNs() }
                : importedMetadata ? { metadata: { ...importedMetadata } } : {}) } : null;
        const inputs = { [id]: owned, ...(id === "stack" ? { stackMessage: message } : {}) };
        this.occupancySamples.set(id, { original: grid, inputs, message });
        return inputs;
    }

    _release(subscription, timeNs, initial = false) {
        const pending = subscription.pending;
        subscription.pending = new Map();
        for (const [path, routes] of subscription.routes) {
            if (!subscription.active || this.disposed) return;
            let sample = pending.get(path);
            if (sample) this.latest.set(path, sample);
            try {
                if (!sample && (initial || subscription.needsInitial)) {
                    if (this.seedInitial) {
                        const entry = this.signalStore?.read(path);
                        if (entry?.exists) sample = { entry, revision: this.signalStore.revision(path) };
                    } else sample = this.latest.get(path);
                }
            } catch (error) {
                for (const { binding } of routes) this._emit(subscription, { type: "status", bindingId: binding.id, status: "error", message: error?.message || String(error) });
                continue;
            }
            for (const route of routes) {
                try {
                    const fallback = !sample ? (route.type === "pose" ? this.getPose(path)
                        : path.startsWith(OCCUPANCY_SIGNAL_PREFIX) ? this._occupancyData(path) : this.getData(path)) : null;
                    if (!sample && !fallback) continue;
                    const entry = sample?.entry ?? { value: fallback, ...(path.startsWith(OCCUPANCY_SIGNAL_PREFIX) ? {
                        metadata: metadataFor({ value: fallback?.[path.slice(OCCUPANCY_SIGNAL_PREFIX.length)] }, this.runId),
                    } : {}) };
                    const metadata = metadataFor(entry, this.runId);
                    const value = route.binding.project ? route.binding.project(entry.value, metadata) : entry.value;
                    if (route.type === "pose") {
                        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Display pose must be an object.");
                        const pose = { ...value, ...(value.yaw === undefined && value.rotation ? { yaw: value.rotation.y } : {}) };
                        for (const key of ["position", "rotation", "orientation", "quaternion"]) {
                            if (pose[key]) pose[key] = { ...pose[key] };
                        }
                        if (samePose(route.previousPose, pose)) continue;
                        route.previousPose = pose;
                        this._emit(subscription, { type: "pose", bindingId: route.binding.id, pose, revision: ++route.poseRevision, metadata });
                    } else {
                        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Display inputs must be an object; scalar signals require a projection.");
                        this._emit(subscription, { type: "data", bindingId: route.binding.id, inputs: value, revision: sample?.revision, metadata });
                    }
                } catch (error) {
                    this._emit(subscription, { type: "status", bindingId: route.binding.id, status: "error", message: error?.message || String(error) });
                }
            }
        }
        subscription.needsInitial = false;
        if (!Object.is(subscription.timeNs, timeNs)) {
            subscription.timeNs = timeNs;
            this._emit(subscription, { type: "clock", timeNs });
        }
    }

    releasePending(timeNs = this.getTimeNs()) {
        if (this.disposed) return;
        for (const subscription of [...this.subscriptions]) this._release(subscription, timeNs);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const subscription of this.subscriptions) {
            subscription.active = false;
            subscription.pending.clear();
            subscription.cancel();
        }
        this.subscriptions.clear();
        this.latest.clear();
        this.runtimeChanged?.(); this.runtimeChanged = null;
        this.occupancySamplers = {}; this.occupancySamples.clear();
        this.zenohSource?.dispose();
    }
}
