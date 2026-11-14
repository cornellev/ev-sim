import { setTimeout as delay } from "node:timers/promises";
import { ProtobufRouteRuntime } from "../../app/interfaces/ProtobufRouteRuntime.js";
import { assertProtobufExecutionCapabilities } from "../../app/interfaces/ProtobufRunBinding.js";
import { ZenohNativeTransport } from "../sensor-transports/ZenohNativeTransport.js";
import { validateZenohTransportAdmission } from "../sensor-transports/ZenohTransportConfig.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { SUPERVISOR_PRESETS } from "./SupervisorConfig.js";

/** One environment's native session; no forwarding queue or simulator ownership. */
export class HeadlessZenohRuntime {
    constructor({ config, limits = null, transportFactory = (options) => new ZenohNativeTransport(options), queueBytes = () => 0 } = {}) {
        this.config = config;
        this.limits = { ...SUPERVISOR_PRESETS.safety.limits, ...limits };
        this.transportFactory = transportFactory;
        this.queueBytes = queueBytes;
        this.routes = new ProtobufRouteRuntime();
        this.active = false;
        this.failure = null;
        this.transport = null;
        this.subscriptions = new Map();
    }

    async prepare(resolvedRun, { episodeIdentity = {}, runId = resolvedRun.manifest.id } = {}) {
        assertProtobufExecutionCapabilities(resolvedRun, { target: "headless", transport: "zenoh-native" });
        this.admission = validateZenohTransportAdmission({ resolvedRun, episodeSpec: episodeIdentity, resourceLimits: this.limits, runId, config: this.config });
        this.transport = this.transportFactory({ config: this.config, admission: this.admission, onEvent: (event) => this._fail(event) });
        try {
            const capabilities = await this.transport.openSession();
            validateZenohTransportAdmission({ resolvedRun, episodeSpec: episodeIdentity, resourceLimits: this.limits, runId, config: this.config, capabilities });
        } catch (error) { await this.close(); throw error; }
    }

    runtimeOptions() {
        return {
            protobufTransport: "zenoh-native",
            protobufRoutes: this.routes,
            protobufPublicationPort: (packet) => this.publish(packet),
            publicationPort: (envelope) => this.publishTopic(envelope),
            onProtobufGeneration: () => { this.active = false; },
        };
    }

    async activate(kernel) {
        this.assertHealthy();
        const generation = this.routes.generation;
        if (generation > this.transport.generation) {
            await this.transport.reset(generation);
            this.subscriptions.clear();
        }
        for (const [routeId, route] of this.admission.routesById) {
            if (route.direction !== "subscribe" || this.subscriptions.has(routeId)) continue;
            const id = await this.transport.subscribe(routeId, (bytes, metadata) => {
                if (!this.active) return { ok: false, code: "inactive" };
                const otherBytes = Math.max(0, this.queueBytes() - Number(kernel.inputQueue.queuedBytes || 0));
                const result = this.routes.acceptInbound(routeId, bytes, { generation: metadata.generation,
                    clock: { step: kernel.steps, timeNs: kernel.timeNs },
                    queueLimits: { maxEntries: this.admission.config.queue.maxEntries, maxBytes: Math.max(0, this.limits.maxQueueBytes - otherBytes) } });
                if (!result.ok) kernel.telemetry?.emitTelemetryEvent?.({ category: "transport", name: "zenoh-inbound-rejected", severity: "warning", payload: { routeId, code: result.code } });
                return result;
            });
            this.subscriptions.set(routeId, id);
        }
        this.assertHealthy();
        this.active = true;
    }

    publish(packet) {
        if (!this.active) return { ok: false, code: "inactive" };
        const result = this.transport.publish(packet);
        if (result.fatal) this._fail({ code: result.code, routeId: packet.routeId });
        return result;
    }

    publishTopic(envelope) {
        if (!this.active) return { ok: false, code: "inactive" };
        const result = this.routes.publishTopic(envelope);
        if (!result.ok && [...this.admission.routesById.values()].some((route) => route.topicId === envelope.topicId && route.required)) {
            this._fail({ code: result.code, routeId: result.routeId ?? null });
        }
        return result;
    }

    _fail({ code, routeId = null } = {}) {
        if (this.failure) return;
        this.failure = Object.assign(new HeadlessRunnerError(
            ["queue-full", "shm-exhausted"].includes(code) ? "RESOURCE_LIMIT" : "INTERNAL",
            `Zenoh transport failed: ${code || "native-failure"}.`,
            { subsystem: "zenoh", nativeCode: code, routeId, requiresReset: true },
        ), { requiresReset: true, infrastructureFailure: true });
        this.active = false;
    }

    assertHealthy() {
        const diagnostics = this.transport?.diagnostics();
        if (diagnostics?.state === "failed") this._fail(diagnostics.lastError);
        if (this.failure) throw this.failure;
    }

    async drain() {
        if (!this.transport) return;
        const deadline = performance.now() + this.admission.config.publishTimeoutMs;
        while (true) {
            this.assertHealthy();
            if (!this.transport.diagnostics().queueEntries) return;
            if (performance.now() >= deadline) { this._fail({ code: "drain-timeout" }); this.assertHealthy(); }
            await delay(5);
        }
    }

    async suspend() {
        this.active = false;
        await this.drain();
        await this.transport.reset(this.routes.invalidateBindings());
        this.subscriptions.clear();
    }

    diagnostics() { return { ...this.transport?.diagnostics(), routing: this.closedRouting ?? this.routes.stats, active: this.active }; }

    async close() {
        this.active = false;
        this.subscriptions.clear();
        this.closedRouting ??= this.routes.stats ? { ...this.routes.stats } : null;
        try { await this.transport?.close(); } finally { this.routes.dispose(); }
    }
}
