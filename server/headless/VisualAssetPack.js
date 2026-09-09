import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
    RUN_PACKAGE_PROFILE,
    VISUAL_ASSET_UPLOAD_OPERATIONS,
    VISUAL_RENDER_PROVIDERS,
    canonicalExactStringify,
    evaluateVisualSourcePolicy,
    normalizeVisualAssetReference,
    parseExactJson,
    sha256ExactBytes,
} from "../../app/simulation/visual/VisualLayer.js";
import { compareUtf8 } from "../../app/simulation/world/WorldDescription.js";
import { RUN_PACKAGE_ERROR_CODES, VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../storage/StorageErrors.js";
import { fsyncDir, mapFsError, maybeFault, writeExclusiveFile } from "../storage/visual-assets/atomicFs.js";
import { canonicalRunBundleStringify, verifyRunBundleBytes } from "./RunBundle.js";

export const USTAR_BLOCK_SIZE = 512;
export const RUN_PACKAGE_KIND = RUN_PACKAGE_PROFILE.kind;
export const RUN_PACKAGE_VERSION = RUN_PACKAGE_PROFILE.version;
export const MANIFEST_ENTRY_NAME = "manifest.json";
export const BUNDLE_ENTRY_NAME = "bundle.json";
export const ASSET_ENTRY_PREFIX = "assets/sha256/";

const SHA256 = /^[a-f0-9]{64}$/;
const PERCENT_TRAVERSAL = /%(?:2e|2f|5c)/i;
const COMPRESSION_MAGICS = [
    [0x1f, 0x8b],
    [0x42, 0x5a],
    [0xfd, 0x37],
    [0x28, 0xb5],
    [0x50, 0x4b],
    [0x1f, 0x9d],
];
const REGULAR_TYPEFLAG = 0x30;
const USTAR_MAGIC = Buffer.from("ustar\0", "latin1");
const USTAR_VERSION = Buffer.from("00", "latin1");
const ZERO_BLOCK = Buffer.alloc(USTAR_BLOCK_SIZE);
const MAX_ARCHIVE_INPUT_CHUNK_BYTES = RUN_PACKAGE_PROFILE.limits.bundleBytes;
const FORBIDDEN_TYPEFLAGS = new Set([
    0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
    0x41, 0x44, 0x4b, 0x4c, 0x4d, 0x53, 0x56, 0x58,
    0x67, 0x78,
]);

export const RUN_PACKAGE_RUNTIME_LIMITS = Object.freeze({
    archiveBytes: RUN_PACKAGE_PROFILE.limits.archiveBytes,
    assetBytes: RUN_PACKAGE_PROFILE.limits.assetBytes,
    bundleBytes: RUN_PACKAGE_PROFILE.limits.bundleBytes,
    manifestBytes: RUN_PACKAGE_PROFILE.limits.manifestBytes,
    assetEntries: RUN_PACKAGE_PROFILE.limits.assetEntries,
    temporaryBytes: RUN_PACKAGE_PROFILE.limits.archiveBytes,
    inodes: 2 + RUN_PACKAGE_PROFILE.limits.assetEntries,
    concurrentVerifications: 2,
    verificationTimeoutMs: 60_000,
    abandonedStageTtlMs: 60 * 60 * 1000,
});

const COUNT_LIMITS = new Set([
    "assetEntries", "inodes", "concurrentVerifications", "verificationTimeoutMs", "abandonedStageTtlMs",
]);

export function runPackageError(code, message, details) {
    return visualAssetError(code, message, details);
}

export function resolveRunPackageLimits(overrides = {}) {
    const resolved = {};
    for (const [key, ceiling] of Object.entries(RUN_PACKAGE_RUNTIME_LIMITS)) {
        const value = overrides[key] === undefined ? ceiling : Number(overrides[key]);
        const minimum = key === "concurrentVerifications" ? 1 : 0;
        if (!Number.isFinite(value) || value < minimum) {
            throw new TypeError(`Run package limit ${key} must be a number greater than or equal to ${minimum}.`);
        }
        const integer = COUNT_LIMITS.has(key) ? Math.floor(value) : value;
        resolved[key] = integer > ceiling ? ceiling : integer;
    }
    return Object.freeze(resolved);
}

function deadlineError() {
    return runPackageError(RUN_PACKAGE_ERROR_CODES.TIMEOUT, "Package verification exceeded its time budget.");
}

async function beforeDeadline(promise, deadline) {
    // Observe the operation even when the deadline expired before this call.
    Promise.resolve(promise).catch(() => {});
    if (!Number.isFinite(deadline)) return promise;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw deadlineError();
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(deadlineError()), remaining);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function checkDeadline(deadline) {
    if (Date.now() >= deadline) throw deadlineError();
}

async function closeIterator(iterator, readable) {
    readable?.destroy?.();
    const closing = Promise.resolve(iterator?.return?.()).catch(() => {});
    // A pending next() on an uncooperative producer must not hold cleanup open.
    await Promise.race([closing, new Promise((resolve) => setImmediate(resolve))]);
}

export function mapRunPackageError(error) {
    const mapped = mapFsError(error);
    if (Object.values(RUN_PACKAGE_ERROR_CODES).includes(mapped?.code)
        || Object.values(VISUAL_ASSET_ERROR_CODES).includes(mapped?.code)
        || mapped?.name === "AbortError") return mapped;
    return runPackageError(RUN_PACKAGE_ERROR_CODES.IO, `Run package I/O failed: ${mapped.message}`);
}

// Do not race a whole writer against a timer: it could continue writing after
// its staging directory has been removed. Bound producers/fault hooks, and
// settle each filesystem operation before cleanup, checking every boundary.
async function stageFile(chunks, filePath, size, deadline, faults) {
    checkDeadline(deadline);
    const handle = await fs.open(filePath, "wx", 0o600);
    const hasher = createHash("sha256");
    let received = 0;
    try {
        for await (const chunk of chunks) {
            checkDeadline(deadline);
            received += chunk.length;
            if (received > size) throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Staged entry exceeds its declared size.");
            await beforeDeadline(maybeFault(faults, "write"), deadline);
            checkDeadline(deadline);
            const written = await handle.write(chunk);
            if (written.bytesWritten !== chunk.length) {
                throw visualAssetError(VISUAL_ASSET_ERROR_CODES.SHORT_WRITE, "Package staging write was shorter than requested.");
            }
            checkDeadline(deadline);
            hasher.update(chunk);
        }
        if (received !== size) throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Staged entry is truncated.");
        await beforeDeadline(maybeFault(faults, "fsync"), deadline);
        checkDeadline(deadline);
        await handle.sync();
        checkDeadline(deadline);
    } finally {
        await handle.close();
    }
    await beforeDeadline(maybeFault(faults, "dirFsync"), deadline);
    checkDeadline(deadline);
    await fsyncDir(path.dirname(filePath));
    checkDeadline(deadline);
    return { received, digest: hasher.digest("hex") };
}

function asBytes(value, path = "bytes") {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `${path} must be exact bytes.`);
}

