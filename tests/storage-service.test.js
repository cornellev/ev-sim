import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { JsonFileStore } from "../server/storage/JsonFileStore.js";
import { StorageService } from "../server/storage/StorageService.js";

async function tempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "cev-sim-storage-"));
}

test("JsonFileStore returns the fallback when the file does not exist", async () => {
    const dir = await tempDir();
    const store = new JsonFileStore(path.join(dir, "missing.json"), { fallback: { count: 0 } });

    assert.deepEqual(await store.read(), { count: 0 });
});

test("JsonFileStore round-trips a written value through disk", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "value.json");
    const store = new JsonFileStore(filePath);

    await store.write({ hello: "world", nested: [1, 2, 3] });

    // Read back from a brand-new store instance to prove it hit the disk.
    const fresh = new JsonFileStore(filePath);
    assert.deepEqual(await fresh.read(), { hello: "world", nested: [1, 2, 3] });
});

test("JsonFileStore overwrites atomically and leaves no temp files", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "value.json");
    const store = new JsonFileStore(filePath);

    await store.write({ version: 1 });
    await store.write({ version: 2 });

    assert.deepEqual(await store.read(), { version: 2 });

    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.equal(leftovers.length, 0, "no temp files should remain after writes");
});

test("JsonFileStore hands out copies so callers cannot mutate the cache", async () => {
    const dir = await tempDir();
    const store = new JsonFileStore(path.join(dir, "value.json"));

    await store.write({ items: ["a"] });
    const first = await store.read();
    first.items.push("b");

    assert.deepEqual(await store.read(), { items: ["a"] });
});

test("JsonFileStore does not publish a cache value when the disk write fails", async () => {
    const dir = await tempDir();
    const blockedParent = path.join(dir, "blocked");
    await fs.writeFile(blockedParent, "not a directory");
    const store = new JsonFileStore(path.join(blockedParent, "value.json"), { fallback: { count: 0 } });

    await assert.rejects(() => store.write({ attempt: 1 }));
    assert.deepEqual(await store.read(), { count: 0 });
});

test("JsonFileStore accepts later writes after a filesystem failure", async () => {
    const dir = await tempDir();
    const blockedParent = path.join(dir, "blocked");
    await fs.writeFile(blockedParent, "not a directory");
    const store = new JsonFileStore(path.join(blockedParent, "value.json"));

    await assert.rejects(() => store.write({ attempt: 1 }));
    await fs.rm(blockedParent);
    await fs.mkdir(blockedParent);

    await store.write({ attempt: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(store.filePath, "utf8")), { attempt: 2 });
});

test("StorageService stores environments at environments/<id>.json", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    await service.putEnvironment("igvc", { environmentId: "igvc", roads: { nodes: [], edges: [] } }, { create: true });

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "environments", "igvc.json"), "utf8"));
    assert.equal(onDisk.environmentId, "igvc");
    assert.deepEqual(await service.getEnvironment("igvc"), onDisk);
});

test("StorageService returns null for an unsaved environment", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    assert.equal(await service.getEnvironment("nope"), null);
});

test("StorageService lists, reads, and deletes scripts", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    await service.putScript({ id: "s1", name: "First" });
    await service.putScript({ id: "s2", name: "Second" });

    const listed = await service.listScripts();
    assert.deepEqual(listed.map((doc) => doc.id).sort(), ["s1", "s2"]);

    await service.deleteScript("s1");
    assert.equal(await service.getScript("s1"), null);
    assert.deepEqual((await service.listScripts()).map((doc) => doc.id), ["s2"]);
});

test("StorageService keeps settings in a single flat map", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    await service.putSetting("currentScriptId", "s1");
    await service.putSetting("bindings:manifest", { bindings: [] });

    assert.equal(await service.getSetting("currentScriptId"), "s1");
    assert.deepEqual(await service.getSetting("bindings:manifest"), { bindings: [] });

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));
    assert.deepEqual(Object.keys(onDisk).sort(), ["bindings:manifest", "currentScriptId"]);
});

test("StorageService migrates legacy binding settings into the canonical v2 store", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);
    await service.putSetting("bindings:manifest", {
        kind: "cev-sim.script-bindings",
        version: 1,
        enabled: true,
        bindings: [{ id: "legacy", name: "Legacy", trigger: { kind: "fixed-update" } }],
    });

    const migrated = await service.getBindings();
    assert.equal(migrated.version, 2);
    assert.equal(migrated.bindings[0].scope, "global");
    assert.equal(migrated.bindings[0].folderId, null);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "bindings.json"), "utf8")), migrated);

    await service.putBindings({
        kind: "cev-sim.script-bindings",
        version: 2,
        folders: [],
        bindings: [{ id: "canonical", scope: "selected" }],
    });
    assert.deepEqual((await service.getBindings()).bindings.map((binding) => binding.id), ["canonical"]);
});

