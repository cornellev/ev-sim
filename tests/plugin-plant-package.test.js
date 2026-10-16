import assert from "node:assert/strict";
import test from "node:test";

import { assertPluginDocument } from "../app/plugin/PluginDocument.js";
import { PLUGIN_ERROR_CODES } from "../app/plugin/PluginErrors.js";
import { assertPlantModuleBytes } from "../app/plugin/PlantModule.js";
import { createPluginPackage, verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { pluginFixtureFiles, pluginFixtureResource } from "./helpers/pluginFixtures.js";
import { encodeBicyclePlantModule, encodeCountingPlantModule } from "../scripts/plant-wasm-module.mjs";

test("plant-only packages admit a wasm module and keep it in the runtime hash", async () => {
    const resource = await pluginFixtureResource({ fixture: "test.plant-fixture" });
    const verified = verifyPluginPackage(resource);
    assert.equal(verified.document.entry, undefined);
    assert.equal(verified.document.plants[0].id, "test.plant-fixture.bicycle");
    assert.equal(verified.runtimeFiles.includes("plant.wasm"), true);
    const files = await pluginFixtureFiles("test.plant-fixture");
    files["plant.wasm"] = encodeCountingPlantModule();
    const next = createPluginPackage(files);
    assert.notEqual(next.runtimeHash, resource.runtimeHash);
    assert.notEqual(next.packageHash, resource.packageHash);
});

test("one document cannot declare the same plant twice", async () => {
    const files = await pluginFixtureFiles("test.plant-fixture");
    const document = JSON.parse(new TextDecoder().decode(files["plugin.json"]));
    document.plants.push({ ...document.plants[0] });
    files["plugin.json"] = new TextEncoder().encode(JSON.stringify(document));
    assert.throws(() => createPluginPackage(files), (error) => error.code === PLUGIN_ERROR_CODES.DOCUMENT_INVALID);
});

test("plant documents reject a missing runtime when they also contribute JavaScript", async () => {
    const resource = await pluginFixtureResource({ fixture: "test.plant-fixture" });
    const document = structuredClone(verifyPluginPackage(resource).document);
    document.units = [{
        type: "test.plant-fixture.ScaleBlock",
        ports: { inputs: {}, outputs: {} },
        settings: [],
        defaults: {},
        catalog: {
            name: "Scale",
            category: "math",
            keywords: [],
            placeable: true,
            deprecated: false,
            requiresSignals: false,
        },
    }];
    assert.throws(() => assertPluginDocument(document), /entry\.runtime is required/);
    delete document.capabilities;
    document.units = [];
    document.capabilities = [];
    assert.throws(() => assertPluginDocument(document), /plant\.step/);
});

test("plant modules must be wasm, import nothing, and fit the ABI buffer", () => {
    const bytes = encodeBicyclePlantModule();
    assert.equal(assertPlantModuleBytes(bytes, "plant.wasm"), bytes);
    assert.throws(() => assertPlantModuleBytes(new Uint8Array([0, 1, 2, 3]), "plant.wasm"), (error) => error.code === PLUGIN_ERROR_CODES.INTEGRITY);
    const huge = new Uint8Array(4 * 1024 * 1024 + 1);
    huge.set([0x00, 0x61, 0x73, 0x6d], 0);
    assert.throws(() => assertPlantModuleBytes(huge, "plant.wasm"), /exceeds/);
});
