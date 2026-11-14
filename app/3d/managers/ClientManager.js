import { ZenohBrowserTransport } from "../../client/ZenohBrowserTransport.js";
import { assertProtobufExecutionCapabilities, bindProtobufRunKeys, planProtobufRouteAdmission } from "../../interfaces/ProtobufRunBinding.js";

function topicRosType(topic) {
    return topic?.schema?.type || topic?.type || null;
}

export class ClientManager {
    constructor(data, { transportFactory = (options) => new ZenohBrowserTransport(options), fetchImpl = (...args) => fetch(...args) } = {}) {
        this.data = data;

        this.client = null;
        this.catalogHash = null;
        this.autonomyCatalog = null;
        this._disposed = false;
        this._orchestratorTopics = new Map();

        this._initPromise = null;
        this._legacy = null;
        this._nativeRun = null;
        this._routeRuntime = null;
        this.transport = null;
        this.transportFactory = transportFactory;
        this.fetchImpl = fetchImpl;
        this.transportListeners = new Set();
        this.transportSnapshot = { state: "disabled", lastError: null, diagnostics: {} };

        this.callbacks = [];

        if (typeof window !== "undefined") window.clientHandler = this; // for debugging
    }

    hasClient() {
        return this.client !== null;
    }

    async _registerCatalogSchemas() {
        const { catalogSchemas, registerMsgDefinition, msgFilePathsForCatalog, registerMsgDefinitionFromFile, syncTypesToServer, waypoints } = await this._loadLegacy();
        const { PLAN_WAYPOINTS_TYPE, PLAN_WAYPOINTS_DEFINITION } = waypoints;
        const schemas = catalogSchemas();
        for (const [type, definition] of Object.entries(schemas)) {
            registerMsgDefinition(type, definition);
        }
        for (const [type, url] of Object.entries(msgFilePathsForCatalog())) {
            try {
                await registerMsgDefinitionFromFile(type, url);
            } catch (err) {
                console.warn(`${type} message definition load skipped:`, err.message);
            }
        }
        registerMsgDefinition(PLAN_WAYPOINTS_TYPE, PLAN_WAYPOINTS_DEFINITION);
        try {
            const synced = await syncTypesToServer({
                ...schemas,
                [PLAN_WAYPOINTS_TYPE]: PLAN_WAYPOINTS_DEFINITION,
            }, { apiBase: (process.env.NEXT_PUBLIC_ORCHESTRATOR_API || "http://localhost:8090") });
            this.catalogHash = synced.catalogHash || synced.hash || this.catalogHash;
        } catch (err) {
            console.warn("autonomy catalog type sync skipped:", err.message);
        }
    }

    _trackOrchestratorTopic(info) {
        if (!info?.name) return;
        const typeStr = info.typeStr ?? info.type ?? null;
        if (typeStr) this._orchestratorTopics.set(info.name, typeStr);
    }

    async _setupClient() {
        const { syncTypesFromServer, Client, catalogMetadata } = await this._loadLegacy();
        this.autonomyCatalog = catalogMetadata();
        try {
            const synced = await syncTypesFromServer({ apiBase: (process.env.NEXT_PUBLIC_ORCHESTRATOR_API || "http://localhost:8090") });
            this.catalogHash = synced.catalogHash;
            console.log(`synced ${synced.count} message type(s) from server`);
        } catch (err) {
            console.warn("type sync skipped:", err.message);
        }

        await this._registerCatalogSchemas();

        if (this._disposed || this._nativeRun) return null;
        this.client = new Client({
            url: (process.env.NEXT_PUBLIC_ORCHESTRATOR_WS || "ws://localhost:8080"),
            onUpdate: this._onUpdate.bind(this),
            onEcho: (topics) => {
                for (const info of topics || []) this._trackOrchestratorTopic(info);
            },
            onNewTopic: (info) => this._trackOrchestratorTopic(info),
            reconnect: false,
        });

        return this.client;
    }

    async _loadLegacy() {
        if (!this._legacy) {
            const [client, catalog, waypoints] = await Promise.all([
                import("../../client/Client.js"), import("../../autonomy/AutonomyContractCatalog.js"), import("../../spatial/planview/waypoints.js"),
            ]);
            this._legacy = { ...client, ...catalog, waypoints };
        }
        return this._legacy;
    }

