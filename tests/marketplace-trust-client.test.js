import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceFixedOriginFetcher } from "../server/marketplace/client/MarketplaceFixedOriginFetcher.js";
import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { MarketplaceRegistryHttpServer } from "../server/marketplace/registry/RegistryHttpServer.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";

test("MKT-05 previews, confirms, refreshes, and reads one complete verified registry snapshot", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-client-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registryRoot = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(registryRoot, {
        offlineRootKeyPath: path.join(parent, "root.pem"),
    });
    const registry = await MarketplaceRegistryHttpServer.open(registryRoot);
    t.after(() => registry.close());
    const address = await registry.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    const service = await MarketplaceService.open(path.join(parent, "client"));
    t.after(() => service.close());

    const preview = await service.previewSource({ baseUrl });
    assert.equal(preview.baseUrl, baseUrl);
    assert.match(preview.trustedRootFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(preview.rootVersion, 1);
    assert.equal(Object.hasOwn(preview, "rootBytes"), false);

    await assert.rejects(
        service.addSource({
            expectedRevision: 0,
            name: "Wrong trust",
            baseUrl,
            registryId: preview.registryId,
            trustedRootFingerprint: "0".repeat(64),
            enabled: true,
            priority: 0,
        }),
        (error) => error.code === "SOURCE_UNTRUSTED",
    );
    assert.deepEqual(await service.listSources(), { revision: 0, sources: [] });

    const added = await service.addSource({
        expectedRevision: 0,
        name: "Local registry",
        baseUrl,
        registryId: preview.registryId,
        trustedRootFingerprint: preview.trustedRootFingerprint,
        enabled: true,
        priority: 10,
    });
    assert.equal(added.revision, 1);
    assert.equal(added.source.credentialConfigured, false);
    assert.equal(added.source.health.status, "stale");

    const refreshed = await service.refreshSource(added.source.sourceId, { expectedRevision: 1 });
    assert.equal(refreshed.catalogRevision, 1);
    assert.equal(refreshed.health.status, "ready");
    const cached = await service.readVerifiedCatalog(added.source.sourceId, { requireFresh: true });
    assert.equal(cached.document.registryId, preview.registryId);
    assert.equal(cached.document.items.length, 0);
    assert.equal(cached.document.releases.length, 0);
    assert.equal(cached.fresh, true);
});

test("MKT-05 fixed-origin transport rejects redirects and never forwards bearer credentials cross-origin", async () => {
    const calls = [];
    const fetcher = new MarketplaceFixedOriginFetcher({
        baseUrl: "https://registry.example/",
        bearerToken: "transport-secret",
        allowedPaths: ["/tuf/metadata/1.root.json"],
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return new Response("root", { status: 200 });
        },
    });
    assert.deepEqual(
        await fetcher.downloadBytes("https://registry.example/tuf/metadata/1.root.json", 16),
        Buffer.from("root"),
    );
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[0].options.headers.authorization, "Bearer transport-secret");
    await assert.rejects(
        fetcher.downloadBytes("https://attacker.example/tuf/metadata/1.root.json", 16),
        (error) => error.code === "SOURCE_UNAVAILABLE",
    );
    assert.equal(calls.length, 1);

    const redirecting = new MarketplaceFixedOriginFetcher({
        baseUrl: "https://registry.example/",
        allowedPaths: ["/tuf/metadata/1.root.json"],
        fetchImpl: async () => new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/root.json" },
        }),
    });
    await assert.rejects(
        redirecting.downloadBytes("https://registry.example/tuf/metadata/1.root.json", 16),
        (error) => error.code === "SOURCE_UNAVAILABLE",
    );
});

test("MKT-05 refresh verifies a continuous root rotation without rewriting pinned bootstrap trust", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-root-rotation-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registryRoot = path.join(parent, "registry");
    const oldRootKey = path.join(parent, "old-root.pem");
    const newRootKey = path.join(parent, "new-root.pem");
    await MarketplaceRegistryStore.initialize(registryRoot, { offlineRootKeyPath: oldRootKey });
    const registry = await MarketplaceRegistryHttpServer.open(registryRoot);
    t.after(() => registry.close());
    const address = await registry.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    const service = await MarketplaceService.open(path.join(parent, "client"));
    t.after(() => service.close());
    const preview = await service.previewSource({ baseUrl });
    const added = await service.addSource({
        expectedRevision: 0,
        name: "Rotating registry",
        baseUrl,
        registryId: preview.registryId,
        trustedRootFingerprint: preview.trustedRootFingerprint,
        enabled: true,
        priority: 0,
    });

    const writer = await MarketplaceRegistryStore.open(registryRoot);
    await writer.mutate(() => writer.tufRepository.rotateRoot({
        currentRootKeyPath: oldRootKey,
        newRootKeyPath: newRootKey,
    }));
    await writer.close();
    const refreshed = await service.refreshSource(added.source.sourceId, { expectedRevision: 1 });
    const cached = await service.readVerifiedCatalog(added.source.sourceId, { requireFresh: true });
    assert.equal(cached.manifest.bootstrapRootVersion, 1);
    assert.equal(cached.manifest.root.version, 3);
    assert.equal(cached.manifest.trustedRootFingerprint, preview.trustedRootFingerprint);
    assert.equal(refreshed.health.status, "ready");
});
