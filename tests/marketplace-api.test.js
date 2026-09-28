import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { blobPath, registryPaths, resolveRegistryPath } from "../server/marketplace/registry/RegistryLayout.js";
import { createMarketplaceRouter } from "../server/routes/marketplaceRouter.js";
import { createPopulatedClientRegistry } from "./helpers/marketplaceClientRegistry.js";

async function listen(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1");
        server.once("error", reject);
        server.once("listening", () => resolve(server));
    });
}

async function request(origin, requestPath, { method = "GET", body } = {}) {
    const response = await fetch(`${origin}${requestPath}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: await response.json(),
    };
}

async function rawRequest(origin, requestPath, { headers = {} } = {}) {
    const response = await fetch(`${origin}${requestPath}`, { headers });
    return {
        status: response.status,
        headers: response.headers,
        bytes: Buffer.from(await response.arrayBuffer()),
    };
}

async function readOperationalText(root) {
    const chunks = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (entry.name === "credentials") continue;
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) chunks.push(await readOperationalText(entryPath));
        else if (entry.isFile()) chunks.push(await fs.readFile(entryPath, "utf8"));
    }
    return chunks.join("\n");
}

test("MKT-06 read and source APIs enforce verification, confinement, revisions, no-store, and redaction", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-api-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const dataDir = path.join(parent, "client");
    const service = await MarketplaceService.open(dataDir);
    t.after(() => service.close());
    const logs = [];
    const app = express();
    app.use("/api/marketplace", createMarketplaceRouter(service, {
        logger: { error: (line) => logs.push(line) },
    }));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const credential = { type: "bearer", token: "api-secret-token" };

    const invalidCredential = await request(origin, "/api/marketplace/sources/preview", {
        method: "POST",
        body: { baseUrl: registry.baseUrl, credential: null },
    });
    assert.equal(invalidCredential.status, 422);

    const preview = await request(origin, "/api/marketplace/sources/preview", {
        method: "POST",
        body: { baseUrl: registry.baseUrl, credential },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.cacheControl, "no-store");
    assert.equal(Object.hasOwn(preview.body, "rootBytes"), false);

    const mismatch = await request(origin, "/api/marketplace/sources", {
        method: "POST",
        body: {
            expectedRevision: 0,
            name: "Registry",
            baseUrl: registry.baseUrl,
            registryId: preview.body.registryId,
            trustedRootFingerprint: "0".repeat(64),
            enabled: true,
            priority: 0,
            credential,
        },
    });
    assert.equal(mismatch.status, 412);
    assert.equal(mismatch.body.error.code, "SOURCE_UNTRUSTED");

    const added = await request(origin, "/api/marketplace/sources", {
        method: "POST",
        body: {
            expectedRevision: 0,
            name: "Registry",
            baseUrl: registry.baseUrl,
            registryId: preview.body.registryId,
            trustedRootFingerprint: preview.body.trustedRootFingerprint,
            enabled: true,
            priority: 0,
            credential,
        },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.source.credentialConfigured, true);
    assert.equal(Object.hasOwn(added.body.source, "credentialRef"), false);
    const refreshed = await request(origin, `/api/marketplace/sources/${added.body.source.sourceId}/refresh`, {
        method: "POST",
        body: { expectedRevision: 1 },
    });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));

    const status = await request(origin, "/api/marketplace/status");
    assert.deepEqual(status.body, { mode: "read-only", canInstall: false });
    const discover = await request(origin, "/api/marketplace/discover?q=controller&track=stable&limit=1");
    assert.equal(discover.status, 200, JSON.stringify(discover.body));
    assert.equal(discover.cacheControl, "no-store");
    assert.equal(discover.body.page.total, 1, JSON.stringify(discover.body));
    assert.equal(discover.body.entries[0].item.itemId, registry.item.itemId);
    assert.equal(discover.body.entries[0].source.sourceId, added.body.source.sourceId);
    assert.equal(discover.body.entries[0].fresh, true);
    assert.equal(discover.body.entries[0].preview.sha256, registry.preview.sha256);
    const repeated = await request(origin, "/api/marketplace/discover?q=one&q=two");
    assert.equal(repeated.status, 422);
    const unknown = await request(origin, "/api/marketplace/discover?installed=true");
    assert.equal(unknown.status, 422);
    const overLimit = await request(origin, "/api/marketplace/discover?limit=101");
    assert.equal(overLimit.status, 422);

    const itemPath = `/api/marketplace/items/${added.body.source.sourceId}/${registry.item.itemId}`;
    const detail = await request(origin, itemPath);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.selectedRelease.releaseVersion, registry.release.releaseVersion);
    assert.equal(detail.body.verification.registryId, preview.body.registryId);
    assert.equal(detail.body.verification.trustedRootFingerprint, preview.body.trustedRootFingerprint);
    assert.equal(detail.body.verification.role, "releases");
    assert.equal(detail.body.verification.roleKeyIds.length, 1);
    assert.equal(detail.body.canInstall, false);

    const previewPath = `${itemPath}/previews/${registry.preview.sha256}`;
    const previewResponse = await rawRequest(origin, previewPath);
    assert.equal(previewResponse.status, 200);
    assert.deepEqual(previewResponse.bytes, registry.previewBytes);
    assert.equal(previewResponse.headers.get("content-type"), "image/png");
    assert.equal(previewResponse.headers.get("content-length"), String(registry.previewBytes.byteLength));
    assert.equal(previewResponse.headers.get("etag"), `"${registry.preview.sha256}"`);
    assert.equal(previewResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(previewResponse.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(previewResponse.headers.get("cache-control"), "private, max-age=31536000, immutable");
    const notModified = await rawRequest(origin, previewPath, {
        headers: { "if-none-match": `"${registry.preview.sha256}"` },
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.bytes.byteLength, 0);
    const unreferenced = await request(origin, `${itemPath}/previews/${"0".repeat(64)}`);
    assert.equal(unreferenced.status, 404);
    await fs.writeFile(
        resolveRegistryPath(registryPaths(registry.root), blobPath(registry.preview.sha256)),
        Buffer.alloc(registry.previewBytes.byteLength, 0x3c),
    );
    const malformed = await request(origin, previewPath);
    assert.equal(malformed.status, 422);
    assert.equal(malformed.body.error.code, "ARTIFACT_HASH_MISMATCH");
    assert.doesNotMatch(JSON.stringify(malformed.body), /authorization|api-secret-token|cause|registry\/blobs/u);

    const immutable = await request(origin, `/api/marketplace/sources/${added.body.source.sourceId}`, {
        method: "PATCH",
        body: { expectedRevision: 1, baseUrl: registry.baseUrl },
    });
    assert.equal(immutable.status, 422);
    const stale = await request(origin, `/api/marketplace/sources/${added.body.source.sourceId}`, {
        method: "PATCH",
        body: { expectedRevision: 0, name: "Stale" },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.currentRevision, 1);

    const listed = await request(origin, "/api/marketplace/sources");
    const serialized = JSON.stringify({ responses: [preview, mismatch, added, refreshed, immutable, stale, listed], logs });
    assert.equal(listed.body.sources[0].health.status, "ready");
    assert.doesNotMatch(serialized, /api-secret-token|credentialRef|authorization|cause/u);
    assert.doesNotMatch(await readOperationalText(path.join(dataDir, "marketplace")), /api-secret-token|authorization/u);
    assert.match(logs.join("\n"), /POST \/sources SOURCE_UNTRUSTED/u);
    assert.match(logs.join("\n"), /PATCH \/sources\/:sourceId DOCUMENT_INVALID/u);

    const cleared = await request(origin, `/api/marketplace/sources/${added.body.source.sourceId}`, {
        method: "PATCH",
        body: { expectedRevision: 1, credential: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.revision, 2);
    assert.equal(cleared.body.source.credentialConfigured, false);
    const removed = await request(origin, `/api/marketplace/sources/${added.body.source.sourceId}?expectedRevision=2`, {
        method: "DELETE",
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.revision, 3);
    assert.deepEqual((await request(origin, "/api/marketplace/sources")).body, { revision: 3, sources: [] });
});
