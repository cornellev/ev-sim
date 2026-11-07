import assert from "node:assert/strict";
import test from "node:test";

import { ADVANCED_AUTHORING_STORAGE_KEY } from "../app/ui/authoringModeStorage.js";
import {
    RUN_CONFIG_MODE_STORAGE_KEY,
    readRunConfigModePreference,
    resolveRunConfigMode,
    writeRunConfigModePreference,
} from "../app/config/runConfigMode.js";

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

test("explicit run configuration mode wins over the global advanced preference", () => {
    assert.equal(resolveRunConfigMode({ stored: "simple", advancedAuthoring: true }), "simple");
    assert.equal(resolveRunConfigMode({ stored: "advanced", advancedAuthoring: false }), "advanced");
});

test("missing run mode honors global advanced and otherwise defaults to simple", () => {
    assert.equal(resolveRunConfigMode({ stored: null, advancedAuthoring: true }), "advanced");
    assert.equal(resolveRunConfigMode({ stored: null, advancedAuthoring: false }), "simple");
});

test("invalid stored mode is ignored and a write does not touch advanced authoring", () => {
    const storage = createMemoryStorage({
        [RUN_CONFIG_MODE_STORAGE_KEY]: "test-ci",
        [ADVANCED_AUTHORING_STORAGE_KEY]: "true",
    });
    assert.equal(readRunConfigModePreference(storage), null);
    assert.equal(resolveRunConfigMode({
        stored: readRunConfigModePreference(storage),
        advancedAuthoring: true,
    }), "advanced");

    assert.equal(writeRunConfigModePreference("simple", storage), true);
    assert.equal(storage.getItem(RUN_CONFIG_MODE_STORAGE_KEY), "simple");
    assert.equal(storage.getItem(ADVANCED_AUTHORING_STORAGE_KEY), "true");
    assert.equal(readRunConfigModePreference(storage), "simple");
});

test("storage failures leave the preference unread and unwritten", () => {
    const throwing = {
        getItem() {
            throw new Error("storage unavailable");
        },
        setItem() {
            throw new Error("storage unavailable");
        },
    };
    assert.equal(readRunConfigModePreference(throwing), null);
    assert.equal(writeRunConfigModePreference("advanced", throwing), false);
    assert.equal(writeRunConfigModePreference("nope", createMemoryStorage()), false);
});
