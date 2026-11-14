import { HeadlessRunnerError } from "../headless/HeadlessRunnerErrors.js";
import { resolveZenohTransportHostConfig, ZENOH_VERSION } from "./ZenohTransportConfig.js";
import { PROTOBUF_LIMITS } from "../../app/interfaces/ProtobufSchema.js";

export class ZenohNativeTransport {
    constructor({ config, admission = null, nativeBinding = null, onEvent = null } = {}) {
        this.config = resolveZenohTransportHostConfig(config);
        if (!this.config) throw new HeadlessRunnerError("INVALID_REQUEST", "Zenoh requires an explicit host configuration.");
        this.admission = admission;
        if (admission) this.config = { ...this.config, queue: { ...this.config.queue, maxBytes: admission.maxQueueBytes } };
        this.nativeBinding = nativeBinding;
        this.onEvent = onEvent;
        this.session = null;
        this.state = "created";
        this.generation = 0;
        this.subscriptions = new Map();
        this.callbacks = new Map();
        this.lastFailure = null;
        this.artifact = null;
    }

    async openSession() {
        if (this.state !== "created") throw new HeadlessRunnerError("INVALID_REQUEST", "Zenoh transport has already opened or closed.");
        this.state = "opening";
        try {
            const loaded = this.nativeBinding ? { binding: this.nativeBinding, artifact: null }
                : await import("../../native/zenoh-transport/index.js").then((module) => module.loadNativeBinding());
            if (this.state !== "opening") throw new Error("Transport closed while loading native artifact.");
            this.artifact = loaded.artifact;
            this.session = loaded.binding.createSession(JSON.stringify(this.config), () => this._drain());
            await this.session.openSession();
            if (this.state !== "opening") throw new Error("Transport closed while connecting.");
            const status = JSON.parse(this.session.diagnostics());
            if (!status.available || status.zenohVersion !== ZENOH_VERSION || (this.config.shm.mode === "required"
                && (!status.shmProviderAvailable || !status.transports.length || status.transports.some((entry) => !entry.shm)))) throw new Error("Required pinned Zenoh capability is unavailable.");
            this.state = "open";
            return this.diagnostics();
        } catch (error) {
            await this.session?.close().catch(() => {});
            if (this.state !== "closed") this.state = "failed";
            throw new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", `Native Zenoh preflight failed: ${error.message}`);
        }
    }

    _failure(code, routeId = null) {
        if (this.lastFailure) return;
        this.lastFailure = { code: String(code).slice(0, 1024), routeId };
        this.state = "failed";
        try { this.onEvent?.({ kind: "transport-failed", ...this.lastFailure, generation: this.generation }); } catch { /* Diagnostics retain the failure if a reporting callback throws. */ }
    }

    _route(routeId, direction) {
        const route = this.admission?.routesById.get(routeId);
        if (this.admission && (!route || route.direction !== direction)) throw new Error("Unknown or wrong-direction admitted Zenoh route.");
        return route;
    }

    publish(packet) {
        if (this.state !== "open") return { ok: false, accepted: false, code: "not-open", fatal: this.state === "failed" };
        let required = packet?.required === true;
        try {
            const route = this._route(packet?.routeId, "publish");
            required = route ? route.required : required;
            if (!packet || !(packet.bytes instanceof Uint8Array) || packet.bytes.byteLength > PROTOBUF_LIMITS.payloadBytes
                || typeof packet.routeId !== "string" || packet.routeId.length > 128 || typeof packet.key !== "string"
                || packet.key.length > 1024 || packet.key.includes("*") || packet.key.includes("{")
                || (route && packet.key !== route.key)) throw new Error("Invalid admitted publication packet.");
            if (packet.generation !== this.generation) return { ok: false, accepted: false, code: "stale-generation", fatal: false };
            const result = this.session.publish(packet.key, packet.bytes, packet.routeId, this.generation, required);
            if (result.fatal) this._failure(result.code, packet.routeId);
            return result;
        } catch (error) {
            if (required) this._failure(error.message, packet?.routeId);
            return { ok: false, accepted: false, code: "invalid-publication", fatal: required };
        }
    }

