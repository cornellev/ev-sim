import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    artifactAdapterRegistry,
    createCollectionLifecycleAdapter,
} from "../server/marketplace/ArtifactAdapters.js";
import { artifactByteLimitFor, MARKETPLACE_ARTIFACTS, MARKETPLACE_LIMITS } from "../server/marketplace/MarketplaceContract.js";
import { marketplaceDocumentBytes } from "../server/marketplace/MarketplaceContracts.js";
import { MarketplaceInstallOwnershipStore } from "../server/marketplace/client/MarketplaceInstallOwnershipStore.js";
import { resolveInstallGraph } from "../server/marketplace/client/MarketplaceDependencyResolver.js";
import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { MarketplaceRegistryHttpServer } from "../server/marketplace/registry/RegistryHttpServer.js";
import { MarketplaceRegistryService } from "../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";
import { createPopulatedClientRegistry } from "./helpers/marketplaceClientRegistry.js";
import { marketplacePluginDocuments } from "./helpers/marketplacePluginDocuments.js";
import { configureMarketplaceSource, waitForInstallJob } from "./helpers/marketplaceInstallLifecycle.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const documents = JSON.parse(await fs.readFile(new URL("./fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const REGISTRY_ID = "22222222-2222-4222-8222-222222222222";

function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}

function exact(release) {
    return {
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifact.sha256,
    };
}

function release(itemId, contentKind, dependencies = []) {
    return {
        itemId,
        releaseVersion: "1.0.0",
        contentKind,
        artifact: {
            mediaType: MARKETPLACE_ARTIFACTS[contentKind].mediaType,
            sha256: digest(itemId),
            sizeBytes: 100,
        },
        dependencies,
    };
}

async function workspace(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt12-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

async function stage(root, name, bytes) {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, bytes, { mode: 0o600 });
    return {
        path: filePath,
        mediaType: MARKETPLACE_ARTIFACTS.collection.mediaType,
        sha256: digest(bytes),
        sizeBytes: bytes.length,
    };
}

test("MKT-12 collection inspection requires canonical bytes and exact signed members", async (t) => {
    const root = await workspace(t);
    const member = release("com.example.member", "plugin");
    const document = {
        kind: "cev-sim.marketplace-collection",
        version: 1,
        members: [{ release: exact(member), group: "Core" }],
    };
    const bytes = marketplaceDocumentBytes(document);
    const handle = await stage(root, "collection.json", bytes);
    const inspection = await artifactAdapterRegistry.inspect("collection", handle);
    assert.deepEqual(inspection.identity, {
        memberCount: 1,
        members: [{ release: exact(member), group: "Core" }],
    });
    const collectionRelease = {
        ...release("com.example.collection", "collection", [exact(member)]),
        artifact: { mediaType: handle.mediaType, sha256: handle.sha256, sizeBytes: handle.sizeBytes },
    };
    assert.equal(artifactAdapterRegistry.validate("collection", inspection, collectionRelease), inspection);
    assert.throws(() => artifactAdapterRegistry.validate("collection", inspection, {
        ...collectionRelease,
        dependencies: [],
    }), /exactly match/u);

    const noncanonical = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    await assert.rejects(
        artifactAdapterRegistry.inspect("collection", await stage(root, "noncanonical.json", noncanonical)),
        /canonical marketplace JSON/u,
    );
    const oversized = Buffer.alloc(MARKETPLACE_LIMITS.jsonBytes + 1, 0x20);
    await assert.rejects(
        artifactAdapterRegistry.inspect("collection", await stage(root, "oversized.json", oversized)),
        /exceeds/u,
    );
    assert.equal(artifactByteLimitFor("collection"), MARKETPLACE_LIMITS.jsonBytes);
});

