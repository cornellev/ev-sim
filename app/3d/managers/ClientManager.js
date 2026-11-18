import { ZenohBrowserTransport } from "../../client/ZenohBrowserTransport.js";
import { assertProtobufExecutionCapabilities, bindProtobufRunKeys, planProtobufRouteAdmission } from "../../interfaces/ProtobufRunBinding.js";
import { abortable } from "../../simulation/AsyncCancellation.js";

export class ClientManager {
    constructor(data, { transportFactory = (options) => new ZenohBrowserTransport(options), fetchImpl = (...args) => fetch(...args) } = {}) {
        this.data = data;

        this._disposed = false;

        this._nativeRun = null;
        this._routeRuntime = null;
        this.transport = null;
        this.transportFactory = transportFactory;
        this.fetchImpl = fetchImpl;
        this.transportListeners = new Set();
        this.transportSnapshot = { state: "disabled", lastError: null, diagnostics: {} };


        if (typeof window !== "undefined") window.clientHandler = this; // for debugging
    }

    async setup(resolved = null, { runId = resolved?.manifest?.id } = {}) {
        if (this._disposed) throw new Error("Client manager is disposed.");
        if (resolved?.version !== 13) throw new Error("Browser execution requires run manifest v13; use reviewed native adoption.");
        if (resolved.manifest.protobuf.mode !== "zenoh") { await this.closeRun(); return; }
        assertProtobufExecutionCapabilities(resolved, { target: "browser", transport: "zenoh-browser" });
        const keys = bindProtobufRunKeys(resolved.protobufInterface, runId);
        const run = this._nativeRun = { resolved, runId, routes: resolved.protobufInterface.document.routes.map((route) => ({ routeId: route.id, key: keys.get(route.id), direction: route.direction })) };
        const response = await this.fetchImpl("/api/zenoh/browser-config", { headers: { Accept: "application/json" }, cache: "no-store" });
        const config = await response.json();
        if (this._nativeRun !== run || this._disposed) throw new Error("Native preparation was superseded.");
        if (!response.ok || !config) throw new Error(config?.error || "Browser Zenoh is unavailable: configure CEV_SIM_ZENOH_BROWSER_CONFIG.");
        run.config = config;
        this.transport ??= this.transportFactory({ onState: (snapshot) => this._transportState(snapshot) });
        return this._connectNative();
    }

    async _connectNative() {
        const run = this._nativeRun;
        if (!run || this._disposed) throw new Error("Native run was closed.");
        const generation = this._routeRuntime?.generation ?? 0;
        return this.transport.connect({ config: run.config, routes: run.routes, generation, onSample: (sample) => {
            const runtime = this._routeRuntime;
            const clock = this.data.simulation?.();
            if (!runtime || this._nativeRun !== run || !clock) return;
            const accepted = runtime.acceptInbound(sample.routeId, sample.bytes, { generation: sample.routeGeneration, clock: { step: clock.steps, timeNs: clock.timeNs } });
            if (!accepted.ok) this.data.bindings?.()?.signalStore?.emitTelemetryEvent?.({ category: "transport", name: "zenoh-inbound-rejected", severity: "warning", payload: { routeId: sample.routeId, code: accepted.code } });
        } });
    }

    stageGeneration(generation) { this.transport?.stageGeneration(generation); }
    publishProtobuf(packet) { return this.transport?.publish(packet) ?? { ok: false, code: "transport-unavailable" }; }

    async activateRoutes(runtime = this.data.simulation?.()?.protobufRoutes) {
        if (!this._nativeRun) return;
        this._routeRuntime = runtime;
        if (!runtime || runtime.disposed || runtime.runId !== this._nativeRun.runId) throw new Error("Native route runtime does not match the prepared run.");
        await this.transport.bindGeneration(runtime.generation);
    }

    async reconnect() {
        await this._connectNative();
        await this.activateRoutes();
        return this.transport.getSnapshot();
    }

    subscribeTransport(listener) {
        this.transportListeners.add(listener);
        listener(this.transportSnapshot);
        return () => this.transportListeners.delete(listener);
    }

    _transportState(snapshot) {
        this.transportSnapshot = snapshot;
        for (const listener of this.transportListeners) listener(snapshot);
    }

    async closeRun({ runId = null, signal = null } = {}) {
        if (runId && this._nativeRun?.runId !== runId) return;
        const transport = this.transport;
        this._nativeRun = null;
        this._routeRuntime?.invalidateBindings();
        this._routeRuntime = null;
        await abortable(transport?.close(), signal);
        if (this.transport === transport && !this._nativeRun) {
            this._transportState({ state: "disabled", lastError: null, diagnostics: {} });
        }
    }

    async preflight(resolved, { runId = resolved?.manifest?.id } = {}) {
        const issues = [];
        const manifest = resolved?.manifest;
        if (!manifest) {
            return { ok: false, issues: [{ path: "manifest", message: "Resolved run manifest is required." }] };
        }

        if (resolved.version !== 13) return { ok: false, issues: [{ path: "manifest.version", message: "Browser execution requires run manifest v13; use reviewed native adoption." }] };
        try {
            const admitted = planProtobufRouteAdmission({ manifest, interfaceResource: resolved.protobufInterface, resolvedRun: resolved });
            if (manifest.protobuf.mode === "zenoh") {
                const subscribed = new Set(admitted.routes.filter((entry) => entry.route.direction === "subscribe").map((entry) => entry.route.target.topicId));
                for (const [index, topic] of manifest.topics.entries()) if (topic.direction === "input" && topic.required && ["candidate", "reference"].includes(topic.producer) && !subscribed.has(topic.id)) {
                    issues.push({ path: `topics.${index}`, message: `Required external input "${topic.id}" has no subscription route.` });
                }
            }
            if (!issues.length) await this.setup(resolved, { runId });
        } catch (error) { issues.push({ path: error.path ?? "protobuf.transport", message: error.message }); }
        return { ok: !issues.length, issues };
    }

    async dispose() {
        this._disposed = true;
        await this.closeRun();
        this.transportListeners.clear();
    }
}
