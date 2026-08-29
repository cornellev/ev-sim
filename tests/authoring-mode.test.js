import assert from "node:assert/strict";
import test from "node:test";

import {
    ADVANCED_AUTHORING_STORAGE_KEY,
    readAdvancedAuthoringPreference,
    validationIssueRequiresAdvanced,
    validationIssuesRequireAdvanced,
    writeAdvancedAuthoringPreference,
} from "../app/ui/authoringModeStorage.js";

function createMemoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
    };
}

test("advanced authoring preference defaults to false and persists in storage", () => {
    const storage = createMemoryStorage();
    assert.equal(readAdvancedAuthoringPreference(storage), false);

    writeAdvancedAuthoringPreference(true, storage);
    assert.equal(storage.getItem(ADVANCED_AUTHORING_STORAGE_KEY), "true");
    assert.equal(readAdvancedAuthoringPreference(storage), true);

    writeAdvancedAuthoringPreference(false, storage);
    assert.equal(readAdvancedAuthoringPreference(storage), false);
});

test("validationIssueRequiresAdvanced maps hidden authoring paths", () => {
    assert.equal(validationIssueRequiresAdvanced("sensorRig.mapFrameId"), true);
    assert.equal(validationIssueRequiresAdvanced("sensorRig.sensors.0.mountFrameId"), true);
    assert.equal(validationIssueRequiresAdvanced("sensorRig.sensors.0.calibration.gravity"), true);
    assert.equal(validationIssueRequiresAdvanced("sensorRig.sensors.0.id"), false);
    assert.equal(validationIssueRequiresAdvanced("clock.publishClock"), true);
    assert.equal(validationIssueRequiresAdvanced("clock.stepNs"), false);
    assert.equal(validationIssueRequiresAdvanced("topics.0.producer"), true);
    assert.equal(validationIssueRequiresAdvanced("topics.0.name"), false);
    assert.equal(validationIssueRequiresAdvanced("scripts.artifacts.0.expectedHash"), true);
    assert.equal(validationIssueRequiresAdvanced("assertions.0.tolerance"), true);
    assert.equal(validationIssueRequiresAdvanced("parameters.0.target.path"), true);
});

test("validationIssuesRequireAdvanced detects any hidden issue", () => {
    assert.equal(validationIssuesRequireAdvanced([
        { path: "name", message: "Required" },
        { path: "sensorRig.sensors.0.noise.bias", message: "Invalid" },
    ]), true);
    assert.equal(validationIssuesRequireAdvanced([
        { path: "name", message: "Required" },
        { path: "sensorRig.sensors.0.id", message: "Duplicate" },
    ]), false);
});
