import { Visualizer } from "./Visualizer.js";

const targets = ["scene", "map"];

function requestMicrotask(callback) {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) callback(); });
    return () => { cancelled = true; };
}

function equalFields(left, right) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]));
}

/**
 * tools: { toolId: Visualizer }; one owned instance per tool, shared by both targets.
 * configure({ toolId: { data: [binding], pose: [binding], visible: { scene, map }, predictedPath } }, contexts)
 * A binding has a unique string id; remaining source-specific descriptor fields are opaque here.
 * Shared ids must have the same shallow descriptor. Data events merge input keys atomically;
 * channel bindings can emit { oracle: grid }, { lidar: grid }, or { stack: grid }.
 * Events use type: data/pose/clock/status/reset. Revisions or changed field references identify
 * samples; sources own stable buffers. Metadata and nanosecond/sequence values are never narrowed.
 * requestFlush(callback) schedules presentation and returns immediate cancellation.
 * display contexts add toolId, layerVisibility, predictedPathHidden, and separate dirty flags.
 * Snapshot tools contain status, visibility, metadata, a cached output and display revision.
 */
export class VisualizationManager {
    constructor({ tools = {}, sceneContext = {}, mapContext = {}, requestFlush = requestMicrotask } = {}) {
        this.tools = tools;
        this.contexts = { scene: sceneContext, map: mapContext };
        this.requestFlush = requestFlush;
        this.entries = new Map();
        this.index = new Map();
        this.bindings = [];
        this.source = null;
        this.subscription = null;
        this.pending = null;
        this.generation = 0;
        this.disposed = false;
        this.predictedPathHidden = false;
        this.listeners = { scene: new Set(), map: new Set() };
        this.snapshots = { scene: { tools: {} }, map: { tools: {} } };
    }

    _configuration(toolBindings) {
        if (!toolBindings || typeof toolBindings !== "object" || Array.isArray(toolBindings)) throw new TypeError("Tool bindings must be an object.");
        const entries = new Map();
        const descriptors = new Map();
        const index = new Map();
        for (const [toolId, config] of Object.entries(toolBindings)) {
            const tool = this.tools[toolId];
            if (!(tool instanceof Visualizer) || tool.disposed) throw new TypeError(`Unknown or disposed visualizer: ${toolId}.`);
            if (!config || typeof config !== "object") throw new TypeError(`Invalid bindings for ${toolId}.`);
            const visible = { scene: true, map: true, ...config.visible };
            if (targets.some((target) => typeof visible[target] !== "boolean")) throw new TypeError("Visibility must be boolean.");
            entries.set(toolId, { tool, visible, predictedPath: config.predictedPath === true, outputs: { scene: undefined, map: undefined }, revisions: { scene: 0, map: 0 } });
            for (const kind of ["data", "pose"]) {
                const bindings = config[kind] ?? [];
                if (!Array.isArray(bindings)) throw new TypeError(`${kind} bindings must be an array.`);
                for (const binding of bindings) {
                    if (!binding || typeof binding.id !== "string" || !binding.id) throw new TypeError("Bindings require a nonempty string id.");
                    const previous = descriptors.get(binding.id);
                    if (previous && !equalFields(previous, binding)) throw new TypeError(`Conflicting binding: ${binding.id}.`);
                    descriptors.set(binding.id, { ...binding });
                    if (!index.has(binding.id)) index.set(binding.id, []);
                    index.get(binding.id).push({ toolId, kind, sample: null });
                }
            }
        }
        return { entries, index, bindings: [...descriptors.values()] };
    }

    configure(toolBindings, { sceneContext = this.contexts.scene, mapContext = this.contexts.map } = {}) {
        if (this.disposed) return;
        // Validate and subscribe before replacing the working configuration.
        const next = this._configuration(toolBindings);
        let subscription;
        try { subscription = this._subscribe(this.source, next.bindings, this.generation + 1); }
        catch (error) { this._reportAll(error); this._schedule(); return; }
        this._fence();
        for (const [toolId, { tool }] of this.entries) {
            if (next.entries.has(toolId)) continue;
            this._safe(() => tool.reset(), tool);
            for (const target of targets) this._safe(() => tool.setVisible(target, false), tool);
        }
        this.entries = next.entries;
        this.index = next.index;
        this.bindings = next.bindings;
        this.contexts = { scene: sceneContext, map: mapContext };
        this.subscription = subscription;
        this._resetTools();
        subscription?.activate();
        this._publish();
        this._schedule();
    }

