import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { marketplaceClientPaths } from "../server/marketplace/client/MarketplaceClientLayout.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { createPopulatedClientRegistry } from "./helpers/marketplaceClientRegistry.js";
import {
    configureMarketplaceSource,
    createTestLifecycleRegistry,
    waitForInstallJob,
} from "./helpers/marketplaceInstallLifecycle.js";

const RECOVERY_BOUNDARIES = ["after-receipt", "after-adapter-commit", "after-installed", "after-cleanup"];

async function installPlugin(service, registry, sourceId) {
    const plan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    const started = await service.startInstallJob(plan.planHash);
    const ready = await waitForInstallJob(service, started.job.jobId, "awaiting-confirmation");
    await service.confirmInstallJob(ready.job.jobId, {
        expectedRevision: ready.job.revision,
        finalPlanHash: ready.job.finalPlanHash,
    });
    await waitForInstallJob(service, ready.job.jobId, "complete");
    return service.listInstalled();
}

test("MKT-07 recovery is idempotent after every durable transaction visibility boundary", async (t) => {
    for (const boundary of RECOVERY_BOUNDARIES) {
        await t.test(boundary, async (st) => {
            const parent = await fs.mkdtemp(path.join(os.tmpdir(), `cev-mkt-${boundary}-`));
            st.after(() => fs.rm(parent, { recursive: true, force: true }));
            const registry = await createPopulatedClientRegistry(parent);
            st.after(() => registry.server.close());
            const commits = [];
            const dataDir = path.join(parent, "client");
            let faulted = false;
            const first = await MarketplaceService.open(dataDir, {
                adapterRegistry: createTestLifecycleRegistry(commits),
                transactionFault: async (stage) => {
                    if (stage === boundary && !faulted) {
                        faulted = true;
                        throw new Error(`injected ${boundary}`);
                    }
                },
            });
            const sourceId = await configureMarketplaceSource(first, registry);
            const plan = await first.createInstallPlan({
                sourceId,
                itemId: registry.release.itemId,
                releaseVersion: registry.release.releaseVersion,
            });
            const started = await first.startInstallJob(plan.planHash);
            const ready = await waitForInstallJob(first, started.job.jobId, "awaiting-confirmation");
            await first.confirmInstallJob(ready.job.jobId, {
                expectedRevision: ready.job.revision,
                finalPlanHash: ready.job.finalPlanHash,
            });
            await waitForInstallJob(first, ready.job.jobId, boundary === "after-cleanup" ? "complete" : "recover");
            await first.close();

            const recovered = await MarketplaceService.open(dataDir, {
                adapterRegistry: createTestLifecycleRegistry(commits),
            });
            st.after(() => recovered.close());
            const complete = await waitForInstallJob(recovered, ready.job.jobId, "complete");
            assert.equal(complete.job.receiptHashes.length, 1);
            const installed = await recovered.listInstalled();
            assert.equal(installed.revision, 1);
            assert.equal(installed.installations.length, 1);
            assert.equal(commits.length, 1, "adapter commit must be idempotent for the transaction ID");

            await recovered.close();
            const repeated = await MarketplaceService.open(dataDir, {
                adapterRegistry: createTestLifecycleRegistry(commits),
            });
            st.after(() => repeated.close());
            assert.equal((await repeated.listInstalled()).revision, 1);
            assert.equal((await repeated.getInstallJob(ready.job.jobId)).job.phase, "complete");
            assert.equal(commits.length, 1);
        });
    }
});

test("MKT-08 removal recovery converges after ledger and owner boundaries without source or cache", async (t) => {
    for (const boundary of ["after-installed", "after-adapter-removal", "after-cleanup"]) {
        await t.test(boundary, async (st) => {
            const parent = await fs.mkdtemp(path.join(os.tmpdir(), `cev-mkt-remove-${boundary}-`));
            st.after(() => fs.rm(parent, { recursive: true, force: true }));
            const registry = await createPopulatedClientRegistry(parent);
            const dataDir = path.join(parent, "client");
            const pluginStore = new PluginStore(dataDir);
            let inject = false;
            let faulted = false;
            const service = await MarketplaceService.open(dataDir, {
                pluginStore,
                transactionFault: async (stage) => {
                    if (inject && stage === boundary && !faulted) {
                        faulted = true;
                        throw new Error(`injected ${boundary}`);
                    }
                },
            });
            const sourceId = await configureMarketplaceSource(service, registry);
            const installed = await installPlugin(service, registry, sourceId);
            assert.equal((await pluginStore.listInstalled()).packages.length, 1);

            await service.removeSource(sourceId, 1);
            await registry.server.close();
            inject = true;
            await assert.rejects(service.removeInstalled({
                sourceId,
                itemId: registry.release.itemId,
                releaseVersion: registry.release.releaseVersion,
                artifactSha256: registry.release.artifact.sha256,
                expectedRevision: installed.revision,
            }), new RegExp(boundary, "u"));
            await service.close();

            const recoveredStore = new PluginStore(dataDir);
            const recovered = await MarketplaceService.open(dataDir, { pluginStore: recoveredStore });
            st.after(() => recovered.close());
            assert.deepEqual((await recovered.listInstalled()).installations, []);
            assert.deepEqual((await recoveredStore.listInstalled()).packages, []);
            assert.equal((await recoveredStore.getPackage(registry.resource.packageHash)).packageHash, registry.resource.packageHash);
            assert.deepEqual(await fs.readdir(marketplaceClientPaths(dataDir).transactions), []);

            await recovered.close();
            const repeatedStore = new PluginStore(dataDir);
            const repeated = await MarketplaceService.open(dataDir, { pluginStore: repeatedStore });
            st.after(() => repeated.close());
            assert.deepEqual((await repeated.listInstalled()).installations, []);
            assert.deepEqual((await repeatedStore.listInstalled()).packages, []);
        });
    }
});

test("MKT-08 marketplace removal preserves a manual owner and stale library plans fail before commit", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-manual-owner-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const dataDir = path.join(parent, "client");
    const pluginStore = new PluginStore(dataDir);
    const service = await MarketplaceService.open(dataDir, { pluginStore });
    t.after(() => service.close());
    const sourceId = await configureMarketplaceSource(service, registry);

    const stalePlan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    const staleStarted = await service.startInstallJob(stalePlan.planHash);
    const staleReady = await waitForInstallJob(service, staleStarted.job.jobId, "awaiting-confirmation");
    await pluginStore.putPackage(registry.resource);
    await pluginStore.addManualOwner(registry.resource.packageHash);
    await service.confirmInstallJob(staleReady.job.jobId, {
        expectedRevision: staleReady.job.revision,
        finalPlanHash: staleReady.job.finalPlanHash,
    });
    const failed = await waitForInstallJob(service, staleReady.job.jobId, "failed");
    assert.equal(failed.job.error.code, "CONFLICT");

    const installed = await installPlugin(service, registry, sourceId);
    const owned = await pluginStore.snapshotWithOwners();
    assert.equal(owned.packages[0].ownership.manual, true);
    assert.equal(owned.packages[0].ownership.marketplace.length, 1);
    await service.removeInstalled({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
        artifactSha256: registry.release.artifact.sha256,
        expectedRevision: installed.revision,
    });
    const retained = await pluginStore.snapshotWithOwners();
    assert.equal(retained.packages.length, 1);
    assert.deepEqual(retained.packages[0].ownership, { manual: true, marketplace: [] });
});
