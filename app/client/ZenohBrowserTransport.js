import { normalizeZenohBrowserConfig, ZENOH_BROWSER_LIMITS as LIMITS } from "./ZenohBrowserConfig.js";

export class ZenohBrowserTransport {
    constructor({ workerFactory = () => new Worker(new URL("./zenohBrowserTransport.worker.js", import.meta.url), { type: "module" }), onState = () => {}, limits = LIMITS } = {}) {
        this.workerFactory = workerFactory;
        this.onState = onState;
        this.limits = limits;
        this.worker = null;
        this.connectionGeneration = 0;
        this.lifecycleGeneration = 0;
        this.routeGeneration = 0;
        this.nextRequestId = 0;
        this.requests = new Map();
        this.routes = new Map();
        this.subscriptions = new Map();
        this.queue = [];
        this.inFlight = null;
        this.queuedBytes = 0;
        this.heartbeatTimer = null;
        this.acceptInbound = false;
        this.bindingReady = false;
        this.state = "closed";
        this.lastError = null;
        this.stats = { accepted: 0, sent: 0, rejected: 0, lost: 0, inboundRejected: 0 };
        this.routeDiagnostics = new Map();
    }

    getSnapshot() {
        return { state: this.state, lastError: this.lastError, diagnostics: { ...this.stats, queuedEntries: this.queue.length + (this.inFlight ? 1 : 0), queuedBytes: this.queuedBytes,
            routes: Object.fromEntries(this.routeDiagnostics) } };
    }

    _state(state, error = null) {
        this.state = state;
        this.lastError = error?.message ?? error;
        this.onState(this.getSnapshot());
    }

