import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { VISUAL_ASSET_ACCESS_OPERATIONS, VISUAL_ASSET_UPLOAD_OPERATIONS } from "../app/simulation/visual/VisualLayer.js";
import { VISUAL_ASSET_ERROR_CODES } from "../server/storage/StorageErrors.js";
import { VisualAssetStore } from "../server/storage/VisualAssetStore.js";
import {
    createAssetStore,
    makePng,
    publishAsset,
    sha256Hex,
    writeRegistry,
    ownedGrant,
} from "./helpers/visual-assets.js";

const limits = {
    publishedBytes: 120,
    stagingBytes: 120,
    decodedClosureBytes: 1024 * 1024,
    concurrentUploads: 2,
    abandonedStageTtlMs: 50,
};

async function withStore(fn, options = {}) {
    const created = await createAssetStore({ limits, ...options });
    try {
        return await fn(created.store, created.dir);
    } finally {
        await fs.rm(created.dir, { recursive: true, force: true });
    }
}

test("G-LIFECYCLE reserves quota concurrently and never deletes published bytes", async () => {
    await withStore(async (store, dir) => {
        const first = makePng({ width: 2, height: 2 });
        const second = makePng({ width: 3, height: 1, green: 0x80 });
        const results = await Promise.allSettled([
            publishAsset(store, first, { mediaType: "image/png", role: "texture" }),
            publishAsset(store, second, { mediaType: "image/png", role: "texture" }),
            publishAsset(store, makePng({ width: 2, height: 2, blue: 0x40 }), { mediaType: "image/png", role: "texture" }),
        ]);
        assert.ok(results.some((entry) => entry.status === "rejected"));
        assert.ok(results.some((entry) => entry.status === "fulfilled"));
        const published = results.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
        for (const item of published) {
            const casPath = path.join(dir, "visual-assets", "sha256", item.use.asset.sha256);
            assert.equal(await fs.readFile(casPath).then((bytes) => sha256Hex(bytes)), item.use.asset.sha256);
            await assert.rejects(() => store.deletePublished(), (error) => (
                error.code === VISUAL_ASSET_ERROR_CODES.DELETION_DISABLED
            ));
        }
    });
});

test("G-LIFECYCLE deduplicates bytes while preserving distinct use hashes and cancelling staging", async () => {
    await withStore(async (store, dir) => {
        const bytes = makePng();
        const first = await publishAsset(store, bytes, { mediaType: "image/png", role: "texture", sourceIds: ["owned-lab"] });
        await writeRegistry(dir, [
            ownedGrant("owned-lab"),
            ownedGrant("owned-other"),
        ]);
        const second = await publishAsset(store, bytes, { mediaType: "image/png", role: "texture", sourceIds: ["owned-other"] });
        assert.notEqual(first.useHash, second.useHash);
        const casEntries = (await fs.readdir(path.join(dir, "visual-assets", "sha256"))).filter((name) => name.length === 64);
        assert.equal(casEntries.length, 1);

        const upload = await store.createUpload({
            asset: { sha256: sha256Hex(bytes), mediaType: "image/png", sizeBytes: bytes.length, role: "texture" },
            sourceIds: ["owned-lab"],
            dependencies: {},
        });
        const cancelled = await store.abortUpload(upload.id);
        assert.equal(cancelled.cancelled, true);
        const again = await store.abortUpload(upload.id);
        assert.equal(again.cancelled, true);
        assert.equal((await fs.readdir(path.join(dir, "visual-assets", "staging"))).length, 0);
    });
});

