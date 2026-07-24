import { getBindingRuntime } from "../scripting/bindings/BindingRuntime.js";

const CHANNEL_NAME = "sensor-fusion-telemetry-v1";
const HEARTBEAT_MS = 2000;
const SOURCE_TIMEOUT_MS = 6500;

function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
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

/**
 * Mirrors a local telemetry source to other same-origin tabs. The transport is
 * deliberately a small protocol adapter; SignalStore remains authoritative.
 */
export class TelemetryTabBridge {
    constructor(store = getTelemetryStore(), options = {}) {
        this.store = store;
        this.sourceId = store.sourceId;
        this.channelName = options.channelName || CHANNEL_NAME;
        this.channel = null;
        this.listeners = new Set();
        this.remoteSources = new Map();
        this.remoteSubscriptions = new Map();
        this.previewSentAt = new Map();
        this.updateSequence = 0;
        this._unsubscribe = null;
        this._heartbeat = null;
        this._expiry = null;
    }

    start() {
        if (this.channel || typeof BroadcastChannel === "undefined") return this;
        this.channel = new BroadcastChannel(this.channelName);
        this.channel.addEventListener("message", (event) => this._onMessage(event.data));
        this._unsubscribe = this.store.subscribeSignals(
            { includeEvents: true, includeCatalog: true },
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
        this._heartbeat = null;
        this._expiry = null;
        this.channel?.close();
        this.channel = null;
        this.remoteSources.clear();
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
        this._post("subscribe", { targetSourceId: sourceId, paths });
    }

    _catalogPayload() {
        return {
            sourceId: this.sourceId,
            descriptors: this.store.descriptors(),
            snapshot: this.store.snapshot(),
            timeUs: this.store.getTimeUs(),
        };
    }

    _post(type, payload) {
        this.channel?.postMessage({ protocol: 1, type, sourceId: this.sourceId, ...payload });
    }

    _onLocalMessage(message) {
        if (!this.channel) return;
        if (message.kind === "catalog") {
            this._post("catalog", { action: message.action || "updated", path: message.path, descriptor: message.descriptor });
            return;
        }

        if (message.kind === "update") {
            const requested = this.remoteSubscriptions.get(message.path);
            if (requested) {
                this._post("update", { message, updateSequence: ++this.updateSequence });
                return;
            }
            if (message.descriptor?.logClass === "heavy") return;
            const now = Date.now();
            if (now - (this.previewSentAt.get(message.path) || 0) < 500) return;
            this.previewSentAt.set(message.path, now);
            this._post("preview", { message, updateSequence: ++this.updateSequence });
            return;
        }
        this._post(message.kind, { message });
    }

    _onMessage(message) {
        if (!message || message.protocol !== 1 || message.sourceId === this.sourceId) return;
        const now = Date.now();

        if (["announce", "heartbeat"].includes(message.type)) {
            const firstSeen = !this.remoteSources.has(message.sourceId);
            this.remoteSources.set(message.sourceId, {
                sourceId: message.sourceId,
                descriptors: message.descriptors || [],
                snapshot: message.snapshot || {},
                timeUs: message.timeUs || 0,
                lastSeenAt: now,
            });
            if (message.type === "announce" && firstSeen) {
                this._post("snapshot-request", { targetSourceId: message.sourceId });
                this._post("announce", this._catalogPayload());
            }
            this._emit();
            return;
        }

        if (message.type === "goodbye") {
            this.remoteSources.delete(message.sourceId);
            this._emit();
            return;
        }

        if (message.type === "snapshot-request" && message.targetSourceId === this.sourceId) {
            this._post("snapshot", { targetSourceId: message.sourceId, ...this._catalogPayload() });
            return;
        }

        if (message.type === "subscribe" && message.targetSourceId === this.sourceId) {
            for (const path of message.paths || []) {
                this.remoteSubscriptions.set(path, (this.remoteSubscriptions.get(path) || 0) + 1);
            }
            this._post("snapshot", { targetSourceId: message.sourceId, ...this._catalogPayload() });
            return;
        }

        if (message.targetSourceId && message.targetSourceId !== this.sourceId) return;
        const source = this.remoteSources.get(message.sourceId) || {
            sourceId: message.sourceId,
            descriptors: [],
            snapshot: {},
            timeUs: 0,
            lastSeenAt: now,
        };
        source.lastSeenAt = now;

        if (message.type === "snapshot") {
            source.descriptors = message.descriptors || source.descriptors;
            source.snapshot = message.snapshot || source.snapshot;
            source.timeUs = message.timeUs || source.timeUs;
        } else if (message.type === "catalog") {
            const path = message.path || message.descriptor?.path;
            if (path) {
                source.descriptors = source.descriptors.filter((item) => item.path !== path);
                if (message.action === "removed") delete source.snapshot[path];
                else if (message.descriptor) source.descriptors.push(message.descriptor);
            }
        } else if (["update", "preview"].includes(message.type) && message.message?.path) {
            const sequence = Number(message.updateSequence || 0);
            if (source.lastUpdateSequence && sequence > source.lastUpdateSequence + 1) {
                this._post("snapshot-request", { targetSourceId: message.sourceId });
            }
            source.snapshot[message.message.path] = message.message.entry;
            source.timeUs = message.message.timeUs || source.timeUs;
            source.lastUpdateSequence = Math.max(source.lastUpdateSequence || 0, sequence);
        } else if (message.type === "event") {
            source.lastEvent = message.message?.event || null;
        }
        this.remoteSources.set(message.sourceId, source);
        this._emit(message);
    }

    _expireSources() {
        const cutoff = Date.now() - SOURCE_TIMEOUT_MS;
        let changed = false;
        for (const [sourceId, source] of this.remoteSources) {
            if (source.lastSeenAt >= cutoff) continue;
            this.remoteSources.delete(sourceId);
            changed = true;
        }
        if (changed) this._emit();
    }

    _emit(message = null) {
        const sources = this.getSources();
        for (const listener of this.listeners) listener(sources, message);
    }
}

let tabBridge = null;

export function getTelemetryTabBridge() {
    if (!tabBridge) tabBridge = new TelemetryTabBridge().start();
    return tabBridge;
}
