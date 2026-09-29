import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { compareUtf8 } from "../../app/math/compareUtf8.js";
import {
    normalizeEditorAssetRevision,
    validateEditorAssetRevision,
} from "../../app/editor-assets/EditorAssetContract.js";
import { collectAssetRevisionReferences } from "../../app/editor-assets/AssetDefinition.js";
import {
    hashVisualAssetUse,
    normalizeVisualAssetUse,
} from "../../app/simulation/visual/VisualLayer.js";
import {
    createDeterministicArchiveStream,
    verifyDeterministicArchive,
} from "../artifacts/DeterministicArchive.js";
import { ASSET_PACKAGE_LIMITS } from "./MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";
import {
    canonicalMarketplaceBytes,
    hashMarketplaceBytes,
    parseMarketplaceJsonBytes,
} from "./MarketplaceJson.js";
import {
    createPackagePreparationIndex,
    packagePreparationHash,
    readPackagePreparation,
} from "./PackagePreparation.js";

export const ASSET_PACKAGE_KIND = "cev-sim.asset-package";
export const ASSET_PACKAGE_VERSION = 1;
export const ASSET_PACKAGE_MANIFEST = "manifest.json";
export const ASSET_PACKAGE_RECORD_PREFIX = "records/sha256/";
export const ASSET_PACKAGE_BLOB_PREFIX = "blobs/sha256/";
export const ASSET_PACKAGE_EXPORT_OPERATIONS = Object.freeze(["export"]);

const SHA256 = /^[a-f0-9]{64}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function invalid(message, pathName = null) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message, { path: pathName });
}

function limit(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, message);
}

function exactKeys(value, keys, pathName) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${pathName} must be an object.`, pathName);
    const expected = new Set(keys);
    for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${pathName}.${key} is required.`, `${pathName}.${key}`);
    for (const key of Object.keys(value)) if (!expected.has(key)) invalid(`${pathName}.${key} is not allowed.`, `${pathName}.${key}`);
}

function portableId(value, pathName) {
    if (typeof value !== "string" || !PORTABLE_ID.test(value)) invalid(`${pathName} must be a portable id.`, pathName);
    return value;
}

function digest(value, pathName) {
    if (typeof value !== "string" || !SHA256.test(value)) invalid(`${pathName} must be a lowercase SHA-256 digest.`, pathName);
    return value;
}

function positive(value, pathName) {
    if (!Number.isSafeInteger(value) || value < 1) invalid(`${pathName} must be a positive safe integer.`, pathName);
    return value;
}

function nonNegative(value, pathName) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(`${pathName} must be a non-negative safe integer.`, pathName);
    return value;
}

function denseArray(value, pathName) {
    if (!Array.isArray(value) || Object.keys(value).length !== value.length) invalid(`${pathName} must be a dense array.`, pathName);
    return value;
}

function sortedUnique(values, key, pathName) {
    let previous = null;
    const seen = new Set();
    values.forEach((value, index) => {
        const current = key(value);
        if (seen.has(current)) invalid(`${pathName}.${index} is a duplicate.`, `${pathName}.${index}`);
        if (previous !== null && compareUtf8(previous, current) >= 0) invalid(`${pathName} must be in canonical UTF-8 order.`, pathName);
        seen.add(current);
        previous = current;
    });
}

