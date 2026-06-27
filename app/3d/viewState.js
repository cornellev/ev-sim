/** @typedef {"scripting" | "3d"} AppView */
/** @typedef {"simulation" | "environment"} ThreeDMode */

export const APP_VIEWS = {
    SCRIPTING: "scripting",
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