    _subscribe(source, bindings, generation) {
        if (!source) return null;
        let active = false;
        let closed = false;
        const pending = [];
        const callback = (event) => {
            if (closed || this.disposed) return;
            if (!active) { pending.push(event); return; }
            if (generation === this.generation) this._onEvent(event);
        };
        let cancel;
        try {
            cancel = source.subscribe(bindings, callback);
            if (typeof cancel !== "function") throw new TypeError("Source subscriptions must return cancellation.");
        } catch (error) { closed = true; throw error; }
        return {
            cancel: () => { closed = true; pending.length = 0; cancel(); },
            activate: () => { active = true; for (const event of pending.splice(0)) callback(event); },
        };
    }

    setSource(source) {
        if (this.disposed || source === this.source) return;
        if (source && (typeof source.subscribe !== "function" || typeof source.dispose !== "function")) throw new TypeError("Sources require subscribe and dispose.");
        let subscription;
        try { subscription = this._subscribe(source, this.bindings, this.generation + 1); }
        catch (error) { this._reportAll(error); this._safe(() => source.dispose()); this._schedule(); return; }
        const previous = this.source;
        this._fence();
        this.source = source;
        this.subscription = subscription;
        this._safe(() => previous?.dispose());
        this._resetTools();
        subscription?.activate();
        this._publish();
        this._schedule();
    }

    _safe(callback, tool = null) {
        try { return callback(); }
        catch (error) {
            if (tool) this._report(error, tool);
            else this._reportAll(error);
            return undefined;
        }
    }

    _report(error, tool) {
        Visualizer.prototype.setStatus.call(tool, "error", error?.message || String(error));
    }

    _reportAll(error) {
        for (const { tool } of this.entries.values()) this._report(error, tool);
    }

    _fence() {
        this.generation += 1;
        this._cancelPending();
        const subscription = this.subscription;
        this.subscription = null;
        this._safe(() => subscription?.cancel());
    }

    _resetTools() {
        for (const entry of this.entries.values()) {
            this._safe(() => entry.tool.reset(), entry.tool);
            entry.outputs = { scene: undefined, map: undefined };
            entry.revisions = { scene: 0, map: 0 };
            for (const target of targets) this._applyVisibility(entry, target);
        }
        for (const routes of this.index.values()) for (const route of routes) route.sample = null;
    }

    _onEvent(event) {
        if (this.disposed) return;
        this._safe(() => {
            if (event.type === "reset") { this.reset(); return; }
            if (event.type === "clock") {
                if (!(Number.isSafeInteger(event.timeNs) && event.timeNs >= 0) && !(typeof event.timeNs === "bigint" && event.timeNs >= 0n)) throw new TypeError("Invalid visualization clock.");
                for (const { tool } of this.entries.values()) this._safe(() => tool.onTimeAdvance(event.timeNs), tool);
                return;
            }
            for (const route of this.index.get(event.bindingId) ?? []) {
                const { tool } = this.entries.get(route.toolId);
                this._safe(() => {
                    if (event.type === "status") { tool.setStatus(event.status, event.message ?? null); return; }
                    if (event.type !== route.kind) return;
                    const previous = route.sample;
                    const revisionChanged = event.revision !== undefined && (!previous || !Object.is(previous.revision, event.revision));
                    if (event.type === "data") {
                        const inputs = event.inputs;
                        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new TypeError("Display inputs must be an object.");
                        const changed = Object.keys(inputs).filter((key) => revisionChanged || !previous || !Object.is(previous.inputs[key], inputs[key]));
                        if (!tool.acceptDataUpdate(inputs, changed, event.metadata)) return;
                        route.sample = { inputs: { ...inputs }, revision: event.revision };
                    } else {
                        if (previous && !revisionChanged && Object.is(previous.pose, event.pose)) return;
                        if (!tool.acceptVehicleMove(event.pose, event.metadata)) return;
                        route.sample = { pose: event.pose, revision: event.revision };
                    }
                }, tool);
            }
        });
        this._schedule();
    }

    _applyVisibility(entry, target) {
        const visible = entry.visible[target] && !(target === "scene" && entry.predictedPath && this.predictedPathHidden);
        this._safe(() => entry.tool.setVisible(target, visible), entry.tool);
    }

    setVisible(toolId, target, visible) {
        const entry = this._entry(toolId, target, visible);
        entry.visible[target] = visible;
        this._applyVisibility(entry, target);
        this._schedule();
    }

