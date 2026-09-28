import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { createPopulatedClientRegistry } from "./helpers/marketplaceClientRegistry.js";
import {
    configureMarketplaceSource,
    createTestLifecycleRegistry,
    waitForInstallJob,
} from "./helpers/marketplaceInstallLifecycle.js";

const RECOVERY_BOUNDARIES = ["after-receipt", "after-adapter-commit", "after-installed", "after-cleanup"];

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
