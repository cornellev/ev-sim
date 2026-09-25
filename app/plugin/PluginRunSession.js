import { cloneJson } from "../util/cloneJson.js";
import { PLUGIN_CAPABILITIES } from "../plugin-api/capabilities.js";
import { BlockRegistry } from "../scripting/BlockRegistry.js";
import { registerBuiltInBlocks } from "../scripting/registerBuiltInBlocks.js";
import { PluginEffectJournal } from "./PluginEffectJournal.js";
import { PluginHost } from "./PluginHost.js";
import { clonePluginJson } from "./PluginJson.js";
import { PluginLoader } from "./PluginLoader.js";
import { verifyPluginPackage } from "./PluginPackage.js";
import {
    comparePluginText,
    encodePluginSignalSegment,
    normalizeResolvedPlugins,
} from "./PluginSelection.js";
import { PLUGIN_ERROR_CODES, assertSynchronous, pluginError } from "./PluginErrors.js";
import { PluginRandom } from "./PluginRandom.js";
import { PluginSystemDispatcher } from "./PluginSystemDispatcher.js";
import {
    SensorTypeRegistry,
    registerBuiltInSensorTypes,
} from "../simulation/sensors/SensorTypeRegistry.js";
import {
    PluginTopicRuntime,
    isPluginControlTopic,
    isPluginHeavyTopic,
} from "./PluginTopicRuntime.js";

export const PLG02_RUNTIME_CAPABILITIES = Object.freeze(PLUGIN_CAPABILITIES.filter((capability) => (
    capability.startsWith("signals.read.")
    || capability === "signals.write.debug"
    || capability === "signals.write.mission"
    || capability === "scenario.flags.write"
    || capability === "world.read"
)));

export const PLG03_RUNTIME_CAPABILITIES = Object.freeze([...PLUGIN_CAPABILITIES]);
export const PLUGIN_HEADLESS_GPU_BACKEND_KIND = 4;
export const PLUGIN_OVERLAY_OWNER_PREFIX = "plugin:";

function clone(value) {
    if (value === undefined) return undefined;
    return cloneJson(value);
}

function effectKey(value) {
    const key = String(value ?? "").trim();
    if (!key || key.split(".").some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
        throw new TypeError("Plugin-owned signal keys must contain dot-separated alphanumeric, underscore, or hyphen segments.");
    }
    return key;
}

function requireGrant(grants, capability, pluginId) {
    if (!grants.has(capability)) {
        throw pluginError(PLUGIN_ERROR_CODES.CAPABILITY, `Plugin "${pluginId}" was not granted "${capability}".`, {
            pluginId,
            requiresReset: true,
        });
    }
}

function overlayOwner(pluginId) {
    return `${PLUGIN_OVERLAY_OWNER_PREFIX}${pluginId}`;
}

function pluginIdFromOwner(owner) {
    const value = String(owner ?? "");
    return value.startsWith(PLUGIN_OVERLAY_OWNER_PREFIX)
        ? value.slice(PLUGIN_OVERLAY_OWNER_PREFIX.length)
        : value;
}

export function overlaySpawnSupported(resolved = {}, {
    renderTarget = "headless",
    backendSelections = resolved.backendSelections,
} = {}) {
    const backends = backendSelections ?? resolved.backendSelections ?? [];
    const usesGpu = backends.some((entry) => Number(entry.kind) === PLUGIN_HEADLESS_GPU_BACKEND_KIND);
    return !(usesGpu && renderTarget === "headless");
}

export function pluginRuntimeCapabilitiesForRun(resolved = {}, options = {}) {
    const capabilities = [...PLG03_RUNTIME_CAPABILITIES];
    if (!overlaySpawnSupported(resolved, options)) {
        return Object.freeze(capabilities.filter((capability) => capability !== "overlay.spawn").sort(comparePluginText));
    }
    return Object.freeze(capabilities.sort(comparePluginText));
}

const RESETTING_DENIED_NAMESPACES = new Set(["vehicles", "devices"]);