test("G-LIFECYCLE recovers interrupted streams, injected write faults, and every journal phase", async () => {
    await withStore(async (store, dir) => {
        const bytes = makePng();
        const truncated = Readable.from([bytes.subarray(0, 4)]);
        const upload = await store.createUpload({
            asset: { sha256: sha256Hex(bytes), mediaType: "image/png", sizeBytes: bytes.length, role: "texture" },
            sourceIds: ["owned-lab"],
            dependencies: {},
        });
        await assert.rejects(
            () => store.writeUploadContent(upload.id, truncated, { contentLength: bytes.length }),
            /expected|shorter|ended after/i,
        );
        await store.abortUpload(upload.id);

        store.faults.write = async () => {
            const error = new Error("ENOSPC");
            error.code = "ENOSPC";
            throw error;
        };
        await assert.rejects(
            () => publishAsset(store, makePng({ width: 2, height: 1 }), { mediaType: "image/png", role: "texture" }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.DISK_FULL,
        );
        delete store.faults.write;

        store.faults.write = async () => {
            throw Object.assign(new Error("short"), { code: VISUAL_ASSET_ERROR_CODES.SHORT_WRITE });
        };
        await assert.rejects(
            () => publishAsset(store, makePng({ width: 1, height: 2 }), { mediaType: "image/png", role: "texture" }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.SHORT_WRITE,
        );
        delete store.faults.write;

        store.faults.fsync = async () => {
            throw Object.assign(new Error("fsync"), { code: "EIO" });
        };
        await assert.rejects(() => publishAsset(store, makePng({ red: 1 }), { mediaType: "image/png", role: "texture" }));
        delete store.faults.fsync;

        store.faults.link = async () => {
            throw Object.assign(new Error("link"), { code: "EIO" });
        };
        await assert.rejects(() => publishAsset(store, makePng({ green: 1 }), { mediaType: "image/png", role: "texture" }));
        delete store.faults.link;

        const published = await publishAsset(store, makePng({ blue: 1 }), { mediaType: "image/png", role: "texture" });
        const phases = ["acquire-new", "release-old"];
        for (const phase of phases) {
            const journalDir = path.join(dir, "visual-assets", "journals", "root-replace");
            await fs.mkdir(journalDir, { recursive: true });
            await fs.writeFile(path.join(journalDir, "synthetic-owner.json"), JSON.stringify({
                phase,
                ownerId: "synthetic-owner",
                ownerKind: "synthetic",
                oldGeneration: 1,
                newGeneration: 2,
                oldUseHash: published.useHash,
                newUseHash: published.useHash,
            }));
            const recovered = new VisualAssetStore(dir, {
                registryPath: path.join(dir, "visual-source-registry.json"),
                limits,
            });
            await recovered.initialize();
            assert.equal((await fs.readdir(journalDir)).length, 0);
        }
    }, { limits: { ...limits, publishedBytes: 1024 * 1024, stagingBytes: 1024 * 1024 } });
});

test("G-LIFECYCLE roots use compare-and-swap, pins expire on restart, and readers see immutable bytes", async () => {
    let now = Date.parse("2026-09-06T00:00:00.000Z");
    await withStore(async (store, dir) => {
        const published = await publishAsset(store, makePng(), { mediaType: "image/png", role: "texture" });
        const root = await store.acquireRoot({
            ownerId: "synthetic-env",
            ownerKind: "synthetic",
            useHash: published.useHash,
            operations: [...VISUAL_ASSET_UPLOAD_OPERATIONS, ...VISUAL_ASSET_ACCESS_OPERATIONS],
        });
        assert.equal(root.generation, 1);
        await assert.rejects(
            () => store.acquireRoot({
                ownerId: "synthetic-env",
                useHash: published.useHash,
                operations: VISUAL_ASSET_ACCESS_OPERATIONS,
            }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.CONFLICT,
        );
        const other = await publishAsset(store, makeJpegSafe(), { mediaType: "image/jpeg", role: "texture" });
        const replaced = await store.replaceRoot({
            ownerId: "synthetic-env",
            expectedGeneration: 1,
            useHash: other.useHash,
            operations: [...VISUAL_ASSET_UPLOAD_OPERATIONS, ...VISUAL_ASSET_ACCESS_OPERATIONS],
        });
        assert.equal(replaced.generation, 2);
        await store.releaseRoot({ ownerId: "synthetic-env", expectedGeneration: 2 });

        const pin = await store.acquirePin({
            ownerId: "synthetic-worker",
            useHash: published.useHash,
            operations: VISUAL_ASSET_ACCESS_OPERATIONS,
            leaseMs: 10,
        });
        now = Date.parse("2026-09-06T02:00:00.000Z");
        const recovered = new VisualAssetStore(dir, {
            registryPath: path.join(dir, "visual-source-registry.json"),
            limits,
            now: () => new Date(now),
        });
        await recovered.initialize();
        await assert.rejects(() => recovered.renewPin({ handle: pin.handle }));
        await recovered.releasePin({ handle: pin.handle });
        await recovered.releasePin({ handle: pin.handle });

        const opened = await store.openUseContent(published.useHash);
        const before = await fs.readFile(path.join(dir, "visual-assets", "sha256", published.use.asset.sha256));
        await assert.rejects(() => store.deletePublished());
        const after = await fs.readFile(path.join(dir, "visual-assets", "sha256", published.use.asset.sha256));
        assert.deepEqual(after, before);
        opened.stream.resume();
        await opened.release();
    }, { now: () => new Date(now) });
});

test("legacy single-use roots and pins migrate to sorted use-hash sets", async () => {
    await withStore(async (store, dir) => {
        const published = await publishAsset(store, makePng({ width: 2, height: 2 }), {
            mediaType: "image/png",
            role: "texture",
        });
        const other = await publishAsset(store, makePng({ width: 3, height: 1, green: 0x40 }), {
            mediaType: "image/png",
            role: "texture",
        });
        await fs.writeFile(path.join(dir, "visual-assets", "roots.json"), JSON.stringify({
            kind: "cev-sim.visual-asset-roots",
            version: 1,
            roots: {
                "synthetic-env": {
                    ownerId: "synthetic-env",
                    ownerKind: "environment",
                    generation: 4,
                    useHash: published.useHash,
                },
            },
        }));
        await fs.writeFile(path.join(dir, "visual-assets", "pins.json"), JSON.stringify({
            kind: "cev-sim.visual-asset-pins",
            version: 1,
            pins: {
                "legacy-pin": {
                    ownerId: "synthetic-worker",
                    handle: "legacy-pin",
                    useHash: other.useHash,
                    expiresAt: "2099-01-01T00:00:00.000Z",
                },
            },
        }));
        const recovered = new VisualAssetStore(dir, {
            registryPath: path.join(dir, "visual-source-registry.json"),
            limits,
        });
        await recovered.initialize();
        const replaced = await recovered.replaceRoot({
            ownerId: "synthetic-env",
            expectedGeneration: 4,
            useHashes: [other.useHash, published.useHash],
            operations: VISUAL_ASSET_ACCESS_OPERATIONS,
        });
        assert.deepEqual(replaced.useHashes, [other.useHash, published.useHash].sort());
        assert.equal(replaced.useHash, replaced.useHashes[0]);
        const pin = await recovered.acquirePin({
            ownerId: "synthetic-worker-2",
            useHashes: [published.useHash, other.useHash],
            operations: VISUAL_ASSET_ACCESS_OPERATIONS,
        });
        assert.deepEqual(pin.useHashes, [other.useHash, published.useHash].sort());
        await recovered.releasePin({ handle: pin.handle });
        await recovered.releaseRoot({ ownerId: "synthetic-env", expectedGeneration: replaced.generation });
    }, { limits: { ...limits, publishedBytes: 1024 * 1024, stagingBytes: 1024 * 1024 } });
});

function makeJpegSafe() {
    return Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);
}
