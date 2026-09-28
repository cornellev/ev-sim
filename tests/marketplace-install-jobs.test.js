import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { marketplaceClientPaths } from "../server/marketplace/client/MarketplaceClientLayout.js";
import { createMarketplaceHostProfile } from "../server/marketplace/client/MarketplaceCompatibility.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { createPopulatedClientRegistry } from "./helpers/marketplaceClientRegistry.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";
import {
    configureMarketplaceSource,
    createTestLifecycleRegistry,
    waitForInstallJob,
} from "./helpers/marketplaceInstallLifecycle.js";

test("MKT-08 installs and removes real plugin ownership offline without executing plugin source or deleting CAS", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-install-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const resource = await pluginFixtureResource({
        mutateFiles(files) {
            files["runtime/index.js"] = new TextEncoder().encode(
                "throw new Error('marketplace installation evaluated plugin source');\nexport default {};\n",
            );
        },
    });
    const registry = await createPopulatedClientRegistry(parent, { pluginResource: resource });
    t.after(() => registry.server.close());
    const dataDir = path.join(parent, "client");
    const pluginStore = new PluginStore(dataDir);
    const service = await MarketplaceService.open(dataDir, { pluginStore });
    t.after(() => service.close());
    const sourceId = await configureMarketplaceSource(service, registry);

    assert.deepEqual(service.status(), { mode: "coordinator", canInstall: true });
    const firstPlan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    const repeatedPlan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    assert.equal(firstPlan.planHash, repeatedPlan.planHash);
    assert.equal(firstPlan.preflight.releases.length, 1);

    const firstStarted = await service.startInstallJob(firstPlan.planHash);
    const firstReady = await waitForInstallJob(service, firstStarted.job.jobId, "awaiting-confirmation");
    assert.equal(firstReady.finalPlan.committable, true);
    assert.deepEqual(firstReady.finalPlan.releases[0].rights, []);
    assert.deepEqual(firstReady.finalPlan.releases[0].adapterPlan.capabilityChange.grantsAdded, []);
    assert.deepEqual(firstReady.finalPlan.releases[0].adapterPlan.changes, {
        cas: "add",
        libraryMembership: "add",
        marketplaceOwner: "add",
    });
    assert.deepEqual(await pluginStore.listInstalled(), { revision: 0, packages: [] });
    await assert.rejects(pluginStore.getPackage(resource.packageHash), (error) => error.code === "ENOENT");
    await assert.rejects(fs.access(pluginStore.runtimeDir), (error) => error.code === "ENOENT");

    const cancelledStarted = await service.startInstallJob(firstPlan.planHash);
    const cancelledReady = await waitForInstallJob(service, cancelledStarted.job.jobId, "awaiting-confirmation");
    const cancelled = await service.cancelInstallJob(cancelledReady.job.jobId, cancelledReady.job.revision);
    assert.equal(cancelled.job.phase, "cancelled");
    await assert.rejects(
        service.confirmInstallJob(cancelled.job.jobId, {
            expectedRevision: cancelled.job.revision,
            finalPlanHash: cancelledReady.job.finalPlanHash,
        }),
        (error) => error.code === "CONFLICT",
    );

    const committing = await service.confirmInstallJob(firstReady.job.jobId, {
        expectedRevision: firstReady.job.revision,
        finalPlanHash: firstReady.job.finalPlanHash,
    });
    assert.equal(committing.job.phase, "commit");
    const complete = await waitForInstallJob(service, firstReady.job.jobId, "complete");
    assert.equal(complete.job.receiptHashes.length, 1);
    const installed = await service.listInstalled();
    assert.equal(installed.revision, 1);
    assert.equal(installed.installations.length, 1);
    const receiptHash = installed.installations[0].receiptHashes[0];
    const receipt = await service.readReceipt(receiptHash);
    assert.equal(receipt.release.artifactSha256, registry.release.artifact.sha256);
    assert.deepEqual(receipt.mappings, [{
        resourceKind: "plugin-package",
        sourceId: "acme.example",
        localId: "acme.example",
        hashes: {
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            uiHash: resource.uiHash,
        },
    }]);
    assert.deepEqual((await pluginStore.listInstalled()).packages, [{
        pluginId: "acme.example",
        version: "1.0.0",
        packageHash: resource.packageHash,
        runtimeHash: resource.runtimeHash,
        uiHash: resource.uiHash,
    }]);
    await assert.rejects(fs.access(pluginStore.runtimeDir), (error) => error.code === "ENOENT");

    const artifactFile = path.join(marketplaceClientPaths(dataDir).artifacts, registry.release.artifact.sha256);
    await fs.access(artifactFile);
    const removed = await service.removeInstalled({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
        artifactSha256: registry.release.artifact.sha256,
        expectedRevision: installed.revision,
    });
    assert.equal(removed.installedRevision, 2);
    assert.equal((await service.listInstalled()).installations.length, 0);
    assert.deepEqual((await pluginStore.listInstalled()).packages, []);
    assert.equal((await pluginStore.getPackage(resource.packageHash)).packageHash, resource.packageHash);
    await service.readReceipt(receiptHash);
    await fs.access(artifactFile);

    await registry.server.close();
    const offlinePlan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    const offlineStarted = await service.startInstallJob(offlinePlan.planHash);
    const offlineReady = await waitForInstallJob(service, offlineStarted.job.jobId, "awaiting-confirmation");
    await service.confirmInstallJob(offlineReady.job.jobId, {
        expectedRevision: offlineReady.job.revision,
        finalPlanHash: offlineReady.job.finalPlanHash,
    });
    await waitForInstallJob(service, offlineReady.job.jobId, "complete");
    const reinstalled = await service.listInstalled();
    assert.equal(reinstalled.revision, 3);
    assert.equal(reinstalled.installations[0].receiptHashes.length, 2);
    assert.equal((await pluginStore.listInstalled()).packages.length, 1);
});