    _entry(toolId, target, visible) {
        const entry = this.entries.get(toolId);
        if (!entry || !targets.includes(target) || typeof visible !== "boolean") throw new TypeError("Invalid visualization visibility.");
        return entry;
    }

    setLayerVisible(toolId, layerId, target, visible) {
        const { tool } = this._entry(toolId, target, visible);
        if (typeof layerId !== "string" || !layerId) throw new TypeError("Layer ids must be nonempty strings.");
        this._safe(() => tool.setLayerVisible(layerId, target, visible), tool);
        this._schedule();
    }

    setPredictedPathHidden(hidden) {
        if (typeof hidden !== "boolean") throw new TypeError("Predicted path visibility must be boolean.");
        if (this.predictedPathHidden === hidden) return;
        this.predictedPathHidden = hidden;
        for (const entry of this.entries.values()) if (entry.predictedPath) this._applyVisibility(entry, "scene");
        this._schedule();
    }

    _schedule() {
        if (this.disposed || this.pending) return;
        const dirty = [...this.entries.values()].some(({ tool }) => targets.some((target) => {
            const flags = tool.dirty[target];
            return flags.status || (tool.visible[target] && tool.ready && (flags.geometry || flags.placement));
        }));
        if (!dirty) return;
        const pending = { cancel: null };
        this.pending = pending;
        try {
            pending.cancel = this.requestFlush(() => {
                if (this.disposed || this.pending !== pending) return;
                this.pending = null;
                this.flush();
            });
            if (typeof pending.cancel !== "function") throw new TypeError("Presentation requests must return cancellation.");
        } catch (error) {
            this.pending = null;
            this._reportAll(error);
            this._publish();
        }
    }

    _cancelPending() {
        const pending = this.pending;
        this.pending = null;
        this._safe(() => pending?.cancel?.());
    }

    flush() {
        if (this.disposed) return;
        this._cancelPending();
        for (const [toolId, entry] of this.entries) {
            const { tool } = entry;
            for (const target of targets) {
                const dirty = tool.dirty[target];
                if (!tool.visible[target] || !tool.ready || (!dirty.geometry && !dirty.placement && !(dirty.status && tool.displayOnStatusChange))) continue;
                this._safe(() => {
                    const output = tool.render(target, { ...this.contexts[target], toolId, layerVisibility: tool.layerVisibility[target], predictedPathHidden: this.predictedPathHidden });
                    entry.outputs[target] = output;
                    entry.revisions[target] += 1;
                }, tool);
            }
        }
        this._publish();
    }

    _publish() {
        for (const target of targets) {
            const previous = this.snapshots[target].tools;
            const tools = {};
            let changed = Object.keys(previous).length !== this.entries.size;
            for (const [toolId, entry] of this.entries) {
                const { tool } = entry;
                const next = { ready: tool.ready, status: tool.status, message: tool.message, visible: tool.visible[target], layerVisibility: tool.layerVisibility[target], metadata: tool.metadata, poseMetadata: tool.poseMetadata, output: entry.outputs[target], revision: entry.revisions[target] };
                tools[toolId] = previous[toolId] && equalFields(previous[toolId], next) ? previous[toolId] : next;
                changed ||= tools[toolId] !== previous[toolId];
                tool.dirty[target].status = false;
            }
            if (!changed) continue;
            this.snapshots[target] = { tools };
            for (const listener of [...this.listeners[target]]) {
                try { listener(); } catch { /* Subscriber errors cannot reach simulation stepping. */ }
            }
        }
    }

    getSnapshot() { return this.snapshots.scene; }
    getMapSnapshot() { return this.snapshots.map; }
    subscribe(listener) { return this._listen("scene", listener); }
    subscribeMap(listener) { return this._listen("map", listener); }
    _listen(target, listener) {
        if (typeof listener !== "function") throw new TypeError("Snapshot subscribers must be functions.");
        if (!this.disposed) this.listeners[target].add(listener);
        return () => this.listeners[target].delete(listener);
    }

    reset() {
        if (this.disposed) return;
        this._fence();
        this._resetTools();
        this.subscription = this._safe(() => this._subscribe(this.source, this.bindings, this.generation));
        this.subscription?.activate?.();
        this._publish();
        this._schedule();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._fence();
        const source = this.source;
        this.source = null;
        this._safe(() => source?.dispose());
        for (const tool of new Set(Object.values(this.tools))) this._safe(() => tool.dispose(), tool);
        this.entries.clear();
        this.index.clear();
        this.bindings = [];
        this._publish();
        for (const listeners of Object.values(this.listeners)) listeners.clear();
    }
}
