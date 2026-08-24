import assert from "node:assert/strict";
import test from "node:test";

import {
    applyScenarioSelectionToManifest,
    loadRunManifestCatalog,
} from "../app/config/ConfigCatalogLoader.js";

test("scenario selection synchronizes the run manifest environment", () => {
    const manifest = {
        environment: { id: "igvc", expectedHash: "old-hash" },
        scenario: null,
        initialState: { vehicles: [{ id: "ego", type: "big-car" }] },
    };

    const selected = applyScenarioSelectionToManifest(manifest, {
        id: "corridor-clear",
        definitionHash: "scenario-hash",
        environmentId: "corridor-acceptance",
    });

    assert.deepEqual(selected.environment, {
        id: "corridor-acceptance",
        expectedHash: null,
    });
    assert.deepEqual(selected.scenario, {
        id: "corridor-clear",
        expectedHash: "scenario-hash",
        egoVehicleId: "big-car",
        sensorBindings: {},
        parameterValues: {},
    });
});

test("clearing scenario selection preserves the manifest environment", () => {
    const manifest = {
        environment: { id: "corridor-acceptance", expectedHash: null },
        scenario: { id: "corridor-clear", egoVehicleId: "big-car" },
    };

    const selected = applyScenarioSelectionToManifest(manifest, null);

    assert.equal(selected.scenario, null);
    assert.deepEqual(selected.environment, manifest.environment);
});

test("config catalog loading returns an explicit empty state", async () => {
    const result = await loadRunManifestCatalog({
        listManifests: async () => [],
        getManifest: async () => null,
    });

    assert.deepEqual(result, {
        status: "empty",
        catalog: [],
        selectedId: null,
        document: null,
    });
});

test("config catalog loading selects the preferred available manifest", async () => {
    const loaded = [];
    const result = await loadRunManifestCatalog({
        listManifests: async () => [{ id: "first" }, { id: "preferred" }],
        getManifest: async (id) => {
            loaded.push(id);
            return { id, name: "Preferred" };
        },
        preferredId: "preferred",
    });

    assert.equal(result.status, "ready");
    assert.equal(result.selectedId, "preferred");
    assert.equal(result.document.id, "preferred");
    assert.deepEqual(loaded, ["preferred"]);
});

test("config catalog loading times out instead of hanging indefinitely", async () => {
    await assert.rejects(
        loadRunManifestCatalog({
            listManifests: () => new Promise(() => {}),
            getManifest: async () => null,
            timeoutMs: 5,
        }),
        /timed out/i,
    );
});

test("config catalog loading rejects a missing selected document", async () => {
    await assert.rejects(
        loadRunManifestCatalog({
            listManifests: async () => [{ id: "missing" }],
            getManifest: async () => null,
        }),
        /no longer exists/i,
    );
});
