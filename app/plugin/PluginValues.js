import { PLUGIN_PORT_TYPES, ports } from "../plugin-api/ports.js";
import { clonePluginJson } from "./PluginJson.js";

const PORT_TYPE_SET = new Set(PLUGIN_PORT_TYPES);

function fail(path, expected) {
    throw new TypeError(`${path} must be ${expected}.`);
}

function plainObject(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        fail(path, "a plain object");
    }
    return value;
}

function finiteNumber(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "a finite number");
}

function finiteVector(value, labels, path) {
    const source = plainObject(value, path);
    for (const label of labels) finiteNumber(source[label], `${path}.${label}`);
}

export function assertPluginPortValue(type, value, path = "plugin value") {
    if (!PORT_TYPE_SET.has(type)) fail(path, `a value of a known concrete port type (received ${JSON.stringify(type)})`);
    if (type === "unit") {
        if (value !== ports.UNIT) fail(path, "the public UNIT token");
        return value;
    }
    clonePluginJson(value, path);
    if (type === "float64") finiteNumber(value, path);
    else if (type === "int32") {
        if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail(path, "a signed 32-bit integer");
    } else if (type === "boolean") {
        if (typeof value !== "boolean") fail(path, "a boolean");
    } else if (["string", "road_id", "texture_id"].includes(type)) {
        if (typeof value !== "string") fail(path, "a string");
    } else if (type === "vec2") finiteVector(value, ["x", "y"], path);
    else if (type === "vec3") finiteVector(value, ["x", "y", "z"], path);
    else if (type === "pose2d") {
        const source = plainObject(value, path);
        finiteVector(source.position, ["x", "y"], `${path}.position`);
        finiteNumber(source.yaw, `${path}.yaw`);
    } else if (type === "pose3d") {
        const source = plainObject(value, path);
        finiteVector(source.position, ["x", "y", "z"], `${path}.position`);
        finiteVector(source.rotation, ["x", "y", "z"], `${path}.rotation`);
        if (!["XYZ", "YZX", "ZXY", "XZY", "YXZ", "ZYX"].includes(source.rotation.order)) {
            fail(`${path}.rotation.order`, "a supported Euler order");
        }
    } else if (type === "actor_command") {
        const source = plainObject(value, path);
        if (typeof source.actorId !== "string") fail(`${path}.actorId`, "a string");
        finiteNumber(source.speedMps, `${path}.speedMps`);
        finiteNumber(source.steeringRad, `${path}.steeringRad`);
    } else if (type === "tex1d") {
        if (!Array.isArray(value)) fail(path, "an array of finite numbers");
        value.forEach((entry, index) => finiteNumber(entry, `${path}.${index}`));
    } else if (type.startsWith("array[")) {
        if (!Array.isArray(value)) fail(path, `an ${type} array`);
        const memberType = type.slice(6, -1);
        value.forEach((entry, index) => assertPluginPortValue(memberType, entry, `${path}.${index}`));
    }
    return value;
}

export function assertPluginSettingValue(setting, value, path = "plugin setting") {
    clonePluginJson(value, path);
    if (setting.valueType === "float64") finiteNumber(value, path);
    else if (setting.valueType === "int32") {
        if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail(path, "a signed 32-bit integer");
    } else if (setting.valueType === "boolean") {
        if (typeof value !== "boolean") fail(path, "a boolean");
    } else if (setting.valueType === "string") {
        if (typeof value !== "string") fail(path, "a string");
    } else if (setting.valueType === "enum") {
        if (typeof value !== "string" || !setting.options?.includes(value)) fail(path, "one of the declared enum options");
    } else if (setting.valueType === "port_type") {
        if (!PORT_TYPE_SET.has(value)) fail(path, "a concrete plugin port type");
    }
    if (typeof value === "number") {
        if (setting.min !== undefined && value < setting.min) fail(path, `greater than or equal to ${setting.min}`);
        if (setting.max !== undefined && value > setting.max) fail(path, `less than or equal to ${setting.max}`);
    }
    return value;
}

export function normalizePluginUnitState(definition, value, path = `${definition.type}.state`) {
    const source = plainObject(value, path);
    const settings = new Map((definition.settings ?? []).map((setting) => [setting.key, setting]));
    const result = {};
    for (const [key, entry] of Object.entries(source)) {
        const setting = settings.get(key);
        if (!setting) throw new TypeError(`${path}.${key} has no declared setting.`);
        assertPluginSettingValue(setting, entry, `${path}.${key}`);
        result[key] = clonePluginJson(entry, `${path}.${key}`);
    }
    return result;
}
