import assert from "node:assert/strict";
import test from "node:test";

import {
    APP_VIEWS,
    THREE_D_MODES,
    getActiveWorkspaceKey,
    isThreeDMode,
    managedRunBlocksNavigation,
    parseWorkspaceKey,
    workspaceAllowedDuringManagedRun,
} from "../app/3d/viewState.js";

test("isThreeDMode accepts simulation and environment modes", () => {
    assert.equal(isThreeDMode(THREE_D_MODES.SIMULATION), true);
    assert.equal(isThreeDMode(THREE_D_MODES.ENVIRONMENT), true);
    assert.equal(isThreeDMode("invalid"), false);
});

test("getActiveWorkspaceKey maps scripting and 3D submodes", () => {
    assert.equal(getActiveWorkspaceKey(APP_VIEWS.SCRIPTING, THREE_D_MODES.SIMULATION), "scripting");
    assert.equal(getActiveWorkspaceKey(APP_VIEWS.SCENARIOS, THREE_D_MODES.SIMULATION), "scenarios");
    assert.equal(getActiveWorkspaceKey(APP_VIEWS.LOGS, THREE_D_MODES.SIMULATION), "logs");
    assert.equal(getActiveWorkspaceKey(APP_VIEWS.EXPERIMENTS, THREE_D_MODES.SIMULATION), "experiments");
    assert.equal(getActiveWorkspaceKey(APP_VIEWS.MARKETPLACE, THREE_D_MODES.SIMULATION), "marketplace");
    assert.equal(getActiveWorkspaceKey(APP_VIEWS.THREE_D, THREE_D_MODES.SIMULATION), "3d:simulation");
    assert.equal(getActiveWorkspaceKey(APP_VIEWS.THREE_D, THREE_D_MODES.ENVIRONMENT), "3d:environment");
});

test("parseWorkspaceKey round-trips 3D submodes", () => {
    assert.deepEqual(parseWorkspaceKey("3d:simulation"), {
        view: APP_VIEWS.THREE_D,
        threeDMode: THREE_D_MODES.SIMULATION,
    });
    assert.deepEqual(parseWorkspaceKey("3d:environment"), {
        view: APP_VIEWS.THREE_D,
        threeDMode: THREE_D_MODES.ENVIRONMENT,
    });
    assert.deepEqual(parseWorkspaceKey("scripting"), {
        view: APP_VIEWS.SCRIPTING,
        threeDMode: null,
    });
    assert.deepEqual(parseWorkspaceKey("scenarios"), {
        view: APP_VIEWS.SCENARIOS,
        threeDMode: null,
    });
    assert.deepEqual(parseWorkspaceKey("logs"), {
        view: APP_VIEWS.LOGS,
        threeDMode: null,
    });
    assert.deepEqual(parseWorkspaceKey("experiments"), {
        view: APP_VIEWS.EXPERIMENTS,
        threeDMode: null,
    });
    assert.deepEqual(parseWorkspaceKey("marketplace"), {
        view: APP_VIEWS.MARKETPLACE,
        threeDMode: null,
    });
});

test("an open managed run keeps simulation and inspect workspaces available", () => {
    const open = { activeRunId: "run-1", status: "running" };
    assert.equal(managedRunBlocksNavigation(open), true);
    assert.equal(managedRunBlocksNavigation({ activeRunId: "run-1", status: "preparing" }), true);
    assert.equal(managedRunBlocksNavigation({ activeRunId: "run-1", status: "ready" }), true);
    assert.equal(managedRunBlocksNavigation({ activeRunId: "run-1", status: "paused" }), true);
    assert.equal(managedRunBlocksNavigation({ activeRunId: "run-1", status: "stopped" }), false);
    assert.equal(managedRunBlocksNavigation({ activeRunId: "run-1", status: "completed" }), false);
    assert.equal(managedRunBlocksNavigation({ activeRunId: "run-1", status: "failed" }), false);
    assert.equal(managedRunBlocksNavigation({ status: "running" }), false);
    assert.equal(managedRunBlocksNavigation({ activeRunId: null, status: "idle" }), false);

    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.THREE_D, THREE_D_MODES.SIMULATION), true);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.REPLAY), true);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.ANALYSIS), true);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.LOGS), true);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.THREE_D, THREE_D_MODES.ENVIRONMENT), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.VEHICLE_EDITOR), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.CONFIG), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.CONFIG, null, "ready"), true);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.CONFIG, null, "running"), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.CONFIG, null, "paused"), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.SCRIPTING, null, "ready"), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.THREE_D, THREE_D_MODES.ENVIRONMENT, "ready"), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.SCENARIOS), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.EXPERIMENTS), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.HEADLESS_RUNS), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.SCRIPTING), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.BINDINGS), false);
    assert.equal(workspaceAllowedDuringManagedRun(APP_VIEWS.MARKETPLACE), false);
});
