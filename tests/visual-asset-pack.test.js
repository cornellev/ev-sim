import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { canonicalExactStringify } from "../app/simulation/visual/VisualLayer.js";
import {
    ASSET_ENTRY_PREFIX,
    BUNDLE_ENTRY_NAME,
    MANIFEST_ENTRY_NAME,
    encodeRunPackage,
    createRunPackageStream,
    encodeUstarFile,
    encodeUstarHeader,
    hashRunPackageManifest,
    normalizeRunPackageManifest,
    resolveRunPackageLimits,
    ustarEof,
    verifyRunPackageArchive,
} from "../server/headless/VisualAssetPack.js";
import { RUN_PACKAGE_ERROR_CODES } from "../server/storage/StorageErrors.js";
import { StorageService } from "../server/storage/StorageService.js";

const goldenUrl = new URL("fixtures/visual-layer/run-package.canonical.v1.json", import.meta.url);
const golden = JSON.parse(await fs.readFile(goldenUrl, "utf8"));

function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function goldenInputs() {
    const bundleBytes = Buffer.from(golden.bundleUtf8);
    const assetBytes = Buffer.from(golden.assetUtf8);
    return {
        bundleBytes,
        assets: [{ ...golden.asset, bytes: assetBytes }],
        emptyAssets: [],
    };
}

async function withStaging(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-run-package-"));
    try {
        return await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function analyticArchive() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-run-package-analytic-"));
    try {
        const service = new StorageService(dir);
        const exported = await service.exportRunPackage({ manifestId: "igvc-default" });
        const chunks = [];
        for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));
        return { ...await exported.completion, bytes: Buffer.concat(chunks) };
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function replaceEntry(archive, name, replacement) {
    const encoded = typeof replacement === "function" ? null : replacement;
    const parts = [];
    let offset = 0;
    while (offset + 512 <= archive.length) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            parts.push(archive.subarray(offset));
            break;
        }
        const rawName = header.subarray(0, 100);
        const end = rawName.indexOf(0);
        const entryName = rawName.subarray(0, end === -1 ? 100 : end).toString("utf8");
        const sizeText = header.subarray(124, 135).toString("latin1");
        const size = Number.parseInt(sizeText, 8);
        const total = 512 + size + ((512 - (size % 512)) % 512);
        if (entryName === name) {
            parts.push(encoded ?? replacement(header, archive.subarray(offset, offset + total)));
        } else {
            parts.push(archive.subarray(offset, offset + total));
        }
        offset += total;
    }
    return Buffer.concat(parts);
}

test("G-PACKAGE golden manifest JCS and archive hashes are frozen", () => {
    const { bundleBytes, assets } = goldenInputs();
    const encoded = encodeRunPackage({ bundleBytes, assets });
    const empty = encodeRunPackage({ bundleBytes, assets: [] });
    assert.equal(encoded.manifestBytes.toString("utf8"), golden.withAsset.manifestJcs);
    assert.equal(empty.manifestBytes.toString("utf8"), golden.empty.manifestJcs);
    assert.equal(encoded.manifestBytes.includes(0x0a), false);
    assert.equal(empty.manifestBytes.includes(0x0a), false);
    assert.equal(canonicalExactStringify(encoded.manifest), golden.withAsset.manifestJcs);
    assert.equal(hashRunPackageManifest(encoded.manifest), golden.withAsset.packageManifestHash);
    assert.equal(encoded.packageManifestHash, golden.withAsset.packageManifestHash);
    assert.equal(encoded.archiveHash, golden.withAsset.archiveHash);
    assert.equal(encoded.bytes.length, golden.withAsset.archiveBytes);
    assert.equal(empty.packageManifestHash, golden.empty.packageManifestHash);
    assert.equal(empty.archiveHash, golden.empty.archiveHash);
    assert.equal(empty.bytes.length, golden.empty.archiveBytes);
});

