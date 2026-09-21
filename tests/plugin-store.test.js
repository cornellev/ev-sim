import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PluginStore } from "../server/storage/PluginStore.js";
import { pluginFixtureFiles, pluginFixtureResource } from "./helpers/pluginFixtures.js";

async function temporaryStore(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-store-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, store: new PluginStore(root) };
}

test("PluginStore publishes immutable CAS bytes and revisions library membership", async (t) => {
    const { store } = await temporaryStore(t);
    const resource = await pluginFixtureResource();
    await Promise.all([store.putPackage(resource), store.putPackage(resource)]);
    await Promise.all([store.installFromHash(resource.packageHash), store.installFromHash(resource.packageHash)]);
    assert.deepEqual(await store.listInstalled(), {
        revision: 1,
        packages: [{
            pluginId: "acme.example",
            version: "1.0.0",
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            uiHash: resource.uiHash,
        }],
    });
    assert.equal(new TextDecoder().decode(await store.readFile(resource.packageHash, "shared/math.js")).includes("scale"), true);
    assert.equal(await store.removeFromLibrary("acme.example", resource.packageHash), true);
    assert.equal((await store.listInstalled()).revision, 2);
    assert.equal((await store.getPackage(resource.packageHash)).packageHash, resource.packageHash);
});

test("PluginStore detects tampering and rejects symlink installation", async (t) => {
    const { root, store } = await temporaryStore(t);
    const resource = await pluginFixtureResource();
    await store.putPackage(resource);
    await fs.writeFile(path.join(store.casDir, resource.packageHash, "files", "runtime", "index.js"), "tampered");
    await assert.rejects(store.verifyPackage(resource.packageHash), /corrupt/);

    const source = path.join(root, "source");
    await fs.mkdir(source, { recursive: true });
    const files = await pluginFixtureFiles();
    for (const [member, bytes] of Object.entries(files)) {
        const destination = path.join(source, ...member.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
    }
    await fs.symlink(path.join(source, "runtime", "index.js"), path.join(source, "link.js"));
    await assert.rejects(store.installFromDirectory(source), /symlink/);
});

test("a failed library publication leaves verified CAS content uninstalled", async (t) => {
    const { store } = await temporaryStore(t);
    const resource = await pluginFixtureResource();
    await store.putPackage(resource);
    const original = store._writeLibrary.bind(store);
    store._writeLibrary = async () => { throw new Error("injected index failure"); };
    await assert.rejects(store.installFromHash(resource.packageHash), /injected index failure/);
    assert.deepEqual(await store.listInstalled(), { revision: 0, packages: [] });
    assert.equal((await store.verifyPackage(resource.packageHash)).resource.packageHash, resource.packageHash);
    store._writeLibrary = original;
    await store.installFromHash(resource.packageHash);
    assert.equal((await store.listInstalled()).revision, 1);
});

test("directory, byte, and file installs produce identical hashes without loading plugin code", async (t) => {
    const { root, store } = await temporaryStore(t);
    const files = await pluginFixtureFiles();
    const directory = path.join(root, "plugin-src");
    for (const [member, bytes] of Object.entries(files)) {
        const destination = path.join(directory, ...member.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
    }
    const fromDirectory = await store.installFromDirectory(directory);
    const packedPath = path.join(root, "acme.example.plugin.json");
    const packedBytes = new TextEncoder().encode(JSON.stringify(await pluginFixtureResource()));
    await fs.writeFile(packedPath, packedBytes);
    const fromFile = await store.installFromFile(packedPath);
    const fromBytes = await store.installFromBytes(packedBytes);
    assert.equal(fromDirectory.packageHash, fromFile.packageHash);
    assert.equal(fromDirectory.runtimeHash, fromBytes.runtimeHash);
    assert.equal(fromDirectory.uiHash, fromFile.uiHash);
    assert.equal((await store.listInstalled()).packages.length, 1);

    const hostile = await pluginFixtureResource({
        mutateFiles(next) {
            next["runtime/index.js"] = new TextEncoder().encode(
                "throw new Error('plugin runtime must not load during install');\nexport default { register() {} };\n",
            );
        },
    });
    const hostileStore = new PluginStore(path.join(root, "hostile"));
    const installedHostile = await hostileStore.installFromBytes(new TextEncoder().encode(JSON.stringify(hostile)));
    assert.equal(installedHostile.packageHash, hostile.packageHash);
    assert.equal((await hostileStore.listInstalled()).revision, 1);
});

test("portable file install rejects malformed input, oversize, truncated JSON, and file symlinks", async (t) => {
    const { root, store } = await temporaryStore(t);
    await assert.rejects(store.installFromBytes(new TextEncoder().encode("{")), /not valid JSON|truncated/i);
    await assert.rejects(store.installFromBytes(new Uint8Array([0xff])), /UTF-8/);
    await assert.rejects(store.installFromBytes(new Uint8Array(16 * 1024 * 1024 + 1)), /exceeds/);
    const packedPath = path.join(root, "plugin.json");
    await fs.writeFile(packedPath, JSON.stringify(await pluginFixtureResource()));
    const linkPath = path.join(root, "plugin-link.json");
    await fs.symlink(packedPath, linkPath);
    await assert.rejects(store.installFromFile(linkPath), /regular, non-symlink file/);

    const interrupted = await pluginFixtureResource();
    const originalWrite = store._writeLibrary.bind(store);
    store._writeLibrary = async () => { throw new Error("injected library failure"); };
    await assert.rejects(
        store.installFromBytes(new TextEncoder().encode(JSON.stringify(interrupted))),
        /injected library failure/,
    );
    assert.equal((await store.getPackage(interrupted.packageHash)).packageHash, interrupted.packageHash);
    assert.equal((await store.listInstalled()).revision, 0);
    store._writeLibrary = originalWrite;
});