test("MKT-12 collection lifecycle is verification-only and preserves ordered presentation groups", async (t) => {
    const root = await workspace(t);
    const member = release("com.example.member", "plugin");
    const document = {
        kind: "cev-sim.marketplace-collection",
        version: 1,
        members: [{ release: exact(member), group: "Sensors" }],
    };
    const handle = await stage(root, "collection.json", marketplaceDocumentBytes(document));
    const adapter = createCollectionLifecycleAdapter();
    const collectionRelease = {
        ...release("com.example.collection", "collection", [exact(member)]),
        artifact: { mediaType: handle.mediaType, sha256: handle.sha256, sizeBytes: handle.sizeBytes },
    };
    const inspection = await adapter.inspect(handle);
    adapter.validate(inspection, collectionRelease);
    const adapterPlan = await adapter.plan({ release: collectionRelease, inspection, artifactHandle: handle, context: {} });
    assert.deepEqual(adapterPlan.collection.members, document.members);
    assert.equal(adapterPlan.operations.length, 1);
    assert.deepEqual(adapterPlan.rights, []);
    await adapter.commit({
        release: collectionRelease,
        inspection,
        adapterPlan,
        artifactHandle: handle,
        operation: adapterPlan.operations[0],
    });
    assert.equal((await adapter.createReceipt({ release: collectionRelease })).mappings[0].resourceKind, "marketplace-collection");
});

test("MKT-12 install graph promotes exact collection members and leaves ordinary closure artifact-only", () => {
    const shared = release("com.example.shared", "vehicle");
    const first = release("com.example.first", "plugin", [exact(shared)]);
    const second = release("com.example.second", "plugin");
    const nested = release("com.example.nested", "collection", [exact(second)]);
    const root = release("com.example.root", "collection", [exact(first), exact(nested)]);
    const graph = resolveInstallGraph({
        rootRelease: exact(root),
        catalog: { yanks: [] },
        releases: [root, nested, second, first, shared],
    });
    const byId = new Map(graph.releases.map((entry) => [entry.release.itemId, entry]));
    assert.equal(byId.get(shared.itemId).disposition, "artifact-only");
    assert.deepEqual(byId.get(shared.itemId).owners, []);
    assert.equal(byId.get(first.itemId).disposition, "requested");
    assert.equal(byId.get(second.itemId).disposition, "requested");
    assert.equal(byId.get(nested.itemId).disposition, "collection");
    assert.deepEqual(byId.get(root.itemId).owners, [{ kind: "direct" }]);
    assert.deepEqual(byId.get(second.itemId).owners, [{ kind: "collection", collection: exact(nested) }]);
    const order = graph.releases.map((entry) => entry.release.itemId);
    assert.ok(order.indexOf(shared.itemId) < order.indexOf(first.itemId));
    assert.ok(order.indexOf(second.itemId) < order.indexOf(nested.itemId));
    assert.equal(order.at(-1), root.itemId);
});

test("MKT-12 ownership migrates direct installs, deduplicates acquisition, and cascades only final owners", async (t) => {
    const root = await workspace(t);
    const plugin = release("com.example.plugin", "plugin");
    const collection = release("com.example.collection", "collection", [exact(plugin)]);
    const installedPlugin = {
        sourceId: SOURCE_ID,
        registryId: REGISTRY_ID,
        release: exact(plugin),
        receiptHashes: [digest("plugin-receipt")],
        status: "installed",
    };
    const installedBase = {
        kind: "cev-sim.marketplace-installed",
        version: 1,
        revision: 7,
        installations: [installedPlugin],
    };
    const store = await MarketplaceInstallOwnershipStore.open(root, installedBase);
    t.after(() => store.close());
    const migrated = await store.snapshot();
    assert.deepEqual(migrated.memberships[0].owners, [{ kind: "direct" }]);
    assert.equal(migrated.revision, 7);

    const acquired = store.prepareInstall(migrated, {
        memberships: [{
            sourceId: SOURCE_ID,
            registryId: REGISTRY_ID,
            release: exact(plugin),
            owners: [{ kind: "collection", collection: exact(collection) }],
        }, {
            sourceId: SOURCE_ID,
            registryId: REGISTRY_ID,
            release: exact(collection),
            owners: [{ kind: "direct" }],
        }],
        collections: [{
            sourceId: SOURCE_ID,
            registryId: REGISTRY_ID,
            release: exact(collection),
            members: [{ release: exact(plugin), group: "Core" }],
        }],
    });
    assert.equal(acquired.revision, 8);
    assert.equal(acquired.memberships.find((entry) => entry.release.itemId === plugin.itemId).owners.length, 2);
    assert.deepEqual(store.prepareInstall(acquired, {
        memberships: acquired.memberships,
        collections: acquired.collections,
    }), acquired);

    const removed = store.prepareRemoval(acquired, {
        sourceId: SOURCE_ID,
        ...exact(collection),
        expectedRevision: 8,
    });
    assert.equal(removed.target.revision, 9);
    assert.deepEqual(removed.target.memberships.map((entry) => entry.release.itemId), [plugin.itemId]);
    assert.deepEqual(removed.target.memberships[0].owners, [{ kind: "direct" }]);
    assert.deepEqual(removed.target.collections, []);
});