function encodeOctal(value, fieldLength) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "USTAR numeric fields must be non-negative safe integers.");
    }
    const digits = fieldLength - 1;
    const octal = value.toString(8);
    if (octal.length > digits) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "USTAR numeric field exceeds the canonical width.");
    }
    const field = Buffer.alloc(fieldLength);
    field.write(octal.padStart(digits, "0"), 0, digits, "latin1");
    return field;
}

function encodeChecksum(sum) {
    const octal = sum.toString(8).padStart(6, "0");
    if (octal.length > 6) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "USTAR checksum exceeds six octal digits.");
    }
    return Buffer.from(`${octal}\0 `, "latin1");
}

function writeCString(target, offset, value, length) {
    const bytes = Buffer.from(String(value ?? ""), "utf8");
    if (bytes.length >= length) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "USTAR string field exceeds its fixed width.");
    }
    bytes.copy(target, offset);
}

function headerChecksum(header) {
    let sum = 0;
    for (let index = 0; index < USTAR_BLOCK_SIZE; index += 1) {
        sum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    return sum;
}

function padToBlock(size) {
    const remainder = size % USTAR_BLOCK_SIZE;
    return remainder === 0 ? 0 : USTAR_BLOCK_SIZE - remainder;
}

/**
 * Encode one frozen-profile USTAR header. Optional overrides exist so tests can
 * synthesize hostile archives; production encoding uses the defaults only.
 */
export function encodeUstarHeader({
    name,
    size,
    typeflag = "0",
    mode = RUN_PACKAGE_PROFILE.header.mode,
    uid = RUN_PACKAGE_PROFILE.header.uid,
    gid = RUN_PACKAGE_PROFILE.header.gid,
    mtime = RUN_PACKAGE_PROFILE.header.mtime,
    uname = RUN_PACKAGE_PROFILE.header.ownerName,
    gname = RUN_PACKAGE_PROFILE.header.groupName,
    linkname = "",
    magic = USTAR_MAGIC,
    version = USTAR_VERSION,
    prefix = "",
    devmajor = null,
    devminor = null,
    checksum = "auto",
    modeField = null,
    uidField = null,
    gidField = null,
    sizeField = null,
    mtimeField = null,
} = {}) {
    const header = Buffer.alloc(USTAR_BLOCK_SIZE);
    writeCString(header, 0, name, 100);
    (modeField ?? encodeOctal(mode, 8)).copy(header, 100);
    (uidField ?? encodeOctal(uid, 8)).copy(header, 108);
    (gidField ?? encodeOctal(gid, 8)).copy(header, 116);
    (sizeField ?? encodeOctal(size, 12)).copy(header, 124);
    (mtimeField ?? encodeOctal(mtime, 12)).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = typeof typeflag === "number" ? typeflag : String(typeflag).charCodeAt(0);
    writeCString(header, 157, linkname, 100);
    Buffer.from(magic).copy(header, 257, 0, 6);
    Buffer.from(version).copy(header, 263, 0, 2);
    writeCString(header, 265, uname, 32);
    writeCString(header, 297, gname, 32);
    if (devmajor != null) encodeOctal(devmajor, 8).copy(header, 329);
    if (devminor != null) encodeOctal(devminor, 8).copy(header, 337);
    writeCString(header, 345, prefix, 155);
    const encodedChecksum = checksum === "auto" ? encodeChecksum(headerChecksum(header)) : Buffer.from(checksum);
    encodedChecksum.copy(header, 148, 0, 8);
    return header;
}

export function encodeUstarFile(name, content, headerOverrides = {}) {
    const bytes = asBytes(content, name);
    const header = encodeUstarHeader({ name, size: bytes.length, ...headerOverrides });
    const padding = Buffer.alloc(padToBlock(bytes.length));
    return Buffer.concat(padding.length ? [header, bytes, padding] : [header, bytes]);
}

export function ustarEof() {
    return Buffer.concat([Buffer.from(ZERO_BLOCK), Buffer.from(ZERO_BLOCK)]);
}

function sortAssetRecords(assets) {
    return [...assets].sort((left, right) => compareUtf8(left.sha256, right.sha256));
}

export function normalizeRunPackageManifest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package manifest must be an object.");
    }
    const unknown = Object.keys(value).find((key) => !["kind", "version", "bundle", "assets"].includes(key));
    if (unknown) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Package manifest has unknown field ${unknown}.`);
    }
    if (value.kind !== RUN_PACKAGE_KIND || value.version !== RUN_PACKAGE_VERSION) {
        throw runPackageError(
            RUN_PACKAGE_ERROR_CODES.INVALID,
            `Unsupported package manifest; expected ${RUN_PACKAGE_KIND} version ${RUN_PACKAGE_VERSION}.`,
        );
    }
    if (!value.bundle || typeof value.bundle !== "object" || Array.isArray(value.bundle)) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package manifest bundle identity is required.");
    }
    const bundleUnknown = Object.keys(value.bundle).find((key) => !["sha256", "sizeBytes"].includes(key));
    if (bundleUnknown) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Package manifest bundle has unknown field ${bundleUnknown}.`);
    }
    if (typeof value.bundle.sha256 !== "string" || !SHA256.test(value.bundle.sha256)) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package manifest bundle digest must be a lowercase SHA-256.");
    }
    if (!Number.isSafeInteger(value.bundle.sizeBytes) || value.bundle.sizeBytes < 0) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package manifest bundle size must be a non-negative integer.");
    }
    if (!Array.isArray(value.assets) || Object.keys(value.assets).length !== value.assets.length) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package manifest assets must be a dense array.");
    }
    const assets = value.assets.map((entry, index) => normalizeVisualAssetReference(entry, `manifest.assets.${index}`));
    const digests = assets.map((entry) => entry.sha256);
    if (new Set(digests).size !== digests.length) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package manifest assets contain duplicate digests.");
    }
    const sorted = sortAssetRecords(assets);
    for (let index = 0; index < assets.length; index += 1) {
        if (assets[index].sha256 !== sorted[index].sha256) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package manifest assets must be in UTF-8 digest order.");
        }
    }
    return {
        kind: RUN_PACKAGE_KIND,
        version: RUN_PACKAGE_VERSION,
        bundle: {
            sha256: value.bundle.sha256,
            sizeBytes: value.bundle.sizeBytes,
        },
        assets: sorted,
    };
}

