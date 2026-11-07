import { ADVANCED_AUTHORING_STORAGE_KEY, readAdvancedAuthoringPreference } from "../ui/authoringModeStorage.js";

export const RUN_CONFIG_MODE_STORAGE_KEY = "cev-sim.ui.runConfig.mode";

export const RUN_CONFIG_MODE_FALLBACK = "simple";

// A failed write stays for this page load. Storage events must not clear it.
let sessionMode = null;
const listeners = new Set();

function emitRunConfigMode() {
    for (const listener of listeners) listener();
}

function onRunConfigModeStorage(event) {
    if (event?.key && event.key !== RUN_CONFIG_MODE_STORAGE_KEY && event.key !== ADVANCED_AUTHORING_STORAGE_KEY) return;
    if (sessionMode) return;
    emitRunConfigMode();
}

export function subscribeRunConfigMode(listener) {
    listeners.add(listener);
    if (listeners.size === 1 && typeof window !== "undefined") {
        window.addEventListener("storage", onRunConfigModeStorage);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined") {
            window.removeEventListener("storage", onRunConfigModeStorage);
        }
    };
}

export function readResolvedRunConfigMode(storage = null) {
    if (sessionMode === "simple" || sessionMode === "advanced") return sessionMode;
    return resolveRunConfigMode({
        stored: readRunConfigModePreference(storage),
        advancedAuthoring: readAdvancedAuthoringPreference(storage),
    });
}

export function chooseRunConfigMode(next, storage = null) {
    if ((next !== "simple" && next !== "advanced") || next === readResolvedRunConfigMode(storage)) return;
    sessionMode = writeRunConfigModePreference(next, storage) ? null : next;
    emitRunConfigMode();
}

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
