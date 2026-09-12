/**
 * Environment-editor preferences persisted in localStorage. Follows the
 * authoring-mode storage pattern: injectable storage for tests, silent on
 * failures. Preferences are session/UI state (pane layout, view options,
 * collapsed hierarchy groups, inspector sections); nothing here persists with
 * the environment.
 */

export const ENVIRONMENT_EDITOR_PREFERENCE_KEYS = Object.freeze({
    HIERARCHY_EXPANDED: "cev-sim.ui.environmentEditor.hierarchyExpanded",
    PANE_LAYOUT: "cev-sim.ui.environmentEditor.paneLayout",
    VIEW_OPTIONS: "cev-sim.ui.environmentEditor.viewOptions",
    INSPECTOR_SECTIONS: "cev-sim.ui.environmentEditor.inspectorSections",
});

export function readEnvironmentEditorPreference(key, fallback = false, storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        if (!store?.getItem) return fallback;
        const raw = store.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        if (raw === "true") return true;
        if (raw === "false") return false;
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    } catch {
        return fallback;
    }
}

export function writeEnvironmentEditorPreference(key, value, storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        store?.setItem?.(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch {
        // Ignore storage failures (private mode, SSR).
    }
}
