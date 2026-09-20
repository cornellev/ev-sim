import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PluginHost } from "../app/plugin/PluginHost.js";
import { PluginLoader } from "../app/plugin/PluginLoader.js";
import { BlockRegistry } from "../app/scripting/BlockRegistry.js";
import { BlockOutput, ScriptManager, UnitBlock } from "../app/scripting/ScriptManager.js";
import { compileVisualScript } from "../app/scripting/runtime/Compiler.js";
import { createVisualScriptRunner } from "../app/scripting/runtime/Runner.js";
import { NodePluginModuleSource } from "../server/plugins/NodePluginModuleSource.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

async function harness(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-loader-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new PluginStore(root);
    const moduleSource = new NodePluginModuleSource({ pluginStore: store });
    return { root, store, moduleSource };
}

test("fixture loads into live and compiled isolated harnesses", async (t) => {
    const { store, moduleSource } = await harness(t);
    const resource = await pluginFixtureResource();
    await store.putPackage(resource);
    class ValueBlock extends UnitBlock {
        register() { this.registerOutput("value", "float64"); }
        valid() { return true; }
        execute() { return new BlockOutput().set("value", 3); }
    }
    const registry = new BlockRegistry();
    registry.register("PluginFixtureValueBlock", ValueBlock);
    const host = new PluginHost({ blockRegistry: registry });
    const loaded = await new PluginLoader({ host, moduleSource }).loadPackage(resource);
    const UnitClass = loaded.registry.get("acme.example.ScaleBlock");
    const manager = new ScriptManager();
    manager.addUnit(new ValueBlock("value"));
    const unit = new UnitClass("scale");
    manager.addUnit(unit);
    manager.connectUnits("value", "value", "scale", "value");
    manager.setHead("scale");
    assert.equal(manager.execute().get("result"), 6);
    const artifact = compileVisualScript(manager, "plugin-fixture", loaded.registry.get.bind(loaded.registry));
    const runner = createVisualScriptRunner(artifact, loaded.registry.get.bind(loaded.registry));
    assert.equal(runner.run().result.get("result"), 6);
});

test("registration is transactional and separate hosts may select separate versions", async (t) => {
    const { store, moduleSource } = await harness(t);
    const invalid = await pluginFixtureResource({ fixture: "registration-failure" });
    await store.putPackage(invalid);
    const host = new PluginHost({ blockRegistry: new BlockRegistry() });
    const before = host.registry.snapshot();
    await assert.rejects(new PluginLoader({ host, moduleSource }).loadPackage(invalid), /undeclared/);
    assert.deepEqual(host.registry.snapshot(), before);

    const v1 = await pluginFixtureResource();
    const v2 = await pluginFixtureResource({ fixture: "acme.example-v2" });
    await store.putPackage(v1);
    await store.putPackage(v2);
    const first = new PluginHost({ blockRegistry: new BlockRegistry() });
    const second = new PluginHost({ blockRegistry: new BlockRegistry() });
    await new PluginLoader({ host: first, moduleSource }).loadPackage(v1);
    await new PluginLoader({ host: second, moduleSource }).loadPackage(v2);
    assert.equal(first.packages.get("acme.example").version, "1.0.0");
    assert.equal(second.packages.get("acme.example").version, "2.0.0");
    assert.notEqual(first.registry.get("acme.example.ScaleBlock"), second.registry.get("acme.example.ScaleBlock"));
});

test("systems and asynchronous registration remain explicitly unavailable", async (t) => {
    const { store, moduleSource } = await harness(t);
    const system = await pluginFixtureResource({ fixture: "unavailable-systems" });
    await store.putPackage(system);
    await assert.rejects(new PluginLoader({ host: new PluginHost(), moduleSource }).loadPackage(system), /unavailable until PLG-03/);

    const asyncRegistration = await pluginFixtureResource({ mutateFiles(files) {
        files["runtime/index.js"] = new TextEncoder().encode("export default { async register() {} };");
    } });
    await store.putPackage(asyncRegistration);
    await assert.rejects(new PluginLoader({ host: new PluginHost(), moduleSource }).loadPackage(asyncRegistration), (error) => error.code === "PLUGIN_ASYNC_HOOK");

    const mismatch = await pluginFixtureResource({ fixture: "descriptor-mismatch" });
    await store.putPackage(mismatch);
    await assert.rejects(new PluginLoader({ host: new PluginHost(), moduleSource }).loadPackage(mismatch), /ports do not match/);

    const asyncHooks = await pluginFixtureResource({ fixture: "async-hooks" });
    await store.putPackage(asyncHooks);
    const loaded = await new PluginLoader({ host: new PluginHost(), moduleSource }).loadPackage(asyncHooks);
    const AsyncBlock = loaded.registry.get("acme.async.AsyncBlock");
    assert.throws(() => new AsyncBlock("async-hook").execute(), (error) => error.code === "PLUGIN_ASYNC_HOOK");
    await Promise.resolve();
});

test("capability failures precede import and runtime materializations are reverified", async (t) => {
    const { store, moduleSource } = await harness(t);
    const required = await pluginFixtureResource({ mutateDocument(document) {
        document.capabilities = ["signals.read.vehicles"];
    } });
    await store.putPackage(required);
    await assert.rejects(
        new PluginLoader({ host: new PluginHost({ availableCapabilities: [] }), moduleSource }).loadPackage(required, { capabilities: ["signals.read.vehicles"] }),
        (error) => error.code === "PLUGIN_CAPABILITY",
    );
    assert.equal((await fs.readdir(store.runtimeDir).catch(() => [])).length, 0);

    const resource = await pluginFixtureResource();
    await store.putPackage(resource);
    const host = new PluginHost();
    await new PluginLoader({ host, moduleSource }).loadPackage(resource);
    const runtimeFile = path.join(store.runtimeDir, resource.runtimeHash, "files", "runtime", "index.js");
    await fs.rm(runtimeFile);
    await assert.rejects(
        new PluginLoader({ host: new PluginHost(), moduleSource }).loadPackage(resource),
        (error) => error.code === "PLUGIN_INTEGRITY" && /membership/.test(error.message),
    );
});
