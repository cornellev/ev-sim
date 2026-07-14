import { SignalStore, getByPath } from "../runtime/SignalStore.js";
import {
    SIGNAL_PATHS,
    listSignalPaths,
    topicSignalPath
} from "../runtime/SignalPaths.js";
import { loadScript } from "../ScriptRuntime.js";
import { getBindingManifest, putBindingManifest } from "./BindingStorage.js";
import {
    INPUT_SOURCES,
    OUTPUT_SINKS,
    TRIGGER_KINDS,
    createBindingManifest,
    normalizeBindingManifest,
    validateBinding
} from "./BindingDocument.js";

const EMIT_THROTTLE_MS = 100;

function nowMs() {
    return Date.now();
}

function getConfiguredSignalPaths(manifest) {
    const paths = [];

    manifest.bindings.forEach((binding) => {
        if (binding.trigger.kind === TRIGGER_KINDS.SIGNAL_UPDATE) {
            paths.push(binding.trigger.path);
        }

        binding.inputs.forEach((mapping) => {
            if (mapping.source === INPUT_SOURCES.SIGNAL) paths.push(mapping.path);
        });

        binding.outputs.forEach((mapping) => {
            if (mapping.sink === OUTPUT_SINKS.SIGNAL) paths.push(mapping.path);
        });
    });

    return paths;
}

/**
 * Executes manifest bindings against the shared signal store.
 *
 * Triggers:
 * - topic: ROS topic updates bridged from the ClientManager
 * - fixed-update: called from SimulationEngine._fixedStep via update(dt)
 * - signal-update: watched store path changed (checked after ticks and topic writes)
 * - timer: wall-clock setInterval, independent of the simulation loop
 */
export class BindingRuntime {
    constructor(options = {}) {
        this.signalStore = options.signalStore || new SignalStore();
        this.manifest = createBindingManifest();
        this.loadScriptImpl = options.loadScript || loadScript;

        this.listeners = new Set();
        this.telemetry = new Map();

        this._scripts = new Map();
        this._scriptLoads = new Map();
        this._timers = new Map();
        this._tickCounters = new Map();
        this._signalWatch = new Map();
        this._topicsSeen = new Set();
        this._attachedClients = new WeakSet();
        this._clientManager = null;
        this._lastEmit = 0;
        this._emitTimeout = null;
        this._ready = false;

        this._readyPromise = this._hydrate(options.autoLoad !== false);
    }

    async _hydrate(autoLoad) {
        if (autoLoad) {
            try {
                this.manifest = await getBindingManifest();
            } catch {
                this.manifest = createBindingManifest();
            }
        }

        this._ready = true;
        this._syncTimers();
        this._preloadScripts();
        this._emit();
    }

    ready() {
        return this._readyPromise;
    }

    // ------------------------------------------------------------------ state

