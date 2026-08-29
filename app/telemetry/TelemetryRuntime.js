import { getBindingRuntime } from "../scripting/bindings/BindingRuntime.js";

const CHANNEL_NAME = "cev-sim-telemetry-v2";
const PROTOCOL_VERSION = 2;
const HEARTBEAT_MS = 2000;
const SOURCE_TIMEOUT_MS = 6500;
const PREVIEW_INTERVAL_MS = 500;
const EMIT_INTERVAL_MS = 100;
const HISTORY_DURATION_US = 120e6;
const HISTORY_SAMPLE_LIMIT = 20000;
const BACKLOG_SAMPLE_LIMIT = 2000;
const EVENT_LIMIT = 500;

function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function isHeavyDescriptor(descriptor) {
    return descriptor?.logClass === "heavy" || descriptor?.type === "bytes";
}

function createRing() {
    return { items: [], head: 0 };
}

function appendRing(ring, value, { maxSamples = HISTORY_SAMPLE_LIMIT, durationUs = HISTORY_DURATION_US, latestOnly = false } = {}) {
    if (latestOnly) {
        ring.items[0] = value;
        if (ring.items.length !== 1) ring.items.length = 1;
        ring.head = 0;
        return;
    }
    ring.items.push(clone(value));
    const newestTimeUs = Number(value?.timeUs || 0);
    const oldestTimeUs = Math.max(0, newestTimeUs - durationUs);
    while (ring.head < ring.items.length) {
        const activeLength = ring.items.length - ring.head;
        const sampleTimeUs = Number(ring.items[ring.head]?.timeUs || newestTimeUs);
        if (activeLength <= maxSamples && sampleTimeUs >= oldestTimeUs) break;
        ring.head += 1;
    }
    if (ring.head > 0 && (ring.head > 16 || ring.head * 2 >= ring.items.length)) {
        ring.items = ring.items.slice(ring.head);
        ring.head = 0;
    }
}

function ringValues(ring, { fromUs = 0, toUs = Number.POSITIVE_INFINITY } = {}) {
    if (!ring) return [];
    return ring.items.slice(ring.head)
        .filter((sample) => Number(sample.timeUs || 0) >= fromUs && Number(sample.timeUs || 0) <= toUs)
        .map((sample) => (ArrayBuffer.isView(sample?.value) ? sample : clone(sample)));
}

function boundedBacklog(samples, limit = BACKLOG_SAMPLE_LIMIT) {
    if (samples.length <= limit) return samples;
    const stride = Math.ceil(samples.length / limit);
    const result = [];
    for (let index = 0; index < samples.length; index += stride) result.push(samples[index]);
    if (result.at(-1) !== samples.at(-1)) result.push(samples.at(-1));
    return result.slice(-limit);
}

/** The shared signal store used by simulation, bindings, logging, and analysis. */
export function getTelemetryStore() {
    return getBindingRuntime().signalStore;
}

export function defineSignal(descriptor) {
    return getTelemetryStore().defineSignal(descriptor);
}

export function publishSignal(path, value, options = {}) {
    return getTelemetryStore().publishSignal(path, value, options);
}

export function emitTelemetryEvent(event) {
    return getTelemetryStore().emitTelemetryEvent(event);
}

export function subscribeSignals(options, listener) {
    return getTelemetryStore().subscribeSignals(options, listener);
}

/** Mirrors a local telemetry source to other same-origin tabs. */
export class TelemetryTabBridge {
    constructor(store = getTelemetryStore(), options = {}) {
        this.store = store;
        this.sourceId = store.sourceId;
        this.channelName = options.channelName || CHANNEL_NAME;
        this.channel = null;
        this.listeners = new Set();
        this.remoteSources = new Map();
        this.remoteSeries = new Map();
        this.consumerSubscriptions = new Map();
        this.remoteSubscriptions = new Map();
        this.consumerSequences = new Map();
        this.pendingHeavyUpdates = new Map();
        this.previewSentAt = new Map();
        this.context = { workspace: "unknown", environmentId: null };
        this._unsubscribe = null;
        this._heartbeat = null;
        this._expiry = null;
        this._emitTimer = null;
        this._heavyFlushTimer = null;
    }

