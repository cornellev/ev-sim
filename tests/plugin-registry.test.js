import assert from "node:assert/strict";
import test from "node:test";

import {
    BlockRegistry,
    BlockRegistryError,
    defaultBlockRegistry,
} from "../app/scripting/BlockRegistry.js";
import { registerBuiltInBlocks } from "../app/scripting/registerBuiltInBlocks.js";

const ownership = Object.freeze({ pluginId: "acme.example", version: "1.0.0", runtimeHash: "a".repeat(64) });

test("BlockRegistry isolates snapshots, ownership, collisions, and sealing", () => {
    class BuiltIn {}
    class PluginBlock {}
    const source = new BlockRegistry();
    source.register("BuiltIn", BuiltIn);
    source.register("BuiltIn", BuiltIn);
    source.register("acme.example.Block", PluginBlock, ownership);
    assert.equal(source.get("BuiltIn"), BuiltIn);
    assert.equal(source.has("missing"), false);
    const snapshot = source.snapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot[1].ownership), true);
    const copy = new BlockRegistry({ entries: snapshot });
    class Later {}
    copy.register("Later", Later);
    assert.equal(source.has("Later"), false);
    assert.throws(() => source.register("BuiltIn", Later), (error) => error instanceof BlockRegistryError && error.code === "REGISTRY_CONFLICT");
    assert.throws(() => source.register("acme.example.Block", PluginBlock, ownership), /already registered/);
    source.seal();
    assert.throws(() => source.register("Other", Later), (error) => error.code === "REGISTRY_SEALED");
});

test("built-in registration includes compatibility types and default registry rejects plugins", () => {
    const registry = registerBuiltInBlocks(new BlockRegistry());
    for (const type of ["ROSInputBlock", "ROSOutputBlock", "CompiledProgramUnitBlock", "LocalScriptProgramBlock"]) {
        assert.ok(registry.get(type), type);
    }
    class PluginBlock {}
    assert.throws(() => defaultBlockRegistry.register("acme.example.Nope", PluginBlock, ownership), (error) => error.code === "REGISTRY_PLUGIN_FORBIDDEN");
});