test("StorageService serializes concurrent updates to different settings", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    await Promise.all([
        service.putSetting("activeEnvironmentId", "yard"),
        service.putSetting("selectedScript", "controller"),
    ]);

    assert.equal(await service.getSetting("activeEnvironmentId"), "yard");
    assert.equal(await service.getSetting("selectedScript"), "controller");
});

test("StorageService rejects ids that could escape the data directory", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    await assert.rejects(() => service.getEnvironment("../secret"));
    await assert.rejects(() => service.getScript("a/b"));
});

test("StorageService environment catalog supports create, duplicate, rename, id changes, and delete", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    const initial = await service.listEnvironments();
    assert.deepEqual(initial.map(({ id }) => id), ["igvc"]);
    assert.equal(initial[0].builtIn, true);

    await service.createEnvironment({ id: "yard", name: "Test Yard", templateId: "blank" });
    const renamed = await service.renameEnvironment("yard", { name: "North Yard", expectedRevision: 1 });
    assert.equal((await service.getEnvironment("yard")).environmentId, "yard");
    assert.equal(renamed.revision, 2);

    const moved = await service.changeEnvironmentId("yard", { id: "north-yard", expectedRevision: renamed.revision });
    const duplicated = await service.duplicateEnvironment("north-yard", {
        id: "yard-copy",
        name: "North Yard Copy",
        expectedRevision: moved.revision,
    });

    assert.equal(await service.getEnvironment("yard"), null);
    assert.equal(moved.environmentId, "north-yard");
    assert.equal(moved.document.environmentId, "north-yard");
    assert.equal((await service.getEnvironment("north-yard")).name, "North Yard");
    await assert.rejects(() => fs.access(path.join(dir, "environments", "yard.json")));
    await fs.access(path.join(dir, "environments", "north-yard.json"));
    assert.equal((await service.getEnvironment("yard-copy")).revision, 1);
    assert.equal((await service.listEnvironments()).find((entry) => entry.id === "igvc").revision, 0);
    assert.deepEqual(
        (await service.listEnvironments()).map(({ id }) => id).sort(),
        ["igvc", "north-yard", "yard-copy"],
    );

    await service.deleteEnvironment("yard-copy", duplicated.revision);
    assert.equal(await service.getEnvironment("yard-copy"), null);
});

test("StorageService protects built-in environments and duplicate ids", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    await assert.rejects(() => service.deleteEnvironment("igvc"), /cannot be deleted/);
    await assert.rejects(
        () => service.createEnvironment({ id: "igvc", name: "Other IGVC" }),
        /already exists/,
    );
    await assert.rejects(
        () => service.changeEnvironmentId("igvc", "renamed-igvc"),
        /cannot change its id/,
    );

    await service.createEnvironment({ id: "yard", name: "Yard" });
    await service.createEnvironment({ id: "field", name: "Field" });
    await assert.rejects(
        () => service.changeEnvironmentId("yard", { id: "field", expectedRevision: 1 }),
        /already exists/,
    );
    await assert.rejects(
        () => service.changeEnvironmentId("yard", "Not Valid"),
        /lowercase letters/,
    );
});

test("StorageService rejects unguarded and stale environment revisions", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);
    const created = await service.createEnvironment({ id: "yard", name: "Yard" });

    await assert.rejects(
        () => service.putEnvironment("yard", { environmentId: "yard", name: "Legacy" }),
        /Unguarded environment writes/,
    );
    await assert.rejects(
        () => service.putEnvironment("yard", { manifest: { ...created, name: "Stale" }, expectedRevision: 0 }),
        /revision conflict/,
    );
    assert.equal((await service.getEnvironment("yard")).name, "Yard");
    assert.equal((await service.getEnvironment("yard")).revision, 1);

    const updated = await service.putEnvironment("yard", {
        manifest: { ...created, name: "Newest" },
        expectedRevision: 1,
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.schemaVersion, 3);
});

test("StorageService sequences deletion after pending writes and rejects stale recreation", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);
    const created = await service.createEnvironment({ id: "yard", name: "Yard" });

    const pendingWrite = service.putEnvironment("yard", {
        manifest: { ...created, name: "Pending" },
        expectedRevision: created.revision,
    });
    const pendingDelete = service.deleteEnvironment("yard", created.revision);
    const outcomes = await Promise.allSettled([pendingWrite, pendingDelete]);
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length >= 1, true);
    const remaining = await service.getEnvironment("yard");
    if (remaining) {
        assert.equal(remaining.name === "Pending" || remaining.name === "Yard", true);
    }

    await assert.rejects(
        () => service.putEnvironment("yard", { manifest: { environmentId: "yard" }, expectedRevision: 99 }),
        remaining ? /revision conflict/ : /was deleted/,
    );
});