export function createRunPackageManifest({ bundleBytes, assets = [] }) {
    const bytes = asBytes(bundleBytes, "bundle.json");
    const records = sortAssetRecords(assets.map((entry, index) => {
        const content = entry.bytes != null ? asBytes(entry.bytes, `assets[${index}]`) : null;
        const sizeBytes = entry.sizeBytes ?? content?.length;
        if (content && content.length !== sizeBytes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Asset ${entry.sha256} size does not match its bytes.`);
        }
        if (content && sha256ExactBytes(content) !== entry.sha256) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Asset ${entry.sha256} digest does not match its bytes.`);
        }
        return normalizeVisualAssetReference({
            sha256: entry.sha256,
            mediaType: entry.mediaType,
            sizeBytes,
            role: entry.role,
        }, `assets[${index}]`);
    }));
    return normalizeRunPackageManifest({
        kind: RUN_PACKAGE_KIND,
        version: RUN_PACKAGE_VERSION,
        bundle: {
            sha256: sha256ExactBytes(bytes),
            sizeBytes: bytes.length,
        },
        assets: records,
    });
}

export function hashRunPackageManifest(manifest) {
    return sha256ExactBytes(Buffer.from(canonicalExactStringify(normalizeRunPackageManifest(manifest)), "utf8"));
}

export function collectRunPackageAssets(bundle) {
    const resolved = bundle?.resolved;
    const provider = resolved?.renderScene?.description?.provider;
    const pbrSelected = provider?.id === VISUAL_RENDER_PROVIDERS.pbrMesh.id
        && provider?.version === VISUAL_RENDER_PROVIDERS.pbrMesh.version;
    if (!pbrSelected) {
        if (resolved?.visualLayer || resolved?.evidence?.visualAssets) {
            throw runPackageError(
                RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
                "A non-PBR bundle must not declare visual-layer resources or package assets.",
            );
        }
        return [];
    }
    const closureAssets = resolved.renderScene?.description?.assetClosure?.assets;
    if (!Array.isArray(closureAssets)) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, "A pbr-mesh@1 package requires an exact asset closure.");
    }
    const uses = resolved.evidence?.visualAssets?.uses;
    if (!Array.isArray(uses)) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, "A pbr-mesh@1 package requires source-use evidence.");
    }
    const byDigest = new Map();
    for (const asset of closureAssets) {
        const record = normalizeVisualAssetReference(asset, "assetClosure.assets");
        const prior = byDigest.get(record.sha256);
        if (prior && canonicalExactStringify(prior) !== canonicalExactStringify(record)) {
            throw runPackageError(
                RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
                `Conflicting closure metadata for asset ${record.sha256}.`,
            );
        }
        byDigest.set(record.sha256, record);
    }
    const referenced = new Set();
    for (const entry of uses) {
        const asset = entry?.use?.asset;
        if (!asset) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, "Source-use evidence is missing an asset reference.");
        }
        const record = normalizeVisualAssetReference(asset, "evidence.visualAssets.uses.asset");
        const closed = byDigest.get(record.sha256);
        if (!closed) {
            throw runPackageError(
                RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
                `Source-use evidence references unlisted asset ${record.sha256}.`,
            );
        }
        if (canonicalExactStringify(closed) !== canonicalExactStringify(record)) {
            throw runPackageError(
                RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
                `Conflicting metadata for asset ${record.sha256}.`,
            );
        }
        referenced.add(record.sha256);
    }
    for (const digest of byDigest.keys()) {
        if (!referenced.has(digest)) {
            throw runPackageError(
                RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
                `Render-scene closure contains unreferenced asset ${digest}.`,
            );
        }
    }
    return sortAssetRecords([...byDigest.values()]);
}

function assertAssetListMatch(expected, actual, label) {
    if (expected.length !== actual.length) {
        throw runPackageError(
            RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
            `${label} asset count ${actual.length} does not match the required closure ${expected.length}.`,
        );
    }
    for (let index = 0; index < expected.length; index += 1) {
        if (canonicalExactStringify(expected[index]) !== canonicalExactStringify(actual[index])) {
            throw runPackageError(
                RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
                `${label} asset ${actual[index]?.sha256 ?? index} does not match the render-scene closure.`,
            );
        }
    }
}

