import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";

export const PLANT_ABI_VERSION = 1;
export const PLANT_DYNAMIC_BICYCLE_MODEL = "dynamic-bicycle-v1";
export const PLANT_STATE_LENGTH = 13;
export const PLANT_BUFFER_LENGTH = 45;
export const PLANT_MODULE_MAX_BYTES = 4 * 1024 * 1024;
export const PLANT_STEP_CAPABILITY = "plant.step";

export const PLANT_PARAMETER_SOURCES = Object.freeze([
    "default",
    "kinematics.wheelbase",
    "kinematics.maxSteeringAngle",
    "kinematics.maxSpeed",
    "kinematics.maxAcceleration",
    "kinematics.maxDeceleration",
    "kinematics.maxJerk",
    "kinematics.maxSteeringRate",
    "boundingBox.size.x",
    "boundingBox.size.y",
    "boundingBox.size.z",
]);

const PLANT_SOURCE_SET = new Set(PLANT_PARAMETER_SOURCES);
const REQUIRED_EXPORTS = Object.freeze([
    ["memory", "memory"],
    ["cev_plant_abi", "function"],
    ["cev_plant_buffer", "function"],
    ["cev_plant_step", "function"],
]);

function moduleBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plant module bytes are required.");
}

export function assertPlantModuleBytes(value, path = "plant.wasm") {
    const bytes = moduleBytes(value);
    if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plant module "${path}" is not a WebAssembly binary.`, { path });
    }
    if (bytes.byteLength > PLANT_MODULE_MAX_BYTES) {
        throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plant module "${path}" exceeds ${PLANT_MODULE_MAX_BYTES} bytes.`, { path });
    }
    let wasmModule;
    try {
        if (!WebAssembly.validate(bytes)) {
            throw new Error("validation failed");
        }
        wasmModule = new WebAssembly.Module(bytes);
    } catch (error) {
        throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plant module "${path}" is not a valid WebAssembly module.`, {
            path,
            cause: error,
        });
    }
    const imports = WebAssembly.Module.imports(wasmModule);
    if (imports.length > 0) {
        throw pluginError(
            PLUGIN_ERROR_CODES.INTEGRITY,
            `Plant module "${path}" must have zero imports.`,
            { path },
        );
    }
    const exports = new Map(WebAssembly.Module.exports(wasmModule).map((entry) => [entry.name, entry.kind]));
    for (const [name, kind] of REQUIRED_EXPORTS) {
        if (exports.get(name) !== kind) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plant module "${path}" must export ${kind} ${name}.`, { path });
        }
    }
    let instance;
    try {
        instance = new WebAssembly.Instance(wasmModule, {});
        const abi = instance.exports.cev_plant_abi();
        const pointer = instance.exports.cev_plant_buffer();
        if (abi !== PLANT_ABI_VERSION) {
            throw new Error(`ABI ${abi} is not ${PLANT_ABI_VERSION}.`);
        }
        if (!Number.isInteger(pointer) || pointer < 0 || pointer % 8 !== 0) {
            throw new Error("cev_plant_buffer is not an 8-byte-aligned address.");
        }
        const needed = pointer + PLANT_BUFFER_LENGTH * 8;
        if (instance.exports.memory.buffer.byteLength < needed) {
            throw new Error("Plant buffer does not fit in the exported memory.");
        }
    } catch (error) {
        if (error?.code === PLUGIN_ERROR_CODES.INTEGRITY) throw error;
        throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plant module "${path}" failed ABI checks: ${error.message}`, {
            path,
            cause: error,
        });
    }
    return bytes;
}

export function readPlantParameterSource(manifest, source) {
    if (!PLANT_SOURCE_SET.has(source) || source === "default") {
        throw new TypeError(`Unsupported plant parameter source "${source}".`);
    }
    let value = manifest;
    for (const part of source.split(".")) value = value?.[part];
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new TypeError(`Plant parameter source "${source}" is not a finite number.`);
    }
    return number;
}

export function resolvePlantParameters(parameters = [], manifest = {}) {
    return Float64Array.from(parameters.map((parameter) => (
        parameter.source === "default" ? parameter.default : readPlantParameterSource(manifest, parameter.source)
    )));
}
