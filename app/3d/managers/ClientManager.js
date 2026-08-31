import {
    Client,
    hasRegisteredSchema,
    registerMsgDefinition,
    registerMsgDefinitionFromFile,
    syncTypesFromServer,
    syncTypesToServer,
} from "@/app/client/Client";
import {
    catalogHash,
    catalogMetadata,
    catalogSchemas,
    inputTopicRequiresOrchestrator,
    msgFilePathsForCatalog,
    schemaClosureForManifest,
} from "../../autonomy/AutonomyContractCatalog.js";

function topicRosType(topic) {
    return topic?.schema?.type || topic?.type || null;
}

export class ClientManager {
    constructor(data) {
        this.data = data;

        this.client = null;
        this.catalogHash = null;
        this.autonomyCatalog = catalogMetadata();
        this._disposed = false;
        this._orchestratorTopics = new Map();

        this._initPromise = this._setupClient();

        this.callbacks = [];

        window.clientHandler = this; // for debugging
    }

    hasClient() {
        return this.client !== null;
    }

    async _registerCatalogSchemas() {
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
        try {
            const synced = await syncTypesToServer(schemas, { apiBase: "http://localhost:8090" });
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
        try {
            const synced = await syncTypesFromServer({ apiBase: "http://localhost:8090" });
            this.catalogHash = synced.catalogHash;
            console.log(`synced ${synced.count} message type(s) from server`);
        } catch (err) {
            console.warn("type sync skipped:", err.message);
        }

        await this._registerCatalogSchemas();

        if (this._disposed) return null;
        this.client = new Client({
            url: "ws://localhost:8080",
            onUpdate: this._onUpdate.bind(this),
            onEcho: (topics) => {
                for (const info of topics || []) this._trackOrchestratorTopic(info);
            },
            onNewTopic: (info) => this._trackOrchestratorTopic(info),
            reconnect: false,
        });

        return this.client;
    }

    async setup() {
        await this._initPromise;
        if (this._disposed || !this.client) return;

        console.log("Starting client...");
        this.client.start();
        console.log("Client started");
    }

    onUpdate(callback) {
        this.callbacks.push(callback);
        return () => {
            this.callbacks = this.callbacks.filter((registered) => registered !== callback);
        };
    }

    _onUpdate(info) {
        this._trackOrchestratorTopic(info);
        this.callbacks.forEach((callback) => callback(info));
    }

    async preflight(resolved) {
        const issues = [];
        const manifest = resolved?.manifest;
        if (!manifest) {
            return { ok: false, issues: [{ path: "manifest", message: "Resolved run manifest is required." }] };
        }

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