export function encodeRunPackage({ bundleBytes, assets = [] }) {
    const bundle = asBytes(bundleBytes, "bundle.json");
    // This test convenience must not attempt multi-gigabyte Buffer.concat.
    // Operational callers use createRunPackageStream and the full profile.
    const bufferedLimit = 64 * 1024 * 1024;
    let contentBytes = bundle.length;
    const prepared = assets.map((entry, index) => {
        const bytes = asBytes(entry.bytes, `assets[${index}]`);
        contentBytes += bytes.length;
        if (contentBytes > bufferedLimit) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Buffered package encoding is limited to 64 MiB; use createRunPackageStream.");
        }
        return {
            ...normalizeVisualAssetReference({
                sha256: entry.sha256 ?? sha256ExactBytes(bytes),
                mediaType: entry.mediaType,
                sizeBytes: entry.sizeBytes ?? bytes.length,
                role: entry.role,
            }, `assets[${index}]`),
            bytes,
        };
    });
    if (prepared.length > RUN_PACKAGE_PROFILE.limits.assetEntries) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package exceeds the asset-entry ceiling.");
    }
    if (bundle.length > RUN_PACKAGE_PROFILE.limits.bundleBytes) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package bundle exceeds the 32 MiB ceiling.");
    }
    const manifest = createRunPackageManifest({ bundleBytes: bundle, assets: prepared });
    const manifestBytes = Buffer.from(canonicalExactStringify(manifest), "utf8");
    if (manifestBytes.length > RUN_PACKAGE_PROFILE.limits.manifestBytes) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package manifest exceeds the 4 MiB ceiling.");
    }
    const archiveBytes = 1024 + [manifestBytes, bundle, ...prepared.map((asset) => asset.bytes)]
        .reduce((size, bytes) => size + 512 + bytes.length + padToBlock(bytes.length), 0);
    if (archiveBytes > bufferedLimit) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Buffered package encoding is limited to 64 MiB; use createRunPackageStream.");
    }
    const hasher = createHash("sha256");
    const chunks = [];
    const push = (chunk) => {
        hasher.update(chunk);
        chunks.push(chunk);
    };
    push(encodeUstarFile(MANIFEST_ENTRY_NAME, manifestBytes));
    push(encodeUstarFile(BUNDLE_ENTRY_NAME, bundle));
    for (const asset of sortAssetRecords(prepared)) {
        if (asset.bytes.length > RUN_PACKAGE_PROFILE.limits.assetBytes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, `Asset ${asset.sha256} exceeds the 1 GiB ceiling.`);
        }
        push(encodeUstarFile(`${ASSET_ENTRY_PREFIX}${asset.sha256}`, asset.bytes));
    }
    push(ustarEof());
    const bytes = Buffer.concat(chunks);
    if (bytes.length > RUN_PACKAGE_PROFILE.limits.archiveBytes) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package archive exceeds the 8 GiB ceiling.");
    }
    return {
        bytes,
        manifest,
        manifestBytes,
        packageManifestHash: sha256ExactBytes(manifestBytes),
        archiveHash: hasher.digest("hex"),
        bundleBytesHash: manifest.bundle.sha256,
    };
}

/**
 * Stream the frozen run-package profile without retaining asset or archive
 * bytes. Asset entries may provide `bytes`, `path`, `stream`, or an `open()`
 * function returning an async iterable. The returned completion promise
 * resolves only after the stream has been consumed successfully.
 */
