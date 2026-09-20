import { BlockRegistry } from "../scripting/BlockRegistry.js";
import { createPluginUnitAdapterClass } from "../scripting/PluginUnitAdapter.js";
import { UnitBlock as PublicUnitBlock } from "../plugin-api/UnitBlock.js";
import { createRegistrationApi } from "../plugin-api/index.js";
import { validateCapabilityGrants } from "../plugin-api/capabilities.js";
import { assertPluginCompatibility } from "./PluginDocument.js";
import { clonePluginJson } from "./PluginJson.js";
import { PLUGIN_ERROR_CODES, assertSynchronous, pluginError } from "./PluginErrors.js";
import { comparePluginText } from "./PluginSelection.js";
import { PLUGIN_SYSTEM_METHODS } from "./PluginSystemDispatcher.js";

function signalNamespace(path) {
    return String(path ?? "").trim().split(".", 1)[0];
}

function capabilityGrants(required, granted, available, fields) {
    try {
        return validateCapabilityGrants(required, granted, available);
    } catch (error) {
        throw pluginError(PLUGIN_ERROR_CODES.CAPABILITY, error.message, { ...fields, cause: error });
    }
}

export class PluginHost {
    constructor({
        blockRegistry = new BlockRegistry(),
        createUnitAdapterClass = createPluginUnitAdapterClass,
        simulatorVersion = "0.1.0",
        availableCapabilities = [],
        logger = () => {},
        createFacade = null,
        onUnitDispose = null,
    } = {}) {
        this.blockRegistry = blockRegistry;
        this.createUnitAdapterClass = createUnitAdapterClass;
        this.simulatorVersion = simulatorVersion;
        this.availableCapabilities = Object.freeze([...availableCapabilities].sort(comparePluginText));
        this.logger = logger;
        this.createFacade = createFacade;
        this.onUnitDispose = onUnitDispose;
        this.packages = new Map();
        this.sealed = false;
    }

    get registry() {
        return this.blockRegistry;
    }

    _facadeFactory(granted, plugin) {
        const grants = new Set(granted);
        return (helpers, adapterContext = {}) => {
            const base = {
                readSignal(path, options = {}) {
                    const capability = `signals.read.${signalNamespace(path)}`;
                    if (!grants.has(capability)) {
                        throw pluginError(PLUGIN_ERROR_CODES.CAPABILITY, `Plugin "${plugin.id}" cannot read signal namespace "${signalNamespace(path)}".`, { pluginId: plugin.id });
                    }
                    return helpers.readSignal(path, options);
                },
                getContext: helpers.getContext,
            };
            return this.createFacade ? this.createFacade(Object.freeze(base), {
                plugin,
                capabilities: Object.freeze([...granted]),
                ...adapterContext,
            }) : base;
        };
    }