    start() {
        if (this.channel || typeof BroadcastChannel === "undefined") return this;
        this.channel = new BroadcastChannel(this.channelName);
        this.channel.addEventListener("message", (event) => this._onMessage(event.data));
        this._unsubscribe = this.store.subscribeSignals(
            { includeEvents: true, includeCatalog: true, includeHeavy: true },
            (message) => this._onLocalMessage(message),
        );
        this._post("announce", this._catalogPayload());
        this._heartbeat = setInterval(() => this._post("heartbeat", this._catalogPayload()), HEARTBEAT_MS);
        this._expiry = setInterval(() => this._expireSources(), HEARTBEAT_MS);
        return this;
    }

    stop() {
        this._post("goodbye", {});
        this._unsubscribe?.();
        this._unsubscribe = null;
        clearInterval(this._heartbeat);
        clearInterval(this._expiry);
        clearTimeout(this._emitTimer);
        clearTimeout(this._heavyFlushTimer);
        this._heartbeat = null;
        this._expiry = null;
        this._emitTimer = null;
        this._heavyFlushTimer = null;
        this.channel?.close();
        this.channel = null;
        this.remoteSources.clear();
        this.remoteSeries.clear();
        this.consumerSubscriptions.clear();
        this.remoteSubscriptions.clear();
        this.consumerSequences.clear();
        this.pendingHeavyUpdates.clear();
    }

