import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
    createDeterministicArchiveStream,
    encodeDeterministicArchive,
    encodeUstarFile,
    ustarEof,
    verifyDeterministicArchive,
} from "../server/artifacts/DeterministicArchive.js";
import { ARTIFACT_VERIFICATION_ERROR_CODES } from "../server/artifacts/ArtifactVerification.js";

function archive(entries) {
    return Buffer.concat([...entries.map(([name, bytes, overrides]) => encodeUstarFile(name, bytes, overrides)), ustarEof()]);
}

async function rejected(bytes, code = ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, options) {
    await assert.rejects(verifyDeterministicArchive(bytes, options), (error) => error.code === code);
}

test("MKT-02 deterministic codec preserves caller order and verifies exact staged entries", async () => {
    const entries = [
        { name: "b.json", bytes: Buffer.from("b") },
        { name: "a.json", bytes: Buffer.from("alpha") },
    ];
    const encoded = encodeDeterministicArchive(entries);
    const streamed = createDeterministicArchiveStream(entries);
    const chunks = [];
    for await (const chunk of streamed.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), encoded.bytes);
    assert.equal((await streamed.completion).sha256, encoded.sha256);
    const verified = await verifyDeterministicArchive(encoded.bytes, { retainStaging: true });
    try {
        assert.deepEqual(verified.entries.map((entry) => entry.name), ["b.json", "a.json"]);
        assert.equal((await fs.readFile(verified.entries[1].path)).toString(), "alpha");
        assert.equal(verified.sha256, encoded.sha256);
    } finally {
        await verified.cleanup();
        await verified.cleanup();
    }
});

test("MKT-02 generic verifier rejects hostile names, duplicates, links, devices, and extensions", async () => {
    for (const name of ["/absolute", "../parent", "%2e%2e/encoded", "a\\b", "a//b", "a/./b"]) {
        await rejected(archive([[name, Buffer.from("x")]]));
    }
    await rejected(archive([["a", Buffer.from("1")], ["a", Buffer.from("2")]]));
    await rejected(archive([["A", Buffer.from("1")], ["a", Buffer.from("2")]]));
    for (const typeflag of ["1", "2", "3", "4", "5", "6", "S", "x", "g", "L", "K", "D"]) {
        await rejected(archive([["entry", Buffer.from("x"), { typeflag }]]));
    }
});

test("MKT-02 generic verifier rejects malformed headers, padding, EOF, compression, and truncation", async () => {
    const valid = archive([["entry", Buffer.from("x")]]);
    for (const name of ["PK-safe-name", "BZh-safe-name"]) {
        assert.equal((await verifyDeterministicArchive(archive([[name, Buffer.from("x")]]))).entries[0].name, name);
    }
    const checksum = Buffer.from(valid);
    checksum[148] = checksum[148] === 0x30 ? 0x31 : 0x30;
    await rejected(checksum);
    const numeric = Buffer.concat([
        encodeUstarFile("entry", Buffer.from("x"), { sizeField: Buffer.from("00000000001 ") }),
        ustarEof(),
    ]);
    await rejected(numeric);
    const magic = Buffer.concat([
        encodeUstarFile("entry", Buffer.from("x"), { magic: Buffer.from("tar!!!") }),
        ustarEof(),
    ]);
    await rejected(magic);
    const padding = Buffer.from(valid);
    padding[513] = 1;
    await rejected(padding);
    await rejected(valid.subarray(0, valid.length - 1));
    await rejected(gzipSync(valid));
    await rejected(Buffer.concat([valid, Buffer.alloc(512)]));
    await rejected(Buffer.concat([valid, Buffer.from("x")]));
    await rejected(Buffer.concat([encodeUstarFile("entry", Buffer.from("x")), Buffer.alloc(512)]));
});

test("MKT-02 generic verifier enforces entry, archive, inode, temporary, chunk, deadline, and cancellation limits", async () => {
    const bytes = archive([["entry", Buffer.from("payload")]]);
    const base = {
        archiveBytes: bytes.length,
        entryBytes: 7,
        entries: 1,
        temporaryBytes: 7,
        inodes: 1,
        maxChunkBytes: bytes.length,
        verificationTimeoutMs: 1_000,
    };
    for (const limits of [
        { ...base, archiveBytes: bytes.length - 1 },
        { ...base, entryBytes: 6 },
        { ...base, entries: 0 },
        { ...base, temporaryBytes: 6 },
        { ...base, inodes: 0 },
    ]) await rejected(bytes, ARTIFACT_VERIFICATION_ERROR_CODES.LIMIT_EXCEEDED, { limits });
    await rejected(Readable.from([bytes]), ARTIFACT_VERIFICATION_ERROR_CODES.LIMIT_EXCEEDED, {
        limits: { ...base, maxChunkBytes: bytes.length - 1 },
    });
    await rejected(bytes, ARTIFACT_VERIFICATION_ERROR_CODES.TIMEOUT, { deadline: Date.now() - 1 });
    const controller = new AbortController();
    controller.abort();
    await rejected(bytes, ARTIFACT_VERIFICATION_ERROR_CODES.CANCELLED, { signal: controller.signal });
});

test("MKT-02 streaming writer rejects truncated, excessive, and digest-mismatched sources", async () => {
    const factories = [
        () => createDeterministicArchiveStream([{ name: "entry", sizeBytes: 2, open: () => [Buffer.from("x")] }]),
        () => createDeterministicArchiveStream([{ name: "entry", sizeBytes: 1, open: () => [Buffer.from("xx")] }]),
        () => createDeterministicArchiveStream([{ name: "entry", sizeBytes: 1, sha256: "0".repeat(64), bytes: Buffer.from("x") }]),
    ];
    for (const factory of factories) {
        const current = factory();
        current.stream.resume();
        await assert.rejects(current.completion);
    }
});

test("MKT-02 greater-than-2-GiB lazy archive generation remains bounded", { timeout: 30_000 }, async () => {
    const sizeBytes = 2 * 1024 ** 3 + 1;
    const chunk = Buffer.alloc(8 * 1024 ** 2, 0x5a);
    const source = async function* () {
        let remaining = sizeBytes;
        while (remaining > 0) {
            const length = Math.min(remaining, chunk.length);
            yield length === chunk.length ? chunk : chunk.subarray(0, length);
            remaining -= length;
        }
    };
    const baseline = process.memoryUsage();
    let peakRss = baseline.rss;
    let peakBuffers = baseline.arrayBuffers;
    const generated = createDeterministicArchiveStream([{ name: "large.bin", sizeBytes, open: source }]);
    let observed = 0;
    for await (const output of generated.stream) {
        observed += output.length;
        const usage = process.memoryUsage();
        peakRss = Math.max(peakRss, usage.rss);
        peakBuffers = Math.max(peakBuffers, usage.arrayBuffers);
    }
    const completed = await generated.completion;
    assert.equal(completed.sizeBytes, observed);
    assert.ok(peakRss - baseline.rss < 256 * 1024 ** 2);
    assert.ok(peakBuffers - baseline.arrayBuffers < 128 * 1024 ** 2);
});
