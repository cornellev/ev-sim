import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceCredentialStore } from "../server/marketplace/client/MarketplaceCredentialStore.js";
import { marketplaceClientPaths } from "../server/marketplace/client/MarketplaceClientLayout.js";
import { MarketplaceSourceStore } from "../server/marketplace/client/MarketplaceSourceStore.js";

const IDS = Object.freeze({
    first: "00000000-0000-4000-8000-000000000001",
    second: "00000000-0000-4000-8000-000000000002",
    registryFirst: "10000000-0000-4000-8000-000000000001",
    registrySecond: "10000000-0000-4000-8000-000000000002",
});

function source(sourceId, registryId, priority, port) {
    return {
        sourceId,
        registryId,
        name: `Source ${priority}`,
        baseUrl: `http://127.0.0.1:${port}/`,
        trustedRootFingerprint: String(priority).padStart(64, "0"),
        enabled: true,
        priority,
        credentialRef: null,
    };
}

test("MKT-05 source mutations are revisioned, serialized, and deterministically ordered", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-sources-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const store = await MarketplaceSourceStore.open(dataDir);
    assert.deepEqual(store.snapshot(), {
        kind: "cev-sim.marketplace-sources",
        version: 1,
        revision: 0,
        sources: [],
    });
    const attempts = await Promise.allSettled([
        store.add(source(IDS.first, IDS.registryFirst, 20, 41001), 0),
        store.add(source(IDS.second, IDS.registrySecond, 10, 41002), 0),
    ]);
    assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
    const rejection = attempts.find((entry) => entry.status === "rejected").reason;
    assert.equal(rejection.code, "CONFLICT");
    assert.equal(rejection.currentRevision, 1);

    const winner = store.snapshot().sources[0];
    const other = winner.sourceId === IDS.first
        ? source(IDS.second, IDS.registrySecond, 10, 41002)
        : source(IDS.first, IDS.registryFirst, 20, 41001);
    await store.add(other, 1);
    assert.deepEqual(store.snapshot().sources.map((entry) => entry.priority), [10, 20]);
    await store.update(winner.sourceId, { name: "Renamed" }, 2);
    assert.equal(store.snapshot().revision, 3);
    await assert.rejects(store.remove(winner.sourceId, 2), (error) => error.code === "CONFLICT");
    const removed = await store.remove(winner.sourceId, 3);
    assert.equal(removed.document.revision, 4);
    assert.equal(removed.removed.name, "Renamed");
});

test("MKT-05 credentials are private immutable files and recovery removes only unreferenced files", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-credentials-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const credentials = await MarketplaceCredentialStore.open(dataDir);
    const retained = await credentials.stageBearer("retained-token");
    const orphan = await credentials.stageBearer("orphan-token");
    const sources = await MarketplaceSourceStore.open(dataDir);
    await sources.add({ ...source(IDS.first, IDS.registryFirst, 1, 41003), credentialRef: retained }, 0);
    assert.equal(await credentials.readBearer(retained), "retained-token");
    await credentials.recover([retained]);
    await assert.rejects(credentials.readBearer(orphan));
    const paths = marketplaceClientPaths(dataDir);
    assert.equal((await fs.stat(paths.credentials)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(paths.credentials, `${retained}.json`))).mode & 0o777, 0o600);
    assert.doesNotMatch(await fs.readFile(paths.sources, "utf8"), /retained-token/u);
    await assert.rejects(credentials.stageBearer("contains space"), (error) => error.code === "DOCUMENT_INVALID");

    const hostile = path.join(paths.credentials, "00000000-0000-4000-8000-000000000009.json");
    await fs.symlink(path.join(paths.credentials, `${retained}.json`), hostile);
    await assert.rejects(credentials.recover([retained]), (error) => error.code === "RECOVERY_REQUIRED");
});