    async subscribe(routeId, callback, { key = null, required = false } = {}) {
        if (this.state !== "open" || typeof callback !== "function" || this.callbacks.has(routeId)) throw new HeadlessRunnerError("INVALID_REQUEST", "Subscription requires an open session and an unbound callback.");
        const route = this._route(routeId, "subscribe");
        key = route?.key ?? key;
        required = route?.required ?? required;
        if (typeof key !== "string" || key.includes("*") || key.includes("{") || key.length > 1024) throw new HeadlessRunnerError("INVALID_REQUEST", "Subscription requires an exact key.");
        const generation = this.generation;
        const registration = { callback, generation, required };
        this.callbacks.set(routeId, registration);
        try {
            const id = await this.session.subscribe(key, routeId, generation, required);
            if (this.state !== "open" || generation !== this.generation || this.callbacks.get(routeId) !== registration) {
                await this.session.unsubscribe(id);
                throw new Error("Subscription canceled during declaration.");
            }
            this.subscriptions.set(id, routeId);
            return id;
        } catch (error) {
            if (this.callbacks.get(routeId) === registration) this.callbacks.delete(routeId);
            if (required && this.state === "open" && generation === this.generation) this._failure(error.message, routeId);
            throw error;
        }
    }

    async unsubscribe(id) {
        const routeId = this.subscriptions.get(id);
        this.callbacks.delete(routeId);
        this.subscriptions.delete(id);
        await this.session?.unsubscribe(id);
    }

    _drain() {
        if (!this.session) return;
        for (const packet of this.session.drainInbound()) {
            const entry = this.callbacks.get(packet.routeId);
            if (this.state !== "open" || !entry || entry.generation !== this.generation || packet.generation !== this.generation) continue;
            try {
                const result = entry.callback(packet.bytes, { generation: packet.generation, routeId: packet.routeId });
                if (result?.then) {
                    Promise.resolve(result).catch(() => {});
                    throw new Error("Zenoh inbound callbacks must return synchronously.");
                }
            } catch (error) { if (entry.required) this._failure(error.message, packet.routeId); }
        }
        const status = JSON.parse(this.session.diagnostics());
        if (status.state === "failed") this._failure(status.lastError?.code ?? "native-failure", status.lastError?.routeId);
    }

    async reset(generation) {
        if (this.state !== "open" || !Number.isInteger(generation) || generation <= this.generation || generation > 0xffffffff) throw new HeadlessRunnerError("INVALID_REQUEST", "Reset requires an open session and a newer uint32 generation.");
        this.state = "resetting";
        this.generation = generation;
        this.callbacks.clear(); this.subscriptions.clear();
        try {
            await this.session.reset(generation);
            if (this.state !== "resetting") throw new Error("Reset canceled while closing or failing.");
            this.state = "open";
        } catch (error) { if (this.state === "resetting") this._failure(error.message); throw error; }
    }

    diagnostics() {
        const native = this.session ? JSON.parse(this.session.diagnostics()) : { available: false, zenohVersion: ZENOH_VERSION };
        return { ...native, state: this.state, generation: this.generation, lastError: this.lastFailure ?? native.lastError,
            artifact: this.artifact, requiredShmScope: "direct-connections" };
    }

    async close() {
        if (this.closePromise) return this.closePromise;
        this.state = "closing";
        this.callbacks.clear(); this.subscriptions.clear();
        this.closePromise = (async () => { try { await this.session?.close(); } finally { this.state = "closed"; } })();
        return this.closePromise;
    }
}

export async function probeZenohNativeTransport(config) {
    const transport = new ZenohNativeTransport({ config });
    try { return await transport.openSession(); }
    catch (error) { return { available: false, reason: error.message, requiredShmScope: "direct-connections" }; }
    finally { await transport.close().catch(() => {}); }
}