export function normalizeAssetClosureManifest(value) {
    exactKeys(value, ["kind", "version", "roots", "assets", "uses", "blobs"], "$manifest");
    if (value.kind !== ASSET_PACKAGE_KIND || value.version !== ASSET_PACKAGE_VERSION) {
        invalid(`Expected ${ASSET_PACKAGE_KIND}@${ASSET_PACKAGE_VERSION}.`, "$manifest.kind");
    }
    const roots = denseArray(value.roots, "$manifest.roots").map((entry, index) => {
        exactKeys(entry, ["assetId", "revision"], `$manifest.roots.${index}`);
        return { assetId: portableId(entry.assetId, `$manifest.roots.${index}.assetId`), revision: positive(entry.revision, `$manifest.roots.${index}.revision`) };
    });
    sortedUnique(roots, (entry) => `${entry.assetId}\u0000${String(entry.revision).padStart(16, "0")}`, "$manifest.roots");
    const assets = denseArray(value.assets, "$manifest.assets").map((entry, index) => {
        const entryPath = `$manifest.assets.${index}`;
        exactKeys(entry, ["assetId", "name", "tags", "revisions"], entryPath);
        const assetId = portableId(entry.assetId, `${entryPath}.assetId`);
        if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 1024) invalid(`${entryPath}.name must be bounded text.`, `${entryPath}.name`);
        const tags = denseArray(entry.tags, `${entryPath}.tags`).map((tag, tagIndex) => {
            if (typeof tag !== "string" || !tag.trim() || tag.length > 255) invalid(`${entryPath}.tags.${tagIndex} must be bounded text.`, `${entryPath}.tags.${tagIndex}`);
            return tag;
        });
        sortedUnique(tags, (tag) => tag, `${entryPath}.tags`);
        const revisions = denseArray(entry.revisions, `${entryPath}.revisions`).map((revision, revisionIndex) => {
            const revisionPath = `${entryPath}.revisions.${revisionIndex}`;
            exactKeys(revision, ["revision", "recordSha256", "sizeBytes"], revisionPath);
            return {
                revision: positive(revision.revision, `${revisionPath}.revision`),
                recordSha256: digest(revision.recordSha256, `${revisionPath}.recordSha256`),
                sizeBytes: nonNegative(revision.sizeBytes, `${revisionPath}.sizeBytes`),
            };
        });
        if (revisions.length === 0) invalid(`${entryPath}.revisions must not be empty.`, `${entryPath}.revisions`);
        sortedUnique(revisions, (revision) => String(revision.revision).padStart(16, "0"), `${entryPath}.revisions`);
        return { assetId, name: entry.name.trim(), tags, revisions };
    });
    sortedUnique(assets, (entry) => entry.assetId, "$manifest.assets");
    const uses = denseArray(value.uses, "$manifest.uses").map((entry, index) => {
        const entryPath = `$manifest.uses.${index}`;
        exactKeys(entry, ["useHash", "recordSha256", "sizeBytes"], entryPath);
        return {
            useHash: digest(entry.useHash, `${entryPath}.useHash`),
            recordSha256: digest(entry.recordSha256, `${entryPath}.recordSha256`),
            sizeBytes: nonNegative(entry.sizeBytes, `${entryPath}.sizeBytes`),
        };
    });
    sortedUnique(uses, (entry) => entry.useHash, "$manifest.uses");
    const blobs = denseArray(value.blobs, "$manifest.blobs").map((entry, index) => {
        const entryPath = `$manifest.blobs.${index}`;
        exactKeys(entry, ["sha256", "sizeBytes"], entryPath);
        return { sha256: digest(entry.sha256, `${entryPath}.sha256`), sizeBytes: nonNegative(entry.sizeBytes, `${entryPath}.sizeBytes`) };
    });
    sortedUnique(blobs, (entry) => entry.sha256, "$manifest.blobs");
    return { kind: ASSET_PACKAGE_KIND, version: ASSET_PACKAGE_VERSION, roots, assets, uses, blobs };
}

export const normalizeAssetPackageManifest = normalizeAssetClosureManifest;

export function revisionUseRoots(revision) {
    const hashes = new Set([revision.modelUseHash]);
    if (revision.version === 2) {
        revision.definition.sources.forEach((source) => hashes.add(source.modelUseHash));
        revision.definition.materials.forEach((material) => material.textures.forEach((texture) => hashes.add(texture.useHash)));
        revision.appearance.forEach((material) => material.textures.forEach((texture) => hashes.add(texture.useHash)));
    }
    return [...hashes].sort(compareUtf8);
}

function revisionKey(assetId, revision) {
    return `${assetId}@${revision}`;
}

