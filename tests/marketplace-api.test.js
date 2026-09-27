import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
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

test("MKT-05 source APIs enforce confirmation, revisions, immutability, no-store, and redaction", async (t) => {
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
    assert.equal(refreshed.status, 200);

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
