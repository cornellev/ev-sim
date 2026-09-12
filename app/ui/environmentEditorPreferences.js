/**
 * Environment-editor preferences persisted in localStorage. Follows the
 * authoring-mode storage pattern: injectable storage for tests, silent on
 * failures. `groupFrameFields` gates the bespoke editable group-frame inputs
 * that ED-03's generic fields replace.
 */

export const ENVIRONMENT_EDITOR_PREFERENCE_KEYS = Object.freeze({
    GROUP_FRAME_FIELDS: "cev-sim.ui.environmentEditor.groupFrameFields",
    HIERARCHY_EXPANDED: "cev-sim.ui.environmentEditor.hierarchyExpanded",
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

export function readGroupFrameFieldsPreference(storage = null) {
    return readEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.GROUP_FRAME_FIELDS, false, storage) === true;
}

export function writeGroupFrameFieldsPreference(enabled, storage = null) {
    writeEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.GROUP_FRAME_FIELDS, enabled === true, storage);
}
