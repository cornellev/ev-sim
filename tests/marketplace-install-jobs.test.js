import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { marketplaceClientPaths } from "../server/marketplace/client/MarketplaceClientLayout.js";
import { createMarketplaceHostProfile } from "../server/marketplace/client/MarketplaceCompatibility.js";
import { createPopulatedClientRegistry } from "./helpers/marketplaceClientRegistry.js";
import {
    configureMarketplaceSource,
    createTestLifecycleRegistry,
    waitForInstallJob,
} from "./helpers/marketplaceInstallLifecycle.js";

test("MKT-07 plans, downloads, confirms, installs, removes, and reinstalls offline without executing plugin source", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-install-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent);
    t.after(() => registry.server.close());
    const commits = [];
    const dataDir = path.join(parent, "client");
    const service = await MarketplaceService.open(dataDir, { adapterRegistry: createTestLifecycleRegistry(commits) });
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
    assert.deepEqual(firstReady.finalPlan.releases[0].rights, [{ id: "plugin-files", allowed: true }]);

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
    assert.equal(commits.length, 1);
    const installed = await service.listInstalled();
    assert.equal(installed.revision, 1);
    assert.equal(installed.installations.length, 1);
    const receiptHash = installed.installations[0].receiptHashes[0];
    const receipt = await service.readReceipt(receiptHash);
    assert.equal(receipt.release.artifactSha256, registry.release.artifact.sha256);
    assert.equal(receipt.mappings[0].localId, registry.release.itemId);

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
    await waitForInstallJob(first, ready.job.jobId, "recover");
    await first.close();

    const recovered = await MarketplaceService.open(dataDir, { adapterRegistry: createTestLifecycleRegistry(commits) });
    t.after(() => recovered.close());
    const completed = await waitForInstallJob(recovered, ready.job.jobId, "complete");
    assert.equal(completed.job.receiptHashes.length, 1);
    assert.equal((await recovered.listInstalled()).revision, 1);
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
