const RESERVED_FIELDS = new Set(["plugins", "pluginPackages", "pluginRequirements"]);

function findPluginField(value, path = "$", seen = new WeakSet()) {
    if (!value || typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    try {
        if (!Array.isArray(value)) {
            if (value.identityProfile?.id === "world-bound-plugins") return `${path}.identityProfile`;
            if (value.dependencyHashes && Object.prototype.hasOwnProperty.call(value.dependencyHashes, "plugins")) {
                return `${path}.dependencyHashes.plugins`;
            }
            for (const key of Object.keys(value)) {
                if (RESERVED_FIELDS.has(key)) return `${path}.${key}`;
            }
        }
        for (const [key, child] of Object.entries(value)) {
            const found = findPluginField(child, `${path}.${key}`, seen);
            if (found) return found;
        }
        return null;
    } finally {
        seen.delete(value);
    }
}

export function assertManagedPluginsUnavailable(value, { context = "Managed plugin execution" } = {}) {
    const field = findPluginField(value);
    if (field) {
        const error = new Error(`${context} is unavailable until PLG-02; found plugin data at ${field}.`);
        error.code = "PLUGIN_EXECUTION_UNAVAILABLE";
        error.path = field;
        throw error;
    }
    return value;
}
