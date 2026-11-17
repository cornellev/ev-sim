import { ZenohBrowserTransport } from "../../client/ZenohBrowserTransport.js";
import { normalizeZenohBrowserConfig } from "../../client/ZenohBrowserConfig.js";
import { PROTOBUF_INTERFACE_LIMITS } from "../../interfaces/ProtobufInterface.js";
import { assertProtobufName, base64ToBytes, decodeMessage, loadDescriptorSet, PROTOBUF_LIMITS } from "../../interfaces/ProtobufSchema.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const metadataKeys = ["runId", "captureTimeNs", "sequenceId", "frameId"];

function ownValue(value, budget = { nodes: PROTOBUF_LIMITS.valueNodes, bytes: 0 }, depth = 0) {
    if (depth > PROTOBUF_LIMITS.depth || --budget.nodes < 0) throw new Error("Display projection is too complex.");
    const claim = (bytes) => { if ((budget.bytes += bytes) > PROTOBUF_LIMITS.payloadBytes) throw new Error("Display projection is too large."); };
    if (value == null || typeof value === "boolean" || typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") { claim(new TextEncoder().encode(value).length); return value; }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        claim(value.byteLength);
        if (value instanceof Float32Array || value instanceof Float64Array) {
            if (value.some((entry) => !Number.isFinite(entry))) throw new Error("Display projection must contain finite values.");
        }
        return value instanceof Uint8Array ? new Uint8Array(value) : value.slice();
    }
    if (Array.isArray(value)) {
        if (value.length > budget.nodes || Object.keys(value).length !== value.length) throw new Error("Display projection requires bounded dense arrays.");
        return value.map((entry) => ownValue(entry, budget, depth + 1));
    }
    if (value && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
            if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Display projection contains an unsafe key.");
            claim(new TextEncoder().encode(key).length);
            return [key, ownValue(entry, budget, depth + 1)];
        }));
    }
    throw new TypeError("Display projection must contain plain data and finite values.");
}

/**
 * schemas: [{ id, descriptorBase64, fingerprint }] from existing Protobuf schema resources.
 * bindings: { id, kind: "zenoh", key, schemaId, messageType, project, eventType?: "data" | "pose" }.
 * project(message, metadata) returns plain display inputs or a pose in internal scene coordinates.
 * This source owns a separate read-only transport; it never admits simulation inputs.
 */
