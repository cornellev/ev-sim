import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceInstalledStore } from "../server/marketplace/client/MarketplaceInstalledStore.js";
import { MarketplaceReceiptStore } from "../server/marketplace/client/MarketplaceReceiptStore.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const REGISTRY_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const RELEASE_HASH = "b".repeat(64);

test("MKT-07 installed membership increments once, exact reinstalls are no-ops, and receipts remain immutable", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-installed-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const installedStore = await MarketplaceInstalledStore.open(dataDir);
    const receiptStore = await MarketplaceReceiptStore.open(dataDir);
    const release = { itemId: "example.plugin", releaseVersion: "1.0.0", artifactSha256: DIGEST };
    const receipt = {
        kind: "cev-sim.marketplace-install-receipt",
        version: 1,
        sourceId: SOURCE_ID,
        registryId: REGISTRY_ID,
        release,
        releaseHash: RELEASE_HASH,
        installedAt: "2026-09-28T00:00:00.000Z",
        dependencyLock: [],
        mappings: [{ resourceKind: "plugin", sourceId: "example.plugin", localId: "example.plugin", hashes: { artifact: DIGEST } }],
    };
    const published = await receiptStore.publish(receipt);
    const base = await installedStore.snapshot();
    const addition = {
        sourceId: SOURCE_ID,
        registryId: REGISTRY_ID,
        release,
        receiptHashes: [published.hash],
        status: "installed",
    };
    const target = installedStore.prepareInstall(base, [addition]);
    assert.equal(target.revision, 1);
    await installedStore.commitTarget({ base, target });
    const unchanged = installedStore.prepareInstall(await installedStore.snapshot(), [addition]);
    assert.equal(unchanged.revision, 1);

    const removed = installedStore.prepareRemoval(await installedStore.snapshot(), {
        sourceId: SOURCE_ID,
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifactSha256,
        expectedRevision: 1,
    });
    await installedStore.commitTarget({ base: await installedStore.snapshot(), target: removed });
    assert.deepEqual(await receiptStore.read(published.hash), receipt);
    await assert.rejects(
        Promise.resolve().then(() => installedStore.prepareRemoval(removed, {
            sourceId: SOURCE_ID,
            itemId: release.itemId,
            releaseVersion: release.releaseVersion,
            artifactSha256: release.artifactSha256,
            expectedRevision: 1,
        })),
        (error) => error.code === "CONFLICT",
    );
});

