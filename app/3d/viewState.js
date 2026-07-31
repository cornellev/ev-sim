/** @typedef {"scripting" | "bindings" | "scenarios" | "experiments" | "replay" | "analysis" | "config" | "vehicle-editor" | "3d"} AppView */
/** @typedef {"simulation" | "environment"} ThreeDMode */

export const APP_VIEWS = {
    SCRIPTING: "scripting",
    BINDINGS: "bindings",
    REPLAY: "replay",
    ANALYSIS: "analysis",
    CONFIG: "config",
    SCENARIOS: "scenarios",
    EXPERIMENTS: "experiments",
    VEHICLE_EDITOR: "vehicle-editor",
    THREE_D: "3d",
};

export const THREE_D_MODES = {
    SIMULATION: "simulation",
    ENVIRONMENT: "environment",
};

/** @param {ThreeDMode} mode */
export function isThreeDMode(mode) {
    return mode === THREE_D_MODES.SIMULATION || mode === THREE_D_MODES.ENVIRONMENT;
}

/**
 * @param {AppView} view
 * @param {ThreeDMode} threeDMode
 * @returns {string}
 */
export function getActiveWorkspaceKey(view, threeDMode) {
    if (view === APP_VIEWS.SCRIPTING) return APP_VIEWS.SCRIPTING;
    if (view === APP_VIEWS.BINDINGS) return APP_VIEWS.BINDINGS;
    if (view === APP_VIEWS.REPLAY) return APP_VIEWS.REPLAY;
    if (view === APP_VIEWS.ANALYSIS) return APP_VIEWS.ANALYSIS;
    if (view === APP_VIEWS.CONFIG) return APP_VIEWS.CONFIG;
    if (view === APP_VIEWS.SCENARIOS) return APP_VIEWS.SCENARIOS;
    if (view === APP_VIEWS.EXPERIMENTS) return APP_VIEWS.EXPERIMENTS;
    if (view === APP_VIEWS.VEHICLE_EDITOR) return APP_VIEWS.VEHICLE_EDITOR;
    if (view === APP_VIEWS.THREE_D) return `3d:${threeDMode}`;
    return view;
}

/**
 * @param {string} workspaceKey
 * @returns {{ view: AppView, threeDMode: ThreeDMode | null }}
 */
export function parseWorkspaceKey(workspaceKey) {
    if (workspaceKey === APP_VIEWS.SCRIPTING) {
        return { view: APP_VIEWS.SCRIPTING, threeDMode: null };
    }

    if (workspaceKey === APP_VIEWS.BINDINGS) {
        return { view: APP_VIEWS.BINDINGS, threeDMode: null };
    }

    if (
        workspaceKey === APP_VIEWS.REPLAY
        || workspaceKey === APP_VIEWS.ANALYSIS
        || workspaceKey === APP_VIEWS.CONFIG
        || workspaceKey === APP_VIEWS.SCENARIOS
        || workspaceKey === APP_VIEWS.EXPERIMENTS
        || workspaceKey === APP_VIEWS.VEHICLE_EDITOR
    ) {
        return { view: workspaceKey, threeDMode: null };
    }

    if (workspaceKey.startsWith("3d:")) {
        const mode = workspaceKey.slice(3);
        if (isThreeDMode(mode)) {
            return { view: APP_VIEWS.THREE_D, threeDMode: mode };
        }
    }

    if (workspaceKey === APP_VIEWS.THREE_D) {
        return { view: APP_VIEWS.THREE_D, threeDMode: THREE_D_MODES.SIMULATION };
    }

    return { view: APP_VIEWS.SCRIPTING, threeDMode: null };
}
