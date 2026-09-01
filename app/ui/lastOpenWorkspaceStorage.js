export const LAST_OPEN_WORKSPACE_KEYS = Object.freeze({
    "run-config": "cev-sim.ui.lastOpen.run-config",
    scenarios: "cev-sim.ui.lastOpen.scenarios",
    "experiment-suite": "cev-sim.ui.lastOpen.experiment-suite",
    "headless-runs": "cev-sim.ui.lastOpen.headless-runs",
});

export function lastOpenWorkspaceStorageKey(workspace) {
    return LAST_OPEN_WORKSPACE_KEYS[workspace] ?? `cev-sim.ui.lastOpen.${workspace}`;
}

function storageStore(storage = null) {
    return storage ?? globalThis.localStorage;
}

export function readLastOpenWorkspaceId(workspace, storage = null) {
    try {
        const value = storageStore(storage)?.getItem?.(lastOpenWorkspaceStorageKey(workspace));
        const id = String(value || "").trim();
        return id || null;
    } catch {
        return null;
    }
}

export function writeLastOpenWorkspaceId(workspace, id, storage = null) {
    try {
        const store = storageStore(storage);
        const key = lastOpenWorkspaceStorageKey(workspace);
        const next = String(id || "").trim();
        if (!next) {
            store?.removeItem?.(key);
            return;
        }
        store?.setItem?.(key, next);
    } catch {
        // Ignore storage failures (private mode, SSR).
    }
}

export function pickLastOpenCatalogId(entries = [], preferredId = null) {
    const ids = (Array.isArray(entries) ? entries : [])
        .map((entry) => (typeof entry === "string" ? entry : entry?.id))
        .map((id) => String(id || "").trim())
        .filter(Boolean);
    const preferred = String(preferredId || "").trim();
    if (preferred && ids.includes(preferred)) return preferred;
    return ids[0] ?? null;
}
