import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceRegistryService } from "../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";
import {
    catalogRevisionPath,
    itemTargetPath,
    registryPaths,
    releaseTargetPath,
} from "../server/marketplace/registry/RegistryLayout.js";

const documents = JSON.parse(await fs.readFile(new URL("./fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));

async function workspace(t) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-registry-storage-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    return { parent, root: path.join(parent, "registry") };
}

function itemBytes(overrides = {}) {
    return Buffer.from(JSON.stringify({ ...structuredClone(documents.item), previews: [], ...overrides }));
}

test("MKT-03 layout paths are normalized and content-addressed", () => {
    assert.equal(itemTargetPath("com.example.item", "a".repeat(64)), `targets/items/com.example.item/${"a".repeat(64)}.json`);
    assert.equal(
        releaseTargetPath("com.example.item", "1.2.3", "b".repeat(64)),
        `targets/releases/com.example.item/1.2.3/${"b".repeat(64)}.json`,
    );
    assert.equal(catalogRevisionPath(12, "c".repeat(64)), `catalog/revisions/12-${"c".repeat(64)}.json`);
    assert.throws(() => itemTargetPath("../escape", "a".repeat(64)));
});

test("MKT-03 initialization is atomic, private, complete, and idempotent", async (t) => {
    const { root } = await workspace(t);
    const created = await MarketplaceRegistryStore.initialize(root, {
        registryId: "123e4567-e89b-12d3-a456-426614174000",
        now: () => new Date("2026-09-27T12:00:00.000Z"),
        unsafeUnsignedDevelopment: true,
    });
    const repeated = await MarketplaceRegistryStore.initialize(root);
    assert.deepEqual(repeated, created);
    const paths = registryPaths(root);
    assert.equal((await fs.stat(paths.root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(paths.registry)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(paths.catalogCurrent)).mode & 0o777, 0o600);
    const catalog = JSON.parse(await fs.readFile(paths.catalogCurrent, "utf8"));
    assert.equal(catalog.revision, 1);
    assert.deepEqual(catalog.items, []);
    assert.equal((await fs.readdir(paths.catalogRevisions)).length, 1);
    await assert.rejects(
        MarketplaceRegistryStore.initialize(root, { registryId: "123e4567-e89b-12d3-a456-426614174001" }),
        (error) => error.code === "CONFLICT",
    );
});

test("MKT-03 writer ownership rejects live writers and safely reclaims a dead same-host owner", async (t) => {
    const { root } = await workspace(t);
    await MarketplaceRegistryStore.initialize(root, { unsafeUnsignedDevelopment: true });
    const first = await MarketplaceRegistryStore.open(root);
    await assert.rejects(MarketplaceRegistryStore.open(root), (error) => error.code === "CONFLICT");
    await first.close();

    const paths = registryPaths(root);
    await fs.mkdir(paths.writerLock, { mode: 0o700 });
    await fs.writeFile(paths.writerOwner, JSON.stringify({
        acquiredAt: "2026-09-27T12:00:00.000Z",
        hostname: os.hostname(),
        pid: 2_000_000_000,
        token: "a".repeat(64),
    }), { mode: 0o600 });
    const reclaimed = await MarketplaceRegistryStore.open(root);
    assert.notEqual(JSON.parse(await fs.readFile(paths.writerOwner, "utf8")).token, "a".repeat(64));
    await reclaimed.close();
    await assert.rejects(fs.access(paths.writerLock));
});

test("MKT-03 journal recovery completes forward at every durable commit boundary", async (t) => {
    const boundaries = [
        "afterJournalDurability",
        "afterTargetRename",
        "afterRevisionPublication",
        "afterCurrentCatalogRename",
        "beforeJournalCleanup",
    ];
    for (const boundary of boundaries) {
        const { root } = await workspace(t);
        await MarketplaceRegistryStore.initialize(root, { unsafeUnsignedDevelopment: true });
        let store = await MarketplaceRegistryStore.open(root);
        const service = new MarketplaceRegistryService(store, {
            faults: { [boundary]: () => { throw new Error(`fault:${boundary}`); } },
        });
        await assert.rejects(service.admitItem(itemBytes()), new RegExp(`fault:${boundary}`));
        assert.equal((await store.readCatalog()).revision, boundary === "afterCurrentCatalogRename" || boundary === "beforeJournalCleanup" ? 2 : 1);
        await store.close();

        store = await MarketplaceRegistryStore.open(root);
        const catalog = await store.readCatalog();
        assert.equal(catalog.revision, 2);
        assert.equal(catalog.items.length, 1);
        assert.deepEqual(await fs.readdir(registryPaths(root).transactions), []);
        await store.close();
    }
});

test("MKT-03 rejects hostile symlink nodes instead of following them", async (t) => {
    const { parent, root } = await workspace(t);
    await MarketplaceRegistryStore.initialize(root, { unsafeUnsignedDevelopment: true });
    const paths = registryPaths(root);
    await fs.rmdir(paths.blobs);
    await fs.symlink(parent, paths.blobs);
    await assert.rejects(MarketplaceRegistryStore.open(root), (error) => error.code === "RECOVERY_REQUIRED");
});