export function topologicalOrder(nodes, edges, label) {
    const outgoing = new Map(nodes.map((node) => [node, new Set()]));
    const incoming = new Map(nodes.map((node) => [node, 0]));
    for (const [from, to] of edges) {
        if (!outgoing.has(from) || !outgoing.has(to)) invalid(`${label} references a missing node.`);
        if (outgoing.get(from).has(to)) continue;
        outgoing.get(from).add(to);
        incoming.set(to, incoming.get(to) + 1);
    }
    const ready = nodes.filter((node) => incoming.get(node) === 0).sort(compareUtf8);
    const ordered = [];
    while (ready.length) {
        const node = ready.shift();
        ordered.push(node);
        for (const target of [...outgoing.get(node)].sort(compareUtf8)) {
            incoming.set(target, incoming.get(target) - 1);
            if (incoming.get(target) === 0) {
                ready.push(target);
                ready.sort(compareUtf8);
            }
        }
    }
    if (ordered.length !== nodes.length) invalid(`${label} contains a dependency cycle.`);
    return ordered;
}

export function assertGraphDepth(nodes, edges, order, maximum, label) {
    const outgoing = new Map(nodes.map((node) => [node, []]));
    for (const [from, to] of edges) outgoing.get(from).push(to);
    const depths = new Map(nodes.map((node) => [node, 1]));
    for (const node of order) {
        const depth = depths.get(node);
        if (depth > maximum) limit(`${label} exceeds the depth limit.`);
        for (const target of outgoing.get(node)) depths.set(target, Math.max(depths.get(target), depth + 1));
    }
    if ([...depths.values()].some((depth) => depth > maximum)) limit(`${label} exceeds the depth limit.`);
}

export function parseCanonicalRecord(bytes, expectedSha256, expectedSize, label) {
    if (bytes.byteLength !== expectedSize || hashMarketplaceBytes(bytes) !== expectedSha256) invalid(`${label} bytes do not match the manifest.`);
    const { document } = parseMarketplaceJsonBytes(bytes);
    if (!Buffer.from(bytes).equals(Buffer.from(canonicalMarketplaceBytes(document)))) invalid(`${label} must contain exact canonical JSON.`);
    return document;
}

export function assetPackageLimits(overrides = {}) {
    const merged = { ...ASSET_PACKAGE_LIMITS, ...overrides };
    for (const key of ["archiveBytes", "blobBytes", "recordBytes", "manifestBytes", "payloadEntries", "entries", "graphDepth", "temporaryBytes", "inodes", "verificationTimeoutMs"]) {
        if (!Number.isSafeInteger(merged[key]) || merged[key] < 1 || merged[key] > ASSET_PACKAGE_LIMITS[key]) {
            throw new TypeError(`Asset-package limit ${key} must be a positive integer no larger than the frozen profile.`);
        }
    }
    return Object.freeze(merged);
}