    getSnapshot() {
        return {
            ready: this._ready,
            enabled: this.manifest.enabled,
            manifest: this.manifest,
            telemetry: Object.fromEntries(
                [...this.telemetry.entries()].map(([id, entry]) => [id, { ...entry }])
            ),
            topics: [...this._topicsSeen].sort(),
            signalPaths: listSignalPaths(
                this.signalStore.paths(),
                [...this._topicsSeen].map(topicSignalPath),
                getConfiguredSignalPaths(this.manifest)
            ),
            connected: Boolean(this._clientManager?.hasClient?.())
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    _emit() {
        this._lastEmit = nowMs();
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    _emitThrottled() {
        const elapsed = nowMs() - this._lastEmit;
        if (elapsed >= EMIT_THROTTLE_MS) {
            this._emit();
            return;
        }

        if (this._emitTimeout) return;
        this._emitTimeout = setTimeout(() => {
            this._emitTimeout = null;
            this._emit();
        }, EMIT_THROTTLE_MS - elapsed);
    }

    // -------------------------------------------------------------- manifest

    async setManifest(manifest, { persist = true } = {}) {
        this.manifest = normalizeBindingManifest(manifest);
        this._tickCounters.clear();
        this._signalWatch.clear();
        this._syncTimers();
        this._preloadScripts();
        this._emit();

        if (persist) {
            this.manifest = await putBindingManifest(this.manifest);
        }

        return this.manifest;
    }

    setEnabled(enabled) {
        return this.setManifest({ ...this.manifest, enabled: Boolean(enabled) });
    }

    invalidateScript(scriptId) {
        if (scriptId) {
            this._scripts.delete(scriptId);
            this._scriptLoads.delete(scriptId);
        } else {
            this._scripts.clear();
            this._scriptLoads.clear();
        }
        this._preloadScripts();
    }

    // --------------------------------------------------------------- scripts

    _preloadScripts() {
        this.manifest.bindings
            .filter((binding) => binding.enabled && binding.scriptId)
            .forEach((binding) => {
                this._ensureScript(binding.scriptId).catch(() => {});
            });
    }

    _ensureScript(scriptId) {
        if (this._scripts.has(scriptId)) {
            return Promise.resolve(this._scripts.get(scriptId));
        }

        if (this._scriptLoads.has(scriptId)) {
            return this._scriptLoads.get(scriptId);
        }

        const load = this.loadScriptImpl(scriptId, { signalStore: this.signalStore })
            .then((script) => {
                this._scripts.set(scriptId, script);
                this._scriptLoads.delete(scriptId);
                this._emitThrottled();
                return script;
            })
            .catch((error) => {
                this._scriptLoads.delete(scriptId);
                throw error;
            });

        this._scriptLoads.set(scriptId, load);
        return load;
    }

    // ---------------------------------------------------------------- topics

    attachClient(clientManager) {
        if (!clientManager || this._attachedClients.has(clientManager)) return;
        this._attachedClients.add(clientManager);
        this._clientManager = clientManager;

        clientManager.onUpdate((info) => this._onTopicUpdate(info));
    }

    _onTopicUpdate(info) {
        const topic = info?.name;
        if (!topic) return;

        if (!this._topicsSeen.has(topic)) {
            this._topicsSeen.add(topic);
            this._emitThrottled();
        }

        this.signalStore.set(topicSignalPath(topic), info.value, {
            source: "topic",
            type: "message",
            metadata: { typeStr: info.typeStr ?? null, count: info.count ?? null }
        });

        if (!this.manifest.enabled) return;

        this.manifest.bindings
            .filter((binding) => binding.enabled
                && binding.trigger.kind === TRIGGER_KINDS.TOPIC
                && binding.trigger.topic === topic)
            .forEach((binding) => {
                this._dispatch(binding, { message: info.value, topic });
            });

        this._checkSignalTriggers();
    }

    // ------------------------------------------------------------- sim ticks

    update(dt) {
        if (!this.manifest.enabled) return;

        const simulation = this.signalStore.read(SIGNAL_PATHS.SIMULATION);
        const step = ((simulation.value?.step ?? -1) + 1);
        const time = (simulation.value?.time ?? 0) + dt;

        this.signalStore.set(SIGNAL_PATHS.SIMULATION, { dt, time, step, frame: step }, { source: "simulation" });

        this.manifest.bindings
            .filter((binding) => binding.enabled && binding.trigger.kind === TRIGGER_KINDS.FIXED_UPDATE)
            .forEach((binding) => {
                const everyN = binding.trigger.everyN || 1;
                const counter = (this._tickCounters.get(binding.id) || 0) + 1;

                if (counter >= everyN) {
                    this._tickCounters.set(binding.id, 0);
                    this._dispatch(binding, { dt: dt * everyN, time, step });
                } else {
                    this._tickCounters.set(binding.id, counter);
                }
            });

        this._checkSignalTriggers({ dt, time, step });
    }

    _checkSignalTriggers(context = {}) {
        this.manifest.bindings
            .filter((binding) => binding.enabled
                && binding.trigger.kind === TRIGGER_KINDS.SIGNAL_UPDATE
                && binding.trigger.path)
            .forEach((binding) => {
                const entry = this.signalStore.read(binding.trigger.path);
                if (!entry.exists) return;

                let valueKey;
                try {
                    valueKey = JSON.stringify(entry.value);
                } catch {
                    valueKey = String(entry.value);
                }

                const previous = this._signalWatch.get(binding.id);
                this._signalWatch.set(binding.id, { updatedAt: entry.updatedAt, valueKey });

                // First observation records the baseline without firing.
                if (previous === undefined) return;
                if (previous.updatedAt === entry.updatedAt && previous.valueKey === valueKey) return;

                this._dispatch(binding, { ...context, message: entry.value });
            });
    }

    // ---------------------------------------------------------------- timers

    _syncTimers() {
        for (const timer of this._timers.values()) {
            clearInterval(timer);
        }
        this._timers.clear();

        if (typeof window === "undefined" || !this.manifest.enabled) return;

        this.manifest.bindings
            .filter((binding) => binding.enabled && binding.trigger.kind === TRIGGER_KINDS.TIMER)
            .forEach((binding) => {
                const intervalMs = binding.trigger.intervalMs || 100;
                const timer = setInterval(() => {
                    const current = this.manifest.bindings.find((item) => item.id === binding.id);
                    if (!current || !current.enabled || !this.manifest.enabled) return;
                    this._dispatch(current, { dt: intervalMs / 1000 });
                }, intervalMs);
                this._timers.set(binding.id, timer);
            });
    }

    dispose() {
        for (const timer of this._timers.values()) {
            clearInterval(timer);
        }
        this._timers.clear();
        if (this._emitTimeout) {
            clearTimeout(this._emitTimeout);
            this._emitTimeout = null;
        }
        this.listeners.clear();
    }

    // ------------------------------------------------------------- execution

    async runBindingNow(bindingId) {
        const binding = this.manifest.bindings.find((item) => item.id === bindingId);
        if (!binding) {
            throw new Error(`Binding "${bindingId}" was not found.`);
        }

        if (binding.scriptId) {
            await this._ensureScript(binding.scriptId).catch(() => {});
        }

        const context = {};
        if (binding.trigger.kind === TRIGGER_KINDS.TOPIC && binding.trigger.topic) {
            context.message = this.signalStore.read(topicSignalPath(binding.trigger.topic)).value;
            context.topic = binding.trigger.topic;
        }

        const simulation = this.signalStore.read(SIGNAL_PATHS.SIMULATION).value;
        context.dt = simulation?.dt ?? 0;
        context.time = simulation?.time ?? 0;
        context.step = simulation?.step ?? 0;

        return this._dispatch(binding, context, { manual: true });
    }

    _dispatch(binding, context = {}, { manual = false } = {}) {
        const startedAt = nowMs();
        const record = (patch) => {
            const previous = this.telemetry.get(binding.id) || { runCount: 0 };
            this.telemetry.set(binding.id, {
                ...previous,
                ...patch,
                lastRanAt: startedAt,
                lastDurationMs: nowMs() - startedAt
            });
            this._emitThrottled();
        };

        const issues = validateBinding(binding);
        if (issues.length > 0) {
            const result = { status: "invalid", error: issues[0] };
            record({ lastStatus: "invalid", lastError: issues[0] });
            return result;
        }

        const script = this._scripts.get(binding.scriptId);
        if (!script) {
            this._ensureScript(binding.scriptId).catch((error) => {
                record({ lastStatus: "failure", lastError: error?.message || "Script failed to load." });
            });
            const result = { status: "loading", error: null };
            record({ lastStatus: "loading", lastError: null });
            return result;
        }

        let inputs;
        try {
            inputs = this._resolveInputs(binding, context);
        } catch (error) {
            record({ lastStatus: "failure", lastError: error?.message || "Could not resolve inputs." });
            return { status: "failure", error: error?.message };
        }

        const run = script.runResult(inputs);
        const previous = this.telemetry.get(binding.id) || { runCount: 0 };

        if (run.status === "failure") {
            record({
                runCount: previous.runCount + 1,
                lastStatus: "failure",
                lastError: run.e?.message || "Script execution failed.",
                lastInputs: inputs,
                lastOutputs: null
            });
            return { status: "failure", error: run.e?.message, inputs };
        }

        let publishError = null;
        try {
            this._routeOutputs(binding, run.outputs || {});
        } catch (error) {
            publishError = error?.message || "Could not route outputs.";
        }

        record({
            runCount: previous.runCount + 1,
            lastStatus: publishError ? "failure" : "success",
            lastError: publishError,
            lastInputs: inputs,
            lastOutputs: run.outputs || {}
        });

        if (manual) this._emit();

        return { status: publishError ? "failure" : "success", error: publishError, inputs, outputs: run.outputs };
    }

    _resolveInputs(binding, context) {
        const inputs = {};

        binding.inputs.forEach((mapping) => {
            switch (mapping.source) {
                case INPUT_SOURCES.SIGNAL: {
                    const entry = this.signalStore.read(mapping.path);
                    inputs[mapping.input] = mapping.field
                        ? getByPath(entry.value, mapping.field, null)
                        : entry.value;
                    break;
                }
                case INPUT_SOURCES.MESSAGE:
                    inputs[mapping.input] = mapping.field
                        ? getByPath(context.message, mapping.field, null)
                        : (context.message ?? null);
                    break;
                case INPUT_SOURCES.CONSTANT:
                    inputs[mapping.input] = mapping.value ?? null;
                    break;
                case INPUT_SOURCES.SIM: {
                    const simulation = this.signalStore.read(SIGNAL_PATHS.SIMULATION).value || {};
                    inputs[mapping.input] = context[mapping.key] ?? simulation[mapping.key] ?? 0;
                    break;
                }
                default:
                    inputs[mapping.input] = null;
            }
        });

        return inputs;
    }

    _routeOutputs(binding, outputs) {
        binding.outputs.forEach((mapping) => {
            if (!(mapping.output in outputs)) return;
            const value = outputs[mapping.output];

            if (mapping.sink === OUTPUT_SINKS.SIGNAL) {
                this.signalStore.set(mapping.path, value, { source: "binding" });
                return;
            }

            const client = this._clientManager?.get?.();
            if (!client) {
                throw new Error(`Cannot publish "${mapping.topic}" because no ROS client is connected.`);
            }

            client.publish(mapping.topic, mapping.type, value);
        });
    }
}

let sharedRuntime = null;

/**
 * Module-level singleton so the runtime survives workspace switches
 * (the 3D scene and the bindings page mount/unmount independently).
 */
export function getBindingRuntime() {
    if (!sharedRuntime) {
        sharedRuntime = new BindingRuntime();
    }
    return sharedRuntime;
}
