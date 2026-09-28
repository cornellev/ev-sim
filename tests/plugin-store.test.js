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

function marketplaceOwner(sourceId = "123e4567-e89b-12d3-a456-426614174001", overrides = {}) {
    return {
        sourceId,
        itemId: "acme.example",
        releaseVersion: "1.0.0",
        artifactSha256: "a".repeat(64),
        ...overrides,
    };
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

test("PluginStore atomically migrates version-1 entries to manual ownership without changing revision", async (t) => {
    const { store } = await temporaryStore(t);
    const resource = await pluginFixtureResource();
    await store.putPackage(resource);
    await fs.mkdir(store.root, { recursive: true });
    await fs.writeFile(store.libraryPath, `${JSON.stringify({
        kind: "cev-sim.plugin-library",
        version: 1,
        revision: 7,
        packages: [{
            pluginId: "acme.example",
            version: "1.0.0",
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            uiHash: resource.uiHash,
        }],
    }, null, 2)}\n`);

    assert.deepEqual(await store.ensureOwnershipMigration(), { revision: 7, migrated: true });
    assert.equal((await store.listInstalled()).revision, 7);
    const stored = JSON.parse(await fs.readFile(store.libraryPath, "utf8"));
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.packages[0].ownership, { manual: true, marketplace: [] });
});

test("PluginStore preserves manual and independent marketplace ownership until the last owner leaves", async (t) => {
    const { store } = await temporaryStore(t);
    const resource = await pluginFixtureResource();
    const first = marketplaceOwner();
    const second = marketplaceOwner("123e4567-e89b-12d3-a456-426614174002", { artifactSha256: "b".repeat(64) });
    await store.putPackage(resource);
    await store.addManualOwner(resource.packageHash);
    await store.addMarketplaceOwner(resource, first);
    await store.addMarketplaceOwner(resource, second);
    assert.equal((await store.snapshotWithOwners()).revision, 3);

    assert.deepEqual(await store.removeManualOwner("acme.example", resource.packageHash), {
        ownerChanged: true,
        membershipChanged: false,
        revision: 4,
    });
    assert.equal((await store.listInstalled()).packages.length, 1);
    assert.equal((await store.removeMarketplaceOwner("acme.example", resource.packageHash, first)).membershipChanged, false);
    assert.equal((await store.listInstalled()).packages.length, 1);

    await fs.mkdir(path.join(store.runtimeDir, resource.runtimeHash), { recursive: true });
    await fs.writeFile(path.join(store.runtimeDir, resource.runtimeHash, "retained"), "retained");
    assert.equal((await store.removeMarketplaceOwner("acme.example", resource.packageHash, second)).membershipChanged, true);
    assert.deepEqual((await store.listInstalled()).packages, []);
    assert.equal((await store.getPackage(resource.packageHash)).packageHash, resource.packageHash);
    assert.equal(await fs.readFile(path.join(store.runtimeDir, resource.runtimeHash, "retained"), "utf8"), "retained");
});

test("PluginStore manual removal cannot hide a marketplace-owned package", async (t) => {
    const { store } = await temporaryStore(t);
    const resource = await pluginFixtureResource();
    await store.addMarketplaceOwner(resource, marketplaceOwner());
    assert.equal(await store.removeFromLibrary("acme.example", resource.packageHash), false);
    assert.equal((await store.listInstalled()).packages.length, 1);
});

test("PluginStore keeps coexisting plugin versions and serializes idempotent owner mutations", async (t) => {
    const { store } = await temporaryStore(t);
    const first = await pluginFixtureResource();
    const second = await pluginFixtureResource({ mutateDocument(document) { document.version = "2.0.0"; } });
    const firstOwner = marketplaceOwner();
    const secondOwner = marketplaceOwner("123e4567-e89b-12d3-a456-426614174002", {
        releaseVersion: "2.0.0",
        artifactSha256: "b".repeat(64),
    });
    const additions = await Promise.all(Array.from({ length: 8 }, () => store.addMarketplaceOwner(first, firstOwner)));
    assert.equal(additions.filter((entry) => entry.ownerChanged).length, 1);
    await store.addMarketplaceOwner(second, secondOwner);
    const snapshot = await store.snapshotWithOwners();
    assert.equal(snapshot.revision, 2);
    assert.deepEqual(snapshot.packages.map((entry) => entry.version), ["1.0.0", "2.0.0"]);

    const removals = await Promise.all(Array.from({ length: 8 }, () => (
        store.removeMarketplaceOwner("acme.example", first.packageHash, firstOwner)
    )));
    assert.equal(removals.filter((entry) => entry.ownerChanged).length, 1);
    assert.equal((await store.snapshotWithOwners()).revision, 3);
    assert.deepEqual((await store.listInstalled()).packages.map((entry) => entry.version), ["2.0.0"]);
});
