import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";

import {
    ARTIFACT_VERIFICATION_ERROR_CODES,
    createArtifactStagingArea,
    hashArtifactStream,
    recoverArtifactStagingAreas,
    resolveContentLimits,
    stageArtifactStream,
    validateArchivePath,
} from "../server/artifacts/ArtifactVerification.js";

async function temporary(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-artifact-verification-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test("MKT-02 content ceilings and archive paths fail closed", () => {
    assert.deepEqual(resolveContentLimits({ bytes: 10, entries: 5 }, { bytes: 100, entries: 3.9 }, {
        integerKeys: ["entries"],
    }), { bytes: 10, entries: 3 });
    for (const overrides of [{ bytes: -1 }, { bytes: Number.NaN }, { unknown: 1 }]) {
        assert.throws(() => resolveContentLimits({ bytes: 10 }, overrides), TypeError);
    }
    assert.equal(validateArchivePath("assets/sha256/deadbeef"), "assets/sha256/deadbeef");
    for (const name of ["", "/absolute", "../parent", "a/./b", "a//b", "a\\b", "%2e%2e/a", "e\u0301", "a\n", "x".repeat(100)]) {
        assert.throws(() => validateArchivePath(name), (error) => error.code === ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE);
    }
});

test("MKT-02 stream hashing enforces chunks, exact size, digest, deadline, and abort", async () => {
    const bytes = Buffer.from("bounded artifact bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(await hashArtifactStream(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]), {
        maxBytes: bytes.length,
        expectedBytes: bytes.length,
        expectedSha256: digest,
        maxChunkBytes: bytes.length,
    }), { sizeBytes: bytes.length, sha256: digest });
    await assert.rejects(
        hashArtifactStream(Readable.from([bytes]), { maxBytes: bytes.length, maxChunkBytes: bytes.length - 1 }),
        (error) => error.code === ARTIFACT_VERIFICATION_ERROR_CODES.LIMIT_EXCEEDED,
    );
    await assert.rejects(
        hashArtifactStream(Readable.from([bytes.subarray(1)]), { maxBytes: bytes.length, expectedBytes: bytes.length }),
        (error) => error.code === ARTIFACT_VERIFICATION_ERROR_CODES.INVALID,
    );
    await assert.rejects(
        hashArtifactStream(Readable.from([bytes]), { maxBytes: bytes.length, expectedSha256: "0".repeat(64) }),
        (error) => error.code === ARTIFACT_VERIFICATION_ERROR_CODES.HASH_MISMATCH,
    );
    let returned = false;
    const stalled = {
        [Symbol.asyncIterator]() { return this; },
        next() { return new Promise(() => {}); },
        async return() { returned = true; return { done: true }; },
    };
    await assert.rejects(
        hashArtifactStream(stalled, { maxBytes: 10, deadline: Date.now() + 20 }),
        (error) => error.code === ARTIFACT_VERIFICATION_ERROR_CODES.TIMEOUT,
    );
    assert.equal(returned, true);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(
        hashArtifactStream(Readable.from([bytes]), { maxBytes: bytes.length, signal: controller.signal }),
        (error) => error.code === ARTIFACT_VERIFICATION_ERROR_CODES.CANCELLED,
    );
});

test("MKT-02 staging is exclusive, durable, and deletes every failed operation-owned file", async (t) => {
    const root = await temporary(t);
    const bytes = Buffer.from("stage me");
    const destination = path.join(root, "success.bin");
    const staged = await stageArtifactStream(Readable.from([bytes]), {
        destination,
        expectedBytes: bytes.length,
        maxBytes: bytes.length,
    });
    assert.deepEqual(await fs.readFile(destination), bytes);
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    assert.equal(staged.sha256, createHash("sha256").update(bytes).digest("hex"));
    await assert.rejects(stageArtifactStream(Readable.from([bytes]), { destination, maxBytes: bytes.length }));
    assert.deepEqual(await fs.readFile(destination), bytes, "an exclusive-write failure must not delete another operation's file");

    for (const fault of ["write", "fsync", "dirFsync"]) {
        const failed = path.join(root, `${fault}.bin`);
        await assert.rejects(
            stageArtifactStream(Readable.from([bytes]), {
                destination: failed,
                maxBytes: bytes.length,
                faults: { [fault]: async () => { throw Object.assign(new Error(fault), { code: "EIO" }); } },
            }),
            (error) => error.code === ARTIFACT_VERIFICATION_ERROR_CODES.IO,
        );
        await assert.rejects(fs.access(failed));
    }
});

test("MKT-02 staging recovery removes expired operations and skips active directories", async (t) => {
    const root = await temporary(t);
    const old = await createArtifactStagingArea(root, { id: "old" });
    const active = await createArtifactStagingArea(root, { id: "active" });
    const future = new Date("2100-01-01T00:00:00.000Z");
    const result = await recoverArtifactStagingAreas(root, {
        ttlMs: 0,
        now: () => future,
        active: new Set([active.dir]),
    });
    assert.equal(result.removed, 1);
    await assert.rejects(fs.access(old.dir));
    await fs.access(active.dir);
});
