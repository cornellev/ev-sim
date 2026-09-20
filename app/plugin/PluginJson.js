import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";

function visit(value, path, seen) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, `${path} must contain only finite numbers.`, { path });
        }
        return value;
    }
    if (!value || typeof value !== "object" || typeof value === "bigint") {
        throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, `${path} is outside the plugin JSON state model.`, { path });
    }
    if (seen.has(value)) {
        throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, `${path} contains a cycle.`, { path });
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            if (Object.keys(value).length !== value.length) {
                throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, `${path} must be a dense array.`, { path });
            }
            return value.map((entry, index) => visit(entry, `${path}.${index}`, seen));
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) {
            throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, `${path} must contain only plain objects.`, { path });
        }
        const result = {};
        for (const key of Object.keys(value)) {
            result[key] = visit(value[key], `${path}.${key}`, seen);
        }
        return result;
    } finally {
        seen.delete(value);
    }
}

export function clonePluginJson(value, path = "plugin state") {
    return visit(value, path, new WeakSet());
}

export function assertPluginJson(value, path = "plugin state") {
    visit(value, path, new WeakSet());
    return value;
}