export function verifyAssetClosure({
    manifest: manifestInput,
    recordBytes,
    blobs: blobEntries,
    limits: limitInput = ASSET_PACKAGE_LIMITS,
    requireRoots = false,
} = {}) {
    const limits = limitInput;
    const manifest = normalizeAssetClosureManifest(manifestInput);
    if (requireRoots && manifest.roots.length === 0) invalid("Asset package must declare at least one root revision.");
    if (!(recordBytes instanceof Map) || !(blobEntries instanceof Map)) invalid("Asset closure records and blobs must be maps.");
    const revisionDescriptors = manifest.assets.flatMap((asset) => asset.revisions.map((revision) => ({ ...revision, assetId: asset.assetId })));
    const recordDigests = [...new Set([
        ...revisionDescriptors.map((entry) => entry.recordSha256),
        ...manifest.uses.map((entry) => entry.recordSha256),
    ])].sort(compareUtf8);
    if (recordDigests.length !== recordBytes.size || recordDigests.some((sha256) => !recordBytes.has(sha256))) {
        invalid("Asset closure records are missing or contain unreachable entries.");
    }

    const revisions = new Map();
    for (const descriptor of revisionDescriptors) {
        if (descriptor.sizeBytes > limits.recordBytes) limit(`Asset revision record ${descriptor.recordSha256} exceeds the record limit.`);
        const bytes = recordBytes.get(descriptor.recordSha256);
        const document = parseCanonicalRecord(bytes, descriptor.recordSha256, descriptor.sizeBytes, "Asset revision record");
        const issues = validateEditorAssetRevision(document);
        if (issues.length) invalid(`Asset revision record is invalid: ${issues[0].message}`);
        const revision = normalizeEditorAssetRevision(document);
        if (revision.assetId !== descriptor.assetId || revision.revision !== descriptor.revision) invalid("Asset revision record identity does not match the manifest.");
        if (!Buffer.from(bytes).equals(Buffer.from(canonicalMarketplaceBytes(revision)))) invalid("Asset revision record is not normalized canonical JSON.");
        revisions.set(revisionKey(revision.assetId, revision.revision), { descriptor, revision });
    }

    const uses = new Map();
    for (const descriptor of manifest.uses) {
        if (descriptor.sizeBytes > limits.recordBytes) limit(`Visual-use record ${descriptor.recordSha256} exceeds the record limit.`);
        const bytes = recordBytes.get(descriptor.recordSha256);
        const document = parseCanonicalRecord(bytes, descriptor.recordSha256, descriptor.sizeBytes, "Visual-use record");
        const use = normalizeVisualAssetUse(document);
        if (hashVisualAssetUse(use) !== descriptor.useHash) invalid(`Visual-use record ${descriptor.useHash} has the wrong use hash.`);
        if (!Buffer.from(bytes).equals(Buffer.from(canonicalMarketplaceBytes(use)))) invalid("Visual-use record is not normalized canonical JSON.");
        uses.set(descriptor.useHash, { descriptor, use });
    }

    const blobByDigest = new Map(manifest.blobs.map((blob) => [blob.sha256, blob]));
    if (blobByDigest.size !== blobEntries.size || [...blobByDigest].some(([sha256, blob]) => {
        const entry = blobEntries.get(sha256);
        return !entry || entry.sha256 !== sha256 || entry.sizeBytes !== blob.sizeBytes;
    })) invalid("Asset closure blobs are missing, inconsistent, or contain unreachable entries.");
    for (const blob of manifest.blobs) if (blob.sizeBytes > limits.blobBytes) limit(`Asset-package blob ${blob.sha256} exceeds the blob limit.`);

    const assetNodes = [...revisions.keys()].sort(compareUtf8);
    const assetEdges = [];
    for (const [key, { revision }] of revisions) {
        if (revision.version !== 2) continue;
        for (const child of collectAssetRevisionReferences(revision.definition)) {
            const childKey = revisionKey(child.assetId, child.revision);
            if (!revisions.has(childKey)) invalid(`Asset revision ${key} has missing child ${childKey}.`);
            assetEdges.push([childKey, key]);
        }
    }
    for (const asset of manifest.assets) {
        for (let index = 1; index < asset.revisions.length; index += 1) {
            assetEdges.push([
                revisionKey(asset.assetId, asset.revisions[index - 1].revision),
                revisionKey(asset.assetId, asset.revisions[index].revision),
            ]);
        }
    }
    const assetOrder = topologicalOrder(assetNodes, assetEdges, "Asset revision graph");
    assertGraphDepth(assetNodes, assetEdges, assetOrder, limits.graphDepth, "Asset revision graph");

    const requiredUses = new Set();
    const useEdges = [];
    const visitUse = (useHash, depth = 1) => {
        if (depth > limits.graphDepth) limit("Asset-package visual-use graph exceeds the depth limit.");
        const entry = uses.get(useHash);
        if (!entry) invalid(`Asset package is missing visual-use ${useHash}.`);
        if (requiredUses.has(useHash)) return;
        requiredUses.add(useHash);
        for (const dependency of Object.values(entry.use.dependencies).sort(compareUtf8)) {
            useEdges.push([dependency, useHash]);
            visitUse(dependency, depth + 1);
        }
    };
    for (const { revision } of revisions.values()) revisionUseRoots(revision).forEach((useHash) => visitUse(useHash));
    if (requiredUses.size !== uses.size || [...uses.keys()].some((useHash) => !requiredUses.has(useHash))) invalid("Asset package contains unreachable visual-use records.");
    const requiredBlobs = new Map();
    for (const { use } of uses.values()) {
        const current = requiredBlobs.get(use.asset.sha256);
        if (current !== undefined && current !== use.asset.sizeBytes) invalid(`Blob ${use.asset.sha256} has conflicting sizes.`);
        requiredBlobs.set(use.asset.sha256, use.asset.sizeBytes);
    }
    if (requiredBlobs.size !== blobByDigest.size || [...requiredBlobs].some(([sha256, sizeBytes]) => blobByDigest.get(sha256)?.sizeBytes !== sizeBytes)) {
        invalid("Asset package blob closure is missing, inconsistent, or contains unreachable blobs.");
    }
    const useOrder = topologicalOrder([...uses.keys()].sort(compareUtf8), useEdges, "Visual-use graph");
    assertGraphDepth([...uses.keys()], useEdges, useOrder, limits.graphDepth, "Visual-use graph");
    for (const root of manifest.roots) if (!revisions.has(revisionKey(root.assetId, root.revision))) invalid(`Asset package root ${revisionKey(root.assetId, root.revision)} is missing.`);
    return Object.freeze({
        manifest,
        revisions,
        uses,
        assetOrder: Object.freeze(assetOrder),
        useOrder: Object.freeze(useOrder),
        assetEdges: Object.freeze(assetEdges.map((edge) => Object.freeze([...edge]))),
        useEdges: Object.freeze(useEdges.map((edge) => Object.freeze([...edge]))),
    });
}

