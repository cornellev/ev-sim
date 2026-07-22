import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { JsonFileStore } from "../server/storage/JsonFileStore.js";
import { StorageService } from "../server/storage/StorageService.js";

async function tempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "sensor-fusion-storage-"));
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

    await service.putEnvironment("igvc", { environmentId: "igvc", roads: { nodes: [], edges: [] } });

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

test("StorageService environment catalog supports create, duplicate, rename, and delete", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    const initial = await service.listEnvironments();
    assert.deepEqual(initial.map(({ id }) => id), ["igvc"]);
    assert.equal(initial[0].builtIn, true);

    await service.createEnvironment({ id: "yard", name: "Test Yard", templateId: "blank" });
    await service.renameEnvironment("yard", "North Yard");
    await service.duplicateEnvironment("yard", { id: "yard-copy", name: "North Yard Copy" });

    assert.equal((await service.getEnvironment("yard")).name, "North Yard");
    assert.equal((await service.getEnvironment("yard-copy")).templateId, "blank");
    assert.deepEqual(
        (await service.listEnvironments()).map(({ id }) => id).sort(),
        ["igvc", "yard", "yard-copy"],
    );

    await service.deleteEnvironment("yard-copy");
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
});

test("StorageService ignores stale environment revisions", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);

    await service.putEnvironment("yard", {
        environmentId: "yard",
        name: "Newest",
        clientRevision: 20,
    });
    await service.putEnvironment("yard", {
        environmentId: "yard",
        name: "Stale",
        clientRevision: 10,
    });

    assert.equal((await service.getEnvironment("yard")).name, "Newest");
});

test("StorageService sequences deletion after pending writes and rejects stale recreation", async () => {
    const dir = await tempDir();
    const service = new StorageService(dir);
    await service.createEnvironment({ id: "yard", name: "Yard" });

    const pendingWrite = service.putEnvironment("yard", {
        environmentId: "yard",
        name: "Pending",
        clientRevision: 1,
    });
    const pendingDelete = service.deleteEnvironment("yard");
    await Promise.all([pendingWrite, pendingDelete]);

    assert.equal(await service.getEnvironment("yard"), null);
    await assert.rejects(
        () => service.putEnvironment("yard", { environmentId: "yard", clientRevision: 2 }),
        /was deleted/,
    );
});
