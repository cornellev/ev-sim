import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
    BlockRegistry,
    BlockRegistryError,
    clearBlockTypeRegistryForTests,
    defaultBlockRegistry,
    getRegisteredBlockType,
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

test("ensureBuiltin replaces a built-in class and rejects plugin-owned types", () => {
    const registry = new BlockRegistry({ allowPlugins: true });
    class BuiltIn {}
    class Replacement {}
    registry.ensureBuiltin("BuiltIn", BuiltIn);
    assert.equal(registry.ensureBuiltin("BuiltIn", BuiltIn), BuiltIn);
    assert.equal(registry.ensureBuiltin("BuiltIn", Replacement), Replacement);
    assert.equal(registry.get("BuiltIn"), Replacement);
    assert.equal(Replacement.blockType, "BuiltIn");

    class PluginBlock {}
    registry.register("acme.example.Block", PluginBlock, ownership);
    class Later {}
    assert.throws(
        () => registry.ensureBuiltin("acme.example.Block", Later),
        (error) => error instanceof BlockRegistryError && error.code === "REGISTRY_CONFLICT",
    );

    registry.seal();
    class Sealed {}
    assert.throws(
        () => registry.ensureBuiltin("BuiltIn", Sealed),
        (error) => error instanceof BlockRegistryError && error.code === "REGISTRY_SEALED",
    );
});

test("importing ScriptManager does not register built-in program blocks", () => {
    clearBlockTypeRegistryForTests();
    const result = spawnSync(process.execPath, [
        "--experimental-default-type=module",
        "--input-type=module",
        "--eval",
        [
            'import { getRegisteredBlockType } from "./app/scripting/BlockRegistry.js";',
            'import "./app/scripting/ScriptManager.js";',
            'if (getRegisteredBlockType("CompiledProgramUnitBlock") || getRegisteredBlockType("LocalScriptProgramBlock")) {',
            '    throw new Error("ScriptManager import registered program blocks");',
            "}",
        ].join("\n"),
    ], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(getRegisteredBlockType("CompiledProgramUnitBlock"), null);
    assert.equal(getRegisteredBlockType("LocalScriptProgramBlock"), null);
});

test("built-in registration refreshes replaced program block classes", () => {
    const registry = registerBuiltInBlocks(new BlockRegistry());
    class NextCompiled {}
    class NextLocal {}
    registry.ensureBuiltin("CompiledProgramUnitBlock", NextCompiled);
    registry.ensureBuiltin("LocalScriptProgramBlock", NextLocal);
    assert.equal(registry.get("CompiledProgramUnitBlock"), NextCompiled);
    assert.equal(registry.get("LocalScriptProgramBlock"), NextLocal);
    class Other {}
    assert.throws(
        () => registry.register("CompiledProgramUnitBlock", Other),
        (error) => error instanceof BlockRegistryError && error.code === "REGISTRY_CONFLICT",
    );
});
