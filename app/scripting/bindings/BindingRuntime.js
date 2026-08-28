import { SignalStore, getByPath } from "../runtime/SignalStore.js";
import {
    SIGNAL_PATHS,
    listSignalPaths,
    topicSignalPath
} from "../runtime/SignalPaths.js";
import { createLoadedScript, loadScript } from "../ScriptRuntime.js";
import { SeededRNG } from "../../util/SeededRNG.js";
import { getBindingManifest, putBindingManifest } from "./BindingStorage.js";
import {
    BINDING_SCOPES,
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

function stableArtifactHash(value) {
    const text = JSON.stringify(value ?? null);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
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
        this.libraryManifest = createBindingManifest();
        this.manifest = createBindingManifest();
        this._activeSource = "library";
        this.loadScriptImpl = options.loadScript || loadScript;

        this.listeners = new Set();
        this.telemetry = new Map();

        this._scripts = new Map();
        this._scriptLoads = new Map();
        this._scriptParameterInputs = new Map();
        this._timers = new Map();
        this._tickCounters = new Map();
        this._signalWatch = new Map();
        this._topicsSeen = new Set();
        this._attachedClients = new WeakSet();
        this._clientManager = null;
        this._topicScheduler = null;
        this._runTopics = new Map();
        this._topicRouter = null;
        this._lastEmit = 0;
        this._emitTimeout = null;
        this._ready = false;

        this._readyPromise = this._hydrate(options.autoLoad !== false);
    }

    async _hydrate(autoLoad) {
        if (autoLoad) {
            try {
                this.libraryManifest = await getBindingManifest();
            } catch {
                this.libraryManifest = createBindingManifest();
            }
        }
        this.manifest = this._globalManifest(this.libraryManifest);

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
            manifest: this.libraryManifest,
            activeManifest: this.manifest,
            telemetry: Object.fromEntries(
                [...this.telemetry.entries()].map(([id, entry]) => [id, { ...entry }])
            ),
            topics: [...this._topicsSeen].sort(),
            signalPaths: listSignalPaths(
                this.signalStore.paths(),
                [...this._topicsSeen].map(topicSignalPath),
                getConfiguredSignalPaths(this.libraryManifest)
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

    _globalManifest(libraryManifest) {
        return createBindingManifest({
            enabled: libraryManifest.enabled,
            bindings: libraryManifest.bindings.filter((binding) => binding.scope === BINDING_SCOPES.GLOBAL),
        });
    }

    _activateManifest(manifest, source) {
        this.manifest = normalizeBindingManifest(manifest);
        this._activeSource = source;
        this._tickCounters.clear();
        this._signalWatch.clear();
        this._syncTimers();
        this._preloadScripts();
        this._emit();
        return this.manifest;
    }

    async setLibraryManifest(manifest, { persist = true } = {}) {
        let next = normalizeBindingManifest(manifest);
        if (persist) next = await putBindingManifest(next);
        this.libraryManifest = next;

        if (this._activeSource === "library") {
            this._activateManifest(this._globalManifest(next), "library");
        } else {
            this._emit();
        }

        return this.libraryManifest;
    }

    async setManifest(manifest, { persist = true } = {}) {
        if (persist) return this.setLibraryManifest(manifest, { persist: true });
        return this._activateManifest(manifest, "resolved");
    }

    activateLibraryBindings() {
        return this._activateManifest(this._globalManifest(this.libraryManifest), "library");
    }

    setEnabled(enabled) {
        return this.setLibraryManifest({ ...this.libraryManifest, enabled: Boolean(enabled) });
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
        this._orderedBindings()
            .filter((binding) => binding.enabled && binding.scriptId)
            .forEach((binding) => {
                this._ensureScript(binding.scriptId).catch(() => {});
            });
    }

    async prepareResolvedScripts(entries = [], { seed = "42", parameterBindings = [] } = {}) {
        this._scriptParameterInputs.clear();
        const resolvedIds = new Set(entries.map((entry) => entry.scriptId));
        for (const scriptId of this._scripts.keys()) {
            if (!resolvedIds.has(scriptId)) this._scripts.delete(scriptId);
        }
        if (entries.length === 0) return;
        const { registerBuiltInBlocks } = await import("../registerBuiltInBlocks.js");
        registerBuiltInBlocks();
        await Promise.all(entries.map((entry) => this._ensureScript(entry.scriptId).catch(() => null)));
        for (const binding of parameterBindings) {
            if (binding?.target?.kind !== "script-input") continue;
            const inputs = this._scriptParameterInputs.get(binding.target.scriptId) ?? {};
            inputs[binding.target.input] = structuredClone(binding.value);
            this._scriptParameterInputs.set(binding.target.scriptId, inputs);
        }
        for (const entry of [...entries].sort((left, right) => left.scriptId.localeCompare(right.scriptId))) {
            const rng = new SeededRNG(`${seed}:visual-script:${entry.scriptId}`);
            this._scripts.set(entry.scriptId, createLoadedScript(entry.artifact, {
                signalStore: this.signalStore,
                runtimeContext: {
                    seed,
                    scriptId: entry.scriptId,
                    random: () => rng.next(),
                },
            }));
            this._scriptLoads.delete(entry.scriptId);
        }
    }

    _orderedBindings() {
        return [...this.manifest.bindings].sort((left, right) => String(left.id).localeCompare(String(right.id)));
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
                this.signalStore.publishSignal(`scripts.${scriptId}.versionHash`, stableArtifactHash(script.artifact), {
                    source: "scripting",
                    type: "string",
                    category: "scripts",
                    replayRole: "input",
                    logClass: "core",
                    descriptorMetadata: { artifactKind: script.artifact?.kind || null, artifactVersion: script.artifact?.version || null },
                });
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

    setTopicRouter(topicRouter = null, topics = []) {
        this._topicRouter = topicRouter;
        this._runTopics = new Map((topics || []).map((topic) => [topic.name, topic]));
    }

    _validateTopicSink(mapping) {
        const topic = this._runTopics.get(mapping.topic);
        if (!topic) {
            throw new Error(`Cannot publish "${mapping.topic}" because it is not declared in the run manifest.`);
        }
        const expectedType = topic.schema?.type || topic.type;
        if (mapping.type && expectedType && mapping.type !== expectedType) {
            throw new Error(`Cannot publish "${mapping.topic}" as ${mapping.type}; manifest expects ${expectedType}.`);
        }
        if (topic.direction !== "output") {
            throw new Error(`Cannot publish "${mapping.topic}" because manifest direction is ${topic.direction}.`);
        }
    }

    _onTopicUpdate(info) {
        if (this._topicScheduler) {
            this._topicScheduler(info);
            return;
        }
        this.applyTopicUpdate(info);
    }

    setTopicScheduler(scheduler = null) {
        this._topicScheduler = typeof scheduler === "function" ? scheduler : null;
    }

    applyTopicUpdate(info) {
        const topic = info?.name;
        if (!topic) return;

        if (!this._topicsSeen.has(topic)) {
            this._topicsSeen.add(topic);
            this._emitThrottled();
        }

        this.signalStore.set(topicSignalPath(topic), info.value, {
            source: "topic",
            type: "json",
            category: "topics",
            replayRole: "input",
            logClass: "standard",
            metadata: {
                typeStr: info.typeStr ?? null,
                count: info.count ?? null,
                routerSequence: info.routerSequence ?? null,
                contractId: info.contractId ?? null,
            },
            descriptorMetadata: {
                rosType: info.typeStr ?? null,
                schema: info.schema ?? null,
                contractId: info.contractId ?? null,
            },
        });

        if (!this.manifest.enabled) return;

        this._orderedBindings()
            .filter((binding) => binding.enabled
                && binding.trigger.kind === TRIGGER_KINDS.TOPIC
                && binding.trigger.topic === topic)
            .forEach((binding) => {
                this._dispatch(binding, { message: info.value, topic });
            });

        this._checkSignalTriggers();
    }

    // ------------------------------------------------------------- sim ticks

    update(dt, clock = {}) {
        if (!this.manifest.enabled) return;

        const simulation = this.signalStore.read(SIGNAL_PATHS.SIMULATION);
        const step = ((simulation.value?.step ?? -1) + 1);
        const time = (simulation.value?.time ?? 0) + dt;

        this.signalStore.set(SIGNAL_PATHS.SIMULATION, { dt, time, step, frame: step }, { source: "simulation" });

        this._orderedBindings()
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

        const timeNs = Number(clock.timeNs ?? Math.round(time * 1e9));
        this._orderedBindings()
            .filter((binding) => binding.enabled && binding.trigger.kind === "simulation-timer")
            .forEach((binding) => {
                const intervalNs = Math.max(1, Number(binding.trigger.intervalNs || 100_000_000));
                const nextKey = `sim-timer:${binding.id}`;
                let nextNs = this._tickCounters.get(nextKey) ?? intervalNs;
                while (timeNs >= nextNs) {
                    this._dispatch(binding, { dt: intervalNs / 1e9, time: nextNs / 1e9, step: clock.step ?? step });
                    nextNs += intervalNs;
                }
                this._tickCounters.set(nextKey, nextNs);
            });

        this._checkSignalTriggers({ dt, time, step });
    }

    _checkSignalTriggers(context = {}) {
        this._orderedBindings()
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

        this._orderedBindings()
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
        this._topicScheduler = null;
        if (this._emitTimeout) {
            clearTimeout(this._emitTimeout);
            this._emitTimeout = null;
        }
        this.listeners.clear();
    }

    // ------------------------------------------------------------- execution

    async runBindingNow(bindingId) {
        const binding = this.libraryManifest.bindings.find((item) => item.id === bindingId)
            || this.manifest.bindings.find((item) => item.id === bindingId);
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
            const status = this.telemetry.get(binding.id);
            this.signalStore.publishSignal(`bindings.${binding.id}.status`, status, {
                source: "bindings",
                type: "json",
                category: "bindings",
                replayRole: "derived",
                logClass: "standard",
            });
            if (["failure", "invalid"].includes(patch.lastStatus)) {
                this.signalStore.emitTelemetryEvent({
                    category: "bindings",
                    name: patch.lastStatus === "invalid" ? "binding-invalid" : "binding-failure",
                    severity: "error",
                    payload: { bindingId: binding.id, scriptId: binding.scriptId, error: patch.lastError || null },
                });
            }
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

        this.signalStore.publishSignal(`bindings.${binding.id}.outputs`, run.outputs || {}, {
            source: "bindings",
            type: "json",
            category: "bindings",
            replayRole: "derived",
            logClass: "standard",
        });

        if (manual) this._emit();

        return { status: publishError ? "failure" : "success", error: publishError, inputs, outputs: run.outputs };
    }

    _resolveInputs(binding, context) {
        const inputs = { ...(this._scriptParameterInputs.get(binding.scriptId) ?? {}) };

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

            if (this._runTopics.size > 0) {
                this._validateTopicSink(mapping);
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