async function verifyStagedAssetPackage(verified, limits) {
    if (verified.entries.length === 0 || verified.entries[0].name !== ASSET_PACKAGE_MANIFEST) invalid("Asset package manifest must be the first archive entry.");
    if (verified.entries.length - 1 > limits.payloadEntries) limit("Asset package exceeds the payload-entry limit.");
    const manifestEntry = verified.entries[0];
    const manifestBytes = await fs.readFile(manifestEntry.path);
    const manifestDocument = parseCanonicalRecord(manifestBytes, manifestEntry.sha256, manifestEntry.sizeBytes, "Asset package manifest");
    const manifest = normalizeAssetPackageManifest(manifestDocument);
    if (!Buffer.from(manifestBytes).equals(Buffer.from(canonicalMarketplaceBytes(manifest)))) invalid("Asset package manifest is not normalized canonical JSON.");

    const revisionDescriptors = manifest.assets.flatMap((asset) => asset.revisions.map((revision) => ({ ...revision, assetId: asset.assetId })));
    const recordDigests = [...new Set([
        ...revisionDescriptors.map((entry) => entry.recordSha256),
        ...manifest.uses.map((entry) => entry.recordSha256),
    ])].sort(compareUtf8);
    const expectedNames = [
        ASSET_PACKAGE_MANIFEST,
        ...recordDigests.map((entry) => `${ASSET_PACKAGE_RECORD_PREFIX}${entry}`),
        ...manifest.blobs.map((entry) => `${ASSET_PACKAGE_BLOB_PREFIX}${entry.sha256}`),
    ];
    if (verified.entries.length !== expectedNames.length || verified.entries.some((entry, index) => entry.name !== expectedNames[index])) {
        invalid("Asset package archive entries do not exactly match the manifest or canonical ordering.");
    }
    const entriesByName = new Map(verified.entries.map((entry) => [entry.name, entry]));
    const recordBytes = new Map();
    for (const recordDigest of recordDigests) {
        const entry = entriesByName.get(`${ASSET_PACKAGE_RECORD_PREFIX}${recordDigest}`);
        if (entry.sha256 !== recordDigest) invalid(`Record ${recordDigest} content digest does not match its path.`);
        recordBytes.set(recordDigest, await fs.readFile(entry.path));
    }

    const blobByDigest = new Map(manifest.blobs.map((blob) => [blob.sha256, blob]));
    for (const blob of manifest.blobs) {
        if (blob.sizeBytes > limits.blobBytes) limit(`Asset-package blob ${blob.sha256} exceeds the blob limit.`);
        const entry = entriesByName.get(`${ASSET_PACKAGE_BLOB_PREFIX}${blob.sha256}`);
        if (entry.sha256 !== blob.sha256 || entry.sizeBytes !== blob.sizeBytes) invalid(`Asset-package blob ${blob.sha256} does not match the manifest.`);
    }

    const closure = verifyAssetClosure({
        manifest,
        recordBytes,
        blobs: new Map(manifest.blobs.map((blob) => {
            const entry = entriesByName.get(`${ASSET_PACKAGE_BLOB_PREFIX}${blob.sha256}`);
            return [blob.sha256, { sha256: entry.sha256, sizeBytes: entry.sizeBytes }];
        })),
        limits,
        requireRoots: true,
    });
    return Object.freeze({
        manifest,
        manifestSha256: manifestEntry.sha256,
        archiveSha256: verified.sha256,
        archiveSizeBytes: verified.sizeBytes,
        stagingDir: verified.stagingDir,
        entries: Object.freeze(verified.entries.map((entry) => Object.freeze({ ...entry }))),
        revisions: closure.revisions,
        uses: closure.uses,
        assetOrder: closure.assetOrder,
        useOrder: closure.useOrder,
        assetEdges: closure.assetEdges,
        useEdges: closure.useEdges,
        cleanup: verified.cleanup,
    });
}

