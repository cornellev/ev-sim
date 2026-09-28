import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplaceArtifactStore } from "../server/marketplace/client/MarketplaceArtifactStore.js";
import { MarketplaceArtifactDownloader } from "../server/marketplace/client/MarketplaceArtifactDownloader.js";
import { marketplaceClientPaths } from "../server/marketplace/client/MarketplaceClientLayout.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("MKT-07 artifact CAS rehashes reuse, deduplicates publication, and keeps private modes", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-artifacts-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const store = await MarketplaceArtifactStore.open(dataDir);
    const bytes = Buffer.from("verified marketplace bytes");
    const descriptor = { mediaType: "application/octet-stream", sha256: sha256(bytes), sizeBytes: bytes.length };
    const firstStage = path.join(dataDir, "first.part");
    await fs.writeFile(firstStage, bytes, { mode: 0o600 });
    const first = await store.publish(firstStage, descriptor);
    assert.equal(first.created, true);
    assert.equal((await store.get(descriptor)).sha256, descriptor.sha256);

    const secondStage = path.join(dataDir, "second.part");
    await fs.writeFile(secondStage, bytes, { mode: 0o600 });
    const second = await store.publish(secondStage, descriptor);
    assert.equal(second.created, false);
    const paths = marketplaceClientPaths(dataDir);
    assert.equal((await fs.stat(paths.artifacts)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(paths.artifacts, descriptor.sha256))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(paths.artifactRecords, `${descriptor.sha256}.json`))).mode & 0o777, 0o600);

    await fs.writeFile(path.join(paths.artifacts, descriptor.sha256), Buffer.alloc(bytes.length, 1));
    await assert.rejects(store.get(descriptor), (error) => error.code === "RECOVERY_REQUIRED");
});

test("MKT-07 quarantine retains complete bounded mismatches with only redacted records", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-quarantine-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const store = await MarketplaceArtifactStore.open(dataDir, { now: () => new Date("2026-09-28T00:00:00.000Z") });
    const bytes = Buffer.from("wrong but complete");
    const staged = path.join(dataDir, "mismatch.part");
    await fs.writeFile(staged, bytes, { mode: 0o600 });
    const result = await store.quarantine(staged, {
        expectedSha256: "0".repeat(64),
        actualSha256: sha256(bytes),
        sizeBytes: bytes.length,
        reasonCode: "ARTIFACT_HASH_MISMATCH",
    });
    const directory = path.join(marketplaceClientPaths(dataDir).quarantine, result.quarantineId);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["artifact", "record.json"]);
    const record = await fs.readFile(path.join(directory, "record.json"), "utf8");
    assert.doesNotMatch(record, /[/\\]|authorization|credential|token/u);
    await MarketplaceArtifactStore.open(dataDir);
});

test("MKT-07 downloader quarantines complete digest mismatches and deletes incomplete streams", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-download-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const store = await MarketplaceArtifactStore.open(dataDir);
    const expected = Buffer.from("expected artifact");
    const wrong = Buffer.from("incorrect bytes!!");
    assert.equal(wrong.length, expected.length);
    const descriptor = { mediaType: "application/octet-stream", sha256: sha256(expected), sizeBytes: expected.length };
    const credentialStore = { async readBearer() { return null; } };
    const source = { baseUrl: "https://registry.example/", credentialRef: null };
    const workDirectory = path.join(dataDir, "work");
    const mismatch = new MarketplaceArtifactDownloader({
        artifactStore: store,
        credentialStore,
        fetchImpl: async () => new Response(wrong),
    });
    await assert.rejects(
        mismatch.obtain({ source, descriptor, workDirectory }),
        (error) => error.code === "ARTIFACT_HASH_MISMATCH",
    );
    assert.equal((await fs.readdir(marketplaceClientPaths(dataDir).quarantine)).length, 1);
    assert.deepEqual(await fs.readdir(workDirectory), []);

    const incompleteDir = path.join(dataDir, "incomplete-work");
    const incomplete = new MarketplaceArtifactDownloader({
        artifactStore: store,
        credentialStore,
        fetchImpl: async () => new Response(expected.subarray(0, 3)),
    });
    await assert.rejects(
        incomplete.obtain({ source, descriptor, workDirectory: incompleteDir }),
        (error) => error.code === "SOURCE_UNAVAILABLE",
    );
    assert.deepEqual(await fs.readdir(incompleteDir), []);
    assert.equal((await fs.readdir(marketplaceClientPaths(dataDir).quarantine)).length, 1);
});
