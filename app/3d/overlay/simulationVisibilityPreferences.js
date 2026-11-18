/**
 * Simulation visibility preferences in localStorage. These switches are
 * browser UI state. They are not written into a run manifest, world hash,
 * or environment document. The simulation kernel never reads this store.
 */

import { SIMULATION_VISIBILITY_GROUPS } from "./simulationVisibility.js";

export const SIMULATION_VISIBILITY_PREFERENCE_KEY = "cev-sim.ui.simulation.visibility";

const VISIBILITY_KEYS = SIMULATION_VISIBILITY_GROUPS.flatMap((group) => group.options);

const AUTONOMY_KEYS = [
    "oracle",
    "candidate",
    "ekf",
    "estimateClone",
    "lanes",
    "controls",
    "pastTrajectories",
    "oracleOccupancy",
    "lidarOccupancy",
    "stackOccupancy",
];

const DEBUG_KEYS = ["sensorMarkers", "originMarker"];

function pickBooleans(source, keys) {
    const patch = {};
    if (!source || typeof source !== "object") return patch;
    for (const key of keys) {
        if (typeof source[key] === "boolean") patch[key] = source[key];
    }
    return patch;
}

function knownBooleans(source) {
    return pickBooleans(source, VISIBILITY_KEYS);
}

export function readSimulationVisibilityPreference(storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        if (!store?.getItem) return {};
        const raw = store.getItem(SIMULATION_VISIBILITY_PREFERENCE_KEY);
        if (raw === null || raw === undefined) return {};
        return knownBooleans(JSON.parse(raw));
    } catch {
        return {};
    }
}

export function writeSimulationVisibilityPreference(patch, storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        if (!store?.getItem || !store?.setItem) return;
        const next = { ...readSimulationVisibilityPreference(store), ...knownBooleans(patch) };
        store.setItem(SIMULATION_VISIBILITY_PREFERENCE_KEY, JSON.stringify(next));
    } catch {
        // Ignore storage failures (private mode, SSR).
    }
}

/**
 * Apply only the keys present in `stored`. Diagnostics go through the run
 * session when one is attached, so a later `attachData` does not clear them.
 */
export function applySimulationVisibilityPreference(sim, runController, stored) {
    const autonomy = pickBooleans(stored, AUTONOMY_KEYS);
    if (Object.keys(autonomy).length > 0) sim?.setAutonomyOverlayEnabled?.(autonomy);
    const debug = pickBooleans(stored, DEBUG_KEYS);
    if (Object.keys(debug).length > 0) sim?.setDebugVisuals?.(debug);
    if (typeof stored?.scenarioDiagnostics !== "boolean") return;
    if (runController?.setScenarioDiagnosticsEnabled) {
        runController.setScenarioDiagnosticsEnabled(stored.scenarioDiagnostics);
        return;
    }
    sim?.setScenarioDiagnosticsEnabled?.(stored.scenarioDiagnostics);
}

/** Narrow layouts hide both panels. That hide is not a saved preference. */
export function panelVisibilityForLayout(compact, preferred = {}) {
    if (compact) return { vehicleHierarchy: false, sensorPanel: false };
    return {
        vehicleHierarchy: preferred?.vehicleHierarchy !== false,
        sensorPanel: preferred?.sensorPanel !== false,
    };
}