export class PluginRunSession {
    constructor({
        moduleSource,
        plugins = [],
        availableCapabilities = PLG03_RUNTIME_CAPABILITIES,
        simulatorVersion = "0.1.0",
        logger = () => {},
    } = {}) {
        this.moduleSource = moduleSource;
        this.plugins = normalizeResolvedPlugins(plugins);
        this.availableCapabilities = Object.freeze([...availableCapabilities].sort(comparePluginText));
        this.simulatorVersion = simulatorVersion;
        this.logger = logger;
        this.host = null;
        this.loader = null;
        this.registry = null;
        this.sensorRegistry = null;
        this.sensorFactories = new Map();
        this.services = Object.freeze({
            signalStore: null,
            world: null,
            controlRuntime: null,
            topicRouter: null,
            episodeOverlay: null,
            clock: () => ({ step: 0, timeNs: 0, stepNs: 0 }),
        });
        this.random = new PluginRandom("0");
        this.journal = new PluginEffectJournal();
        this.dispatcher = new PluginSystemDispatcher();
        this.topics = new PluginTopicRuntime();
        this.unitContexts = new WeakMap();
        this.units = new Set();
        this.ownedSignalPaths = new Set();
        this.commandSequences = {};
        this.disposed = false;
        this.generation = 0;
        this.mode = "idle";
        this._clock = null;
        this._topicObserver = null;
        this._finalized = false;
    }