test("G-PACKAGE streaming encoding and fragmented verification preserve frozen bytes", async () => {
    const { bundleBytes, assets } = goldenInputs();
    const expected = encodeRunPackage({ bundleBytes, assets });
    const streamed = createRunPackageStream({
        bundleBytes,
        assets: assets.map((asset) => ({
            ...asset,
            bytes: undefined,
            open: () => Readable.from([...asset.bytes].map((byte) => Buffer.from([byte]))),
        })),
    });
    const chunks = [];
    for await (const chunk of streamed.stream) chunks.push(chunk);
    const completed = await streamed.completion;
    assert.deepEqual(Buffer.concat(chunks), expected.bytes);
    assert.equal(completed.archiveHash, expected.archiveHash);

    const abandoned = createRunPackageStream({ bundleBytes, assets });
    abandoned.stream.destroy();
    await assert.rejects(() => abandoned.completion, (error) => error.code === RUN_PACKAGE_ERROR_CODES.IO);

    const analytic = await analyticArchive();
    const verified = await verifyRunPackageArchive(Readable.from(
        Array.from({ length: Math.ceil(analytic.bytes.length / 37) }, (_, index) => (
            analytic.bytes.subarray(index * 37, (index + 1) * 37)
        )),
    ));
    assert.equal(verified.archiveHash, analytic.archiveHash);
    assert.equal(verified.assets.length, 0);
});

test("G-LIMITS reject oversized pulls, stalled streams, and zero verifier concurrency", async () => {
    const analytic = await analyticArchive();
    const { bundleBytes, assets } = goldenInputs();
    assert.throws(
        () => createRunPackageStream({
            bundleBytes,
            assets,
            limits: { assetBytes: assets[0].bytes.length - 1 },
        }),
        (error) => error.code === RUN_PACKAGE_ERROR_CODES.TOO_LARGE,
    );
    await assert.rejects(
        () => verifyRunPackageArchive(Readable.from([analytic.bytes]), {
            limits: { archiveBytes: analytic.bytes.length - 1 },
        }),
        (error) => error.code === RUN_PACKAGE_ERROR_CODES.TOO_LARGE,
    );
    const stalled = async function* source() {
        yield analytic.bytes.subarray(0, 1);
        await new Promise(() => {});
    };
    await assert.rejects(
        () => verifyRunPackageArchive(stalled(), { limits: { verificationTimeoutMs: 20 } }),
        (error) => error.code === RUN_PACKAGE_ERROR_CODES.TIMEOUT,
    );
    let iteratorClosed = false;
    const malformed = async function* source() {
        try {
            yield Buffer.alloc(512, 0xff);
            yield Buffer.alloc(512);
        } finally {
            iteratorClosed = true;
        }
    };
    await assert.rejects(
        () => verifyRunPackageArchive(malformed()),
        (error) => error.code === RUN_PACKAGE_ERROR_CODES.HOSTILE,
    );
    assert.equal(iteratorClosed, true);
    await withStaging(async (stagingRoot) => {
        await assert.rejects(
            () => verifyRunPackageArchive(Buffer.alloc(101), {
                stagingRoot,
                limits: { archiveBytes: 100 },
            }),
            (error) => error.code === RUN_PACKAGE_ERROR_CODES.TOO_LARGE,
        );
        assert.deepEqual(await fs.readdir(stagingRoot), []);
    });
    assert.throws(() => resolveRunPackageLimits({ concurrentVerifications: 0 }), /greater than or equal to 1/);
});

test("G-PACKAGE identical exact inputs reproduce archive bytes while exportedAt changes identity", async () => {
    const { bundleBytes, assets } = goldenInputs();
    const first = encodeRunPackage({ bundleBytes, assets });
    const second = encodeRunPackage({ bundleBytes: Buffer.from(bundleBytes), assets: assets.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })) });
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.archiveHash, second.archiveHash);

    const later = Buffer.from(golden.bundleUtf8.replace("2026-01-01", "2026-01-02"));
    const changed = encodeRunPackage({ bundleBytes: later, assets });
    assert.notEqual(changed.archiveHash, first.archiveHash);
    assert.notEqual(changed.packageManifestHash, first.packageManifestHash);
    assert.notEqual(sha256Hex(later), sha256Hex(bundleBytes));
});

