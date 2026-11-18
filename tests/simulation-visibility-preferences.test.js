import assert from "node:assert/strict";
import test from "node:test";

import { SIMULATION_VISIBILITY_GROUPS } from "../app/3d/overlay/simulationVisibility.js";
import {
    SIMULATION_VISIBILITY_PREFERENCE_KEY,
    applySimulationVisibilityPreference,
    panelVisibilityForLayout,
    readSimulationVisibilityPreference,
    writeSimulationVisibilityPreference,
} from "../app/3d/overlay/simulationVisibilityPreferences.js";

const OPTION_IDS = SIMULATION_VISIBILITY_GROUPS.flatMap((group) => group.options);
const PANEL_IDS = ["vehicleHierarchy", "sensorPanel"];

function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        getItem(key) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
        },
        setItem(key, value) {
            data[key] = String(value);
        },
        data,
    };
}

test("visibility preferences keep known booleans and drop everything else", () => {
    const store = memoryStorage();
    writeSimulationVisibilityPreference({
        oracle: false,
        physics: true,
        lanes: "yes",
        sensorMarkers: true,
        extra: false,
    }, store);
    assert.deepEqual(readSimulationVisibilityPreference(store), { oracle: false, sensorMarkers: true });

    writeSimulationVisibilityPreference({ lanes: false }, store);
    assert.deepEqual(readSimulationVisibilityPreference(store), {
        oracle: false,
        sensorMarkers: true,
        lanes: false,
    });

    store.setItem(SIMULATION_VISIBILITY_PREFERENCE_KEY, "not-json");
    assert.deepEqual(readSimulationVisibilityPreference(store), {});
    writeSimulationVisibilityPreference({ originMarker: false }, store);
    assert.deepEqual(readSimulationVisibilityPreference(store), { originMarker: false });

    store.setItem(SIMULATION_VISIBILITY_PREFERENCE_KEY, JSON.stringify(["oracle", { oracle: false }]));
    assert.deepEqual(readSimulationVisibilityPreference(store), {});
    store.setItem(SIMULATION_VISIBILITY_PREFERENCE_KEY, JSON.stringify({ oracle: false, sensorMarkers: "no" }));
    assert.deepEqual(readSimulationVisibilityPreference(store), { oracle: false });
});

test("visibility preference storage failures fall back without throwing", () => {
    const broken = {
        getItem() {
            throw new Error("storage blocked");
        },
        setItem() {
            throw new Error("storage blocked");
        },
    };
    assert.deepEqual(readSimulationVisibilityPreference(broken), {});
    assert.deepEqual(readSimulationVisibilityPreference({}), {});
    assert.doesNotThrow(() => writeSimulationVisibilityPreference({ oracle: false }, broken));
    assert.doesNotThrow(() => writeSimulationVisibilityPreference({ oracle: false }, {}));
});

test("apply sends only present keys and routes diagnostics through the run session", () => {
    const calls = [];
    const sim = {
        setAutonomyOverlayEnabled(patch) { calls.push(["autonomy", patch]); },
        setDebugVisuals(patch) { calls.push(["debug", patch]); },
        setScenarioDiagnosticsEnabled(value) { calls.push(["engine", value]); },
    };
    const runController = {
        setScenarioDiagnosticsEnabled(value) { calls.push(["run", value]); },
    };

    applySimulationVisibilityPreference(sim, runController, {});
    applySimulationVisibilityPreference(sim, runController, null);
    applySimulationVisibilityPreference(sim, runController, { physics: true, lanes: "yes" });
    assert.deepEqual(calls, []);

    applySimulationVisibilityPreference(sim, runController, {
        oracle: false,
        sensorMarkers: false,
        scenarioDiagnostics: true,
        vehicleHierarchy: false,
    });
    assert.deepEqual(calls, [
        ["autonomy", { oracle: false }],
        ["debug", { sensorMarkers: false }],
        ["run", true],
    ]);

    applySimulationVisibilityPreference(sim, null, { scenarioDiagnostics: false });
    assert.deepEqual(calls.at(-1), ["engine", false]);
});

test("every visibility menu switch is stored, and non-panel switches reach one setter", () => {
    const store = memoryStorage();
    const patch = Object.fromEntries(OPTION_IDS.map((id) => [id, false]));
    writeSimulationVisibilityPreference(patch, store);
    const stored = readSimulationVisibilityPreference(store);
    assert.deepEqual(stored, patch);

    const seen = [];
    const sim = {
        setAutonomyOverlayEnabled(value) { seen.push(...Object.keys(value)); },
        setDebugVisuals(value) { seen.push(...Object.keys(value)); },
        setScenarioDiagnosticsEnabled() { seen.push("engine-diagnostics"); },
    };
    applySimulationVisibilityPreference(sim, {
        setScenarioDiagnosticsEnabled() { seen.push("scenarioDiagnostics"); },
    }, stored);
    assert.deepEqual(seen.sort(), OPTION_IDS.filter((id) => !PANEL_IDS.includes(id)).sort());
    assert.equal(seen.includes("engine-diagnostics"), false);
});

test("compact layout hides panels without changing the preferred values", () => {
    const preferred = { vehicleHierarchy: false, sensorPanel: true, oracle: false };
    const hidden = panelVisibilityForLayout(true, preferred);
    assert.deepEqual(hidden, { vehicleHierarchy: false, sensorPanel: false });
    assert.deepEqual(preferred, { vehicleHierarchy: false, sensorPanel: true, oracle: false });
    assert.deepEqual(panelVisibilityForLayout(false, preferred), {
        vehicleHierarchy: false,
        sensorPanel: true,
    });
    assert.deepEqual(panelVisibilityForLayout(false, {}), {
        vehicleHierarchy: true,
        sensorPanel: true,
    });
    assert.deepEqual(panelVisibilityForLayout(false, null), {
        vehicleHierarchy: true,
        sensorPanel: true,
    });
});
