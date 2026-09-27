import { promises as fs } from "node:fs";

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
import {
    ARTIFACT_VERIFICATION_ERROR_CODES,
    ArtifactVerificationError,
    createArtifactStagingArea,
    recoverArtifactStagingAreas,
    resolveContentLimits,
} from "../artifacts/ArtifactVerification.js";
import {
    USTAR_BLOCK_SIZE,
    createDeterministicArchiveStream,
    encodeDeterministicArchive,
    encodeUstarFile as encodeDeterministicUstarFile,
    encodeUstarHeader as encodeDeterministicUstarHeader,
    ustarEof,
    verifyDeterministicArchive,
} from "../artifacts/DeterministicArchive.js";
import { canonicalRunBundleStringify, verifyRunBundleBytes } from "./RunBundle.js";

export { USTAR_BLOCK_SIZE, ustarEof };
export const RUN_PACKAGE_KIND = RUN_PACKAGE_PROFILE.kind;
export const RUN_PACKAGE_VERSION = RUN_PACKAGE_PROFILE.version;
export const MANIFEST_ENTRY_NAME = "manifest.json";
export const BUNDLE_ENTRY_NAME = "bundle.json";
export const ASSET_ENTRY_PREFIX = "assets/sha256/";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_INPUT_CHUNK_BYTES = RUN_PACKAGE_PROFILE.limits.bundleBytes;

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
    return resolveContentLimits(RUN_PACKAGE_RUNTIME_LIMITS, overrides, {
        integerKeys: COUNT_LIMITS,
        minimums: { concurrentVerifications: 1 },
    });
}

export function mapRunPackageError(error) {
    if (Object.values(RUN_PACKAGE_ERROR_CODES).includes(error?.code)
        || Object.values(VISUAL_ASSET_ERROR_CODES).includes(error?.code)
        || error?.name === "AbortError") return error;
    if (error instanceof ArtifactVerificationError) {
        if (Object.values(VISUAL_ASSET_ERROR_CODES).includes(error.cause?.code)) return error.cause;
        const code = {
            [ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE]: RUN_PACKAGE_ERROR_CODES.HOSTILE,
            [ARTIFACT_VERIFICATION_ERROR_CODES.INVALID]: RUN_PACKAGE_ERROR_CODES.INVALID,
            [ARTIFACT_VERIFICATION_ERROR_CODES.HASH_MISMATCH]: RUN_PACKAGE_ERROR_CODES.INVALID,
            [ARTIFACT_VERIFICATION_ERROR_CODES.LIMIT_EXCEEDED]: RUN_PACKAGE_ERROR_CODES.TOO_LARGE,
            [ARTIFACT_VERIFICATION_ERROR_CODES.TIMEOUT]: RUN_PACKAGE_ERROR_CODES.TIMEOUT,
            [ARTIFACT_VERIFICATION_ERROR_CODES.CANCELLED]: RUN_PACKAGE_ERROR_CODES.IO,
            [ARTIFACT_VERIFICATION_ERROR_CODES.IO]: RUN_PACKAGE_ERROR_CODES.IO,
        }[error.code] ?? RUN_PACKAGE_ERROR_CODES.IO;
        return runPackageError(code, error.message);
    }
    return runPackageError(RUN_PACKAGE_ERROR_CODES.IO, `Run package I/O failed: ${error.message}`);
}

export function encodeUstarHeader(options) {
    try {
        return encodeDeterministicUstarHeader(options);
    } catch (error) {
        throw mapRunPackageError(error);
    }
}

export function encodeUstarFile(name, content, headerOverrides) {
    try {
        return encodeDeterministicUstarFile(name, content, headerOverrides);
    } catch (error) {
        throw mapRunPackageError(error);
    }
}