export async function verifyAssetPackage(input, {
    limits: overrides = {}, signal, stagingRoot, stagingDir, retainStaging = true,
} = {}) {
    const limits = assetPackageLimits(overrides);
    const source = typeof input === "string" ? createReadStream(input, { signal }) : input;
    const verified = await verifyDeterministicArchive(source, {
        limits: {
            archiveBytes: limits.archiveBytes,
            entryBytes: limits.blobBytes,
            entries: limits.entries,
            temporaryBytes: limits.temporaryBytes,
            inodes: limits.inodes,
            verificationTimeoutMs: limits.verificationTimeoutMs,
        },
        signal,
        stagingRoot,
        stagingDir,
        retainStaging: true,
        cleanupStaging: stagingDir ? true : undefined,
        entryLimit: ({ index, name }) => index === 0 || name === ASSET_PACKAGE_MANIFEST
            ? limits.manifestBytes
            : name.startsWith(ASSET_PACKAGE_RECORD_PREFIX) ? limits.recordBytes : limits.blobBytes,
    });
    try {
        const result = await verifyStagedAssetPackage(verified, limits);
        if (!retainStaging) await verified.cleanup();
        return result;
    } catch (error) {
        await verified.cleanup().catch(() => {});
        throw error;
    }
}

export async function inspectAssetPackage({ archivePath, stagingRoot, limits, signal, retainStaging = false }) {
    const verified = await verifyAssetPackage(archivePath, { stagingRoot, limits, signal, retainStaging });
    const inspection = Object.freeze({
        kind: verified.manifest.kind,
        version: verified.manifest.version,
        archiveSha256: verified.archiveSha256,
        archiveSizeBytes: verified.archiveSizeBytes,
        manifestSha256: verified.manifestSha256,
        rootCount: verified.manifest.roots.length,
        assetCount: verified.manifest.assets.length,
        revisionCount: verified.revisions.size,
        useCount: verified.uses.size,
        blobCount: verified.manifest.blobs.length,
    });
    if (!retainStaging) await verified.cleanup();
    return inspection;
}

