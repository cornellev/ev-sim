import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    createAuthoringRegistry,
    normalizeGraphPluginLocks,
    stampGraphPluginLock,
} from "../app/plugin/PluginAuthoring.js";
import { restoreManagerFromGraph, serializeManagerGraph } from "../app/scripting/GraphDocument.js";
import { ScriptManager } from "../app/scripting/ScriptManager.js";
import { createUnresolvedPluginUnit } from "../app/scripting/units/UnresolvedPluginUnit.js";
import { compileGraph, listUnitCatalog } from "../server/scripting/scriptingHandlers.js";
import { StorageService } from "../server/storage/StorageService.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const RUNTIME_HASH = "f29ebbc784e41f926b0aba3a8de763262be2b0e8181b63031dc4b7a9107657c7";

async function harness(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-authoring-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const storage = new StorageService(root);
    return { root, storage };
}

function scaleGraph(resource, { includeLock = true } = {}) {
    return {
        head: "head-uuid",
        outputNodeConfig: { outputs: [{ id: "output", label: "output", type: "float64" }] },
        ...(includeLock ? {
            pluginLocks: [{
                pluginId: "acme.example",
                version: "1.0.0",
                packageHash: resource.packageHash,
                runtimeHash: resource.runtimeHash,
                types: ["acme.example.ScaleBlock"],
            }],
        } : {}),
        nodes: [
            {
                uuid: "number",
                type: "NumberUnitClass",
                state: {},
                storedData: 3,
                runtimeState: null,
                position: { x: 0, y: 0 },
            },
            {
                uuid: "scale",
                type: "acme.example.ScaleBlock",
                state: { factor: 2 },
                storedData: null,
                runtimeState: null,
                position: { x: 120, y: 0 },
                ports: { inputs: { value: "float64" }, outputs: { result: "float64" } },
            },
        ],
        connections: [
            { from: "number", output: "number", to: "scale", input: "value", type: "float64" },
            { from: "scale", output: "result", to: "head-uuid", input: "output", type: "float64" },
        ],
    };
}

test("graph plugin locks normalize, reject duplicates, and stamp one package per plugin", () => {
    const lock = {
        pluginId: "acme.example",
        version: "1.0.0",
        packageHash: "a".repeat(64),
        runtimeHash: "b".repeat(64),
        types: ["acme.example.ScaleBlock"],
    };
    assert.throws(
        () => normalizeGraphPluginLocks([lock, { ...lock, types: ["acme.example.Other"] }]),
        /duplicate pluginId/,
    );
    const stamped = stampGraphPluginLock([], {
        type: "acme.example.ScaleBlock",
        ownership: {
            pluginId: "acme.example",
            version: "1.0.0",
            packageHash: lock.packageHash,
            runtimeHash: lock.runtimeHash,
        },
    });
    assert.equal(stamped.length, 1);
    const merged = stampGraphPluginLock(stamped, {
        type: "acme.example.HelperBlock",
        ownership: stamped[0],
    });
    assert.deepEqual(merged[0].types, ["acme.example.HelperBlock", "acme.example.ScaleBlock"]);
    assert.throws(() => stampGraphPluginLock(stamped, {
        type: "acme.example.ScaleBlock",
        ownership: { ...stamped[0], packageHash: "c".repeat(64) },
    }), (error) => error.code === "PLUGIN_REGISTRATION");
    assert.deepEqual(stampGraphPluginLock(stamped, { type: "NumberUnitClass", ownership: "builtin" }), stamped);
});

test("revisioned catalog lists plugin units from documents without executing UI", async (t) => {
    const { storage } = await harness(t);
    const resource = await pluginFixtureResource();
    await storage.installPluginFromHash((await storage.plugins.putPackage(resource)).packageHash);
    const first = await listUnitCatalog(storage);
    assert.equal(first.revision, 1);
    const pluginUnit = first.units.find((entry) => entry.type === "acme.example.ScaleBlock");
    assert.equal(pluginUnit.name, "Scale");
    assert.equal(pluginUnit.ownership.packageHash, resource.packageHash);
    assert.equal(pluginUnit.ownership.runtimeHash, RUNTIME_HASH);
    assert.equal(pluginUnit.ui.available, true);
    assert.equal(pluginUnit.ui.fallback, "generic");
    const builtin = first.units.find((entry) => entry.type === "NumberUnitClass");
    assert.equal(builtin.ownership, "builtin");
    assert.equal(builtin.ui.fallback, "builtin");
    await storage.removePluginFromLibrary("acme.example", resource.packageHash);
    const second = await listUnitCatalog(storage);
    assert.equal(second.revision, 2);
    assert.equal(second.units.some((entry) => entry.type === "acme.example.ScaleBlock"), false);
});

