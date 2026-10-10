import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { PluginRunSession, PLG03_RUNTIME_CAPABILITIES } from "../app/plugin/PluginRunSession.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

test("a plant-only package loads without a JavaScript runtime", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plant-load-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new PluginStore(root);
    const resource = await pluginFixtureResource({ fixture: "test.plant-fixture" });
    const verified = verifyPluginPackage(resource);
    await store.putPackage(resource);
    let imported = false;
    const session = await new PluginRunSession({
        moduleSource: {
            async importRuntime() {
                imported = true;
                throw new Error("plant packages do not import JavaScript");
            },
        },
        plugins: [{
            pluginId: verified.document.id,
            version: verified.document.version,
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            capabilities: ["plant.step"],
        }],
        availableCapabilities: PLG03_RUNTIME_CAPABILITIES,
    }).prepareDefinitions([resource]);
    t.after(() => session.dispose());
    assert.equal(imported, false);
    assert.equal(session.plants.size, 1);
    const plant = session.plants.get("test.plant-fixture.bicycle");
    assert.equal(plant.abi, 1);
    assert.ok(plant.moduleBytes instanceof Uint8Array);
    assert.equal(verified.document.entry, undefined);
});

test("an empty plugin selection leaves the plant map empty", async () => {
    const session = await new PluginRunSession({ plugins: [] }).prepareDefinitions([]);
    assert.equal(session.plants.size, 0);
    session.dispose();
});