test("G-PACKAGE preserves exact pretty bundle bytes without rewriting them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-run-package-pretty-"));
    try {
        const service = new StorageService(dir);
        const bundle = await service.exportRunManifest("igvc-default");
        const pretty = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
        const canonical = Buffer.from(canonicalExactStringify(bundle));
        assert.equal(pretty.equals(canonical), false);
        const encoded = encodeRunPackage({ bundleBytes: pretty, assets: [] });
        assert.equal(encoded.manifest.bundle.sha256, sha256Hex(pretty));
        assert.notEqual(encoded.manifest.bundle.sha256, sha256Hex(canonical));
        const verified = await withStaging((stagingDir) => verifyRunPackageArchive(encoded.bytes, {
            stagingDir,
            retainStaging: true,
        }));
        assert.equal(verified.bundleBytes.equals(pretty), true);
        assert.equal(verified.bundleBytes.equals(canonical), false);
        assert.equal(verified.resolvedHash, bundle.resolvedHash);
        assert.equal(canonicalExactStringify(verified.bundle), canonicalExactStringify(bundle));
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("G-SECURITY hostile USTAR corpus is rejected before CAS publication", async () => {
    const analytic = await analyticArchive();
    const valid = analytic.bytes;
    const digest = analytic.manifest.bundle.sha256;

    const cases = [
        ["gzip compression", gzipSync(valid)],
        ["bzip2 compression", Buffer.from([0x42, 0x5a, 0x68, 0x39])],
        ["xz compression", Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
        ["zstd compression", Buffer.from([0x28, 0xb5, 0x2f, 0xfd])],
        ["zip compression", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
        ["compress magic", Buffer.from([0x1f, 0x9d, 0x90])],
        ["truncated header", valid.subarray(0, 100)],
        ["truncated payload", valid.subarray(0, 600)],
        ["trailing data", Buffer.concat([valid, Buffer.from("x")])],
        ["extra zero block", Buffer.concat([valid, Buffer.alloc(512)])],
        ["absolute path", Buffer.concat([
            encodeUstarFile("/etc/passwd", Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["parent path", Buffer.concat([
            encodeUstarFile("../manifest.json", Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["encoded traversal", Buffer.concat([
            encodeUstarFile("%2e%2e/manifest.json", Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["backslash path", Buffer.concat([
            encodeUstarFile("assets\\sha256\\deadbeef", Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["PAX header", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}"), { typeflag: "x" }),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["GNU longname", Buffer.concat([
            encodeUstarFile("././@LongLink", Buffer.from("manifest.json"), { typeflag: "L" }),
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["symlink", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}"), { typeflag: "2", linkname: "bundle.json" }),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["hardlink", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}"), { typeflag: "1", linkname: "bundle.json" }),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["device", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}"), { typeflag: "3", devmajor: 1, devminor: 3 }),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["sparse GNU", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}"), { typeflag: "S" }),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["directory", Buffer.concat([
            encodeUstarFile("assets/", Buffer.alloc(0), { typeflag: "5" }),
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["NUL typeflag", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}"), { typeflag: "\0" }),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["checksum corruption", (() => {
            const bytes = Buffer.from(valid);
            bytes[148] = bytes[148] === 0x30 ? 0x31 : 0x30;
            return bytes;
        })()],
        ["numeric corruption", (() => {
            const header = encodeUstarHeader({ name: MANIFEST_ENTRY_NAME, size: 2 });
            header[135] = 0x20;
            return Buffer.concat([header, Buffer.from("{}"), Buffer.alloc(510), encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")), ustarEof()]);
        })()],
        ["non-zero padding", (() => {
            const bytes = Buffer.from(valid);
            const size = Number.parseInt(bytes.subarray(124, 135).toString("latin1"), 8);
            const padIndex = 512 + size;
            bytes[padIndex] = 1;
            return bytes;
        })()],
        ["duplicate manifest", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}")),
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["extra entry", Buffer.concat([
            valid.subarray(0, valid.length - 1024),
            encodeUstarFile("readme.txt", Buffer.from("nope")),
            ustarEof(),
        ])],
        ["case collision", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}")),
            encodeUstarFile("Manifest.json", Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["unicode name", Buffer.concat([
            encodeUstarFile("manifést.json", Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["nfd unicode name", Buffer.concat([
            encodeUstarFile("cafe\u0301.json", Buffer.from("{}")),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["missing bundle", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from(golden.empty.manifestJcs)),
            ustarEof(),
        ])],
        ["prefix traversal", Buffer.concat([
            encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from("{}"), { prefix: "../" }),
            encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from("{}")),
            ustarEof(),
        ])],
        ["uppercase digest path", replaceEntry(valid, BUNDLE_ENTRY_NAME, (header, entry) => {
            void header;
            return Buffer.concat([
                encodeUstarFile(BUNDLE_ENTRY_NAME, entry.subarray(512, 512 + Number.parseInt(entry.subarray(124, 135).toString("latin1"), 8))),
                encodeUstarFile(`${ASSET_ENTRY_PREFIX}${digest.toUpperCase()}`, Buffer.from("x")),
                ustarEof(),
            ]);
        })],
    ];

    for (const [name, bytes] of cases) {
        await withStaging(async (stagingDir) => {
            await assert.rejects(
                () => verifyRunPackageArchive(bytes, { stagingDir, retainStaging: true }),
                (error) => (
                    error.code === RUN_PACKAGE_ERROR_CODES.HOSTILE
                    || error.code === RUN_PACKAGE_ERROR_CODES.INVALID
                    || error.code === RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH
                    || error.code === RUN_PACKAGE_ERROR_CODES.TOO_LARGE
                ),
                name,
            );
            const names = await fs.readdir(path.join(stagingDir, "..")).catch(() => []);
            void names;
        });
    }

    const missingAsset = Buffer.concat([
        encodeUstarFile(MANIFEST_ENTRY_NAME, Buffer.from(golden.withAsset.manifestJcs)),
        encodeUstarFile(BUNDLE_ENTRY_NAME, Buffer.from(golden.bundleUtf8)),
        ustarEof(),
    ]);
    await withStaging(async (stagingDir) => {
        await assert.rejects(
            () => verifyRunPackageArchive(missingAsset, { stagingDir, retainStaging: true }),
            (error) => error.code === RUN_PACKAGE_ERROR_CODES.INVALID
                || error.code === RUN_PACKAGE_ERROR_CODES.HOSTILE
                || error.code === RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
        );
    });

    await withStaging(async (stagingDir) => {
        await assert.rejects(
            () => verifyRunPackageArchive(valid, {
                stagingDir,
                retainStaging: true,
                limits: { assetEntries: 0, archiveBytes: 100 },
            }),
            (error) => error.code === RUN_PACKAGE_ERROR_CODES.TOO_LARGE || error.code === RUN_PACKAGE_ERROR_CODES.HOSTILE,
        );
    });

    await withStaging(async (stagingDir) => {
        await assert.rejects(
            () => verifyRunPackageArchive(valid, { stagingDir, deadline: Date.now() - 1 }),
            (error) => error.code === RUN_PACKAGE_ERROR_CODES.TIMEOUT,
        );
    });
});

test("G-PACKAGE empty analytic packages have no asset entries", async () => {
    const exported = await analyticArchive();
    assert.equal(exported.assetCount, 0);
    assert.deepEqual(exported.manifest.assets, []);
    assert.equal(exported.bytes.includes(Buffer.from(ASSET_ENTRY_PREFIX)), false);
    const verified = await withStaging((stagingDir) => verifyRunPackageArchive(exported.bytes, {
        stagingDir,
        retainStaging: true,
    }));
    assert.equal(verified.assets.length, 0);
    assert.equal(verified.archiveHash, exported.archiveHash);
});

test("package manifest rejects unknown fields, unsorted assets, and extra hashes", () => {
    assert.throws(() => normalizeRunPackageManifest({
        kind: "cev-sim.run-package",
        version: 1,
        bundle: { sha256: "a".repeat(64), sizeBytes: 1 },
        assets: [],
        extra: true,
    }), /unknown field/);
    assert.throws(() => normalizeRunPackageManifest({
        kind: "cev-sim.run-package",
        version: 1,
        bundle: { sha256: "b".repeat(64), sizeBytes: 1 },
        assets: [
            { sha256: "c".repeat(64), mediaType: "image/png", sizeBytes: 1, role: "texture" },
            { sha256: "a".repeat(64), mediaType: "image/png", sizeBytes: 1, role: "texture" },
        ],
    }), /UTF-8 digest order/);
});