export function createRunPackageStream({
    bundleBytes,
    assets = [],
    deadline,
    limits: limitOverrides = {},
} = {}) {
    const limits = resolveRunPackageLimits(limitOverrides);
    deadline ??= Date.now() + limits.verificationTimeoutMs;
    const bundle = asBytes(bundleBytes, "bundle.json");
    if (bundle.length > limits.bundleBytes) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package bundle exceeds the 32 MiB ceiling.");
    }
    const sources = new Map();
    const prepared = sortAssetRecords(assets.map((entry, index) => {
        if (sources.has(entry.sha256)) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Package contains duplicate asset ${entry.sha256}.`);
        }
        sources.set(entry.sha256, entry);
        return normalizeVisualAssetReference({
        sha256: entry.sha256,
        mediaType: entry.mediaType,
        sizeBytes: entry.sizeBytes ?? entry.bytes?.length,
        role: entry.role,
        }, `assets[${index}]`);
    })).map((record) => ({
        ...record,
        source: sources.get(record.sha256),
    }));
    if (prepared.length > limits.assetEntries) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package exceeds the asset-entry ceiling.");
    }
    for (const asset of prepared) {
        if (asset.sizeBytes > limits.assetBytes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, `Asset ${asset.sha256} exceeds the 1 GiB ceiling.`);
        }
    }
    const manifest = createRunPackageManifest({ bundleBytes: bundle, assets: prepared });
    const manifestBytes = Buffer.from(canonicalExactStringify(manifest), "utf8");
    if (manifestBytes.length > limits.manifestBytes) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package manifest exceeds the 4 MiB ceiling.");
    }
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    // Consumers commonly observe the stream failure before awaiting metadata.
    // Mark the promise handled immediately while preserving its rejection for
    // callers that await `completion`.
    completion.catch(() => {});
    let settled = false;
    const generator = async function* generate() {
        const archiveHasher = createHash("sha256");
        let archiveBytes = 0;
        const emit = (chunk) => {
            checkDeadline(deadline);
            archiveBytes += chunk.length;
            if (archiveBytes > limits.archiveBytes) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package archive exceeds the 8 GiB ceiling.");
            }
            archiveHasher.update(chunk);
            return chunk;
        };
        const emitSmallEntry = function* smallEntry(name, bytes) {
            yield emit(encodeUstarHeader({ name, size: bytes.length }));
            if (bytes.length) yield emit(bytes);
            const padding = padToBlock(bytes.length);
            if (padding) yield emit(Buffer.alloc(padding));
        };
        try {
            yield* emitSmallEntry(MANIFEST_ENTRY_NAME, manifestBytes);
            yield* emitSmallEntry(BUNDLE_ENTRY_NAME, bundle);
            for (const asset of prepared) {
                yield emit(encodeUstarHeader({ name: expectedAssetName(asset.sha256), size: asset.sizeBytes }));
                let cancelledOpen = false;
                const opening = asset.source?.open ? Promise.resolve(asset.source.open()).then(async (source) => {
                    if (cancelledOpen) await closeIterator(source?.[Symbol.asyncIterator]?.(), source);
                    return source;
                }) : null;
                let source;
                try {
                    source = opening ? await beforeDeadline(opening, deadline)
                        : asset.source?.stream ?? (asset.source?.path
                        ? createReadStream(asset.source.path)
                        : Readable.from(asBytes(asset.source?.bytes, asset.sha256)));
                } catch (error) {
                    cancelledOpen = true;
                    throw error;
                }
                const readable = Readable.from(source);
                const iterator = readable[Symbol.asyncIterator]();
                const assetHasher = createHash("sha256");
                let received = 0;
                try {
                    while (true) {
                        const next = await beforeDeadline(iterator.next(), deadline);
                        if (next.done) break;
                        const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
                        if (chunk.length > MAX_ARCHIVE_INPUT_CHUNK_BYTES) {
                            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package asset input chunk exceeds the streaming ceiling.");
                        }
                        received += chunk.length;
                        if (received > asset.sizeBytes) {
                            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Asset ${asset.sha256} exceeds its declared size.`);
                        }
                        assetHasher.update(chunk);
                        yield emit(chunk);
                    }
                } finally {
                    await closeIterator(iterator, readable);
                }
                if (received !== asset.sizeBytes || assetHasher.digest("hex") !== asset.sha256) {
                    throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Asset ${asset.sha256} bytes do not match their declared identity.`);
                }
                const padding = padToBlock(received);
                if (padding) yield emit(Buffer.alloc(padding));
            }
            yield emit(ustarEof());
            resolveCompletion({
                manifest,
                manifestBytes,
                packageManifestHash: sha256ExactBytes(manifestBytes),
                archiveHash: archiveHasher.digest("hex"),
                bundleBytesHash: manifest.bundle.sha256,
                archiveBytes,
            });
            settled = true;
        } catch (error) {
            settled = true;
            rejectCompletion(error);
            throw error;
        } finally {
            if (!settled) rejectCompletion(runPackageError(RUN_PACKAGE_ERROR_CODES.IO, "Run package stream was closed before completion."));
        }
    };
    const stream = Readable.from(generator());
    stream.on("error", () => {});
    const timer = Number.isFinite(deadline) ? setTimeout(() => {
        rejectCompletion(deadlineError());
        stream.destroy(deadlineError());
    }, Math.max(1, deadline - Date.now())) : null;
    timer?.unref?.();
    stream.once("close", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        rejectCompletion(runPackageError(RUN_PACKAGE_ERROR_CODES.IO, "Run package stream was closed before completion."));
    });
    return {
        stream,
        completion,
        manifest,
        manifestBytes,
        packageManifestHash: sha256ExactBytes(manifestBytes),
        bundleBytesHash: manifest.bundle.sha256,
    };
}

function hostile(message) {
    throw runPackageError(RUN_PACKAGE_ERROR_CODES.HOSTILE, message);
}

function readCString(buffer, offset, length) {
    const slice = buffer.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    const bytes = end === -1 ? slice : slice.subarray(0, end);
    if (end !== -1 && !slice.subarray(end).every((value) => value === 0)) {
        hostile("USTAR string fields must be NUL-terminated with zero padding.");
    }
    return { text: bytes.toString("utf8"), bytes };
}

function assertCanonicalNumeric(field, value, length) {
    const expected = encodeOctal(value, length);
    if (!field.equals(expected)) hostile("USTAR numeric fields must use the frozen canonical octal encoding.");
}

function parseCanonicalSize(field) {
    if (field[11] !== 0) hostile("USTAR size fields must use canonical NUL-terminated octal.");
    const text = field.subarray(0, 11).toString("latin1");
    if (!/^[0-7]{11}$/.test(text)) hostile("USTAR size fields must be twelve-byte canonical octal.");
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value) || value < 0) hostile("USTAR size field is not a safe integer.");
    assertCanonicalNumeric(field, value, 12);
    return value;
}

function classifyPath(name, prefix) {
    if (prefix) hostile("USTAR prefix fields must be empty in the frozen profile.");
    if (!name) hostile("Archive entry names must not be empty.");
    if (name.includes("\0")) hostile("Archive entry names must not contain NUL.");
    if (name.includes("\\")) hostile("Archive entry names must not contain backslashes.");
    if (name.startsWith("/")) hostile("Archive entry names must be relative.");
    if (PERCENT_TRAVERSAL.test(name)) hostile("Archive entry names must not contain encoded traversal.");
    const nfc = name.normalize("NFC");
    if (nfc !== name) hostile("Archive entry names must be NFC.");
    const segments = name.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        hostile("Archive entry names must not contain empty, parent, or current-directory segments.");
    }
    if (/[^\u0020-\u007e]/u.test(name)) hostile("Archive entry names must be printable ASCII.");
    return name;
}

function expectedAssetName(digest) {
    return `${ASSET_ENTRY_PREFIX}${digest}`;
}

function detectCompression(prefix) {
    return COMPRESSION_MAGICS.some((magic) => magic.every((byte, index) => prefix[index] === byte));
}

class ArchiveReader {
    constructor(source, limits, deadline) {
        this.limits = limits;
        this.deadline = deadline;
        this.total = 0;
        this.pulled = 0;
        if (Buffer.isBuffer(source) || source instanceof Uint8Array || source instanceof ArrayBuffer) {
            this.pending = asBytes(source, "archive");
            this.pulled = this.pending.length;
            if (this.pulled > limits.archiveBytes) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package archive exceeds the archive-byte ceiling.");
            }
            this.readable = null;
            this.iterator = null;
        } else {
            this.pending = Buffer.alloc(0);
            this.readable = Readable.from(source);
            this.iterator = this.readable[Symbol.asyncIterator]();
        }
    }

    async fill(size) {
        checkDeadline(this.deadline);
        while (this.pending.length < size && this.iterator) {
            const next = await beforeDeadline(this.iterator.next(), this.deadline);
            if (next.done) {
                this.iterator = null;
                break;
            }
            const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
            this.pulled += chunk.length;
            if (chunk.length > MAX_ARCHIVE_INPUT_CHUNK_BYTES || this.pulled > this.limits.archiveBytes) {
                await this.close();
                throw runPackageError(
                    RUN_PACKAGE_ERROR_CODES.TOO_LARGE,
                    chunk.length > MAX_ARCHIVE_INPUT_CHUNK_BYTES
                        ? `Package input chunks may not exceed ${MAX_ARCHIVE_INPUT_CHUNK_BYTES} bytes.`
                        : "Package archive exceeds the archive-byte ceiling.",
                );
            }
            this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        }
    }

    async peek(size) {
        await this.fill(size);
        return this.pending.subarray(0, Math.min(size, this.pending.length));
    }

    async readExact(size, hasher) {
        const chunks = [];
        for await (const chunk of this.readChunks(size, hasher)) chunks.push(Buffer.from(chunk));
        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
    }

    async *readChunks(size, hasher) {
        let remaining = size;
        while (remaining > 0) {
            await this.fill(1);
            if (!this.pending.length) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.HOSTILE, "Archive is truncated.");
            }
            const length = Math.min(remaining, this.pending.length);
            const slice = this.pending.subarray(0, length);
            this.pending = this.pending.subarray(length);
            remaining -= length;
            this.total += length;
            hasher.update(slice);
            yield slice;
        }
    }

    async close() {
        if (!this.iterator) return;
        const iterator = this.iterator;
        this.iterator = null;
        await closeIterator(iterator, this.readable);
    }
}

function parseHeader(header) {
    if (header.equals(ZERO_BLOCK)) return { zero: true, header };
    const magic = header.subarray(257, 263);
    if (!magic.equals(USTAR_MAGIC)) hostile("Archive magic must be the frozen POSIX USTAR marker.");
    const version = header.subarray(263, 265);
    if (!version.equals(USTAR_VERSION)) hostile("Archive version must be the frozen USTAR 00 marker.");
    const typeflag = header[156];
    if (typeflag !== REGULAR_TYPEFLAG) {
        if (typeflag === 0) hostile("Archive regular files must use typeflag '0', not NUL.");
        if (FORBIDDEN_TYPEFLAGS.has(typeflag) || typeflag === 0x53) {
            hostile("Archive entries must be regular files; links, devices, sparse, PAX, and GNU headers are forbidden.");
        }
        hostile("Archive entries must be frozen-profile regular files.");
    }
    if (header.subarray(157, 257).some((value) => value !== 0)) hostile("Archive link names must be empty.");
    if (header.subarray(329, 345).some((value) => value !== 0)) hostile("Archive device fields must be zero.");
    const prefix = readCString(header, 345, 155).text;
    const name = classifyPath(readCString(header, 0, 100).text, prefix);
    assertCanonicalNumeric(header.subarray(100, 108), RUN_PACKAGE_PROFILE.header.mode, 8);
    assertCanonicalNumeric(header.subarray(108, 116), 0, 8);
    assertCanonicalNumeric(header.subarray(116, 124), 0, 8);
    assertCanonicalNumeric(header.subarray(136, 148), 0, 12);
    if (header.subarray(265, 297).some((value) => value !== 0) || header.subarray(297, 329).some((value) => value !== 0)) {
        hostile("Archive owner and group names must be empty.");
    }
    const size = parseCanonicalSize(header.subarray(124, 136));
    const expectedHeader = encodeUstarHeader({ name, size });
    if (!header.equals(expectedHeader)) hostile("Archive headers must match the frozen USTAR profile byte-for-byte.");
    return { zero: false, name, size, header };
}

async function extractEntry(reader, header, archiveHasher, deadline) {
    if (Date.now() > deadline) {
        throw runPackageError(RUN_PACKAGE_ERROR_CODES.TIMEOUT, "Package verification exceeded its time budget.");
    }
    const content = await reader.readExact(header.size, archiveHasher);
    const paddingSize = padToBlock(header.size);
    if (paddingSize) {
        const padding = await reader.readExact(paddingSize, archiveHasher);
        if (!padding.every((byte) => byte === 0)) hostile("Archive content padding must be zero.");
    }
    return content;
}

export async function createPackageStagingDir(rootDir) {
    const id = randomUUID();
    const dir = path.join(rootDir, id);
    await fs.mkdir(dir, { recursive: true });
    const meta = {
        id,
        createdAt: new Date().toISOString(),
        phase: "created",
        entries: [],
    };
    try {
        await writeExclusiveFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    } catch (error) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw mapRunPackageError(error);
    }
    return { id, dir, meta };
}

export async function recoverPackageStaging(rootDir, { ttlMs = RUN_PACKAGE_RUNTIME_LIMITS.abandonedStageTtlMs, now = () => new Date(), active = new Set() } = {}) {
    let names;
    try {
        names = await fs.readdir(rootDir);
    } catch (error) {
        if (error.code === "ENOENT") return { removed: 0 };
        throw error;
    }
    const cutoff = now().getTime() - ttlMs;
    let removed = 0;
    for (const name of names) {
        const dir = path.join(rootDir, name);
        if (active.has(dir)) continue;
        let createdAt = Number.NaN;
        try {
            const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
            createdAt = Date.parse(meta.createdAt || 0);
        } catch {
            try {
                createdAt = (await fs.lstat(dir)).mtimeMs;
            } catch {
                createdAt = Number.NaN;
            }
        }
        if (!Number.isFinite(createdAt) || createdAt <= cutoff) {
            await fs.rm(dir, { recursive: true, force: true });
            removed += 1;
        }
    }
    return { removed };
}

export async function verifyRunPackageArchive(input, options = {}) {
    const limits = resolveRunPackageLimits(options.limits ?? {});
    const deadline = options.deadline ?? (Date.now() + limits.verificationTimeoutMs);
    const faults = options.faults ?? {};
    let ownedRoot = null;
    let staging = null;
    let reader = null;
    let succeeded = false;
    const archiveHasher = createHash("sha256");
    const seenExact = new Set();
    const seenFold = new Set();
    const seenNfc = new Set();
    const staged = [];
    let temporaryBytes = 0;
    let inodes = 0;

    const rememberName = (name) => {
        const fold = name.toLowerCase();
        const nfc = name.normalize("NFC");
        if (seenExact.has(name)) hostile("Archive contains duplicate entry names.");
        if (seenFold.has(fold) || seenNfc.has(nfc)) hostile("Archive contains case or Unicode name collisions.");
        seenExact.add(name);
        seenFold.add(fold);
        seenNfc.add(nfc);
    };

    const reserveStage = (size) => {
        inodes += 1;
        if (inodes > limits.inodes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package exceeds the staging inode ceiling.");
        }
        temporaryBytes += size;
        if (temporaryBytes > limits.temporaryBytes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package exceeds the temporary-byte ceiling.");
        }
    };

    const stage = async (archiveName, bytes, maxBytes) => {
        reserveStage(bytes.length);
        const stagingName = `e${String(staged.length).padStart(6, "0")}`;
        const destPath = path.join(staging.dir, stagingName);
        if (bytes.length > maxBytes) throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package entry exceeds its ceiling.");
        await stageFile([bytes], destPath, bytes.length, deadline, faults);
        staged.push({
            archiveName,
            stagingName,
            path: destPath,
            size: bytes.length,
            sha256: sha256ExactBytes(bytes),
        });
        return staged[staged.length - 1];
    };

    const stageStream = async (archiveName, header, maxBytes) => {
        reserveStage(header.size);
        const stagingName = `e${String(staged.length).padStart(6, "0")}`;
        const destPath = path.join(staging.dir, stagingName);
        if (header.size > maxBytes) throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package entry exceeds its ceiling.");
        const result = await stageFile(reader.readChunks(header.size, archiveHasher), destPath, header.size, deadline, faults);
        const paddingSize = padToBlock(header.size);
        if (paddingSize) {
            const padding = await reader.readExact(paddingSize, archiveHasher);
            if (!padding.every((byte) => byte === 0)) hostile("Archive content padding must be zero.");
        }
        const record = {
            archiveName,
            stagingName,
            path: destPath,
            size: result.received,
            sha256: result.digest,
        };
        staged.push(record);
        return record;
    };

    try {
        checkDeadline(deadline);
        if (options.stagingDir) staging = { dir: options.stagingDir, cleanup: options.cleanupStaging === true };
        else {
            const root = options.stagingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "cev-run-package-"));
            if (!options.stagingRoot) ownedRoot = root;
            staging = { ...await createPackageStagingDir(root), cleanup: true };
        }
        reader = new ArchiveReader(input, limits, deadline);
        const prefix = await reader.peek(2);
        if (prefix.length < 2) throw runPackageError(RUN_PACKAGE_ERROR_CODES.HOSTILE, "Archive is truncated.");
        if (detectCompression(prefix)) hostile("Compressed archives are forbidden; cev-sim.run-package@1 is uncompressed USTAR.");

        const nextHeader = async () => {
            if (Date.now() > deadline) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.TIMEOUT, "Package verification exceeded its time budget.");
            }
            const headerBytes = await reader.readExact(USTAR_BLOCK_SIZE, archiveHasher);
            return parseHeader(headerBytes);
        };

        const firstHeader = await nextHeader();
        if (firstHeader.zero) hostile("Package archives must start with manifest.json.");
        rememberName(firstHeader.name);
        if (firstHeader.name !== MANIFEST_ENTRY_NAME) hostile("The first archive entry must be manifest.json.");
        if (firstHeader.size > limits.manifestBytes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package manifest exceeds the 4 MiB ceiling.");
        }
        const manifestBytes = await extractEntry(reader, firstHeader, archiveHasher, deadline);
        const stagedManifest = await stage(MANIFEST_ENTRY_NAME, manifestBytes, limits.manifestBytes);
        let parsedManifest;
        let manifestText;
        try {
            manifestText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes);
            parsedManifest = parseExactJson(manifestText);
        } catch (error) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Package manifest JSON is invalid: ${error.message}`);
        }
        const manifest = normalizeRunPackageManifest(parsedManifest);
        if (canonicalExactStringify(manifest) !== manifestText) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package manifest must be exact JCS without a trailing newline.");
        }
        if (manifest.assets.length > limits.assetEntries) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package exceeds the asset-entry ceiling.");
        }
        if (manifest.bundle.sizeBytes > limits.bundleBytes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package bundle exceeds the 32 MiB ceiling.");
        }

        const bundleHeader = await nextHeader();
        if (bundleHeader.zero) hostile("Package archives must contain bundle.json.");
        rememberName(bundleHeader.name);
        if (bundleHeader.name !== BUNDLE_ENTRY_NAME) hostile("The second archive entry must be bundle.json.");
        if (bundleHeader.size !== manifest.bundle.sizeBytes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Archived bundle.json size does not match the package manifest.");
        }
        const bundleBytes = await extractEntry(reader, bundleHeader, archiveHasher, deadline);
        const stagedBundle = await stage(BUNDLE_ENTRY_NAME, bundleBytes, limits.bundleBytes);
        if (stagedBundle.sha256 !== manifest.bundle.sha256) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Archived bundle.json digest does not match the package manifest.");
        }
        let verifiedBundle;
        try {
            verifiedBundle = verifyRunBundleBytes(bundleBytes, { execution: false });
        } catch (error) {
            throw runPackageError(
                error.code === "BUNDLE_HASH_MISMATCH" ? RUN_PACKAGE_ERROR_CODES.INVALID : RUN_PACKAGE_ERROR_CODES.INVALID,
                error.message,
            );
        }
        const expectedAssets = collectRunPackageAssets(verifiedBundle.bundle);
        assertAssetListMatch(expectedAssets, manifest.assets, "Package manifest");

        const assetFiles = [];
        for (const asset of manifest.assets) {
            if (asset.sizeBytes > limits.assetBytes) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, `Asset ${asset.sha256} exceeds the 1 GiB ceiling.`);
            }
            const header = await nextHeader();
            if (header.zero) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, `Package is missing asset ${asset.sha256}.`);
            }
            rememberName(header.name);
            if (header.name !== expectedAssetName(asset.sha256)) {
                hostile(`Asset entries must be ${ASSET_ENTRY_PREFIX}<digest> in UTF-8 digest order.`);
            }
            if (header.size !== asset.sizeBytes) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Archived size for ${asset.sha256} does not match the manifest.`);
            }
            const stagedAsset = await stageStream(header.name, header, limits.assetBytes);
            if (stagedAsset.sha256 !== asset.sha256) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Archived bytes for ${asset.sha256} do not match the digest name.`);
            }
            assetFiles.push({ ...asset, path: stagedAsset.path });
        }

        const firstZero = await nextHeader();
        if (!firstZero.zero) hostile("Package archives must not contain extra entries after the closed asset set.");
        const secondZero = await nextHeader();
        if (!secondZero.zero) hostile("Package archives must end with exactly two terminal zero blocks.");
        const trailing = await reader.peek(1);
        if (trailing.length) hostile("Package archives must not contain trailing data after the terminal zero blocks.");

        const retainsPaths = options.retainStaging === true || !staging.cleanup;
        succeeded = true;
        return {
            manifest,
            manifestBytes,
            packageManifestHash: sha256ExactBytes(manifestBytes),
            archiveHash: archiveHasher.digest("hex"),
            bundle: verifiedBundle.bundle,
            bundleBytes,
            bundleBytesHash: verifiedBundle.bundleBytesHash,
            resolvedHash: verifiedBundle.resolvedHash,
            simulationSemanticHash: verifiedBundle.simulationSemanticHash,
            identityVersion: verifiedBundle.identityVersion,
            assets: retainsPaths ? assetFiles : assetFiles.map(({ path: _path, ...asset }) => asset),
            staged: retainsPaths ? staged : [],
            stagingDir: retainsPaths ? staging.dir : null,
            cleanup: async () => {
                if (staging.cleanup) await fs.rm(ownedRoot ?? staging.dir, { recursive: true, force: true });
            },
            canonicalBundle: canonicalRunBundleStringify(verifiedBundle.bundle),
            receivedBundleCanonical: verifiedBundle.identityVersion === 2
                ? canonicalExactStringify(verifiedBundle.bundle)
                : null,
        };
    } catch (error) {
        throw mapRunPackageError(error);
    } finally {
        await reader?.close();
        if (staging?.cleanup && (!succeeded || options.retainStaging !== true)) {
            await fs.rm(staging.dir, { recursive: true, force: true }).catch(() => {});
        }
        if (ownedRoot && (!succeeded || options.retainStaging !== true)) {
            await fs.rm(ownedRoot, { recursive: true, force: true }).catch(() => {});
        }
    }
}

