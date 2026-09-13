import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EditorAssetStore } from "../server/storage/EditorAssetStore.js";
import { EDITOR_ASSET_ERROR_CODES } from "../server/storage/StorageErrors.js";

const USE_HASH = "b".repeat(64);

class FakeVisualAssets {
    constructor() { this.roots = new Map(); }
    async initialize() {}
    async getUse(useHash) { return { asset: { sha256: "a".repeat(64), mediaType: "model/gltf-binary", sizeBytes: 12, role: "mesh" }, sourceIds: ["owned"] , dependencies: {}, useHash }; }
    async validateClosure() { return { ok: true }; }
    async getRoot(ownerId) { return this.roots.get(ownerId) ?? null; }
    async acquireRoot({ ownerId, useHash, ownerKind }) {
        if (this.roots.has(ownerId)) throw new Error("root exists");
        const root = { ownerId, useHash, ownerKind, generation: 1 };
        this.roots.set(ownerId, root);
        return root;
    }
    async replaceRoot({ ownerId, expectedGeneration, useHash, ownerKind }) {
        const root = this.roots.get(ownerId);
        assert.equal(root.generation, expectedGeneration);
        const next = { ...root, useHash, ownerKind, generation: root.generation + 1 };
        this.roots.set(ownerId, next);
        return next;
    }
    async releaseRoot({ ownerId, expectedGeneration }) {
        assert.equal(this.roots.get(ownerId)?.generation, expectedGeneration);
        this.roots.delete(ownerId);
        return { released: true };
    }
}

async function fixture(t, options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-editor-assets-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const visualAssets = options.visualAssets ?? new FakeVisualAssets();
    const now = options.now ?? (() => new Date("2026-09-12T12:00:00.000Z"));
    const store = new EditorAssetStore(dir, { visualAssets, now, faults: options.faults });
    return { dir, visualAssets, store, now };
}

function draft(overrides = {}) {
    return { assetId: "crate", name: "Crate", publicationId: "publication-1", modelUseHash: USE_HASH, tags: ["cargo"], ...overrides };
}

test("ED-06 catalog writes use one revision lane and publication retries are idempotent", async (t) => {
    const { store, visualAssets } = await fixture(t);
    const published = await store.publishRevision(draft(), 0);
    assert.equal(published.catalogRevision, 1);
    assert.equal(published.revision.revision, 1);
    assert.equal(visualAssets.roots.size, 1);
    assert.deepEqual(await store.publishRevision(draft(), 0), {
        catalogRevision: 1, asset: published.asset, revision: published.revision,
    });

    const concurrent = await Promise.allSettled([
        store.createFolder({ id: "yard", name: "Yard" }, 1),
        store.createFolder({ id: "props", name: "Props" }, 1),
    ]);
    assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
    const conflict = concurrent.find((entry) => entry.status === "rejected").reason;
    assert.equal(conflict.code, EDITOR_ASSET_ERROR_CODES.REVISION_CONFLICT);
    assert.equal(conflict.currentRevision, 2);
});

test("ED-06 folders reject cycles and nonempty deletion while archive retains immutable roots", async (t) => {
    const { store, visualAssets } = await fixture(t);
    await store.createFolder({ id: "yard", name: "Yard" }, 0);
    await store.createFolder({ id: "props", name: "Props", parentId: "yard" }, 1);
    await assert.rejects(() => store.updateFolder("yard", { parentId: "props" }, 2), (error) => error.code === EDITOR_ASSET_ERROR_CODES.INVALID);
    await store.publishRevision(draft({ folderId: "props" }), 2);
    await assert.rejects(() => store.deleteFolder("props", 3), (error) => error.code === EDITOR_ASSET_ERROR_CODES.FOLDER_NOT_EMPTY);
    await store.setArchived("crate", true, 3);
    assert.equal((await store.get("crate")).asset.archived, true);
    assert.equal(visualAssets.roots.size, 1, "archive keeps the model revision root");
    assert.equal((await store.getRevision("crate", 1)).modelUseHash, USE_HASH);
});

test("ED-06 recovery rolls back unpublished revision state and completes committed publications", async (t) => {
    const visualAssets = new FakeVisualAssets();
    const rollback = await fixture(t, {
        visualAssets,
        faults: { editorAssetAfterRoot() { throw new Error("crash after root"); } },
    });
    await assert.rejects(() => rollback.store.publishRevision(draft(), 0), /crash after root/);
    assert.equal(visualAssets.roots.size, 1);
    const recovered = new EditorAssetStore(rollback.dir, { visualAssets, now: rollback.now });
    await recovered.initialize();
    assert.equal(visualAssets.roots.size, 0);
    assert.equal((await recovered.list()).assets.length, 0);

    const committedDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-editor-assets-committed-"));
    t.after(() => fs.rm(committedDir, { recursive: true, force: true }));
    const committedVisuals = new FakeVisualAssets();
    const crashed = new EditorAssetStore(committedDir, {
        visualAssets: committedVisuals, now: rollback.now,
        faults: { editorAssetAfterCatalog() { throw new Error("crash after catalog"); } },
    });
    await assert.rejects(() => crashed.publishRevision(draft(), 0), /crash after catalog/);
    const restarted = new EditorAssetStore(committedDir, { visualAssets: committedVisuals, now: rollback.now });
    await restarted.initialize();
    const replay = await restarted.publishRevision(draft(), 0);
    assert.equal(replay.catalogRevision, 1);
    assert.equal(replay.revision.publicationId, "publication-1");
    assert.equal(committedVisuals.roots.size, 1);
});
