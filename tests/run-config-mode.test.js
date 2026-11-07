import assert from "node:assert/strict";
import test from "node:test";

import { ADVANCED_AUTHORING_STORAGE_KEY } from "../app/ui/authoringModeStorage.js";
import {
    RUN_CONFIG_MODE_STORAGE_KEY,
    chooseRunConfigMode,
    readResolvedRunConfigMode,
    readRunConfigModePreference,
    resolveRunConfigMode,
    subscribeRunConfigMode,
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

test("chooseRunConfigMode writes the run view and keeps a failed write for the session", () => {
    const storage = createMemoryStorage({
        [ADVANCED_AUTHORING_STORAGE_KEY]: "true",
    });
    let calls = 0;
    const stop = subscribeRunConfigMode(() => {
        calls += 1;
    });
    try {
        assert.equal(readResolvedRunConfigMode(storage), "advanced");
        chooseRunConfigMode("simple", storage);
        assert.equal(calls, 1);
        assert.equal(storage.getItem(RUN_CONFIG_MODE_STORAGE_KEY), "simple");
        assert.equal(storage.getItem(ADVANCED_AUTHORING_STORAGE_KEY), "true");
        assert.equal(readResolvedRunConfigMode(storage), "simple");
        chooseRunConfigMode("simple", storage);
        assert.equal(calls, 1);

        const throwing = {
            getItem() {
                throw new Error("storage unavailable");
            },
            setItem() {
                throw new Error("storage unavailable");
            },
        };
        chooseRunConfigMode("advanced", throwing);
        assert.equal(calls, 2);
        assert.equal(readResolvedRunConfigMode(storage), "advanced");
        assert.equal(storage.getItem(RUN_CONFIG_MODE_STORAGE_KEY), "simple");
    } finally {
        stop();
        chooseRunConfigMode("simple", storage);
    }
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