export function packageSourceIds(bundle) {
    const uses = bundle?.resolved?.evidence?.visualAssets?.uses ?? [];
    const sourceIds = new Set();
    for (const entry of uses) {
        for (const sourceId of entry.use?.sourceIds ?? []) sourceIds.add(sourceId);
    }
    return [...sourceIds].sort(compareUtf8);
}

export function sortUsesForPublish(uses) {
    const records = uses.map((entry) => ({
        useHash: entry.useHash,
        use: entry.use,
    }));
    const byHash = new Map(records.map((entry) => [entry.useHash, entry]));
    const ordered = [];
    const visiting = new Set();
    const done = new Set();
    const visit = (useHash) => {
        if (done.has(useHash)) return;
        if (visiting.has(useHash)) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Package source-use graph contains a cycle.");
        }
        const record = byHash.get(useHash);
        if (!record) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, `Missing source-use ${useHash} in package evidence.`);
        }
        visiting.add(useHash);
        for (const child of Object.values(record.use.dependencies ?? {})) visit(child);
        visiting.delete(useHash);
        done.add(useHash);
        ordered.push(record);
    };
    for (const record of records) visit(record.useHash);
    return ordered;
}

export function evaluatePackageRights({ bundle, operations, registry, atTime }) {
    const sourceIds = packageSourceIds(bundle);
    return evaluateVisualSourcePolicy({
        sourceIds,
        operations,
        registry,
        atTime,
    });
}

export const RUN_PACKAGE_IMPORT_OPERATIONS = VISUAL_ASSET_UPLOAD_OPERATIONS;
export const RUN_PACKAGE_EXPORT_OPERATIONS = Object.freeze(["export"]);