export async function collectAssetClosure({
    editorAssetStore,
    visualAssetStore,
    roots,
    operations = ASSET_PACKAGE_EXPORT_OPERATIONS,
    allowEmpty = false,
} = {}) {
    const normalizedRoots = [...new Map((roots ?? []).map((root) => [
        `${String(root?.assetId)}@${Number(root?.revision)}`,
        { assetId: String(root?.assetId), revision: Number(root?.revision) },
    ])).values()].sort((left, right) => compareUtf8(left.assetId, right.assetId) || left.revision - right.revision);
    if (!allowEmpty && normalizedRoots.length === 0) invalid("Asset package must declare at least one root revision.");
    const snapshot = normalizedRoots.length
        ? await editorAssetStore.snapshotRevisionClosure(normalizedRoots)
        : { roots: [], assets: [], revisions: [] };
    const revisionRecords = snapshot.revisions.map((revision) => {
        const bytes = Buffer.from(canonicalMarketplaceBytes(revision));
        return { revision, bytes, sha256: hashMarketplaceBytes(bytes) };
    });
    const requestedUses = [...new Set(snapshot.revisions.flatMap(revisionUseRoots))].sort(compareUtf8);
    const access = await visualAssetStore.validateAccessSet({
        useHashes: requestedUses,
        operations,
        verifyBytes: true,
        includeUseRecords: true,
    });
    const useRecords = access.closureUses.map(({ useHash, use }) => {
        const bytes = Buffer.from(canonicalMarketplaceBytes(use));
        return { useHash, use, bytes, sha256: hashMarketplaceBytes(bytes) };
    });
    const blobs = [...new Map(useRecords.map(({ use }) => [use.asset.sha256, {
        sha256: use.asset.sha256,
        sizeBytes: use.asset.sizeBytes,
    }])).values()].sort((left, right) => compareUtf8(left.sha256, right.sha256));
    const assets = snapshot.assets.map((asset) => ({
        assetId: asset.id,
        name: asset.name,
        tags: [...asset.tags].sort(compareUtf8),
        revisions: revisionRecords.filter((entry) => entry.revision.assetId === asset.id)
            .sort((left, right) => left.revision.revision - right.revision.revision)
            .map((entry) => ({ revision: entry.revision.revision, recordSha256: entry.sha256, sizeBytes: entry.bytes.length })),
    })).sort((left, right) => compareUtf8(left.assetId, right.assetId));
    const manifest = normalizeAssetPackageManifest({
        kind: ASSET_PACKAGE_KIND,
        version: ASSET_PACKAGE_VERSION,
        roots: snapshot.roots,
        assets,
        uses: useRecords.sort((left, right) => compareUtf8(left.useHash, right.useHash)).map((entry) => ({
            useHash: entry.useHash,
            recordSha256: entry.sha256,
            sizeBytes: entry.bytes.length,
        })),
        blobs,
    });
    return Object.freeze({
        manifest,
        snapshot,
        access,
        revisionRecords: Object.freeze(revisionRecords),
        useRecords: Object.freeze(useRecords),
        blobs: Object.freeze(blobs),
        records: Object.freeze([...new Map([...revisionRecords, ...useRecords].map((entry) => [entry.sha256, entry])).values()]
            .sort((left, right) => compareUtf8(left.sha256, right.sha256))),
    });
}