    setContext(patch = {}) {
        this.context = { ...this.context, ...patch };
        if (this.channel) this._post("announce", this._catalogPayload());
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSources());
        return () => this.listeners.delete(listener);
    }

    getSources() {
        return [...this.remoteSources.values()]
            .map((source) => clone(source))
            .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    }

    requestSource(sourceId, paths = []) {
        if (!sourceId) return;
        this._post("subscribe", {
            targetSourceId: sourceId,
            paths: [...new Set(paths.filter(Boolean))],
            fromUs: 0,
        });
    }

    getSeries(sourceId, path, range = {}) {
        return ringValues(this.remoteSeries.get(sourceId)?.get(path), range);
    }

    _metadata() {
        const status = this.store.read("simulation.status", { fallback: "idle" }).value;
        const run = this.store.read("simulation.run", { fallback: null }).value;
        const environmentId = this.context.environmentId
            || this.store.read("environment.id", { fallback: null }).value
            || null;
        return {
            workspace: this.context.workspace,
            environmentId,
            simulationStatus: status || "idle",
            manifestId: run?.manifestId || null,
            resolvedHash: run?.resolvedHash || null,
            managed: Boolean(run?.manifestId),
        };
    }

    _catalogPayload({ paths = null } = {}) {
        return {
            descriptors: this.store.descriptors(),
            snapshot: this.store.snapshot({ paths, includeHeavy: false }),
            timeUs: this._sourceTimeUs(),
            metadata: this._metadata(),
        };
    }

    _sourceTimeUs() {
        return this.store.getSimulationTimeUs?.() ?? 0;
    }

    _post(type, payload) {
        this.channel?.postMessage({
            protocol: PROTOCOL_VERSION,
            type,
            sourceId: this.sourceId,
            timeUs: this._sourceTimeUs(),
            ...payload,
        });
    }

    _queueHeavyUpdate(consumerId, message) {
        const key = `${consumerId}\u0000${message.path}`;
        this.pendingHeavyUpdates.set(key, { consumerId, message });
        if (this._heavyFlushTimer) return;
        this._heavyFlushTimer = setTimeout(() => {
            this._heavyFlushTimer = null;
            const pending = [...this.pendingHeavyUpdates.values()];
            this.pendingHeavyUpdates.clear();
            for (const item of pending) {
                const paths = this.consumerSubscriptions.get(item.consumerId);
                if (!paths?.has(item.message.path)) continue;
                const updateSequence = (this.consumerSequences.get(item.consumerId) || 0) + 1;
                this.consumerSequences.set(item.consumerId, updateSequence);
                this._post("update", {
                    targetSourceId: item.consumerId,
                    message: item.message,
                    updateSequence,
                });
            }
        }, 0);
    }

    _onLocalMessage(message) {
        if (!this.channel) return;
        if (message.kind === "catalog") {
            this._post("catalog", { action: message.action || "updated", path: message.path, descriptor: message.descriptor });
            return;
        }

        if (message.kind === "update") {
            const heavy = isHeavyDescriptor(message.descriptor);
            for (const [consumerId, paths] of this.consumerSubscriptions) {
                if (!paths.has(message.path)) continue;
                if (heavy) {
                    this._queueHeavyUpdate(consumerId, message);
                    continue;
                }
                const updateSequence = (this.consumerSequences.get(consumerId) || 0) + 1;
                this.consumerSequences.set(consumerId, updateSequence);
                this._post("update", { targetSourceId: consumerId, message, updateSequence });
            }
            if (heavy) return;
            const now = Date.now();
            if (now - (this.previewSentAt.get(message.path) || 0) < PREVIEW_INTERVAL_MS) return;
            this.previewSentAt.set(message.path, now);
            this._post("preview", { message });
            return;
        }
        this._post(message.kind, { message });
    }

    _replaceConsumerSubscription(consumerId, paths) {
        const previous = this.consumerSubscriptions.get(consumerId) || new Set();
        if (paths.length > 0) this.consumerSubscriptions.set(consumerId, new Set(paths));
        else this.consumerSubscriptions.delete(consumerId);
        this.remoteSubscriptions.clear();
        for (const subscribed of this.consumerSubscriptions.values()) {
            for (const path of subscribed) this.remoteSubscriptions.set(path, (this.remoteSubscriptions.get(path) || 0) + 1);
        }
        for (const key of [...this.pendingHeavyUpdates.keys()]) {
            if (!key.startsWith(`${consumerId}\u0000`)) continue;
            const path = key.slice(consumerId.length + 1);
            if (!paths.includes(path)) this.pendingHeavyUpdates.delete(key);
        }
        for (const path of previous) {
            if (paths.includes(path)) continue;
            if ((this.remoteSubscriptions.get(path) || 0) > 0) continue;
            for (const byPath of this.remoteSeries.values()) byPath.delete(path);
        }
    }

    _subscriptionPayload(paths) {
        const series = {};
        const newest = this._sourceTimeUs();
        const fromUs = Math.max(0, newest - HISTORY_DURATION_US);
        for (const path of paths) {
            const descriptor = this.store.descriptor(path);
            if (isHeavyDescriptor(descriptor)) {
                const latest = this.store.history(path).at(-1);
                series[path] = latest ? [latest] : [];
            } else {
                series[path] = boundedBacklog(this.store.series(path, { fromUs }));
            }
        }
        return {
            ...this._catalogPayload({ paths }),
            series,
        };
    }

    _createRemoteSource(message, now) {
        return {
            sourceId: message.sourceId,
            descriptors: message.descriptors || [],
            snapshot: message.snapshot || {},
            events: [],
            timeUs: message.timeUs || 0,
            metadata: message.metadata || {},
            lastSeenAt: now,
        };
    }

    _onMessage(message) {
        if (!message || message.protocol !== PROTOCOL_VERSION || message.sourceId === this.sourceId) return;
        const now = Date.now();

        if (["announce", "heartbeat"].includes(message.type)) {
            const firstSeen = !this.remoteSources.has(message.sourceId);
            const source = this.remoteSources.get(message.sourceId) || this._createRemoteSource(message, now);
            source.descriptors = message.descriptors || source.descriptors;
            source.snapshot = { ...source.snapshot, ...(message.snapshot || {}) };
            source.timeUs = message.timeUs ?? source.timeUs;
            source.metadata = message.metadata || source.metadata;
            source.lastSeenAt = now;
            this.remoteSources.set(message.sourceId, source);
            if (message.type === "announce" && firstSeen) {
                this._post("snapshot-request", { targetSourceId: message.sourceId });
                this._post("announce", this._catalogPayload());
            }
            this._emitNow();
            return;
        }

        if (message.type === "goodbye") {
            this.remoteSources.delete(message.sourceId);
            this.remoteSeries.delete(message.sourceId);
            this.consumerSubscriptions.delete(message.sourceId);
            this.consumerSequences.delete(message.sourceId);
            this._replaceConsumerSubscription(message.sourceId, []);
            this._emitNow();
            return;
        }

        if (message.type === "snapshot-request" && message.targetSourceId === this.sourceId) {
            this._post("snapshot", { targetSourceId: message.sourceId, ...this._catalogPayload() });
            return;
        }

        if (message.type === "subscribe" && message.targetSourceId === this.sourceId) {
            const paths = [...new Set((message.paths || []).filter(Boolean))];
            this._replaceConsumerSubscription(message.sourceId, paths);
            this.consumerSequences.set(message.sourceId, 0);
            this._post("snapshot", { targetSourceId: message.sourceId, ...this._subscriptionPayload(paths) });
            return;
        }

        if (message.targetSourceId && message.targetSourceId !== this.sourceId) return;
        const source = this.remoteSources.get(message.sourceId) || this._createRemoteSource(message, now);
        source.lastSeenAt = now;

        if (message.type === "snapshot") {
            source.descriptors = message.descriptors || source.descriptors;
            source.snapshot = { ...source.snapshot, ...(message.snapshot || {}) };
            source.timeUs = message.timeUs ?? source.timeUs;
            source.metadata = message.metadata || source.metadata;
            if (message.series) {
                const byPath = this.remoteSeries.get(message.sourceId) || new Map();
                const nextPaths = new Set(Object.keys(message.series));
                for (const path of [...byPath.keys()]) {
                    if (!nextPaths.has(path)) byPath.delete(path);
                }
                for (const [path, samples] of Object.entries(message.series)) {
                    const descriptor = source.descriptors.find((item) => item.path === path);
                    const heavy = isHeavyDescriptor(descriptor);
                    const ring = createRing();
                    const list = heavy ? (samples || []).slice(-1) : (samples || []);
                    for (const sample of list) appendRing(ring, sample, { latestOnly: heavy });
                    byPath.set(path, ring);
                }
                this.remoteSeries.set(message.sourceId, byPath);
            }
        } else if (message.type === "catalog") {
            const path = message.path || message.descriptor?.path;
            if (path) {
                source.descriptors = source.descriptors.filter((item) => item.path !== path);
                if (message.action === "removed") {
                    delete source.snapshot[path];
                    this.remoteSeries.get(message.sourceId)?.delete(path);
                } else if (message.descriptor) source.descriptors.push(message.descriptor);
            }
        } else if (["update", "preview"].includes(message.type) && message.message?.path) {
            source.snapshot[message.message.path] = message.message.entry;
            source.timeUs = message.timeUs ?? source.timeUs;
            if (message.type === "update") {
                const descriptor = message.message.descriptor
                    || source.descriptors.find((item) => item.path === message.message.path);
                const heavy = isHeavyDescriptor(descriptor);
                const byPath = this.remoteSeries.get(message.sourceId) || new Map();
                const ring = byPath.get(message.message.path) || createRing();
                appendRing(ring, message.message.entry, { latestOnly: heavy });
                byPath.set(message.message.path, ring);
                this.remoteSeries.set(message.sourceId, byPath);
                source.lastUpdateSequence = Math.max(source.lastUpdateSequence || 0, Number(message.updateSequence || 0));
            }
        } else if (message.type === "event" && message.message?.event) {
            source.events.push(message.message.event);
            source.events = source.events.slice(-EVENT_LIMIT);
        }
        this.remoteSources.set(message.sourceId, source);
        this._scheduleEmit(message);
    }

    _expireSources() {
        const cutoff = Date.now() - SOURCE_TIMEOUT_MS;
        let changed = false;
        for (const [sourceId, source] of this.remoteSources) {
            if (source.lastSeenAt >= cutoff) continue;
            this.remoteSources.delete(sourceId);
            this.remoteSeries.delete(sourceId);
            changed = true;
        }
        if (changed) this._emitNow();
    }

    _scheduleEmit(message = null) {
        if (this._emitTimer) return;
        this._emitTimer = setTimeout(() => {
            this._emitTimer = null;
            this._emitNow(message);
        }, EMIT_INTERVAL_MS);
    }

    _emitNow(message = null) {
        clearTimeout(this._emitTimer);
        this._emitTimer = null;
        const sources = this.getSources();
        for (const listener of this.listeners) listener(sources, message);
    }

    _emit(message = null) {
        this._emitNow(message);
    }
}

let tabBridge = null;

export function getTelemetryTabBridge() {
    if (!tabBridge) tabBridge = new TelemetryTabBridge();
    return tabBridge.start();
}
