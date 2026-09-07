import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import {
    VISUAL_ASSET_ACCESS_OPERATIONS,
    VISUAL_ASSET_UPLOAD_OPERATIONS,
    hashVisualLayer,
    parseVisualLayerJson,
} from "../app/simulation/visual/VisualLayer.js";
import { VISUAL_ASSET_ERROR_CODES } from "../server/storage/StorageErrors.js";
import {
    createAssetStore,
    makePng,
    ownedGrant,
    publishAsset,
    restrictedGrant,
    writeRegistry,
} from "./helpers/visual-assets.js";

const operations = [...VISUAL_ASSET_UPLOAD_OPERATIONS, ...VISUAL_ASSET_ACCESS_OPERATIONS];

async function withStore(sources, fn, options = {}) {
    const created = await createAssetStore({ sources, ...options });
    try {
        return await fn(created.store, created.dir);
    } finally {
        await fs.rm(created.dir, { recursive: true, force: true });
    }
}

test("G-RIGHTS fail closed for unknown, google-derived, expired, revoked, and incomplete grants", async () => {
    const sources = [
        ownedGrant("owned-lab"),
        restrictedGrant("google", {
            kind: "google-derived",
            permissions: { "live-preview-display": true },
        }),
        restrictedGrant("expired", { expiresAt: "2026-01-01T00:00:00.000Z" }),
        restrictedGrant("revoked", { status: "revoked" }),
        restrictedGrant("partial", { permissions: { display: true } }),
        restrictedGrant("derived", { ancestorIds: ["google"] }),
    ];
    await withStore(sources, async (store) => {
        const bytes = makePng();
        await assert.rejects(
            () => publishAsset(store, bytes, { mediaType: "image/png", role: "texture", sourceIds: ["unknown"] }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
        );
        for (const sourceId of ["google", "expired", "revoked", "partial", "derived"]) {
            await assert.rejects(
                () => publishAsset(store, bytes, { mediaType: "image/png", role: "texture", sourceIds: [sourceId] }),
                (error) => error.code === VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
                sourceId,
            );
        }
        const owned = await publishAsset(store, bytes, { mediaType: "image/png", role: "texture", sourceIds: ["owned-lab"] });
        await store.validateClosure({ useHash: owned.useHash, operations });
    }, { now: () => new Date("2026-09-06T00:00:00.000Z") });
});

test("G-RIGHTS traverse ancestral uses, survive dedup, and re-evaluate runtime revocation", async () => {
    const sources = [
        ownedGrant("owned-lab"),
        restrictedGrant("google", {
            kind: "google-derived",
            permissions: { "live-preview-display": true },
        }),
    ];
    await withStore(sources, async (store, dir) => {
        const texture = makePng();
        const ownedTexture = await publishAsset(store, texture, {
            mediaType: "image/png",
            role: "texture",
            sourceIds: ["owned-lab"],
        });
        await assert.rejects(
            () => publishAsset(store, texture, {
                mediaType: "image/png",
                role: "texture",
                sourceIds: ["google"],
            }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
        );

        await writeRegistry(dir, [
            ownedGrant("owned-lab"),
            restrictedGrant("restricted", { ancestorIds: ["owned-lab"], permissions: { display: true } }),
        ]);
        const ancestral = await publishAsset(store, makePng({ green: 8 }), {
            mediaType: "image/png",
            role: "texture",
            sourceIds: ["restricted"],
        }).catch((error) => error);
        assert.equal(ancestral.code, VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED);

        await writeRegistry(dir, [ownedGrant("owned-lab")]);
        const published = await publishAsset(store, makePng({ blue: 8 }), {
            mediaType: "image/png",
            role: "texture",
            sourceIds: ["owned-lab"],
        });
        await writeRegistry(dir, [ownedGrant("owned-lab", { status: "revoked" })]);
        await assert.rejects(
            () => store.statUseContent(published.useHash),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
        );
        await assert.rejects(
            () => store.acquireRoot({
                ownerId: "synthetic-bake",
                useHash: published.useHash,
                operations,
            }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
        );
    });
});

test("G-RIGHTS evidence does not change visual layer or episode identity hashes", async () => {
    const fixturePath = new URL("./fixtures/visual-layer/owned-layer.v1.json", import.meta.url);
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
    const before = hashVisualLayer(fixture.document);
    await withStore([ownedGrant("owned-lab")], async (store) => {
        await publishAsset(store, makePng(), { mediaType: "image/png", role: "texture" });
        assert.equal(hashVisualLayer(fixture.document), before);
        assert.equal(parseVisualLayerJson(JSON.stringify(fixture.document)).sourceWorldHash, fixture.document.sourceWorldHash);
    });
});

test("G-RIGHTS ignore forged ownership metadata on the upload body", async () => {
    await withStore([ownedGrant("owned-lab")], async (store) => {
        const bytes = makePng();
        await assert.rejects(
            () => store.createUpload({
                asset: { sha256: "a".repeat(64), mediaType: "image/png", sizeBytes: bytes.length, role: "texture" },
                sourceIds: ["forged"],
                dependencies: {},
                owned: true,
            }),
            /unknown field|trusted source|RIGHTS|denied/i,
        );
    });
});