export class ZenohVisualizationSource {
    constructor({ schemas = [], fetchImpl = (...args) => fetch(...args), transportFactory = (options) => new ZenohBrowserTransport(options),
        setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
        this.schemas = schemas;
        this.fetchImpl = fetchImpl;
        this.transportFactory = transportFactory;
        this.setTimeoutImpl = setTimeoutImpl;
        this.clearTimeoutImpl = clearTimeoutImpl;
        this.loaded = new Map();
        this.routes = new Map();
        this.subscriptions = new Set();
        this.nextRouteId = 0;
        this.generation = 0;
        this.transport = null;
        this.config = null;
        this.retry = null;
        this.attempt = 0;
        this.disposed = false;
    }

    _binding(binding) {
        if (!binding || typeof binding.id !== "string" || !ID.test(binding.id) || binding.kind !== "zenoh" || typeof binding.schemaId !== "string" || !ID.test(binding.schemaId)
            || typeof binding.key !== "string" || !binding.key || binding.key.length > 1024
            || /[\s*?#{}\\]/.test(binding.key) || binding.key.split("/").some((part) => !part || part === "." || part === "..")
            || typeof binding.messageType !== "string" || !binding.messageType || binding.messageType.length > 1024
            || typeof binding.project !== "function" || !["data", "pose"].includes(binding.eventType ?? "data")) {
            throw new TypeError("Zenoh visualization bindings require an id, exact key, schemaId, messageType, and function projection.");
        }
        binding.messageType.split(".").forEach((part) => assertProtobufName(part));
        if (!Array.isArray(this.schemas) || this.schemas.length > PROTOBUF_INTERFACE_LIMITS.schemas) throw new Error("Visualization schemas require at most 16 resources.");
        for (const id of this.loaded.keys()) if (!this.schemas.some((resource) => resource?.id === id)) this.loaded.delete(id);
        const resources = this.schemas.filter((entry) => entry?.id === binding.schemaId);
        const resource = resources[0];
        if (resources.length !== 1 || typeof resource.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(resource.fingerprint)) throw new Error("Visualization schema requires a unique resource and SHA-256 fingerprint.");
        let schema = this.loaded.get(resource.id);
        if (!schema || schema.descriptorBase64 !== resource.descriptorBase64 || schema.fingerprint !== resource.fingerprint) {
            schema = { ...loadDescriptorSet(base64ToBytes(resource.descriptorBase64), resource.fingerprint), types: new Map() };
            this.loaded.set(resource.id, schema);
        }
        let type = schema.types.get(binding.messageType);
        if (!type) { type = schema.root.lookupType(binding.messageType); schema.types.set(binding.messageType, type); }
        return { binding: { ...binding }, type, decoderId: `${schema.fingerprint}:${type.fullName}`, pending: null };
    }

    subscribe(bindings, onEvent) {
        if (this.disposed) return () => {};
        if (!Array.isArray(bindings) || typeof onEvent !== "function" || new Set(bindings.map((entry) => entry?.id)).size !== bindings.length) throw new TypeError("Invalid Zenoh visualization subscription.");
        // Complete synchronous admission before touching working routes or consumers.
        const consumers = bindings.map((binding) => this._binding(binding));
        if (new Set([...this.routes.keys(), ...consumers.map((entry) => entry.binding.key)]).size > PROTOBUF_INTERFACE_LIMITS.routes) throw new Error("Visualization requires at most 64 Zenoh routes.");
        const subscription = { consumers, onEvent, active: true };
        let changed = false;
        for (const consumer of consumers) {
            const key = consumer.binding.key;
            if (!this.routes.has(key)) {
                this.routes.set(key, { routeId: `display-${++this.nextRouteId}`, key, consumers: new Set(), revision: 0 });
                changed = true;
            }
            consumer.subscription = subscription;
            this.routes.get(key).consumers.add(consumer);
        }
        this.subscriptions.add(subscription);
        if (changed) this._restart();
        return () => {
            if (!subscription.active) return;
            subscription.active = false;
            this.subscriptions.delete(subscription);
            let changed = false;
            for (const consumer of consumers) {
                consumer.pending = null;
                consumer.error = null;
                const route = this.routes.get(consumer.binding.key);
                route?.consumers.delete(consumer);
                if (route && !route.consumers.size) { this.routes.delete(route.key); changed = true; }
            }
            if (changed) this._restart();
        };
    }

    _emit(consumer, event) {
        if (!consumer.subscription.active || this.disposed) return;
        try { consumer.subscription.onEvent(event); } catch { /* Display listeners cannot affect the managed run. */ }
    }

    _status(message) {
        for (const route of this.routes.values()) for (const consumer of route.consumers) {
            this._emit(consumer, { type: "status", bindingId: consumer.binding.id, status: "error", message });
        }
    }

    _sample(sample, generation) {
        if (generation !== this.generation || this.disposed) return;
        const route = [...this.routes.values()].find((entry) => entry.routeId === sample.routeId);
        if (!route || sample.routeGeneration !== generation) return;
        const decoded = new Map();
        const revision = ++route.revision;
        for (const consumer of route.consumers) {
            try {
                if (!decoded.has(consumer.decoderId)) {
                    try { decoded.set(consumer.decoderId, { value: decodeMessage(consumer.type, sample.bytes) }); }
                    catch (error) { decoded.set(consumer.decoderId, { error }); }
                }
                const result = decoded.get(consumer.decoderId);
                if (result.error) throw result.error;
                const metadata = {};
                for (const key of metadataKeys) {
                    const field = sample.metadata?.[key] ?? sample[key] ?? result.value.metadata?.[key] ?? result.value[key];
                    if (field != null) metadata[key] = field;
                }
                const projected = consumer.binding.project(result.value, metadata);
                if (!projected || ![Object.prototype, null].includes(Object.getPrototypeOf(projected)) || Array.isArray(projected)) throw new TypeError("Display projection must return a plain object.");
                const value = ownValue(projected);
                const type = consumer.binding.eventType ?? "data";
                consumer.pending = { type, bindingId: consumer.binding.id, [type === "pose" ? "pose" : "inputs"]: value, revision, metadata: { ...metadata } };
                consumer.error = null;
            } catch (error) {
                consumer.error = { type: "status", bindingId: consumer.binding.id, status: "error", message: error?.message || String(error) };
            }
            if (consumer.flush) continue;
            const flush = consumer.flush = {};
            queueMicrotask(() => {
                if (consumer.flush !== flush) return;
                consumer.flush = null;
                const event = consumer.pending;
                const error = consumer.error;
                consumer.pending = null;
                consumer.error = null;
                if (generation !== this.generation) return;
                if (event) this._emit(consumer, event);
                if (error) this._emit(consumer, error);
            });
        }
    }

    _close() {
        this.generation++;
        this.abort?.abort();
        this.abort = null;
        if (this.retry !== null) this.clearTimeoutImpl(this.retry);
        this.retry = null;
        const transport = this.transport;
        this.transport = null;
        for (const route of this.routes.values()) for (const consumer of route.consumers) { consumer.pending = null; consumer.error = null; consumer.flush = null; }
        try { Promise.resolve(transport?.close()).catch(() => {}); } catch { /* Source cancellation is immediate even if transport cleanup fails. */ }
    }

    _restart() {
        this._close();
        this.attempt = 0;
        if (this.routes.size && !this.disposed) void this._connect(this.generation);
    }

    async _connect(generation) {
        let connecting = true;
        const current = () => generation === this.generation && this.routes.size && !this.disposed;
        try {
            if (!this.config) {
                const abort = this.abort = new AbortController();
                const response = await this.fetchImpl("/api/zenoh/browser-config", { headers: { Accept: "application/json" }, cache: "no-store", signal: abort.signal });
                const config = await response.json();
                if (!current()) return;
                if (!response.ok || !config) throw Object.assign(new Error(config?.error || "Browser Zenoh configuration is unavailable."), { code: "ZENOH_CONFIG_INVALID" });
                this.config = normalizeZenohBrowserConfig(config);
                this.abort = null;
            }
            if (!current()) return;
            let transport;
            transport = this.transport = this.transportFactory({ onState: (snapshot) => {
                if (!current() || this.transport !== transport || snapshot.state !== "reconnecting") return;
                this._status(snapshot.lastError || "Visualization Zenoh connection was lost.");
                if (!connecting) { this._close(); this._retry(this.generation); }
            } });
            await transport.connect({ config: this.config, generation,
                routes: [...this.routes.values()].map(({ routeId, key }) => ({ routeId, key, direction: "subscribe" })),
                onSample: (sample) => this._sample(sample, generation) });
            if (!current()) return;
            await transport.bindGeneration(generation);
            if (current()) this.attempt = 0;
        } catch (error) {
            if (current()) {
                this._status(error?.message || String(error));
                this._close();
                if (error?.code !== "ZENOH_CONFIG_INVALID") this._retry(this.generation);
            }
        } finally { connecting = false; }
    }

    _retry(generation) {
        if (this.retry !== null || generation !== this.generation || this.disposed || !this.routes.size) return;
        const delay = [500, 1000, 2000, 4000, 5000][Math.min(this.attempt++, 4)];
        this.retry = this.setTimeoutImpl(() => {
            this.retry = null;
            if (generation !== this.generation || this.disposed || !this.routes.size) return;
            this._close();
            void this._connect(this.generation);
        }, delay);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._close();
        for (const subscription of this.subscriptions) subscription.active = false;
        this.subscriptions.clear();
        this.routes.clear();
        this.loaded.clear();
    }
}
