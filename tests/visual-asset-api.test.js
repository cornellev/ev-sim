import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import test from "node:test";

import express from "express";

import { VisualAssetClient } from "../app/3d/environment/visual/VisualAssetClient.js";
import { VISUAL_ASSET_ACCESS_OPERATIONS, VISUAL_ASSET_UPLOAD_OPERATIONS } from "../app/simulation/visual/VisualLayer.js";
import { mountStorageApi } from "../server/routes/storageApi.js";
import { StorageService } from "../server/storage/StorageService.js";
import { VISUAL_ASSET_ERROR_CODES } from "../server/storage/StorageErrors.js";
import { makePng, ownedGrant, sha256Hex, writeRegistry } from "./helpers/visual-assets.js";

async function withApi(fn) {
    const dir = await fs.mkdtemp((await import("node:os")).tmpdir() + "/cev-visual-api-");
    await writeRegistry(dir, [ownedGrant("owned-lab")]);
    const service = new StorageService(dir, {
        visualAssets: { registryPath: `${dir}/visual-source-registry.json` },
    });
    const app = express();
    mountStorageApi(app, service);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    const client = new VisualAssetClient({ baseUrl: `${origin}/api/storage/visual-assets` });
    try {
        await fn({ origin, client, service, dir });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(dir, { recursive: true, force: true });
    }
}

test("VisualAssetClient and streaming routes honor parser ordering and hide digest URLs", async () => {
    await withApi(async ({ origin, client }) => {
        const bytes = makePng();
        const asset = {
            sha256: sha256Hex(bytes),
            mediaType: "image/png",
            sizeBytes: bytes.length,
            role: "texture",
        };
        const upload = await client.createUpload({ asset, sourceIds: ["owned-lab"], dependencies: {} });
        const published = await client.putUploadContent(upload.id, bytes, { mediaType: "image/png" });
        const use = await client.getUse(published.useHash);
        assert.equal(use.asset.sha256, asset.sha256);
        const head = await client.headUseContent(published.useHash);
        assert.equal(head.etag, `"${asset.sha256}"`);
        assert.equal(head.acceptRanges, "bytes");
        const content = await client.getUseContent(published.useHash);
        assert.deepEqual([...content.bytes], [...bytes]);
        const ranged = await client.getUseContent(published.useHash, { range: { start: 0, end: 7 } });
        assert.equal(ranged.status, 206);
        assert.equal(ranged.bytes.length, 8);
        const closure = await client.validateClosure({
            useHash: published.useHash,
            operations: [...VISUAL_ASSET_UPLOAD_OPERATIONS, ...VISUAL_ASSET_ACCESS_OPERATIONS],
        });
        assert.equal(closure.ok, true);

        const digestResponse = await fetch(`${origin}/api/storage/visual-assets/sha256/${asset.sha256}`);
        assert.equal(digestResponse.status, 404);
        const digestBody = await digestResponse.json();
        assert.equal(digestBody.code, VISUAL_ASSET_ERROR_CODES.USE_NOT_FOUND);

        const deleteUse = await fetch(`${origin}/api/storage/visual-assets/uses/sha256/${published.useHash}`, { method: "DELETE" });
        assert.equal(deleteUse.status, 405);
        assert.equal((await deleteUse.json()).code, VISUAL_ASSET_ERROR_CODES.DELETION_DISABLED);

        const rangeFail = await fetch(`${origin}/api/storage/visual-assets/uses/sha256/${published.useHash}/content`, {
            headers: { Range: "bytes=999-1000" },
        });
        assert.equal(rangeFail.status, 416);
        assert.equal(rangeFail.headers.get("Content-Range"), `bytes */${bytes.length}`);
    });
});

test("PUT content is not consumed by the shared JSON parser", async () => {
    await withApi(async ({ origin, client }) => {
        const bytes = makePng();
        const upload = await client.createUpload({
            asset: { sha256: sha256Hex(bytes), mediaType: "image/png", sizeBytes: bytes.length, role: "texture" },
            sourceIds: ["owned-lab"],
            dependencies: {},
        });
        const response = await fetch(`${origin}/api/storage/visual-assets/uploads/${upload.id}/content`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(bytes.length),
            },
            body: bytes,
        });
        const payload = await response.json();
        assert.equal(response.status, 200, JSON.stringify(payload));
        assert.equal(payload.use.asset.sha256, sha256Hex(bytes));
    });
});