test("MKT-12 installs a collection atomically and preserves a separately direct member on removal", async (t) => {
    const parent = await workspace(t);
    const registryRoot = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(registryRoot, { offlineRootKeyPath: path.join(parent, "root.pem") });
    const store = await MarketplaceRegistryStore.open(registryRoot);
    const registryService = new MarketplaceRegistryService(store);
    const resource = await pluginFixtureResource();
    const pluginArtifact = (await registryService.admitArtifact(Buffer.from(JSON.stringify(resource)), { contentKind: "plugin" })).descriptor;
    const plugin = marketplacePluginDocuments({
        item: { ...structuredClone(documents.item), previews: [] },
        release: structuredClone(documents.release),
        artifact: pluginArtifact,
        resource,
    });
    await registryService.admitItem(marketplaceDocumentBytes(plugin.item));
    await registryService.admitRelease(marketplaceDocumentBytes(plugin.release), { track: "stable" });

    const pluginRef = exact(plugin.release);
    const collectionDocument = {
        kind: "cev-sim.marketplace-collection",
        version: 1,
        members: [{ release: pluginRef, group: "Controllers" }],
    };
    const collectionArtifact = (await registryService.admitArtifact(marketplaceDocumentBytes(collectionDocument), { contentKind: "collection" })).descriptor;
    const collectionItem = {
        ...structuredClone(plugin.item),
        itemId: "com.example.collection",
        contentKind: "collection",
        displayName: "Control Collection",
        summary: "An exact test collection.",
        description: "Installs one exact controller release.",
        tags: ["collection"],
        categories: ["collections"],
    };
    const collectionRelease = {
        ...structuredClone(plugin.release),
        itemId: collectionItem.itemId,
        contentKind: "collection",
        artifact: collectionArtifact,
        capabilities: [],
        dependencies: [pluginRef],
        compatibility: {
            ...structuredClone(plugin.release.compatibility),
            contracts: [{ kind: "cev-sim.marketplace-collection", versions: [1] }],
            runtimes: [],
        },
    };
    await registryService.admitItem(marketplaceDocumentBytes(collectionItem));
    await assert.rejects(
        registryService.admitRelease(marketplaceDocumentBytes({ ...collectionRelease, dependencies: [] }), { track: "stable" }),
        /exactly match/u,
    );
    const missingRef = { itemId: "com.example.missing", releaseVersion: "1.0.0", artifactSha256: digest("missing") };
    const missingCollectionArtifact = (await registryService.admitArtifact(marketplaceDocumentBytes({
        ...collectionDocument,
        members: [{ release: missingRef }],
    }), { contentKind: "collection" })).descriptor;
    await assert.rejects(
        registryService.admitRelease(marketplaceDocumentBytes({
            ...collectionRelease,
            releaseVersion: "1.0.1",
            artifact: missingCollectionArtifact,
            dependencies: [missingRef],
        })),
        /dependency/u,
    );
    await registryService.admitRelease(marketplaceDocumentBytes(collectionRelease), { track: "stable" });
    await store.close();
    const server = await MarketplaceRegistryHttpServer.open(registryRoot);
    t.after(() => server.close());
    const address = await server.listen({ port: 0 });
    const registry = {
        baseUrl: `http://127.0.0.1:${address.port}/`,
        release: collectionRelease,
    };
    const service = await MarketplaceService.open(path.join(parent, "client"));
    t.after(() => service.close());
    const sourceId = await configureMarketplaceSource(service, registry);

    const install = async (target) => {
        const plan = await service.createInstallPlan({
            sourceId,
            itemId: target.itemId,
            releaseVersion: target.releaseVersion,
        });
        const started = await service.startInstallJob(plan.planHash);
        const ready = await waitForInstallJob(service, started.job.jobId, "awaiting-confirmation");
        await service.confirmInstallJob(ready.job.jobId, {
            expectedRevision: ready.job.revision,
            finalPlanHash: ready.job.finalPlanHash,
        });
        return waitForInstallJob(service, ready.job.jobId, "complete");
    };

    await install(plugin.release);
    const collectionPlan = await service.createInstallPlan({
        sourceId,
        itemId: collectionRelease.itemId,
        releaseVersion: collectionRelease.releaseVersion,
    });
    assert.deepEqual(collectionPlan.preflight.releases.map((entry) => [entry.release.itemId, entry.disposition]), [
        [plugin.release.itemId, "requested"],
        [collectionRelease.itemId, "collection"],
    ]);
    const collectionStarted = await service.startInstallJob(collectionPlan.planHash);
    const collectionReady = await waitForInstallJob(service, collectionStarted.job.jobId, "awaiting-confirmation");
    assert.equal(collectionReady.finalPlan.releases.at(-1).adapterId, "collection@1");
    assert.equal(collectionReady.finalPlan.releases.at(-1).adapterPlan.collection.members[0].group, "Controllers");
    assert.equal(collectionReady.finalPlan.releases[0].adapterPlan.operations.length, 0);
    assert.equal(collectionReady.job.progress.totalOperations, 1);
    await service.confirmInstallJob(collectionReady.job.jobId, {
        expectedRevision: collectionReady.job.revision,
        finalPlanHash: collectionReady.job.finalPlanHash,
    });
    await waitForInstallJob(service, collectionReady.job.jobId, "complete");

    const installed = await service.listInstalled();
    assert.deepEqual(installed.installations.map((entry) => entry.release.itemId), [plugin.release.itemId, collectionRelease.itemId]);
    const ownership = await service.listInstalledOwnership();
    assert.deepEqual(ownership.memberships.find((entry) => entry.release.itemId === plugin.release.itemId).owners, [
        { kind: "direct" },
        { kind: "collection", collection: exact(collectionRelease) },
    ]);
    assert.equal(ownership.collections[0].members[0].group, "Controllers");

    await service.removeInstalled({
        sourceId,
        ...exact(collectionRelease),
        expectedRevision: installed.revision,
    });
    const remaining = await service.listInstalled();
    assert.deepEqual(remaining.installations.map((entry) => entry.release.itemId), [plugin.release.itemId]);
    assert.deepEqual((await service.listInstalledOwnership()).memberships[0].owners, [{ kind: "direct" }]);
});

