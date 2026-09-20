export const PLUGIN_ERROR_CODES = Object.freeze({
    DOCUMENT_INVALID: "PLUGIN_DOCUMENT_INVALID",
    COMPATIBILITY: "PLUGIN_COMPATIBILITY",
    CAPABILITY: "PLUGIN_CAPABILITY",
    IMPORT_INVALID: "PLUGIN_IMPORT_INVALID",
    INTEGRITY: "PLUGIN_INTEGRITY",
    REGISTRATION: "PLUGIN_REGISTRATION",
    ASYNC_HOOK: "PLUGIN_ASYNC_HOOK",
    STATE_INVALID: "PLUGIN_STATE_INVALID",
    EXECUTION: "PLUGIN_EXECUTION",
    UNAVAILABLE: "PLUGIN_FEATURE_UNAVAILABLE",
    RESOURCE: "PLUGIN_RESOURCE",
});

export class PluginError extends Error {
    constructor(code, message, {
        pluginId = null,
        packageHash = null,
        path = null,
        contributionId = null,
        details = null,
        scopeId = null,
        unitId = null,
        hook = null,
        requiresReset = false,
        cause = null,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = "PluginError";
        this.code = code;
        this.pluginId = pluginId;
        this.packageHash = packageHash;
        this.path = path;
        this.contributionId = contributionId;
        this.details = details;
        this.scopeId = scopeId;
        this.unitId = unitId;
        this.hook = hook;
        this.requiresReset = requiresReset === true;
    }
}

export function pluginError(code, message, fields = {}) {
    return new PluginError(code, message, fields);
}

export function assertSynchronous(value, hook, fields = {}) {
    if (value && (typeof value === "object" || typeof value === "function")
        && typeof value.then === "function") {
        if (typeof value.catch === "function") value.catch(() => {});
        throw pluginError(
            PLUGIN_ERROR_CODES.ASYNC_HOOK,
            `Plugin hook "${hook}" must be synchronous.`,
            fields,
        );
    }
    return value;
}