    registerPackage(verifiedPackage, moduleNamespace, { capabilities = [] } = {}) {
        const { document, resource } = verifiedPackage;
        const fields = { pluginId: document.id, packageHash: resource.packageHash };
        if (this.sealed) throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, "Plugin host is sealed.", fields);
        if (this.packages.has(document.id)) {
            throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin "${document.id}" is already selected by this host.`, fields);
        }
        assertPluginCompatibility(document, { pluginApi: 1, simulatorVersion: this.simulatorVersion });
        const granted = capabilityGrants(document.capabilities, capabilities, this.availableCapabilities, fields);
        const candidate = new BlockRegistry({ entries: this.blockRegistry.snapshot(), allowPlugins: true });
        const units = [];
        const systems = [];
        let active = true;
        const contribute = (target, kind) => (definition) => {
            if (!active) throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Late ${kind} contribution from "${document.id}".`, fields);
            if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin ${kind} contribution must be an object.`, fields);
            }
            target.push(definition);
        };
        const api = createRegistrationApi({
            plugin: { id: document.id, version: document.version, runtimeHash: resource.runtimeHash },
            capabilities: granted,
            contributeUnit: contribute(units, "unit"),
            contributeSystem: contribute(systems, "system"),
            log: (level, message, details) => this.logger({
                level: String(level),
                message: String(message),
                details: details === undefined ? null : clonePluginJson(details, `${document.id}.log.details`),
                pluginId: document.id,
                packageHash: resource.packageHash,
            }),
        });
        const register = moduleNamespace?.default?.register;
        if (typeof register !== "function") {
            throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin "${document.id}" must export default.register(api).`, fields);
        }
        try {
            assertSynchronous(register(api), "register", fields);
        } catch (error) {
            if (error?.code) throw error;
            throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin registration failed: ${error.message}`, { ...fields, cause: error });
        } finally {
            active = false;
        }
        const declared = new Map(document.units.map((definition) => [definition.type, definition]));
        if (units.length !== declared.size) {
            throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin "${document.id}" did not register its exact declared unit set.`, fields);
        }
        const ownership = Object.freeze({
            pluginId: document.id,
            version: document.version,
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
        });
        const adapterClasses = new Map();
        for (const contribution of units) {
            const keys = Object.keys(contribution).sort();
            if (keys.length !== 2 || keys[0] !== "blockClass" || keys[1] !== "type") {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, "Unit contributions contain only type and blockClass.", fields);
            }
            const definition = declared.get(contribution.type);
            if (!definition) {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin registered undeclared unit "${contribution.type}".`, { ...fields, contributionId: contribution.type });
            }
            if (adapterClasses.has(contribution.type)) {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin registered unit "${contribution.type}" more than once.`, { ...fields, contributionId: contribution.type });
            }
            if (typeof contribution.blockClass !== "function" || !(contribution.blockClass.prototype instanceof PublicUnitBlock)) {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin unit "${contribution.type}" must extend the public UnitBlock.`, { ...fields, contributionId: contribution.type });
            }
            const AdapterClass = this.createUnitAdapterClass({
                definition,
                blockClass: contribution.blockClass,
                ownership,
                createFacade: this._facadeFactory(granted, document),
                onDispose: this.onUnitDispose,
            });
            const probe = new AdapterClass("__plugin_validation__");
            try {
                probe.serializeState();
                probe.serializeRuntimeState();
            } finally {
                probe.dispose();
            }
            candidate.register(contribution.type, AdapterClass, ownership);
            adapterClasses.set(contribution.type, AdapterClass);
        }
        for (const type of declared.keys()) {
            if (!adapterClasses.has(type)) {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin did not register declared unit "${type}".`, { ...fields, contributionId: type });
            }
        }
        const declaredSystems = new Map(document.systems.map((definition) => [definition.id, definition]));
        if (systems.length !== declaredSystems.size) {
            throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin "${document.id}" did not register its exact declared system set.`, fields);
        }
        const systemFactories = [];
        const seenSystems = new Set();
        for (const contribution of systems) {
            const keys = Object.keys(contribution).sort();
            if (keys.length !== 2 || keys[0] !== "create" || keys[1] !== "id") {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, "System contributions contain only id and create.", fields);
            }
            const definition = declaredSystems.get(contribution.id);
            if (!definition) {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin registered undeclared system "${contribution.id}".`, {
                    ...fields,
                    contributionId: contribution.id,
                });
            }
            if (seenSystems.has(contribution.id)) {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin registered system "${contribution.id}" more than once.`, {
                    ...fields,
                    contributionId: contribution.id,
                });
            }
            if (typeof contribution.create !== "function") {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin system "${contribution.id}" create must be a function.`, {
                    ...fields,
                    contributionId: contribution.id,
                });
            }
            const probe = contribution.create();
            assertSynchronous(probe, "create", { ...fields, contributionId: contribution.id, hook: "create" });
            if (!probe || typeof probe !== "object") {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin system "${contribution.id}" create() must return an instance.`, {
                    ...fields,
                    contributionId: contribution.id,
                });
            }
            try {
                for (const name of PLUGIN_SYSTEM_METHODS) {
                    if (typeof probe[name] !== "function") {
                        throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin system "${contribution.id}" is missing ${name}().`, {
                            ...fields,
                            contributionId: contribution.id,
                            hook: name,
                        });
                    }
                }
            } finally {
                try {
                    assertSynchronous(probe.dispose(), "dispose", {
                        ...fields,
                        contributionId: contribution.id,
                        hook: "dispose",
                    });
                } catch (error) {
                    if (error?.code === PLUGIN_ERROR_CODES.ASYNC_HOOK) throw error;
                }
            }
            seenSystems.add(contribution.id);
            systemFactories.push(Object.freeze({
                id: contribution.id,
                pluginId: document.id,
                version: document.version,
                runtimeHash: resource.runtimeHash,
                capabilities: granted,
                priority: definition.priority,
                stateVersion: definition.stateVersion,
                create: contribution.create,
            }));
        }
        for (const id of declaredSystems.keys()) {
            if (!seenSystems.has(id)) {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin did not register declared system "${id}".`, {
                    ...fields,
                    contributionId: id,
                });
            }
        }
        const metadata = Object.freeze({
            pluginId: document.id,
            version: document.version,
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            capabilities: granted,
            units: Object.freeze([...adapterClasses.keys()].sort(comparePluginText)),
            systems: Object.freeze(systemFactories.map((entry) => entry.id).sort(comparePluginText)),
            systemFactories: Object.freeze(systemFactories),
        });
        this.blockRegistry = candidate;
        this.packages.set(document.id, metadata);
        return Object.freeze({ registry: candidate, plugin: metadata });
    }

    seal() {
        this.sealed = true;
        this.blockRegistry.seal();
        return this;
    }
}