    async prepareDefinitions(resources = []) {
        if (this.disposed) throw new Error("Plugin run session is disposed.");
        if (this.plugins.length === 0) {
            const registry = registerBuiltInBlocks(new BlockRegistry({ allowPlugins: true }));
            registry.seal();
            this.registry = registry;
            this.sensorRegistry = registerBuiltInSensorTypes(
                new SensorTypeRegistry({ allowPlugins: true }),
            ).seal();
            this.mode = "definitions";
            return this;
        }
        if (!this.moduleSource?.importRuntime) throw new Error("Selected plugins require a platform module source.");
        if (!Array.isArray(resources) || resources.length !== this.plugins.length) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "The selected plugin resource set is incomplete.");
        }
        const verifiedById = new Map();
        for (const resource of resources) {
            const verified = verifyPluginPackage(resource);
            if (verifiedById.has(verified.document.id)) {
                throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Duplicate plugin package "${verified.document.id}".`);
            }
            verifiedById.set(verified.document.id, verified);
        }
        for (const selected of this.plugins) {
            const verified = verifiedById.get(selected.pluginId);
            if (!verified || verified.document.version !== selected.version
                || verified.resource.packageHash !== selected.packageHash
                || verified.resource.runtimeHash !== selected.runtimeHash) {
                throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Selected plugin "${selected.pluginId}" does not match its package resource.`, {
                    pluginId: selected.pluginId,
                    packageHash: selected.packageHash,
                });
            }
        }
        const baseRegistry = registerBuiltInBlocks(new BlockRegistry({ allowPlugins: true }));
        const baseSensorRegistry = registerBuiltInSensorTypes(
            new SensorTypeRegistry({ allowPlugins: true }),
        );
        this.host = new PluginHost({
            blockRegistry: baseRegistry,
            sensorRegistry: baseSensorRegistry,
            simulatorVersion: this.simulatorVersion,
            availableCapabilities: this.availableCapabilities,
            logger: this.logger,
            createFacade: (base, context) => this._createFacade(base, context),
            onUnitDispose: (adapter) => this.detachUnit(adapter),
        });
        this.loader = new PluginLoader({ moduleSource: this.moduleSource, host: this.host });
        for (const selected of this.plugins) {
            await this.loader.loadPackage(verifiedById.get(selected.pluginId).resource, {
                capabilities: selected.capabilities,
            });
        }
        this.host.seal();
        this.registry = this.host.registry;
        this.sensorRegistry = this.host.sensorRegistry;
        for (const selected of this.plugins) {
            const metadata = this.host.packages.get(selected.pluginId);
            for (const factory of metadata?.systemFactories ?? []) {
                this.dispatcher.addDefinition({
                    ...factory,
                    capabilities: selected.capabilities,
                });
            }
            for (const factory of metadata?.sensorFactories ?? []) {
                this.sensorFactories.set(factory.type, factory);
            }
        }
        this.dispatcher.sort();
        this.mode = "definitions";
        return this;
    }

    bindServices({
        signalStore = this.services.signalStore,
        world = this.services.world,
        controlRuntime = this.services.controlRuntime,
        topicRouter = this.services.topicRouter,
        episodeOverlay = this.services.episodeOverlay,
        clock = this.services.clock,
    } = {}) {
        this._unbindRouter();
        this.services = Object.freeze({
            signalStore: signalStore ?? null,
            world: world ? clone(world) : null,
            controlRuntime: controlRuntime ?? null,
            topicRouter: topicRouter ?? null,
            episodeOverlay: episodeOverlay ?? null,
            clock: typeof clock === "function" ? clock : () => clock ?? { step: 0, timeNs: 0, stepNs: 0 },
        });
        if (this.services.topicRouter?.addObserver) {
            this._topicObserver = (envelope) => {
                try {
                    this.topics.observe(envelope);
                } catch (error) {
                    this.mode = "failed";
                    throw error;
                }
            };
            this.services.topicRouter.addObserver(this._topicObserver);
        }
        if (this.mode !== "disposed" && this.mode !== "failed") this.mode = "bound";
        return this;
    }

    prepareInstances() {
        this._assertOpen();
        this.mode = "definitions";
        try {
            this.dispatcher.prepare((record, hook) => this._runSystemHook(record, hook));
            this.mode = "bound";
        } catch (error) {
            this.topics.clearSubscriptions();
            this.mode = "failed";
            throw error;
        }
        return this;
    }

    attachUnit(adapter, { scopeId = "script", unitId = adapter?.uuid ?? "unit" } = {}) {
        const ownership = adapter?.constructor?.pluginOwnership;
        if (!ownership || ownership === "builtin") return;
        this.unitContexts.set(adapter, Object.freeze({
            pluginId: ownership.pluginId,
            runtimeHash: ownership.runtimeHash,
            scopeId: String(scopeId),
            unitId: String(unitId),
            generation: this.generation,
        }));
        this.units.add(adapter);
    }

    detachUnit(adapter) {
        this.units.delete(adapter);
        this.unitContexts.delete(adapter);
    }

    _assertOpen(pluginId) {
        if (this.disposed || this.mode === "disposed") {
            throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, "Plugin session is closed.", { pluginId });
        }
    }

    _assertActor(pluginId, { requireResetting = false } = {}) {
        this._assertOpen(pluginId);
        if (this.mode === "failed") {
            throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, "Plugin session requires reset.", {
                pluginId,
                requiresReset: true,
            });
        }
        if (requireResetting && this.mode !== "resetting") {
            throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, "Plugin overlay spawn is only allowed during reset.", {
                pluginId,
                requiresReset: true,
            });
        }
    }

    _unitContext(adapter, pluginId) {
        this._assertActor(pluginId);
        const context = this.unitContexts.get(adapter);
        if (!context || context.generation !== this.generation) {
            throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, "Plugin unit is outside its active run scope.", {
                pluginId,
                requiresReset: true,
            });
        }
        return context;
    }

    _currentClock() {
        return this._clock ?? this.services.clock?.() ?? { step: 0, timeNs: 0, stepNs: 0 };
    }

    _stageOwnedSignal({ plugin, grants, capability, domain, key, value, scopeId, unitId }) {
        requireGrant(grants, capability, plugin.id);
        this._assertActor(plugin.id);
        const path = `${domain}.plugins.${encodePluginSignalSegment(plugin.id)}.${effectKey(key)}`;
        const normalized = clonePluginJson(value, path);
        this.journal.stage({
            kind: "signal-write",
            path,
            value: normalized,
            pluginId: plugin.id,
            scopeId,
            unitId,
        });
        return normalized;
    }

    _readSignal(base, path, options, pluginId) {
        this._assertActor(pluginId);
        const namespace = String(path ?? "").trim().split(".", 1)[0];
        if (this.mode === "resetting" && RESETTING_DENIED_NAMESPACES.has(namespace)) {
            throw pluginError(
                PLUGIN_ERROR_CODES.STATE_INVALID,
                "Plugin reset context cannot read pre-reset vehicle or device state.",
                { pluginId, requiresReset: true },
            );
        }
        return clone(base.readSignal(path, options));
    }

    _createFacade(base, { plugin, capabilities, adapter, record = null }) {
        const grants = new Set(capabilities);
        const actor = () => (adapter
            ? this._unitContext(adapter, plugin.id)
            : { scopeId: `system:${record.id}`, unitId: record.id });
        return {
            readSignal: (path, options = {}) => {
                if (adapter) this._unitContext(adapter, plugin.id);
                return this._readSignal(base, path, options, plugin.id);
            },
            getContext: () => {
                this._assertActor(plugin.id);
                if (adapter) return Object.freeze({ ...base.getContext() });
                const clock = this._currentClock();
                return Object.freeze({
                    scopeId: `system:${record.id}`,
                    stepIndex: clock.step ?? 0,
                    simulationTimeNs: clock.timeNs ?? 0,
                    stepNs: clock.stepNs ?? 0,
                });
            },
            getWorld: () => {
                requireGrant(grants, "world.read", plugin.id);
                this._assertActor(plugin.id);
                return clone(this.services.world);
            },
            random: () => {
                const context = actor();
                const stream = adapter
                    ? `${plugin.id}@${plugin.runtimeHash}/${context.scopeId}/${context.unitId}`
                    : `${plugin.id}@${plugin.runtimeHash}/system/${record.id}`;
                return this.random.next(stream);
            },
            writeDebug: (key, value) => this._stageOwnedSignal({
                plugin, grants, capability: "signals.write.debug", domain: "debug", key, value, ...actor(),
            }),
            writeMission: (key, value) => this._stageOwnedSignal({
                plugin, grants, capability: "signals.write.mission", domain: "mission", key, value, ...actor(),
            }),
            setFlag: (key, value) => {
                if (typeof value !== "boolean") throw new TypeError("Plugin scenario flags must be boolean.");
                return this._stageOwnedSignal({
                    plugin, grants, capability: "scenario.flags.write", domain: "scenario.flags", key, value, ...actor(),
                });
            },
            submitReferenceCommand: (vehicleId, { speedMps = 0, steeringRadRep103 = 0 } = {}) => {
                requireGrant(grants, "controls.reference", plugin.id);
                this._assertActor(plugin.id);
                const id = String(vehicleId ?? "").trim();
                if (!id) throw new TypeError("Reference commands require a vehicleId.");
                if (!Number.isFinite(speedMps) || !Number.isFinite(steeringRadRep103)) {
                    throw new TypeError("Reference commands require finite speed and steering.");
                }
                this.journal.stage({
                    kind: "reference-command",
                    pluginId: plugin.id,
                    vehicleId: id,
                    speedMps,
                    steeringRadRep103,
                });
            },
            publishTopic: (topicIdOrName, { value = null, typeStr = null } = {}) => {
                requireGrant(grants, "topics.publish", plugin.id);
                this._assertActor(plugin.id);
                const topicId = String(topicIdOrName ?? "").trim();
                if (!topicId) throw new TypeError("Topic publications require a topic id.");
                this.journal.stage({
                    kind: "topic-publish",
                    pluginId: plugin.id,
                    topicId,
                    value: clonePluginJson(value, "plugin topic value"),
                    typeStr: typeStr == null ? null : String(typeStr),
                });
            },
            spawnOverlay: ({ id, assetId, pose } = {}) => {
                requireGrant(grants, "overlay.spawn", plugin.id);
                this._assertActor(plugin.id, { requireResetting: true });
                const spec = {
                    kind: "overlay-spawn",
                    pluginId: plugin.id,
                    assetId: String(assetId ?? "").trim() || "barrel",
                    pose: clonePluginJson(pose ?? {}, "plugin overlay pose"),
                };
                if (id != null && String(id).trim()) spec.id = String(id).trim();
                this.journal.stage(spec);
            },
            subscribeTopic: (topicIdOrName, onMessage) => {
                requireGrant(grants, "topics.subscribe", plugin.id);
                if (adapter) {
                    throw pluginError(
                        PLUGIN_ERROR_CODES.STATE_INVALID,
                        "Plugin units cannot subscribe to topics.",
                        { pluginId: plugin.id, requiresReset: true },
                    );
                }
                if (this.mode !== "definitions") {
                    throw pluginError(
                        PLUGIN_ERROR_CODES.STATE_INVALID,
                        "Plugin topic subscriptions are only allowed during prepare.",
                        { pluginId: plugin.id, contributionId: record?.id, requiresReset: true },
                    );
                }
                this.topics.subscribe({
                    pluginId: plugin.id,
                    systemId: record.id,
                    topic: this._requireTopic(topicIdOrName, plugin.id),
                    onMessage,
                });
            },
        };
    }

    _systemFacade(record) {
        const plugin = { id: record.pluginId, version: record.version, runtimeHash: record.runtimeHash };
        const grants = new Set(record.capabilities);
        const base = {
            readSignal: (path, options = {}) => {
                const capability = `signals.read.${String(path ?? "").trim().split(".", 1)[0]}`;
                if (!grants.has(capability)) {
                    throw pluginError(
                        PLUGIN_ERROR_CODES.CAPABILITY,
                        `Plugin "${plugin.id}" cannot read signal namespace "${String(path ?? "").trim().split(".", 1)[0]}".`,
                        { pluginId: plugin.id },
                    );
                }
                if (!this.services.signalStore?.read) {
                    throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, "Plugin signal reads require a signal store.", {
                        pluginId: plugin.id,
                        requiresReset: true,
                    });
                }
                return this.services.signalStore.read(path, options);
            },
            getContext: () => ({}),
        };
        return this._createFacade(base, {
            plugin,
            capabilities: record.capabilities,
            record,
        });
    }

    _requireTopic(topicIdOrName, pluginId) {
        const topic = this.services.topicRouter?.getTopic?.(topicIdOrName);
        if (!topic) {
            throw pluginError(
                PLUGIN_ERROR_CODES.STATE_INVALID,
                `Plugin topic "${topicIdOrName}" is not declared in the run manifest.`,
                { pluginId, requiresReset: true },
            );
        }
        return topic;
    }

    _snapshotHook(record) {
        const state = record?.instance?.getDeterministicState
            ? clonePluginJson(
                assertSynchronous(
                    record.instance.getDeterministicState(),
                    "getDeterministicState",
                    { pluginId: record.pluginId, contributionId: record.id, hook: "getDeterministicState" },
                ) ?? {},
                `${record.id}.state`,
            )
            : {};
        return {
            journal: this.journal.begin(),
            random: this.random.snapshot(),
            commandSequences: clone(this.commandSequences),
            overlay: this.services.episodeOverlay?.captureState?.() ?? null,
            systemState: state,
            record,
        };
    }

    beginEvaluation() {
        return Object.freeze({
            journal: this.journal.begin(),
            random: this.random.snapshot(),
            commandSequences: clone(this.commandSequences),
            overlay: this.services.episodeOverlay?.captureState?.() ?? null,
        });
    }

    beginHook(record, hook) {
        return Object.freeze({ ...this._snapshotHook(record), hook });
    }

    _restoreHook(token) {
        this.random.restore(token.random);
        this.commandSequences = token.commandSequences ?? {};
        this.services.episodeOverlay?.restoreState?.(token.overlay);
        if (token.record?.instance?.hydrateDeterministicState) {
            assertSynchronous(
                token.record.instance.hydrateDeterministicState(token.systemState ?? {}),
                "hydrateDeterministicState",
                {
                    pluginId: token.record.pluginId,
                    contributionId: token.record.id,
                    hook: "hydrateDeterministicState",
                },
            );
        }
    }

    commitEvaluation(token, signalStore = this.services.signalStore) {
        const overlaySnap = this.services.episodeOverlay?.captureState?.() ?? null;
        const sequencesSnap = clone(this.commandSequences);
        const storeToken = signalStore?.beginTransaction?.() ?? null;
        try {
            this.journal.commit(token.journal, (effect) => this._applyEffect(effect, { signalStore }));
            storeToken && signalStore.commitTransaction?.(storeToken);
        } catch (error) {
            storeToken && signalStore.rollbackTransaction?.(storeToken);
            this.commandSequences = sequencesSnap;
            this.services.episodeOverlay?.restoreState?.(overlaySnap);
            throw error;
        }
    }

    commitHook(token, signalStore = this.services.signalStore) {
        this.commitEvaluation(token, signalStore);
    }

    rollbackEvaluation(token) {
        this.journal.rollback(token.journal);
        this._restoreHook(token);
    }

    rollbackHook(token) {
        this.rollbackEvaluation(token);
    }

    _applyEffect(effect, { signalStore = this.services.signalStore } = {}) {
        if (effect.kind === "signal-write") {
            if (!signalStore?.write) throw new Error("Plugin signal effects require a signal store.");
            signalStore.write(effect.path, effect.value, {
                source: `plugin:${effect.pluginId}`,
                category: effect.path.split(".", 1)[0],
                replayRole: "state",
                logClass: "core",
            });
            this.ownedSignalPaths.add(effect.path);
            return;
        }
        if (effect.kind === "reference-command") {
            const controlRuntime = this.services.controlRuntime;
            if (!controlRuntime?.submitSiSpeedSteer) {
                throw pluginError(
                    PLUGIN_ERROR_CODES.STATE_INVALID,
                    "Plugin reference commands require a control runtime.",
                    { pluginId: effect.pluginId, requiresReset: true },
                );
            }
            const clock = this._currentClock();
            const pending = controlRuntime.pendingByVehicle?.get(effect.vehicleId);
            const previousSequence = Number(pending?.get?.("reference")?.sequence) || 0;
            controlRuntime.submitSiSpeedSteer(effect.vehicleId, {
                speedMps: effect.speedMps,
                steeringRadRep103: effect.steeringRadRep103,
                mode: "velocity",
                producer: "reference",
                source: `plugin:${effect.pluginId}`,
                captureTimeNs: clock.timeNs,
                sequence: null,
            });
            const assigned = Number(controlRuntime.pendingByVehicle?.get(effect.vehicleId)?.get?.("reference")?.sequence)
                || previousSequence + 1;
            this.commandSequences[effect.pluginId] ??= {};
            this.commandSequences[effect.pluginId][effect.vehicleId] = assigned;
            return;
        }
        if (effect.kind === "topic-publish") {
            const topic = this._requireTopic(effect.topicId, effect.pluginId);
            if (isPluginControlTopic(topic)) {
                throw pluginError(
                    PLUGIN_ERROR_CODES.UNAVAILABLE,
                    `Plugin "${effect.pluginId}" cannot publish control topics; use controls.reference.`,
                    { pluginId: effect.pluginId, requiresReset: true },
                );
            }
            this._applyTopicPublish(effect);
            return;
        }
        if (effect.kind === "overlay-spawn") {
            this._applyOverlaySpawn(effect);
            return;
        }
        throw new Error(`Unsupported plugin effect "${effect.kind}".`);
    }

    _applyTopicPublish(effect) {
        if (this.topics.delivering) {
            this.topics.deferPublish(effect);
            return;
        }
        const topic = this._requireTopic(effect.topicId, effect.pluginId);
        if (topic.direction !== "output") {
            throw pluginError(
                PLUGIN_ERROR_CODES.STATE_INVALID,
                `Plugin "${effect.pluginId}" can publish only output topics.`,
                { pluginId: effect.pluginId, requiresReset: true },
            );
        }
        if (isPluginControlTopic(topic)) {
            throw pluginError(
                PLUGIN_ERROR_CODES.UNAVAILABLE,
                `Plugin "${effect.pluginId}" cannot publish control topics; use controls.reference.`,
                { pluginId: effect.pluginId, requiresReset: true },
            );
        }
        const expectedType = topic.schema?.type || topic.type;
        if (effect.typeStr && expectedType && effect.typeStr !== expectedType) {
            throw pluginError(
                PLUGIN_ERROR_CODES.STATE_INVALID,
                `Plugin topic "${topic.name}" expected ${expectedType}, received ${effect.typeStr}.`,
                { pluginId: effect.pluginId, requiresReset: true },
            );
        }
        if (isPluginHeavyTopic(topic, effect.value)) {
            throw pluginError(
                PLUGIN_ERROR_CODES.RESOURCE,
                `Plugin "${effect.pluginId}" cannot publish heavy topic payloads.`,
                { pluginId: effect.pluginId, requiresReset: true },
            );
        }
        const clock = this._currentClock();
        const routed = this.services.topicRouter.routeOutbound(topic.id, {
            value: effect.value,
            typeStr: effect.typeStr ?? expectedType,
        }, {
            producer: topic.producer || "simulator",
            captureTimeNs: clock.timeNs,
            deliveryTimeNs: clock.timeNs,
            cycle: clock.step,
        });
        if (!routed?.ok) {
            throw pluginError(
                PLUGIN_ERROR_CODES.STATE_INVALID,
                `Plugin "${effect.pluginId}" could not publish "${topic.name}".`,
                { pluginId: effect.pluginId, requiresReset: true },
            );
        }
    }

    _applyOverlaySpawn(effect) {
        const overlay = this.services.episodeOverlay;
        if (!overlay?.upsert) {
            throw pluginError(
                PLUGIN_ERROR_CODES.STATE_INVALID,
                "Plugin overlay spawn requires an episode overlay.",
                { pluginId: effect.pluginId, requiresReset: true },
            );
        }
        const owner = overlayOwner(effect.pluginId);
        if (effect.id) {
            try {
                overlay.assertOwner(effect.id, owner);
            } catch (error) {
                throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, error.message, {
                    pluginId: effect.pluginId,
                    requiresReset: true,
                    cause: error,
                });
            }
        }
        overlay.upsert({
            id: effect.id,
            assetId: effect.assetId,
            pose: effect.pose,
            scriptId: owner,
        });
    }

    _wrapHookError(error, record, hook) {
        if (error?.code) {
            error.pluginId ??= record.pluginId;
            error.contributionId ??= record.id;
            error.hook ??= hook;
            error.requiresReset = true;
            return error;
        }
        return pluginError(
            PLUGIN_ERROR_CODES.EXECUTION,
            `Plugin system hook "${hook}" failed: ${error.message}`,
            {
                pluginId: record.pluginId,
                contributionId: record.id,
                hook,
                requiresReset: true,
                cause: error,
            },
        );
    }

    _runSystemHook(record, hook) {
        const token = this.beginHook(record, hook);
        try {
            const context = this._systemFacade(record);
            assertSynchronous(record.instance[hook](context), hook, {
                pluginId: record.pluginId,
                contributionId: record.id,
                hook,
            });
            this.commitHook(token);
        } catch (error) {
            this.rollbackHook(token);
            this.mode = "failed";
            throw this._wrapHookError(error, record, hook);
        }
    }

    deliverTopics(clock = this._currentClock()) {
        if (this.disposed || this.plugins.length === 0) return this;
        this._clock = clock;
        const previous = this.mode;
        this.mode = "stepping";
        try {
            const deferred = this.topics.deliver((subscription, message) => {
                const record = this.dispatcher.instances.find((entry) => (
                    entry.pluginId === subscription.pluginId && entry.id === subscription.systemId
                ));
                if (!record) {
                    throw pluginError(
                        PLUGIN_ERROR_CODES.STATE_INVALID,
                        "Plugin topic callback has no active system.",
                        {
                            pluginId: subscription.pluginId,
                            contributionId: subscription.systemId,
                            hook: "topic-callback",
                            requiresReset: true,
                        },
                    );
                }
                const token = this.beginHook(record, "topic-callback");
                try {
                    assertSynchronous(subscription.onMessage(clone(message)), "onMessage", {
                        pluginId: subscription.pluginId,
                        contributionId: subscription.systemId,
                        hook: "topic-callback",
                    });
                    this.commitHook(token);
                } catch (error) {
                    this.rollbackHook(token);
                    this.mode = "failed";
                    throw this._wrapHookError(error, record, "topic-callback");
                }
            });
            for (const effect of deferred) this._applyTopicPublish(effect);
        } catch (error) {
            this.mode = "failed";
            throw error;
        } finally {
            if (this.mode === "stepping") this.mode = previous === "resetting" ? "resetting" : "bound";
            this._clock = null;
        }
        return this;
    }

    dispatchSystems(dt, clock = this._currentClock()) {
        if (this.disposed || this.plugins.length === 0) return this;
        this._clock = { ...clock, dt };
        const previous = this.mode;
        this.mode = "stepping";
        try {
            this.dispatcher.onStep((record, hook) => this._runSystemHook(record, hook));
        } finally {
            if (this.mode === "stepping") this.mode = previous === "resetting" ? "resetting" : "bound";
            this._clock = null;
        }
        return this;
    }

    beginResetWindow({ resetSeed = "0", signalStore = this.services.signalStore } = {}) {
        this._assertOpen();
        for (const unit of [...this.units]) unit?.dispose?.();
        this.generation += 1;
        this.journal.reset();
        this.random.reset(resetSeed);
        this.topics.reset();
        this.commandSequences = {};
        for (const path of this.ownedSignalPaths) signalStore?.removeSignal?.(path);
        this.ownedSignalPaths.clear();
        this.units.clear();
        this.unitContexts = new WeakMap();
        this.mode = "resetting";
        this._clock = { step: 0, timeNs: 0, stepNs: 0 };
        this.dispatcher.reset((record, hook) => this._runSystemHook(record, hook));
        return this;
    }

    endResetWindow() {
        this._clock = null;
        if (this.mode === "resetting") this.mode = "bound";
        return this;
    }

    reset({ resetSeed = "0", signalStore = this.services.signalStore } = {}) {
        this.beginResetWindow({ resetSeed, signalStore });
        this.endResetWindow();
        return this;
    }

    finalizeSystems() {
        if (this._finalized || this.disposed) return this;
        this._finalized = true;
        if (this.mode !== "failed") {
            this.dispatcher.finalize((record, hook) => this._runSystemHook(record, hook));
        }
        return this;
    }

    getDeterministicState() {
        const units = [...this.units].map((unit) => {
            const context = this.unitContexts.get(unit);
            return {
                pluginId: context.pluginId,
                scopeId: context.scopeId,
                unitId: context.unitId,
                state: clonePluginJson(unit.serializeRuntimeState?.() ?? {}, "plugin runtime state"),
            };
        }).sort((left, right) => comparePluginText(left.pluginId, right.pluginId)
            || comparePluginText(left.scopeId, right.scopeId)
            || comparePluginText(left.unitId, right.unitId));
        const signals = Object.fromEntries([...this.ownedSignalPaths].sort(comparePluginText).map((path) => [
            path,
            clone(this.services.signalStore?.read?.(path)?.value),
        ]));
        const overlay = this.services.episodeOverlay;
        const overlayRecords = (overlay?.snapshot?.() ?? [])
            .filter((record) => String(record.scriptId).startsWith(PLUGIN_OVERLAY_OWNER_PREFIX))
            .sort((left, right) => comparePluginText(left.id, right.id));
        const overlaySerials = Object.fromEntries(Object.entries(overlay?.serialSnapshot?.() ?? {})
            .filter(([key]) => key.startsWith(PLUGIN_OVERLAY_OWNER_PREFIX))
            .map(([key, serial]) => [pluginIdFromOwner(key), serial])
            .sort(([left], [right]) => comparePluginText(left, right)));
        const commandSequences = Object.fromEntries(Object.entries(this.commandSequences)
            .sort(([left], [right]) => comparePluginText(left, right))
            .map(([pluginId, vehicles]) => [
                pluginId,
                Object.fromEntries(Object.entries(vehicles).sort(([left], [right]) => comparePluginText(left, right))),
            ]));
        return {
            units,
            signals,
            systems: this.dispatcher.getDeterministicState(),
            rngStreams: this.random.snapshot(),
            topicQueues: this.topics.snapshot(),
            commandSequences,
            overlayRecords,
            overlaySerials,
        };
    }

    _unbindRouter() {
        if (this._topicObserver && this.services.topicRouter?.removeObserver) {
            this.services.topicRouter.removeObserver(this._topicObserver);
        }
        this._topicObserver = null;
    }

    dispose() {
        if (this.disposed) return;
        this.dispatcher.dispose();
        this._unbindRouter();
        this.topics.dispose();
        for (const unit of [...this.units]) unit?.dispose?.();
        this.units.clear();
        this.journal.reset();
        this.random.reset("0");
        this.unitContexts = new WeakMap();
        this.commandSequences = {};
        this.sensorFactories.clear();
        this.mode = "disposed";
        this.disposed = true;
    }
}
