import assert from "node:assert/strict";
import test from "node:test";

import {
    LAST_OPEN_WORKSPACE_KEYS,
    lastOpenWorkspaceStorageKey,
    pickLastOpenCatalogId,
    readLastOpenWorkspaceId,
    writeLastOpenWorkspaceId,
} from "../app/ui/lastOpenWorkspaceStorage.js";

function createMemoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        },
    };
}

test("last-open workspace ids persist per workspace and ignore blanks", () => {
    const storage = createMemoryStorage();
    assert.equal(readLastOpenWorkspaceId("scenarios", storage), null);

    writeLastOpenWorkspaceId("scenarios", "corridor-clear", storage);
    writeLastOpenWorkspaceId("experiment-suite", "nightly", storage);
    writeLastOpenWorkspaceId("run-config", "igvc-default", storage);

    assert.equal(storage.getItem(LAST_OPEN_WORKSPACE_KEYS.scenarios), "corridor-clear");
    assert.equal(readLastOpenWorkspaceId("scenarios", storage), "corridor-clear");
    assert.equal(readLastOpenWorkspaceId("experiment-suite", storage), "nightly");
    assert.equal(readLastOpenWorkspaceId("run-config", storage), "igvc-default");

    writeLastOpenWorkspaceId("scenarios", "  ", storage);
    assert.equal(storage.getItem(LAST_OPEN_WORKSPACE_KEYS.scenarios), null);
    assert.equal(readLastOpenWorkspaceId("scenarios", storage), null);
});

test("last-open workspace keys stay namespaced", () => {
    assert.equal(lastOpenWorkspaceStorageKey("scenarios"), "cev-sim.ui.lastOpen.scenarios");
    assert.equal(lastOpenWorkspaceStorageKey("unknown"), "cev-sim.ui.lastOpen.unknown");
});

test("pickLastOpenCatalogId prefers a live remembered id and otherwise uses the first entry", () => {
    const catalog = [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }];
    assert.equal(pickLastOpenCatalogId(catalog, "beta"), "beta");
    assert.equal(pickLastOpenCatalogId(catalog, "deleted"), "alpha");
    assert.equal(pickLastOpenCatalogId(catalog, "  "), "alpha");
    assert.equal(pickLastOpenCatalogId(["alpha", "beta"], "beta"), "beta");
    assert.equal(pickLastOpenCatalogId([], "beta"), null);
});
