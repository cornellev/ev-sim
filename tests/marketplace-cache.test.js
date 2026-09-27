import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { marketplaceClientPaths } from "../server/marketplace/client/MarketplaceClientLayout.js";
import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { createPopulatedClientRegistry } from "./helpers/marketplaceClientRegistry.js";

async function configure(service, baseUrl) {
    const preview = await service.previewSource({ baseUrl });
    return service.addSource({
        expectedRevision: 0,
        name: "Populated registry",
        baseUrl,
        registryId: preview.registryId,
        trustedRootFingerprint: preview.trustedRootFingerprint,
        enabled: true,
        priority: 0,
    });
}

test("MKT-05 eagerly caches every signed document and preserves exact offline reads after expiry", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cache-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const dataDir = path.join(parent, "client");
    const service = await MarketplaceService.open(dataDir);
    const added = await configure(service, registry.baseUrl);
    await service.refreshSource(added.source.sourceId, { expectedRevision: 1 });
    await registry.server.close();

    const item = await service.readVerifiedItem(added.source.sourceId, registry.item.itemId, { requireFresh: true });
    const release = await service.readVerifiedRelease(
        added.source.sourceId,
        registry.release.itemId,
        registry.release.releaseVersion,
        { requireFresh: true },
    );
    assert.equal(item.document.itemId, registry.item.itemId);
    assert.equal(release.document.releaseVersion, registry.release.releaseVersion);
    await assert.rejects(
        service.refreshSource(added.source.sourceId, { expectedRevision: 1 }),
        (error) => error.code === "SOURCE_UNAVAILABLE",
    );
    const offlineHealth = await service.listSources();
    assert.equal(offlineHealth.sources[0].health.status, "offline");
    assert.equal(offlineHealth.sources[0].health.usableOffline, true);
    await service.close();

    const paths = marketplaceClientPaths(dataDir);
    const stagingOrphan = path.join(paths.cache, added.source.sourceId, "staging", "00000000-0000-4000-8000-000000000099");
    await fs.mkdir(stagingOrphan, { recursive: true });
    const future = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    const expiredService = await MarketplaceService.open(dataDir, { now: () => new Date(future) });
    t.after(() => expiredService.close());
    await assert.rejects(fs.stat(stagingOrphan), (error) => error.code === "ENOENT");
    const offline = await expiredService.readVerifiedCatalog(added.source.sourceId);
    assert.equal(offline.fresh, false);
    await assert.rejects(
        expiredService.readVerifiedCatalog(added.source.sourceId, { requireFresh: true }),
        (error) => error.code === "METADATA_EXPIRED",
    );
    const listed = await expiredService.listSources();
    assert.equal(listed.sources[0].health.status, "expired");
    assert.equal(listed.sources[0].health.usableOffline, true);
});

test("MKT-05 never publishes a failed refresh over the current verified snapshot", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cache-fault-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const dataDir = path.join(parent, "client");
    let failPublication = false;
    const service = await MarketplaceService.open(dataDir, {
        cacheFault: async (boundary) => {
            if (failPublication && boundary === "before-current-pointer") throw new Error("injected publication fault");
        },
    });
    t.after(() => service.close());
    const added = await configure(service, registry.baseUrl);
    const first = await service.refreshSource(added.source.sourceId, { expectedRevision: 1 });
    failPublication = true;
    await assert.rejects(service.refreshSource(added.source.sourceId, { expectedRevision: 1 }));
    const current = await service.readVerifiedCatalog(added.source.sourceId, { requireFresh: true });
    assert.equal(current.manifest.snapshotId, first.snapshotId);
});