test("MKT-12 collection verification and receipt faults recover before installed visibility", async (t) => {
    for (const boundary of ["after-collection-operation", "after-collection-receipt"]) {
        await t.test(boundary, async (st) => {
            const parent = await workspace(st);
            const registry = await createPopulatedClientRegistry(parent, { includeCollection: true });
            st.after(() => registry.server.close());
            const dataDir = path.join(parent, "client");
            let faulted = false;
            const first = await MarketplaceService.open(dataDir, {
                transactionFault: async (stageName) => {
                    if (stageName === boundary && !faulted) {
                        faulted = true;
                        throw new Error(`injected ${boundary}`);
                    }
                },
            });
            const sourceId = await configureMarketplaceSource(first, registry);
            const plan = await first.createInstallPlan({
                sourceId,
                itemId: registry.collection.release.itemId,
                releaseVersion: registry.collection.release.releaseVersion,
            });
            const started = await first.startInstallJob(plan.planHash);
            const ready = await waitForInstallJob(first, started.job.jobId, "awaiting-confirmation");
            await first.confirmInstallJob(ready.job.jobId, {
                expectedRevision: ready.job.revision,
                finalPlanHash: ready.job.finalPlanHash,
            });
            await waitForInstallJob(first, ready.job.jobId, "needs-attention");
            assert.deepEqual((await first.listInstalled()).installations, []);
            await first.close();

            const recovered = await MarketplaceService.open(dataDir);
            st.after(() => recovered.close());
            const complete = await waitForInstallJob(recovered, ready.job.jobId, "complete");
            assert.equal(complete.job.receiptHashes.length, 2);
            const installed = await recovered.listInstalled();
            assert.deepEqual(installed.installations.map((entry) => entry.release.itemId), [
                registry.release.itemId,
                registry.collection.release.itemId,
            ]);
            const ownership = await recovered.listInstalledOwnership();
            assert.equal(ownership.collections.length, 1);
            assert.equal(ownership.revision, installed.revision);
        });
    }
});
