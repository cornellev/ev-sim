export const RUN_CONFIG_MODE_STORAGE_KEY = "cev-sim.ui.runConfig.mode";

// CFG-06 is the change that sets this to "simple".
export const RUN_CONFIG_MODE_FALLBACK = "advanced";

export function readRunConfigModePreference(storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        if (!store?.getItem) return null;
        const value = store.getItem(RUN_CONFIG_MODE_STORAGE_KEY);
        return value === "simple" || value === "advanced" ? value : null;
    } catch {
        return null;
    }
}

export function writeRunConfigModePreference(mode, storage = null) {
    if (mode !== "simple" && mode !== "advanced") return false;
    try {
        const store = storage ?? globalThis.localStorage;
        if (!store?.setItem) return false;
        store.setItem(RUN_CONFIG_MODE_STORAGE_KEY, mode);
        return true;
    } catch {
        return false;
    }
}

export function resolveRunConfigMode({
    stored = null,
    advancedAuthoring = false,
    fallback = RUN_CONFIG_MODE_FALLBACK,
} = {}) {
    if (stored === "simple" || stored === "advanced") return stored;
    if (advancedAuthoring === true) return "advanced";
    return fallback === "simple" ? "simple" : "advanced";
}
