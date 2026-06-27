import assert from "node:assert/strict";
import test from "node:test";

import {
    APP_VIEWS,
    THREE_D_MODES,
    getActiveWorkspaceKey,
    isThreeDMode,
    parseWorkspaceKey,
} from "../app/3d/viewState.js";

test("isThreeDMode accepts simulation and environment modes", () => {
    assert.equal(isThreeDMode(THREE_D_MODES.SIMULATION), true);
    assert.equal(isThreeDMode(THREE_D_MODES.ENVIRONMENT), true);
    assert.equal(isThreeDMode("invalid"), false);
});

test("getActiveWorkspaceKey maps scripting and 3D submodes", () => {
    assert.equal(getActiveWorkspaceKey(APP_VIEWS.SCRIPTING, THREE_D_MODES.SIMULATION), "scripting");
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
});