    async setup(resolved = null, { runId = resolved?.manifest?.id } = {}) {
        if (this._disposed) throw new Error("Client manager is disposed.");
        if (resolved?.version === 13) {
            await this.client?.stop?.();
            this.client = null;
            this._initPromise = null;
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
        await this.closeRun();
        this._initPromise ??= this._setupClient();
        await this._initPromise;
        if (!this._disposed && this.client) {
            this.client.start().catch((error) => console.warn("Legacy client connection failed:", error.message));
            await this.client.echo().catch(() => {});
        }
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

    async closeRun({ runId = null } = {}) {
        if (runId && this._nativeRun?.runId !== runId) return;
        this._nativeRun = null;
        this._routeRuntime?.invalidateBindings();
        this._routeRuntime = null;
        await this.transport?.close();
        this._transportState({ state: "disabled", lastError: null, diagnostics: {} });
    }

    onUpdate(callback) {
        this.callbacks.push(callback);
        return () => {
            this.callbacks = this.callbacks.filter((registered) => registered !== callback);
        };
    }

    _onUpdate(info) {
        const waypoints = this._legacy?.waypoints;
        if (waypoints && info?.name === waypoints.PLAN_WAYPOINTS_TOPIC) waypoints.setPlanWaypoints(info.value);
        this._trackOrchestratorTopic(info);
        this.callbacks.forEach((callback) => callback(info));
    }

    async preflight(resolved, { runId = resolved?.manifest?.id } = {}) {
        const issues = [];
        const manifest = resolved?.manifest;
        if (!manifest) {
            return { ok: false, issues: [{ path: "manifest", message: "Resolved run manifest is required." }] };
        }

        if (resolved.version === 13) {
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
        await this.setup(resolved, { runId });
        const { schemaClosureForManifest, hasRegisteredSchema, catalogHash, inputTopicRequiresOrchestrator } = await this._loadLegacy();

        const schemas = resolved.schemas || schemaClosureForManifest(manifest);
        for (const type of Object.keys(schemas)) {
            if (!hasRegisteredSchema(type)) {
                issues.push({ path: `schemas.${type}`, message: `Schema "${type}" is not registered locally.` });
            }
        }

        const resolvedCatalogHash = resolved.autonomyCatalog?.hash || resolved.manifest?.autonomyCatalog?.hash;
        if (resolvedCatalogHash && resolvedCatalogHash !== catalogHash()) {
            issues.push({
                path: "autonomyCatalog.hash",
                message: `Autonomy catalog hash mismatch: resolved ${resolvedCatalogHash}, runtime ${catalogHash()}.`,
            });
        }

        const scenario = resolved.scenario?.scenario
            ?? (resolved.scenario?.kind === "cev-sim.scenario" ? resolved.scenario : null);
        const preflightContext = {
            controlsAuthority: manifest.controls?.authority || (manifest.scenario ? "reference" : "candidate"),
            scenario,
            scenarioSelected: Boolean(manifest.scenario),
        };
        const needsOrchestrator = (manifest.topics || []).some((topic) => (
            inputTopicRequiresOrchestrator(topic, preflightContext)
        ));

        const client = this.client;
        if (!client?.isOpen?.()) {
            if (needsOrchestrator) {
                issues.push({ path: "transport", message: "ROS orchestrator transport is not connected." });
            }
            return { ok: issues.length === 0, issues };
        }

        let catalogTopics = [];
        try {
            catalogTopics = await client.fetchTopicCatalog();
            for (const info of catalogTopics) this._trackOrchestratorTopic(info);
        } catch (error) {
            if (needsOrchestrator) {
                issues.push({ path: "transport.echo", message: error.message || "Could not read orchestrator topic catalog." });
                return { ok: false, issues };
            }
            return { ok: issues.length === 0, issues };
        }

        const catalogByName = new Map(catalogTopics.map((info) => [info.name, info.typeStr ?? info.type ?? null]));

        for (const [index, topic] of (manifest.topics || []).entries()) {
            if (topic.direction !== "input") continue;
            const expectedType = topicRosType(topic);
            const knownType = catalogByName.get(topic.name) ?? this._orchestratorTopics.get(topic.name) ?? null;
            if (knownType && expectedType && knownType !== expectedType) {
                issues.push({
                    path: `topics.${index}.schema.type`,
                    message: `Topic "${topic.name}" expected ${expectedType}, orchestrator advertises ${knownType}.`,
                });
            } else if (inputTopicRequiresOrchestrator(topic, preflightContext) && !knownType) {
                issues.push({
                    path: `topics.${index}.name`,
                    message: `Required return topic "${topic.name}" is not available on the orchestrator.`,
                });
            }
        }

        return { ok: issues.length === 0, issues };
    }

    async dispose() {
        this._disposed = true;
        this.callbacks = [];
        await this.closeRun();
        this.transportListeners.clear();
        try {
            await this._initPromise;
        } catch {
            // Setup already logs recoverable initialization failures.
        }
        return this.client?.stop?.();
    }

    /**
     *
     * @returns {Client}
     */
    get() {
        return this.client;
    }
}