function asBytes(value, path = "bytes") {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `${path} must be exact bytes.`);
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
    try {
        const bundle = asBytes(bundleBytes, "bundle.json");
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
        const encoded = encodeDeterministicArchive([
            { name: MANIFEST_ENTRY_NAME, bytes: manifestBytes },
            { name: BUNDLE_ENTRY_NAME, bytes: bundle },
            ...sortAssetRecords(prepared).map((asset) => ({
                name: `${ASSET_ENTRY_PREFIX}${asset.sha256}`,
                bytes: asset.bytes,
                sizeBytes: asset.sizeBytes,
                sha256: asset.sha256,
            })),
        ], {
            maxBufferedBytes: bufferedLimit,
            limits: {
                archiveBytes: RUN_PACKAGE_PROFILE.limits.archiveBytes,
                entryBytes: RUN_PACKAGE_PROFILE.limits.assetBytes,
                entries: 2 + RUN_PACKAGE_PROFILE.limits.assetEntries,
                temporaryBytes: RUN_PACKAGE_PROFILE.limits.archiveBytes,
                inodes: 2 + RUN_PACKAGE_PROFILE.limits.assetEntries,
                maxChunkBytes: MAX_ARCHIVE_INPUT_CHUNK_BYTES,
                verificationTimeoutMs: RUN_PACKAGE_RUNTIME_LIMITS.verificationTimeoutMs,
            },
        });
        return {
            bytes: encoded.bytes,
            manifest,
            manifestBytes,
            packageManifestHash: sha256ExactBytes(manifestBytes),
            archiveHash: encoded.sha256,
            bundleBytesHash: manifest.bundle.sha256,
        };
    } catch (error) {
        throw mapRunPackageError(error);
    }
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
    try {
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
        })).map((record) => ({ ...record, source: sources.get(record.sha256) }));
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
        const archive = createDeterministicArchiveStream([
            { name: MANIFEST_ENTRY_NAME, bytes: manifestBytes },
            { name: BUNDLE_ENTRY_NAME, bytes: bundle },
            ...prepared.map((asset) => ({
                name: expectedAssetName(asset.sha256),
                sizeBytes: asset.sizeBytes,
                sha256: asset.sha256,
                ...(asset.source.open ? { open: asset.source.open }
                    : asset.source.stream ? { stream: asset.source.stream }
                    : asset.source.path ? { path: asset.source.path }
                    : { bytes: asBytes(asset.source.bytes, asset.sha256) }),
            })),
        ], {
            deadline,
            limits: {
                archiveBytes: limits.archiveBytes,
                entryBytes: limits.assetBytes,
                entries: 2 + limits.assetEntries,
                temporaryBytes: limits.temporaryBytes,
                inodes: limits.inodes,
                maxChunkBytes: MAX_ARCHIVE_INPUT_CHUNK_BYTES,
                verificationTimeoutMs: limits.verificationTimeoutMs,
            },
        });
        const completion = archive.completion.then((result) => ({
            manifest,
            manifestBytes,
            packageManifestHash: sha256ExactBytes(manifestBytes),
            archiveHash: result.sha256,
            bundleBytesHash: manifest.bundle.sha256,
            archiveBytes: result.sizeBytes,
        })).catch((error) => { throw mapRunPackageError(error); });
        completion.catch(() => {});
        const stream = archive.stream;
        const destroyArchiveStream = stream.destroy.bind(stream);
        stream.destroy = (error) => destroyArchiveStream(error ? mapRunPackageError(error) : error);
        stream.on("error", () => {});
        return {
            stream,
            completion,
            manifest,
            manifestBytes,
            packageManifestHash: sha256ExactBytes(manifestBytes),
            bundleBytesHash: manifest.bundle.sha256,
        };
    } catch (error) {
        throw mapRunPackageError(error);
    }
}

function expectedAssetName(digest) {
    return `${ASSET_ENTRY_PREFIX}${digest}`;
}

export async function createPackageStagingDir(rootDir) {
    try {
        return await createArtifactStagingArea(rootDir);
    } catch (error) {
        throw mapRunPackageError(error);
    }
}

export async function recoverPackageStaging(rootDir, { ttlMs = RUN_PACKAGE_RUNTIME_LIMITS.abandonedStageTtlMs, now = () => new Date(), active = new Set() } = {}) {
    try {
        return await recoverArtifactStagingAreas(rootDir, { ttlMs, now, active });
    } catch (error) {
        throw mapRunPackageError(error);
    }
}