test("MKT-07 rolls a durable journal forward after restart and completes the owning job", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-recover-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const commits = [];
    const dataDir = path.join(parent, "client");
    let faulted = false;
    const first = await MarketplaceService.open(dataDir, {
        adapterRegistry: createTestLifecycleRegistry(commits),
        transactionFault: async (stage) => {
            if (stage === "after-journal" && !faulted) {
                faulted = true;
                throw new Error("injected crash after journal durability");
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
    await waitForInstallJob(first, ready.job.jobId, "needs-attention");
    await first.close();

    const recovered = await MarketplaceService.open(dataDir, { adapterRegistry: createTestLifecycleRegistry(commits) });
    t.after(() => recovered.close());
    const completed = await waitForInstallJob(recovered, ready.job.jobId, "complete");
    assert.equal(completed.job.receiptHashes.length, 1);
    assert.equal((await recovered.listInstalled()).revision, 1);
    assert.equal(commits.length, 1);
});

test("MKT-09 resumes a needs-attention job from verified operation completions", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-resume-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const commits = [];
    let faulted = false;
    const service = await MarketplaceService.open(path.join(parent, "client"), {
        adapterRegistry: createTestLifecycleRegistry(commits),
        transactionFault: async (stage) => {
            if (stage === "after-adapter-operation" && !faulted) {
                faulted = true;
                throw new Error("injected operation-boundary failure");
            }
        },
    });
    t.after(() => service.close());
    const sourceId = await configureMarketplaceSource(service, registry);
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
    const attention = await waitForInstallJob(service, ready.job.jobId, "needs-attention");
    const operations = await service.listInstallJobOperations(ready.job.jobId, { status: "complete" });
    assert.equal(operations.total, 1);
    assert.equal(attention.job.progress.completedOperations, 0);
    await service.resumeInstallJob(attention.job.jobId, attention.job.revision);
    const complete = await waitForInstallJob(service, attention.job.jobId, "complete");
    assert.equal(complete.job.progress.completedOperations, complete.job.progress.totalOperations);
    assert.equal(commits.length, 1);
});

test("MKT-07 serializes concurrent commits and rejects changed host or local revisions before journaling", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-conflict-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const dataDir = path.join(parent, "client");
    let profileGeneration = 0;
    let localRevision = 0;
    const service = await MarketplaceService.open(dataDir, {
        adapterRegistry: createTestLifecycleRegistry([], { localRevisionProvider: () => localRevision }),
        hostProfileProvider: async () => createMarketplaceHostProfile({
            supervisorCapabilities: { transports: profileGeneration ? ["unix"] : [] },
        }),
    });
    t.after(() => service.close());
    const sourceId = await configureMarketplaceSource(service, registry);
    const plan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    const staleStarted = await service.startInstallJob(plan.planHash);
    const staleReady = await waitForInstallJob(service, staleStarted.job.jobId, "awaiting-confirmation");
    profileGeneration = 1;
    await service.confirmInstallJob(staleReady.job.jobId, {
        expectedRevision: staleReady.job.revision,
        finalPlanHash: staleReady.job.finalPlanHash,
    });
    const failed = await waitForInstallJob(service, staleReady.job.jobId, "failed");
    assert.equal(failed.job.error.code, "CONFLICT");
    assert.deepEqual(await fs.readdir(marketplaceClientPaths(dataDir).transactions), []);

    const localPlan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    const localStarted = await service.startInstallJob(localPlan.planHash);
    const localReady = await waitForInstallJob(service, localStarted.job.jobId, "awaiting-confirmation");
    localRevision = 1;
    await service.confirmInstallJob(localReady.job.jobId, {
        expectedRevision: localReady.job.revision,
        finalPlanHash: localReady.job.finalPlanHash,
    });
    const localFailed = await waitForInstallJob(service, localReady.job.jobId, "failed");
    assert.equal(localFailed.job.error.code, "CONFLICT");
    assert.deepEqual(await fs.readdir(marketplaceClientPaths(dataDir).transactions), []);

    const currentPlan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    const [first, second] = await Promise.all([
        service.startInstallJob(currentPlan.planHash),
        service.startInstallJob(currentPlan.planHash),
    ]);
    const [firstReady, secondReady] = await Promise.all([
        waitForInstallJob(service, first.job.jobId, "awaiting-confirmation"),
        waitForInstallJob(service, second.job.jobId, "awaiting-confirmation"),
    ]);
    await Promise.all([
        service.confirmInstallJob(firstReady.job.jobId, {
            expectedRevision: firstReady.job.revision,
            finalPlanHash: firstReady.job.finalPlanHash,
        }),
        service.confirmInstallJob(secondReady.job.jobId, {
            expectedRevision: secondReady.job.revision,
            finalPlanHash: secondReady.job.finalPlanHash,
        }),
    ]);
    const terminals = await Promise.all([
        waitForInstallJob(service, first.job.jobId, ["complete", "failed"]),
        waitForInstallJob(service, second.job.jobId, ["complete", "failed"]),
    ]);
    assert.ok(terminals.some((entry) => entry.job.phase === "complete"));
    for (const entry of terminals.filter((candidate) => candidate.job.phase === "failed")) {
        assert.equal(entry.job.error.code, "CONFLICT");
    }
    assert.equal((await service.listInstalled()).revision, 1);
    assert.deepEqual(await fs.readdir(marketplaceClientPaths(dataDir).transactions), []);
});

test("MKT-07 exposes denied rights in a non-committable final plan", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-rights-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const service = await MarketplaceService.open(path.join(parent, "client"), {
        adapterRegistry: createTestLifecycleRegistry([], { denyRights: true }),
    });
    t.after(() => service.close());
    const sourceId = await configureMarketplaceSource(service, registry);
    const plan = await service.createInstallPlan({
        sourceId,
        itemId: registry.release.itemId,
        releaseVersion: registry.release.releaseVersion,
    });
    const started = await service.startInstallJob(plan.planHash);
    const ready = await waitForInstallJob(service, started.job.jobId, "awaiting-confirmation");
    assert.equal(ready.finalPlan.committable, false);
    assert.deepEqual(ready.finalPlan.releases[0].rights, [{ id: "plugin-files", allowed: false }]);
    assert.match(ready.finalPlan.blockingIssues[0], /Required right denied/u);
    await assert.rejects(service.confirmInstallJob(ready.job.jobId, {
        expectedRevision: ready.job.revision,
        finalPlanHash: ready.job.finalPlanHash,
    }), (error) => error.code === "RIGHTS_DENIED");
    assert.equal((await service.listInstalled()).revision, 0);
});
