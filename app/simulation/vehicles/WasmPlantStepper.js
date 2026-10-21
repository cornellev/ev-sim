import { sha256ExactBytes } from "../visual/VisualLayer.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../../plugin/PluginErrors.js";
import {
    PLANT_BUFFER_LENGTH,
    PLANT_STATE_LENGTH,
    resolvePlantParameters,
} from "../../plugin/PlantModule.js";

function plantFailure(message, definition, cause = null) {
    return pluginError(PLUGIN_ERROR_CODES.EXECUTION, message, {
        pluginId: definition?.ownership?.pluginId ?? null,
        packageHash: definition?.ownership?.packageHash ?? null,
        contributionId: definition?.id ?? null,
        hook: "step",
        requiresReset: true,
        cause,
    });
}

export async function compilePlantModules(plants = new Map()) {
    const compiled = new Map();
    const cache = new Map();
    for (const [id, definition] of plants) {
        const bytes = definition?.moduleBytes;
        if (!(bytes instanceof Uint8Array)) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plant "${id}" is missing its WebAssembly module.`, {
                pluginId: definition?.ownership?.pluginId ?? null,
                contributionId: id,
            });
        }
        const key = sha256ExactBytes(bytes);
        let wasmModule = cache.get(key);
        if (!wasmModule) {
            wasmModule = await WebAssembly.compile(bytes);
            cache.set(key, wasmModule);
        }
        compiled.set(id, wasmModule);
    }
    return compiled;
}

export function resolveVehiclePlantMount(manifest, plants, compiled = null) {
    const plantId = manifest?.dynamics?.plant || "";
    if (!plantId) return {};
    if (!(plants instanceof Map)) {
        const lock = manifest.pluginLocks?.find((entry) => entry.plants?.includes(plantId));
        return {
            unresolvedPluginPlant: true,
            plantPluginId: lock?.pluginId || "",
            plantRuntimeHash: lock?.runtimeHash || "",
        };
    }
    const record = plants.get(plantId);
    const wasmModule = compiled?.get(plantId);
    if (!record || !wasmModule) {
        throw pluginError(
            PLUGIN_ERROR_CODES.UNAVAILABLE,
            `Plant "${plantId}" is not available in this run.`,
            { pluginId: record?.ownership?.pluginId ?? null, contributionId: plantId },
        );
    }
    return {
        plantStepper: createPlantStepper(wasmModule, record, manifest),
        plantPluginId: record.ownership?.pluginId || "",
        plantRuntimeHash: record.ownership?.runtimeHash || "",
        plantModel: record.model || "",
    };
}

export function createPlantStepper(wasmModule, definition, manifest = {}) {
    if (!wasmModule || !definition) {
        throw pluginError(PLUGIN_ERROR_CODES.UNAVAILABLE, `Plant "${definition?.id ?? "unknown"}" is not available.`, {
            pluginId: definition?.ownership?.pluginId ?? null,
            contributionId: definition?.id ?? null,
        });
    }
    const parameters = resolvePlantParameters(definition.parameters ?? [], manifest);
    let instance = null;
    let view = null;

    const bufferView = () => {
        const pointer = instance.exports.cev_plant_buffer();
        if (!Number.isInteger(pointer) || pointer < 0 || pointer % 8 !== 0) {
            throw plantFailure(`Plant "${definition.id}" returned an unaligned buffer.`, definition);
        }
        return new Float64Array(instance.exports.memory.buffer, pointer, PLANT_BUFFER_LENGTH);
    };

    const instantiate = () => {
        instance = new WebAssembly.Instance(wasmModule, {});
        view = bufferView();
    };

    instantiate();
    return {
        step(state, dt) {
            if (!(state instanceof Float64Array) || state.length < PLANT_STATE_LENGTH) {
                throw plantFailure(`Plant "${definition.id}" requires a ${PLANT_STATE_LENGTH}-value state.`, definition);
            }
            view = bufferView();
            view.set(state.subarray(0, PLANT_STATE_LENGTH), 0);
            view.set(parameters, PLANT_STATE_LENGTH);
            let code;
            try {
                code = instance.exports.cev_plant_step(parameters.length, dt);
            } catch (error) {
                throw plantFailure(`Plant "${definition.id}" failed during step.`, definition, error);
            }
            if (code !== 0) {
                throw plantFailure(`Plant "${definition.id}" rejected the step with code ${code}.`, definition);
            }
            const next = bufferView().slice(0, PLANT_STATE_LENGTH);
            for (const value of next) {
                if (!Number.isFinite(value)) {
                    throw plantFailure(`Plant "${definition.id}" produced a non-finite state.`, definition);
                }
            }
            return next;
        },
        reset() {
            instantiate();
        },
    };
}