export async function verifyRunPackageArchive(input, options = {}) {
    const limits = resolveRunPackageLimits(options.limits ?? {});
    const deadline = options.deadline ?? (Date.now() + limits.verificationTimeoutMs);
    let archive = null;
    let keepStaging = false;
    try {
        archive = await verifyDeterministicArchive(input, {
            deadline,
            signal: options.signal,
            stagingRoot: options.stagingRoot,
            stagingDir: options.stagingDir,
            cleanupStaging: options.cleanupStaging,
            retainStaging: true,
            faults: options.faults,
            limits: {
                archiveBytes: limits.archiveBytes,
                entryBytes: Math.max(limits.manifestBytes, limits.bundleBytes, limits.assetBytes),
                entries: 2 + limits.assetEntries,
                temporaryBytes: limits.temporaryBytes,
                inodes: limits.inodes,
                maxChunkBytes: MAX_ARCHIVE_INPUT_CHUNK_BYTES,
                verificationTimeoutMs: limits.verificationTimeoutMs,
            },
            entryLimit: ({ index }) => index === 0
                ? limits.manifestBytes
                : index === 1 ? limits.bundleBytes : limits.assetBytes,
        });
        const [manifestEntry, bundleEntry, ...assetEntries] = archive.entries;
        if (!manifestEntry || manifestEntry.name !== MANIFEST_ENTRY_NAME) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.HOSTILE, "The first archive entry must be manifest.json.");
        }
        if (!bundleEntry || bundleEntry.name !== BUNDLE_ENTRY_NAME) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.HOSTILE, "The second archive entry must be bundle.json.");
        }
        const manifestBytes = await fs.readFile(manifestEntry.path);
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
        if (bundleEntry.sizeBytes !== manifest.bundle.sizeBytes) {
            throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, "Archived bundle.json size does not match the package manifest.");
        }
        const bundleBytes = await fs.readFile(bundleEntry.path);
        if (bundleEntry.sha256 !== manifest.bundle.sha256) {
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
        if (assetEntries.length !== manifest.assets.length) {
            throw runPackageError(
                RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH,
                assetEntries.length < manifest.assets.length
                    ? "Package is missing one or more required assets."
                    : "Package contains extra entries after the closed asset set.",
            );
        }
        const assetFiles = [];
        for (const [index, asset] of manifest.assets.entries()) {
            if (asset.sizeBytes > limits.assetBytes) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, `Asset ${asset.sha256} exceeds the 1 GiB ceiling.`);
            }
            const entry = assetEntries[index];
            if (entry.name !== expectedAssetName(asset.sha256)) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.HOSTILE, `Asset entries must be ${ASSET_ENTRY_PREFIX}<digest> in UTF-8 digest order.`);
            }
            if (entry.sizeBytes !== asset.sizeBytes) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Archived size for ${asset.sha256} does not match the manifest.`);
            }
            if (entry.sha256 !== asset.sha256) {
                throw runPackageError(RUN_PACKAGE_ERROR_CODES.INVALID, `Archived bytes for ${asset.sha256} do not match the digest name.`);
            }
            assetFiles.push({ ...asset, path: entry.path });
        }
        keepStaging = options.retainStaging === true || (options.stagingDir && options.cleanupStaging !== true);
        const staged = archive.entries.map((entry) => ({
            archiveName: entry.name,
            stagingName: entry.stagingName,
            path: entry.path,
            size: entry.sizeBytes,
            sha256: entry.sha256,
        }));
        return {
            manifest,
            manifestBytes,
            packageManifestHash: sha256ExactBytes(manifestBytes),
            archiveHash: archive.sha256,
            bundle: verifiedBundle.bundle,
            bundleBytes,
            bundleBytesHash: verifiedBundle.bundleBytesHash,
            resolvedHash: verifiedBundle.resolvedHash,
            simulationSemanticHash: verifiedBundle.simulationSemanticHash,
            identityVersion: verifiedBundle.identityVersion,
            assets: keepStaging ? assetFiles : assetFiles.map(({ path: _path, ...asset }) => asset),
            staged: keepStaging ? staged : [],
            stagingDir: keepStaging ? archive.stagingDir : null,
            cleanup: archive.cleanup,
            canonicalBundle: canonicalRunBundleStringify(verifiedBundle.bundle),
            receivedBundleCanonical: verifiedBundle.identityVersion === 2
                ? canonicalExactStringify(verifiedBundle.bundle)
                : null,
        };
    } catch (error) {
        throw mapRunPackageError(error);
    } finally {
        if (archive && !keepStaging) await archive.cleanup().catch(() => {});
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
