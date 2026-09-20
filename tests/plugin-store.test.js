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
