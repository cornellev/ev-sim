/**
 * Vehicle-editor preferences in localStorage. Pane layout and display options
 * are UI state. They are not written into a vehicle manifest.
 */

export const VEHICLE_EDITOR_PREFERENCE_KEYS = Object.freeze({
    PANE_LAYOUT: "cev-sim.ui.vehicleEditor.paneLayout",
    DISPLAY: "cev-sim.ui.vehicleEditor.display",
    HIERARCHY_EXPANDED: "cev-sim.ui.vehicleEditor.hierarchyExpanded",
    WHEELS_PANEL: "cev-sim.ui.vehicleEditor.wheelsPanel",
});

export function readVehicleEditorPreference(key, fallback = null, storage = null) {
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

export function writeVehicleEditorPreference(key, value, storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        store?.setItem?.(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch {
        // Ignore storage failures (private mode, SSR).
    }
}
