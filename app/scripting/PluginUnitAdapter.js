import { UnitBlock as HostUnitBlock } from "./ScriptManager.js";
import { BlockOutput as PluginBlockOutput } from "../plugin-api/BlockOutput.js";
import {
    initializePluginUnit,
    pluginUnitPortSnapshot,
    revokePluginUnit,
} from "../plugin-api/UnitBlock.js";
import { clonePluginJson } from "../plugin/PluginJson.js";
import { PLUGIN_ERROR_CODES, assertSynchronous, pluginError } from "../plugin/PluginErrors.js";
import { assertPluginPortValue, normalizePluginUnitState } from "../plugin/PluginValues.js";

const instances = new WeakMap();

function samePorts(actual, expected) {
    const ordered = (value) => Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify({ inputs: ordered(actual.inputs), outputs: ordered(actual.outputs) })
        === JSON.stringify({ inputs: ordered(expected.inputs), outputs: ordered(expected.outputs) });
}

function invoke(instance, name, args, fields) {
    try {
        return assertSynchronous(instance[name](...args), name, fields);
    } catch (error) {
        if (error?.code) throw error;
        throw pluginError(PLUGIN_ERROR_CODES.EXECUTION, `Plugin unit hook "${name}" failed: ${error.message}`, {
            ...fields,
            hook: name,
            requiresReset: name === "execute",
            cause: error,
        });
    }
}

function stateValue(definition, value, path, fields) {
    try {
        return normalizePluginUnitState(definition, value, path);
    } catch (error) {
        if (error?.code === PLUGIN_ERROR_CODES.STATE_INVALID) throw error;
        throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, error.message, { ...fields, path, cause: error });
    }
}

export function createPluginUnitAdapterClass({
    definition,
    blockClass,
    ownership,
    createFacade = null,
    onDispose = null,
}) {
    const fields = {
        pluginId: ownership.pluginId,
        packageHash: ownership.packageHash ?? null,
        contributionId: definition.type,
    };
    const expectedPorts = definition.ports ?? { inputs: {}, outputs: {} };
    const runtimeFields = (adapter) => ({
        ...fields,
        scopeId: adapter?.manager?.getScopeId?.() ?? adapter?.manager?.scopeId ?? null,
        unitId: adapter?.uuid ?? null,
    });

    return class PluginUnitAdapter extends HostUnitBlock {
        static blockType = definition.type;
        static pluginOwnership = ownership;
        static pluginDefinition = definition;

        register() {
            for (const [label, type] of Object.entries(expectedPorts.inputs ?? {})) this.registerInput(label, type);
            for (const [label, type] of Object.entries(expectedPorts.outputs ?? {})) this.registerOutput(label, type);
        }

        constructor(uuid) {
            super(uuid);
            const instance = new blockClass(uuid);
            try {
                const helpers = Object.freeze({
                    readSignal: (path, options = {}) => this.manager?.readSignal?.(path, options),
                    getContext: () => {
                        const context = this.manager?.getRuntimeContext?.() ?? {};
                        return {
                            scopeId: context.scopeId ?? null,
                            stepIndex: context.stepIndex ?? context.step ?? 0,
                            simulationTimeNs: context.simulationTimeNs ?? context.timeNs ?? 0,
                            stepNs: context.stepNs ?? 0,
                        };
                    },
                });
                const facade = Object.freeze(createFacade ? createFacade(helpers, { adapter: this }) : {
                    readSignal: helpers.readSignal,
                    getContext: helpers.getContext,
                });
                const registration = initializePluginUnit(instance, {
                    uuid,
                    facade,
                    readInput: (label) => this.getInput(label),
                    hasInput: (label) => this.hasInput(label),
                });
                assertSynchronous(registration, "register", fields);
                const actualPorts = pluginUnitPortSnapshot(instance);
                if (!samePorts(actualPorts, expectedPorts)) {
                    throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin unit "${definition.type}" ports do not match its descriptor.`, fields);
                }
                invoke(instance, "hydrateState", [stateValue(definition, definition.defaults ?? {}, `${definition.type}.defaults`, fields)], fields);
                instances.set(this, { instance, disposed: false });
            } catch (error) {
                try {
                    assertSynchronous(instance.dispose(), "dispose", fields);
                } catch {
                    // Preserve the initialization failure while still revoking the bridge.
                }
                revokePluginUnit(instance);
                throw error;
            }
        }

        serializeState() {
            const record = instances.get(this);
            if (!record) return clonePluginJson(definition.defaults ?? {});
            const activeFields = runtimeFields(this);
            return stateValue(definition, invoke(record.instance, "serializeState", [], activeFields), `${definition.type}.state`, activeFields);
        }

        hydrateState(state = {}) {
            const record = instances.get(this);
            if (!record) return;
            const activeFields = runtimeFields(this);
            const next = stateValue(definition, { ...definition.defaults, ...state }, `${definition.type}.state`, activeFields);
            invoke(record.instance, "hydrateState", [next], activeFields);
        }

        serializeRuntimeState() {
            const record = instances.get(this);
            if (!record) return {};
            return clonePluginJson(invoke(record.instance, "serializeRuntimeState", [], runtimeFields(this)), `${definition.type}.runtimeState`);
        }

        hydrateRuntimeState(state = {}) {
            const record = instances.get(this);
            if (!record) return;
            invoke(record.instance, "hydrateRuntimeState", [clonePluginJson(state, `${definition.type}.runtimeState`)], runtimeFields(this));
        }

        valid() {
            const record = instances.get(this);
            return record ? Boolean(invoke(record.instance, "valid", [], runtimeFields(this))) : false;
        }

        execute() {
            const record = instances.get(this);
            if (!record || record.disposed) throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, "Plugin unit is disposed.", fields);
            const activeFields = runtimeFields(this);
            const output = invoke(record.instance, "execute", [], activeFields);
            if (!(output instanceof PluginBlockOutput)) {
                throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, `Plugin unit "${definition.type}" must return a BlockOutput.`, fields);
            }
            for (const [label, value] of Object.entries(output.map)) {
                if (!Object.prototype.hasOwnProperty.call(expectedPorts.outputs ?? {}, label)) {
                    throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, `Plugin unit produced undeclared output "${label}".`, fields);
                }
                try {
                    assertPluginPortValue(expectedPorts.outputs[label], value, `${definition.type}.outputs.${label}`);
                } catch (error) {
                    if (error?.code === PLUGIN_ERROR_CODES.STATE_INVALID) throw error;
                    throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, error.message, { ...activeFields, path: `${definition.type}.outputs.${label}`, cause: error });
                }
            }
            return output;
        }

        dispose() {
            const record = instances.get(this);
            if (!record || record.disposed) return;
            record.disposed = true;
            try {
                invoke(record.instance, "dispose", [], runtimeFields(this));
            } finally {
                revokePluginUnit(record.instance);
                onDispose?.(this);
            }
        }
    };
}