export async function exportAssetPackage({ editorAssetStore, visualAssetStore, roots, output = null, signal }) {
    const closure = await collectAssetClosure({ editorAssetStore, visualAssetStore, roots });
    const { manifest, records, blobs } = closure;
    const manifestBytes = Buffer.from(canonicalMarketplaceBytes(manifest));
    const entries = [
        { name: ASSET_PACKAGE_MANIFEST, bytes: manifestBytes, sizeBytes: manifestBytes.length },
        ...records.map((entry) => ({ name: `${ASSET_PACKAGE_RECORD_PREFIX}${entry.sha256}`, bytes: entry.bytes, sizeBytes: entry.bytes.length, sha256: entry.sha256 })),
        ...blobs.map((blob) => ({
            name: `${ASSET_PACKAGE_BLOB_PREFIX}${blob.sha256}`,
            sizeBytes: blob.sizeBytes,
            sha256: blob.sha256,
            open: () => visualAssetStore.openPublishedStream(blob.sha256, { expectedSize: blob.sizeBytes }),
        })),
    ];
    if (manifestBytes.length > ASSET_PACKAGE_LIMITS.manifestBytes) limit("Asset-package manifest exceeds the manifest limit.");
    if (records.some((entry) => entry.bytes.length > ASSET_PACKAGE_LIMITS.recordBytes)) limit("Asset-package record exceeds the record limit.");
    if (blobs.some((entry) => entry.sizeBytes > ASSET_PACKAGE_LIMITS.blobBytes)) limit("Asset-package blob exceeds the blob limit.");
    if (entries.length - 1 > ASSET_PACKAGE_LIMITS.payloadEntries) limit("Asset package exceeds the payload-entry limit.");
    const archive = createDeterministicArchiveStream(entries, {
        limits: {
            archiveBytes: ASSET_PACKAGE_LIMITS.archiveBytes,
            entryBytes: ASSET_PACKAGE_LIMITS.blobBytes,
            entries: ASSET_PACKAGE_LIMITS.entries,
            temporaryBytes: ASSET_PACKAGE_LIMITS.temporaryBytes,
            inodes: ASSET_PACKAGE_LIMITS.inodes,
        },
        signal,
    });
    if (output) {
        await pipeline(archive.stream, output, { signal });
        return Object.freeze({ manifest, ...await archive.completion });
    }
    return Object.freeze({ manifest, stream: archive.stream, completion: archive.completion });
}

export function assetPackagePreparationHash(verified) {
    return packagePreparationHash({
        archiveSha256: verified.archiveSha256,
        manifestSha256: verified.manifestSha256,
        entries: verified.entries,
    });
}

export function stagedAssetPackageEntry(verified, name) {
    const entry = verified.entries.find((candidate) => candidate.name === name);
    if (!entry) invalid(`Prepared asset package entry ${name} is missing.`);
    return entry;
}

export async function prepareAssetPackage({ archivePath, workDirectory, limits, signal }) {
    const stagingRoot = path.join(workDirectory, "asset-package-staging");
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const verified = await verifyAssetPackage(archivePath, { stagingRoot, limits, signal, retainStaging: true });
    const { preparationHash, index } = createPackagePreparationIndex({
        kind: "cev-sim.asset-package-preparation",
        archiveSha256: verified.archiveSha256,
        manifestSha256: verified.manifestSha256,
        entries: verified.entries,
    });
    const indexBytes = Buffer.from(canonicalMarketplaceBytes(index));
    const destinationRoot = path.join(workDirectory, "asset-packages");
    const destination = path.join(destinationRoot, preparationHash);
    await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(verified.stagingDir, "preparation.json"), indexBytes, { flag: "wx", mode: 0o600 });
    try {
        await fs.rename(verified.stagingDir, destination);
    } catch (error) {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        const existing = await fs.readFile(path.join(destination, "preparation.json"));
        if (!existing.equals(indexBytes)) invalid("Existing asset-package preparation does not match the verified artifact.");
        await verified.cleanup();
    }
    return Object.freeze({ verified, preparationHash, preparationDir: destination, index });
}

export async function readAssetPackagePreparation({ workDirectory, preparationHash, archiveSha256 = null }) {
    return readPackagePreparation({
        workDirectory,
        directoryName: "asset-packages",
        preparationHash,
        archiveSha256,
        kind: "cev-sim.asset-package-preparation",
        manifestName: ASSET_PACKAGE_MANIFEST,
        recordPrefix: ASSET_PACKAGE_RECORD_PREFIX,
        blobPrefix: ASSET_PACKAGE_BLOB_PREFIX,
    });
}

export async function readPreparedJsonRecord(preparation, recordSha256) {
    digest(recordSha256, "$recordSha256");
    const descriptor = preparation.entry(`${ASSET_PACKAGE_RECORD_PREFIX}${recordSha256}`);
    const bytes = await fs.readFile(descriptor.path);
    return parseCanonicalRecord(bytes, recordSha256, descriptor.sizeBytes, `Prepared record ${recordSha256}`);
}