test("locked compile emits runtimeHash pluginRequirements and preserves UI-only identity", async (t) => {
    const { storage } = await harness(t);
    const original = await pluginFixtureResource();
    const uiEdit = await pluginFixtureResource({ fixture: "acme.example-ui-edit" });
    await storage.plugins.putPackage(original);
    await storage.plugins.putPackage(uiEdit);
    await storage.installPluginFromHash(original.packageHash);

    const compiled = await compileGraph(storage, scaleGraph(original), "scale");
    assert.equal(compiled.ok, true);
    assert.deepEqual(compiled.artifact.pluginRequirements, [{
        pluginId: "acme.example",
        version: "1.0.0",
        runtimeHash: RUNTIME_HASH,
        types: ["acme.example.ScaleBlock"],
    }]);
    assert.equal(JSON.stringify(compiled.artifact).includes(original.packageHash), false);

    const uiCompiled = await compileGraph(storage, scaleGraph(uiEdit), "scale");
    assert.deepEqual(uiCompiled.artifact.pluginRequirements, compiled.artifact.pluginRequirements);

    const builtin = await compileGraph(storage, {
        head: "head-uuid",
        outputNodeConfig: { outputs: [{ id: "output", label: "output", type: "float64" }] },
        nodes: [{
            uuid: "number",
            type: "NumberUnitClass",
            state: {},
            storedData: 4,
            runtimeState: null,
            position: { x: 0, y: 0 },
        }],
        connections: [{ from: "number", output: "number", to: "head-uuid", input: "output", type: "float64" }],
    }, "number");
    assert.equal(builtin.ok, true);
    assert.equal(builtin.artifact.pluginRequirements, undefined);
});

test("missing locked packages restore placeholders and fail compile without dropping connections", async (t) => {
    const { storage } = await harness(t);
    const resource = await pluginFixtureResource();
    const graph = scaleGraph(resource);
    const authoring = await createAuthoringRegistry({
        locks: graph.pluginLocks,
        getPackage: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        moduleSource: { importRuntime: async () => ({}) },
    });
    assert.deepEqual(authoring.unresolvedTypes, ["acme.example.ScaleBlock"]);
    const manager = restoreManagerFromGraph(graph, (type) => authoring.registry.get(type), {
        createManager: () => new ScriptManager({ blockRegistry: authoring.registry, pluginHost: authoring.host }),
        onMissingBlock: (node) => createUnresolvedPluginUnit(node),
    });
    assert.equal(manager.units.some((unit) => unit.typeId() === "acme.example.ScaleBlock"), true);
    const serialized = serializeManagerGraph(manager, { outputNodeConfig: graph.outputNodeConfig });
    assert.equal(serialized.connections.length >= 2, true);
    assert.equal(serialized.nodes.find((node) => node.type === "acme.example.ScaleBlock").ports.outputs.result, "float64");
    manager.dispose();
    authoring.dispose();

    await assert.rejects(compileGraph(storage, graph, "scale"), /Missing plugin types/);
});

test("newer library version does not replace a graph locked to an older package", async (t) => {
    const { storage } = await harness(t);
    const v1 = await pluginFixtureResource();
    const v2 = await pluginFixtureResource({ fixture: "acme.example-v2" });
    await storage.plugins.putPackage(v1);
    await storage.plugins.putPackage(v2);
    await storage.installPluginFromHash(v1.packageHash);
    await storage.installPluginFromHash(v2.packageHash);
    const catalog = await listUnitCatalog(storage);
    assert.equal(catalog.units.filter((entry) => entry.type === "acme.example.ScaleBlock"
        || entry.type?.startsWith("acme.example")).length >= 1, true);
    const compiled = await compileGraph(storage, scaleGraph(v1), "scale");
    assert.equal(compiled.artifact.pluginRequirements[0].runtimeHash, v1.runtimeHash);
    const v2Entry = catalog.units.find((entry) => entry.ownership?.packageHash === v2.packageHash);
    assert.throws(() => stampGraphPluginLock(scaleGraph(v1).pluginLocks, v2Entry), (error) => error.code === "PLUGIN_REGISTRATION");
});