    async connect({ config, routes = [], generation = 0, onSample = () => {} } = {}) {
        const operation = ++this.lifecycleGeneration;
        const normalized = normalizeZenohBrowserConfig(config);
        if (!Array.isArray(routes) || routes.length > 64 || new Set(routes.map((route) => route.routeId)).size !== routes.length) throw new Error("Zenoh requires at most 64 distinct routes.");
        await this._close();
        if (operation !== this.lifecycleGeneration) throw new Error("Zenoh connection was superseded.");
        this.config = normalized;
        this.routes = new Map(routes.map((route) => [route.routeId, { ...route }]));
        this.subscriptions = new Map(routes.filter((route) => route.direction === "subscribe").map((route) => [route.routeId, { key: route.key, handler: onSample }]));
        this.routeGeneration = generation;
        const connectionGeneration = ++this.connectionGeneration;
        this._state("connecting");
        try {
            this.worker = this.workerFactory();
            const worker = this.worker;
            this.worker.onerror = (event) => { if (this.worker === worker) this._lost(new Error(event.message || "Zenoh worker failed.")); };
            // Bundled workers can finish asynchronous imports after the first message arrives.
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { this.workerBoot = null; reject(new Error("Zenoh worker startup timed out.")); }, this.limits.connectTimeoutMs);
                this.workerBoot = { reject: (error) => { clearTimeout(timer); reject(error); } };
                worker.onmessage = (event) => {
                    if (this.worker !== worker) return;
                    if (event.data?.type === "worker-ready" && this.workerBoot) {
                        clearTimeout(timer);
                        this.workerBoot = null;
                        resolve();
                    } else this._onMessage(event.data);
                };
            });
            if (this.worker !== worker) throw new Error("Zenoh connection was superseded.");
            await this._request("open", { endpoint: normalized.endpoint, routes, routeGeneration: generation }, this.limits.connectTimeoutMs);
            if (connectionGeneration !== this.connectionGeneration || !this.worker) throw new Error("Zenoh connection was superseded.");
            this._state("ready");
            this._scheduleHeartbeat();
            return this.getSnapshot();
        } catch (error) {
            if (connectionGeneration === this.connectionGeneration) this._lost(error);
            throw error;
        }
    }

    stageGeneration(generation) {
        if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid Zenoh route generation.");
        this.acceptInbound = false;
        this.bindingReady = false;
        this.routeGeneration = generation;
        this._dropQueued();
    }

    async bindGeneration(generation) {
        if (generation !== this.routeGeneration) this.stageGeneration(generation);
        await this._request("bind", { routeGeneration: generation });
        if (generation === this.routeGeneration && this.state === "ready") {
            this.acceptInbound = true;
            this.bindingReady = true;
            this._pump();
        }
    }

    publish(packet) {
        const route = this.routes.get(packet?.routeId);
        let code = null;
        if (this.state !== "ready" || !this.worker) code = "transport-unavailable";
        else if (packet.generation !== this.routeGeneration) code = "stale-generation";
        else if (!route || route.direction !== "publish" || route.key !== packet.key || !(packet.bytes instanceof Uint8Array)) code = "publication-invalid";
        else if (packet.bytes.byteLength > this.limits.payloadBytes) code = "payload-too-large";
        else if (this.queue.length + (this.inFlight ? 1 : 0) >= this.config.maxOutboundEntries || this.queuedBytes + packet.bytes.byteLength > this.config.maxOutboundBytes) code = "queue-full";
        if (code) {
            this.stats.rejected++;
            this._diagnostic(packet?.routeId, code);
            return { ok: false, code };
        }
        const bytes = packet.bytes.slice();
        this.queue.push({ ...packet, bytes });
        this.queuedBytes += bytes.byteLength;
        this.stats.accepted++;
        this._pump();
        return { ok: true };
    }

    _pump() {
        if (this.inFlight || !this.bindingReady || this.state !== "ready" || !this.worker || !this.queue.length) return;
        const packet = this.queue.shift();
        const length = packet.bytes.byteLength;
        const generation = this.connectionGeneration;
        this.inFlight = packet;
        this._request("publish", { routeId: packet.routeId, key: packet.key, routeGeneration: packet.generation, bytes: packet.bytes }, this.limits.sendTimeoutMs, [packet.bytes.buffer])
            .then(() => {
                if (generation !== this.connectionGeneration || this.inFlight !== packet) return;
                this.stats.sent++;
                this.queuedBytes -= length;
                this.inFlight = null;
                this._pump();
            }, (error) => { if (generation === this.connectionGeneration) this._lost(error); });
    }

    async subscribe(routeId, key, handler) {
        if (typeof routeId !== "string" || !routeId || typeof key !== "string" || !key || typeof handler !== "function") throw new Error("Zenoh subscription requires a route ID, key and callback.");
        if (this.routes.has(routeId)) throw new Error("Unsubscribe an existing route before declaring it again.");
        const binding = { key, handler };
        this.routes.set(routeId, { routeId, key, direction: "subscribe" });
        this.subscriptions.set(routeId, binding);
        try { await this._request("subscribe", { routeId, key }); }
        catch (error) {
            if (this.subscriptions.get(routeId) === binding) { this.subscriptions.delete(routeId); this.routes.delete(routeId); }
            throw error;
        }
    }

    async unsubscribe(routeId) {
        this.subscriptions.delete(routeId);
        this.routes.delete(routeId);
        if (this.worker) await this._request("unsubscribe", { routeId });
    }

    _request(type, fields = {}, timeoutMs = this.limits.connectTimeoutMs, transfer = []) {
        if (!this.worker) return Promise.reject(new Error("Zenoh worker is unavailable."));
        const requestId = ++this.nextRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.requests.delete(requestId);
                reject(new Error(`Zenoh ${type} timed out.`));
            }, timeoutMs);
            this.requests.set(requestId, { resolve, reject, timer });
            try { this.worker.postMessage({ type, requestId, connectionGeneration: this.connectionGeneration, ...fields }, transfer); }
            catch (error) { clearTimeout(timer); this.requests.delete(requestId); reject(error); }
        });
    }

    _onMessage(message) {
        if (!this.worker || message?.connectionGeneration !== this.connectionGeneration) return;
        if (message.type === "reply") {
            const request = this.requests.get(message.requestId);
            if (!request) return;
            clearTimeout(request.timer);
            this.requests.delete(message.requestId);
            if (message.ok) request.resolve(message);
            else request.reject(new Error(message.error || "Zenoh request failed."));
        } else if (message.type === "sample") {
            try {
                const subscription = this.subscriptions.get(message.routeId);
                if (this.acceptInbound && message.routeGeneration === this.routeGeneration && subscription
                    && message.bytes instanceof Uint8Array && message.bytes.byteLength <= this.limits.payloadBytes) subscription.handler(message);
                else this.stats.inboundRejected++;
            } catch (error) { this.stats.inboundRejected++; this._diagnostic(message.routeId, error.message); }
            finally { this.worker?.postMessage({ type: "sample-ack", sampleId: message.sampleId, connectionGeneration: this.connectionGeneration }); }
        } else if (message.type === "inbound-rejected") { this.stats.inboundRejected++; this._diagnostic(message.routeId, message.code); }
    }

    _diagnostic(routeId, code) {
        if (!this.routes.has(routeId)) return;
        const previous = this.routeDiagnostics.get(routeId);
        this.routeDiagnostics.set(routeId, { code, count: (previous?.count ?? 0) + 1 });
        if (previous?.code !== code) this.onState(this.getSnapshot());
    }

    _scheduleHeartbeat() {
        clearTimeout(this.heartbeatTimer);
        const generation = this.connectionGeneration;
        this.heartbeatTimer = setTimeout(async () => {
            try { await this._request("heartbeat", {}, this.limits.heartbeatTimeoutMs); }
            catch (error) { if (generation === this.connectionGeneration) this._lost(error); return; }
            if (generation === this.connectionGeneration && this.state === "ready") { this.onState(this.getSnapshot()); this._scheduleHeartbeat(); }
        }, this.limits.heartbeatIntervalMs);
    }

    _dropQueued() {
        this.stats.lost += this.queue.length;
        this.queuedBytes -= this.queue.reduce((sum, packet) => sum + packet.bytes.byteLength, 0);
        this.queue = [];
    }

    _terminate(error) {
        this.workerBoot?.reject(error);
        this.workerBoot = null;
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.acceptInbound = false;
        this.bindingReady = false;
        this.worker?.terminate();
        this.worker = null;
        this.connectionGeneration++;
        this.stats.lost += this.queue.length + (this.inFlight ? 1 : 0);
        this.queue = [];
        this.inFlight = null;
        this.queuedBytes = 0;
        for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
        this.requests.clear();
    }

    _lost(error) {
        if (this.state === "closed" || (!this.worker && this.state !== "connecting")) return;
        this._terminate(error);
        this._state("reconnecting", error);
    }

    async close() {
        this.lifecycleGeneration++;
        return this._close();
    }

    async _close() {
        const worker = this.worker;
        this.acceptInbound = false;
        this._state("closed");
        this._dropQueued();
        clearTimeout(this.heartbeatTimer);
        try { if (worker) await this._request("close", {}, this.limits.closeTimeoutMs); }
        catch { /* Worker termination also closes sockets if SDK cleanup stalls. */ }
        if (this.worker === worker) {
            this._terminate(new Error("Zenoh transport closed."));
            this.routes.clear();
            this.subscriptions.clear();
        }
    }
}
