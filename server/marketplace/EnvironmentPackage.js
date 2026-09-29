import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { collectAssetInstanceReferences } from "../../app/editor-assets/EditorAssetContract.js";
import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import {
    assertVisualLayer,
    assertVisualLayerAccess,
    assertVisualLayerAccessMatches,
    canonicalExactStringify,
    hashVisualAssetUse,
    hashVisualLayer,
    hashVisualLayerAccess,
    normalizeVisualAssetUse,
    parseExactJson,
} from "../../app/simulation/visual/VisualLayer.js";
import { environmentSourceKind, readSchemaVersion } from "../../app/3d/environment/EnvironmentManifestPolicy.js";
import {
    createDeterministicArchiveStream,
    verifyDeterministicArchive,
} from "../artifacts/DeterministicArchive.js";
import { maybeFault } from "../storage/visual-assets/atomicFs.js";
import {
    ASSET_PACKAGE_BLOB_PREFIX,
    ASSET_PACKAGE_KIND,
    ASSET_PACKAGE_RECORD_PREFIX,
    ASSET_PACKAGE_VERSION,
    assertGraphDepth,
    collectAssetClosure,
    normalizeAssetClosureManifest,
    parseCanonicalRecord,
    topologicalOrder,
    verifyAssetClosure,
} from "./AssetPackage.js";
import { ENVIRONMENT_PACKAGE_LIMITS } from "./MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";
import {
    canonicalMarketplaceBytes,
    hashMarketplaceBytes,
} from "./MarketplaceJson.js";
import {
    createPackagePreparationIndex,
    packagePreparationHash,
    readPackagePreparation,
} from "./PackagePreparation.js";

export const ENVIRONMENT_PACKAGE_KIND = "cev-sim.environment-package";
export const ENVIRONMENT_PACKAGE_VERSION = 1;
export const ENVIRONMENT_PACKAGE_MANIFEST = "manifest.json";
export const ENVIRONMENT_PACKAGE_RECORD_PREFIX = ASSET_PACKAGE_RECORD_PREFIX;
export const ENVIRONMENT_PACKAGE_BLOB_PREFIX = ASSET_PACKAGE_BLOB_PREFIX;
export const ENVIRONMENT_PACKAGE_EXPORT_OPERATIONS = Object.freeze(["export"]);

const SHA256 = /^[a-f0-9]{64}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function invalid(message, field = null) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message, { path: field });
}

function limit(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, message);
}

function conflict(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function exactKeys(value, keys, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object.`, field);
    const expected = new Set(keys);
    for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${field}.${key} is required.`, `${field}.${key}`);
    for (const key of Object.keys(value)) if (!expected.has(key)) invalid(`${field}.${key} is not allowed.`, `${field}.${key}`);
}

function digest(value, field) {
    if (typeof value !== "string" || !SHA256.test(value)) invalid(`${field} must be a lowercase SHA-256 digest.`, field);
    return value;
}

function portableId(value, field) {
    if (typeof value !== "string" || !PORTABLE_ID.test(value)) invalid(`${field} must be a portable id.`, field);
    return value;
}

function nonNegative(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(`${field} must be a non-negative safe integer.`, field);
    return value;
}

function dense(value, field) {
    if (!Array.isArray(value) || Object.keys(value).length !== value.length) invalid(`${field} must be a dense array.`, field);
    return value;
}

function sortedUnique(values, key, field) {
    let previous = null;
    const seen = new Set();
    values.forEach((entry, index) => {
        const current = key(entry);
        if (seen.has(current)) invalid(`${field}.${index} is a duplicate.`, `${field}.${index}`);
        if (previous !== null && compareUtf8(previous, current) >= 0) invalid(`${field} must be in canonical UTF-8 order.`, field);
        seen.add(current);
        previous = current;
    });
}

function normalizeUseDescriptors(value, field) {
    const uses = dense(value, field).map((entry, index) => {
        const current = `${field}.${index}`;
        exactKeys(entry, ["useHash", "recordSha256", "sizeBytes"], current);
        return {
            useHash: digest(entry.useHash, `${current}.useHash`),
            recordSha256: digest(entry.recordSha256, `${current}.recordSha256`),
            sizeBytes: nonNegative(entry.sizeBytes, `${current}.sizeBytes`),
        };
    });
    sortedUnique(uses, (entry) => entry.useHash, field);
    return uses;
}

function normalizeBlobDescriptors(value, field) {
    const blobs = dense(value, field).map((entry, index) => {
        const current = `${field}.${index}`;
        exactKeys(entry, ["sha256", "sizeBytes"], current);
        return { sha256: digest(entry.sha256, `${current}.sha256`), sizeBytes: nonNegative(entry.sizeBytes, `${current}.sizeBytes`) };
    });
    sortedUnique(blobs, (entry) => entry.sha256, field);
    return blobs;
}

export function normalizeEnvironmentPackageManifest(value) {
    exactKeys(value, ["kind", "version", "environment", "assets", "visualLayer"], "$manifest");
    if (value.kind !== ENVIRONMENT_PACKAGE_KIND || value.version !== ENVIRONMENT_PACKAGE_VERSION) {
        invalid(`Expected ${ENVIRONMENT_PACKAGE_KIND}@${ENVIRONMENT_PACKAGE_VERSION}.`, "$manifest.kind");
    }
    exactKeys(value.environment, ["environmentId", "revision", "recordSha256", "sizeBytes", "worldHash"], "$manifest.environment");
    const environment = {
        environmentId: portableId(value.environment.environmentId, "$manifest.environment.environmentId"),
        revision: nonNegative(value.environment.revision, "$manifest.environment.revision"),
        recordSha256: digest(value.environment.recordSha256, "$manifest.environment.recordSha256"),
        sizeBytes: nonNegative(value.environment.sizeBytes, "$manifest.environment.sizeBytes"),
        worldHash: digest(value.environment.worldHash, "$manifest.environment.worldHash"),
    };
    const assets = normalizeAssetClosureManifest(value.assets);
    let visualLayer = null;
    if (value.visualLayer !== null) {
        exactKeys(value.visualLayer, ["descriptorHash", "descriptor", "accessHash", "access", "uses", "blobs"], "$manifest.visualLayer");
        exactKeys(value.visualLayer.descriptor, ["recordSha256", "sizeBytes"], "$manifest.visualLayer.descriptor");
        exactKeys(value.visualLayer.access, ["recordSha256", "sizeBytes"], "$manifest.visualLayer.access");
        visualLayer = {
            descriptorHash: digest(value.visualLayer.descriptorHash, "$manifest.visualLayer.descriptorHash"),
            descriptor: {
                recordSha256: digest(value.visualLayer.descriptor.recordSha256, "$manifest.visualLayer.descriptor.recordSha256"),
                sizeBytes: nonNegative(value.visualLayer.descriptor.sizeBytes, "$manifest.visualLayer.descriptor.sizeBytes"),
            },
            accessHash: digest(value.visualLayer.accessHash, "$manifest.visualLayer.accessHash"),
            access: {
                recordSha256: digest(value.visualLayer.access.recordSha256, "$manifest.visualLayer.access.recordSha256"),
                sizeBytes: nonNegative(value.visualLayer.access.sizeBytes, "$manifest.visualLayer.access.sizeBytes"),
            },
            uses: normalizeUseDescriptors(value.visualLayer.uses, "$manifest.visualLayer.uses"),
            blobs: normalizeBlobDescriptors(value.visualLayer.blobs, "$manifest.visualLayer.blobs"),
        };
    }
    return { kind: ENVIRONMENT_PACKAGE_KIND, version: ENVIRONMENT_PACKAGE_VERSION, environment, assets, visualLayer };
}

function portableRoots(environment) {
    return [...new Map(collectAssetInstanceReferences(environment.document).map((entry) => [
        `${entry.assetId}@${entry.revision}`,
        { assetId: entry.assetId, revision: entry.revision },
    ])).values()].sort((left, right) => compareUtf8(left.assetId, right.assetId) || left.revision - right.revision);
}

function assertPortableEnvironment(environment) {
    if (readSchemaVersion(environment) !== 4) invalid("Environment packages require a saved schema-v4 environment.");
    if (environmentSourceKind(environment) === "google") {
        invalid("Live Google Photorealistic Tiles are not portable; bake or import a GLTF tile asset first.");
    }
    if (environment.document?.environmentId !== environment.environmentId) invalid("Environment document identity does not match the manifest.");
}

export function marketplaceEnvironmentContentHash(environment) {
    const value = structuredClone(environment);
    delete value.revision;
    delete value.createdAt;
    delete value.updatedAt;
    delete value.clientRevision;
    value.evidence = null;
    if (value.visualLayer) {
        delete value.visualLayer.bakeReuseManifestHash;
    }
    return hashMarketplaceBytes(canonicalMarketplaceBytes(value));
}

function environmentRecord(environment) {
    const bytes = Buffer.from(canonicalMarketplaceBytes(environment));
    return { bytes, sha256: hashMarketplaceBytes(bytes) };
}

function exactVisualRecord(value, hash) {
    const bytes = Buffer.from(canonicalExactStringify(value));
    return { bytes, sha256: hashMarketplaceBytes(bytes), hash };
}

function mergeRecords(records) {
    const result = new Map();
    for (const record of records) {
        const existing = result.get(record.sha256);
        if (existing && !existing.bytes.equals(record.bytes)) invalid(`Record digest collision at ${record.sha256}.`);
        result.set(record.sha256, record);
    }
    return [...result.values()].sort((left, right) => compareUtf8(left.sha256, right.sha256));
}

function mergeBlobs(blobs) {
    const result = new Map();
    for (const blob of blobs) {
        const existing = result.get(blob.sha256);
        if (existing && existing.sizeBytes !== blob.sizeBytes) invalid(`Blob ${blob.sha256} has conflicting sizes.`);
        result.set(blob.sha256, blob);
    }
    return [...result.values()].sort((left, right) => compareUtf8(left.sha256, right.sha256));
}

function packageLimits(overrides = {}) {
    const merged = { ...ENVIRONMENT_PACKAGE_LIMITS, ...overrides };
    for (const key of ["archiveBytes", "blobBytes", "recordBytes", "manifestBytes", "payloadEntries", "entries", "graphDepth", "temporaryBytes", "inodes", "verificationTimeoutMs"]) {
        if (!Number.isSafeInteger(merged[key]) || merged[key] < 1 || merged[key] > ENVIRONMENT_PACKAGE_LIMITS[key]) {
            throw new TypeError(`Environment-package limit ${key} must be a positive integer no larger than the frozen profile.`);
        }
    }
    return Object.freeze(merged);
}

function verifyVisualClosure({ manifest, recordBytes, blobEntries, limits }) {
    if (!manifest) return Object.freeze({ descriptor: null, access: null, uses: new Map(), useOrder: Object.freeze([]), useEdges: Object.freeze([]) });
    for (const descriptor of manifest.uses) if (descriptor.sizeBytes > limits.recordBytes) limit("Environment visual-use record exceeds the record limit.");
    for (const blob of manifest.blobs) if (blob.sizeBytes > limits.blobBytes) limit("Environment visual blob exceeds the blob limit.");
    const descriptorBytes = recordBytes.get(manifest.descriptor.recordSha256);
    const accessBytes = recordBytes.get(manifest.access.recordSha256);
    if (!descriptorBytes || !accessBytes) invalid("Environment visual descriptor or access record is missing.");
    if (descriptorBytes.length !== manifest.descriptor.sizeBytes || hashMarketplaceBytes(descriptorBytes) !== manifest.descriptor.recordSha256) invalid("Visual descriptor bytes do not match the manifest.");
    if (accessBytes.length !== manifest.access.sizeBytes || hashMarketplaceBytes(accessBytes) !== manifest.access.recordSha256) invalid("Visual access bytes do not match the manifest.");
    const descriptor = parseExactJson(descriptorBytes.toString("utf8"));
    const access = parseExactJson(accessBytes.toString("utf8"));
    assertVisualLayer(descriptor);
    assertVisualLayerAccess(access);
    if (Buffer.from(canonicalExactStringify(descriptor)).compare(descriptorBytes) !== 0 || hashVisualLayer(descriptor) !== manifest.descriptorHash) invalid("Visual descriptor identity is invalid.");
    if (Buffer.from(canonicalExactStringify(access)).compare(accessBytes) !== 0 || hashVisualLayerAccess(access) !== manifest.accessHash) invalid("Visual access identity is invalid.");
    const uses = new Map();
    for (const useDescriptor of manifest.uses) {
        const bytes = recordBytes.get(useDescriptor.recordSha256);
        const use = normalizeVisualAssetUse(parseCanonicalRecord(bytes, useDescriptor.recordSha256, useDescriptor.sizeBytes, "Environment visual-use record"));
        if (hashVisualAssetUse(use) !== useDescriptor.useHash) invalid("Environment visual-use hash is invalid.");
        uses.set(useDescriptor.useHash, { descriptor: useDescriptor, use });
    }
    assertVisualLayerAccessMatches(access, descriptor, new Map([...uses].map(([useHash, entry]) => [useHash, entry.use])));
    const required = new Set();
    const edges = [];
    const visit = (useHash, depth = 1) => {
        if (depth > limits.graphDepth) limit("Environment visual-use graph exceeds the depth limit.");
        const entry = uses.get(useHash);
        if (!entry) invalid(`Environment visual closure is missing use ${useHash}.`);
        if (required.has(useHash)) return;
        required.add(useHash);
        for (const dependency of Object.values(entry.use.dependencies).sort(compareUtf8)) {
            edges.push([dependency, useHash]);
            visit(dependency, depth + 1);
        }
    };
    for (const entry of access.assets) visit(entry.useHash);
    if (required.size !== uses.size) invalid("Environment visual closure contains unreachable uses.");
    const expectedBlobs = new Map([...uses.values()].map(({ use }) => [use.asset.sha256, use.asset.sizeBytes]));
    if (expectedBlobs.size !== manifest.blobs.length || manifest.blobs.some((blob) => expectedBlobs.get(blob.sha256) !== blob.sizeBytes)) invalid("Environment visual blob closure is not exact.");
    if (manifest.blobs.some((blob) => {
        const entry = blobEntries.get(blob.sha256);
        return !entry || entry.sha256 !== blob.sha256 || entry.sizeBytes !== blob.sizeBytes;
    })) invalid("Environment visual blob bytes do not match the manifest.");
    const nodes = [...uses.keys()].sort(compareUtf8);
    const useOrder = topologicalOrder(nodes, edges, "Environment visual-use graph");
    assertGraphDepth(nodes, edges, useOrder, limits.graphDepth, "Environment visual-use graph");
    return Object.freeze({ descriptor, access, uses, useOrder: Object.freeze(useOrder), useEdges: Object.freeze(edges.map((edge) => Object.freeze(edge))) });
}

async function verifyStagedEnvironmentPackage(verified, limits) {
    if (!verified.entries.length || verified.entries[0].name !== ENVIRONMENT_PACKAGE_MANIFEST) invalid("Environment package manifest must be the first archive entry.");
    if (verified.entries.length - 1 > limits.payloadEntries) limit("Environment package exceeds the payload-entry limit.");
    const manifestEntry = verified.entries[0];
    const manifestBytes = await fs.readFile(manifestEntry.path);
    const parsed = parseCanonicalRecord(manifestBytes, manifestEntry.sha256, manifestEntry.sizeBytes, "Environment package manifest");
    const manifest = normalizeEnvironmentPackageManifest(parsed);
    if (!manifestBytes.equals(Buffer.from(canonicalMarketplaceBytes(manifest)))) invalid("Environment package manifest is not normalized canonical JSON.");

    const assetRecordDigests = manifest.assets.assets.flatMap((asset) => asset.revisions.map((entry) => entry.recordSha256))
        .concat(manifest.assets.uses.map((entry) => entry.recordSha256));
    const visualRecordDigests = manifest.visualLayer ? [
        manifest.visualLayer.descriptor.recordSha256,
        manifest.visualLayer.access.recordSha256,
        ...manifest.visualLayer.uses.map((entry) => entry.recordSha256),
    ] : [];
    const recordDigests = [...new Set([manifest.environment.recordSha256, ...assetRecordDigests, ...visualRecordDigests])].sort(compareUtf8);
    const blobDescriptors = mergeBlobs([...(manifest.assets.blobs ?? []), ...(manifest.visualLayer?.blobs ?? [])]);
    const expectedNames = [
        ENVIRONMENT_PACKAGE_MANIFEST,
        ...recordDigests.map((sha256) => `${ENVIRONMENT_PACKAGE_RECORD_PREFIX}${sha256}`),
        ...blobDescriptors.map((blob) => `${ENVIRONMENT_PACKAGE_BLOB_PREFIX}${blob.sha256}`),
    ];
    if (verified.entries.length !== expectedNames.length || verified.entries.some((entry, index) => entry.name !== expectedNames[index])) {
        invalid("Environment package entries do not exactly match the manifest or canonical ordering.");
    }
    const entries = new Map(verified.entries.map((entry) => [entry.name, entry]));
    const recordBytes = new Map();
    for (const sha256 of recordDigests) {
        const entry = entries.get(`${ENVIRONMENT_PACKAGE_RECORD_PREFIX}${sha256}`);
        if (entry.sha256 !== sha256) invalid(`Record ${sha256} digest does not match its path.`);
        recordBytes.set(sha256, await fs.readFile(entry.path));
    }
    const blobEntries = new Map(blobDescriptors.map((blob) => {
        const entry = entries.get(`${ENVIRONMENT_PACKAGE_BLOB_PREFIX}${blob.sha256}`);
        return [blob.sha256, { sha256: entry.sha256, sizeBytes: entry.sizeBytes }];
    }));
    const environmentBytes = recordBytes.get(manifest.environment.recordSha256);
    const environment = parseCanonicalRecord(environmentBytes, manifest.environment.recordSha256, manifest.environment.sizeBytes, "Environment record");
    assertPortableEnvironment(environment);
    if (environment.environmentId !== manifest.environment.environmentId || environment.revision !== manifest.environment.revision) invalid("Environment record identity does not match the package manifest.");
    const world = createWorldResource(environment);
    if (world.hash !== manifest.environment.worldHash) invalid("Environment world hash does not match canonical world content.");
    const roots = portableRoots(environment);
    if (JSON.stringify(roots) !== JSON.stringify(manifest.assets.roots)) invalid("Environment asset roots do not exactly match document pins.");

    const assetRecordBytes = new Map(assetRecordDigests.map((sha256) => [sha256, recordBytes.get(sha256)]));
    const assetBlobEntries = new Map(manifest.assets.blobs.map((blob) => [blob.sha256, blobEntries.get(blob.sha256)]));
    const assets = verifyAssetClosure({ manifest: manifest.assets, recordBytes: assetRecordBytes, blobs: assetBlobEntries, limits });
    const visual = verifyVisualClosure({ manifest: manifest.visualLayer, recordBytes, blobEntries, limits });
    if (manifest.visualLayer) {
        if (environment.visualLayer?.descriptorHash !== manifest.visualLayer.descriptorHash
            || environment.visualLayer?.accessHash !== manifest.visualLayer.accessHash) invalid("Environment visual reference does not match the packaged visual layer.");
        if (visual.descriptor.sourceWorldHash !== world.hash) invalid("Packaged visual descriptor is bound to a different source world.");
    } else if (environment.visualLayer !== null && environment.visualLayer !== undefined) {
        invalid("Environment references a visual layer that is absent from the package.");
    }
    const allUses = new Map(assets.uses);
    for (const [useHash, entry] of visual.uses) {
        const current = allUses.get(useHash);
        if (current && JSON.stringify(current.use) !== JSON.stringify(entry.use)) invalid(`Use ${useHash} differs between asset and visual closures.`);
        allUses.set(useHash, entry);
    }
    const allEdges = [...assets.useEdges, ...visual.useEdges];
    const allUseOrder = topologicalOrder([...allUses.keys()].sort(compareUtf8), allEdges, "Environment package visual-use graph");
    assertGraphDepth([...allUses.keys()], allEdges, allUseOrder, limits.graphDepth, "Environment package visual-use graph");
    return Object.freeze({
        manifest,
        manifestSha256: manifestEntry.sha256,
        archiveSha256: verified.sha256,
        archiveSizeBytes: verified.sizeBytes,
        stagingDir: verified.stagingDir,
        entries: Object.freeze(verified.entries.map((entry) => Object.freeze({ ...entry }))),
        environment,
        world,
        assets,
        visual,
        revisions: assets.revisions,
        uses: allUses,
        assetOrder: assets.assetOrder,
        useOrder: Object.freeze(allUseOrder),
        cleanup: verified.cleanup,
    });
}

export async function verifyEnvironmentPackage(input, {
    limits: overrides = {}, signal, stagingRoot, stagingDir, retainStaging = true,
} = {}) {
    const limits = packageLimits(overrides);
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
        entryLimit: ({ index, name }) => index === 0 || name === ENVIRONMENT_PACKAGE_MANIFEST
            ? limits.manifestBytes
            : name.startsWith(ENVIRONMENT_PACKAGE_RECORD_PREFIX) ? limits.recordBytes : limits.blobBytes,
    });
    try {
        const result = await verifyStagedEnvironmentPackage(verified, limits);
        if (!retainStaging) await verified.cleanup();
        return result;
    } catch (error) {
        await verified.cleanup().catch(() => {});
        throw error;
    }
}

export async function inspectEnvironmentPackage({ archivePath, stagingRoot, limits, signal, retainStaging = false }) {
    const verified = await verifyEnvironmentPackage(archivePath, { stagingRoot, limits, signal, retainStaging });
    const inspection = Object.freeze({
        kind: verified.manifest.kind,
        version: verified.manifest.version,
        archiveSha256: verified.archiveSha256,
        archiveSizeBytes: verified.archiveSizeBytes,
        manifestSha256: verified.manifestSha256,
        environmentId: verified.manifest.environment.environmentId,
        sourceRevision: verified.manifest.environment.revision,
        assetCount: verified.manifest.assets.assets.length,
        revisionCount: verified.revisions.size,
        useCount: verified.uses.size,
        blobCount: new Set([...verified.manifest.assets.blobs, ...(verified.manifest.visualLayer?.blobs ?? [])].map((entry) => entry.sha256)).size,
    });
    if (!retainStaging) await verified.cleanup();
    return inspection;
}

async function buildEnvironmentExport({ storageService, environmentId, expectedRevision }) {
    const snapshot = await storageService.snapshotMarketplaceEnvironment(environmentId);
    if (expectedRevision !== undefined && snapshot.environment.revision !== expectedRevision) conflict("Environment revision changed before export.");
    const environment = snapshot.environment;
    assertPortableEnvironment(environment);
    const envRecord = environmentRecord(environment);
    const roots = portableRoots(environment);
    const assets = await collectAssetClosure({
        editorAssetStore: storageService.editorAssets,
        visualAssetStore: storageService.visualAssets,
        roots,
        operations: ENVIRONMENT_PACKAGE_EXPORT_OPERATIONS,
        allowEmpty: true,
    });
    let visualLayer = null;
    let visualRecords = [];
    let visualBlobs = [];
    if (snapshot.descriptor) {
        const access = await storageService.visualAssets.validateAccessSet({
            useHashes: snapshot.access.assets.map((entry) => entry.useHash),
            operations: ENVIRONMENT_PACKAGE_EXPORT_OPERATIONS,
            verifyBytes: true,
            includeUseRecords: true,
        });
        assertVisualLayerAccessMatches(snapshot.access, snapshot.descriptor, new Map(access.closureUses.map((entry) => [entry.useHash, entry.use])));
        const descriptorRecord = exactVisualRecord(snapshot.descriptor, snapshot.environment.visualLayer.descriptorHash);
        const accessRecord = exactVisualRecord(snapshot.access, snapshot.environment.visualLayer.accessHash);
        const useRecords = access.closureUses.map(({ useHash, use }) => {
            const bytes = Buffer.from(canonicalMarketplaceBytes(use));
            return { useHash, use, bytes, sha256: hashMarketplaceBytes(bytes) };
        }).sort((left, right) => compareUtf8(left.useHash, right.useHash));
        visualBlobs = mergeBlobs(useRecords.map(({ use }) => ({ sha256: use.asset.sha256, sizeBytes: use.asset.sizeBytes })));
        visualRecords = [descriptorRecord, accessRecord, ...useRecords];
        visualLayer = {
            descriptorHash: snapshot.environment.visualLayer.descriptorHash,
            descriptor: { recordSha256: descriptorRecord.sha256, sizeBytes: descriptorRecord.bytes.length },
            accessHash: snapshot.environment.visualLayer.accessHash,
            access: { recordSha256: accessRecord.sha256, sizeBytes: accessRecord.bytes.length },
            uses: useRecords.map((entry) => ({ useHash: entry.useHash, recordSha256: entry.sha256, sizeBytes: entry.bytes.length })),
            blobs: visualBlobs,
        };
    }
    const manifest = normalizeEnvironmentPackageManifest({
        kind: ENVIRONMENT_PACKAGE_KIND,
        version: ENVIRONMENT_PACKAGE_VERSION,
        environment: {
            environmentId: environment.environmentId,
            revision: environment.revision,
            recordSha256: envRecord.sha256,
            sizeBytes: envRecord.bytes.length,
            worldHash: createWorldResource(environment).hash,
        },
        assets: assets.manifest,
        visualLayer,
    });
    return {
        snapshot,
        manifest,
        records: mergeRecords([{ ...envRecord }, ...assets.records, ...visualRecords]),
        blobs: mergeBlobs([...assets.blobs, ...visualBlobs]),
        recordSha256: envRecord.sha256,
    };
}

export async function exportEnvironmentPackage({
    storageService, environmentId, expectedRevision, output = null, signal,
} = {}) {
    let captured = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        captured = await buildEnvironmentExport({ storageService, environmentId, expectedRevision });
        await maybeFault(storageService.faults, "marketplaceEnvironmentExportBeforeRecheck");
        const current = await storageService.snapshotMarketplaceEnvironment(environmentId);
        const currentRecord = environmentRecord(current.environment);
        if (current.environment.revision === captured.snapshot.environment.revision && currentRecord.sha256 === captured.recordSha256) break;
        if (expectedRevision !== undefined || attempt === 3) conflict("Environment changed while its portable package was being captured.");
        captured = null;
    }
    const manifestBytes = Buffer.from(canonicalMarketplaceBytes(captured.manifest));
    const entries = [
        { name: ENVIRONMENT_PACKAGE_MANIFEST, bytes: manifestBytes, sizeBytes: manifestBytes.length },
        ...captured.records.map((entry) => ({ name: `${ENVIRONMENT_PACKAGE_RECORD_PREFIX}${entry.sha256}`, bytes: entry.bytes, sizeBytes: entry.bytes.length, sha256: entry.sha256 })),
        ...captured.blobs.map((blob) => ({
            name: `${ENVIRONMENT_PACKAGE_BLOB_PREFIX}${blob.sha256}`,
            sizeBytes: blob.sizeBytes,
            sha256: blob.sha256,
            open: () => storageService.visualAssets.openPublishedStream(blob.sha256, { expectedSize: blob.sizeBytes }),
        })),
    ];
    if (manifestBytes.length > ENVIRONMENT_PACKAGE_LIMITS.manifestBytes) limit("Environment-package manifest exceeds the manifest limit.");
    if (captured.records.some((entry) => entry.bytes.length > ENVIRONMENT_PACKAGE_LIMITS.recordBytes)) limit("Environment-package record exceeds the record limit.");
    if (captured.blobs.some((entry) => entry.sizeBytes > ENVIRONMENT_PACKAGE_LIMITS.blobBytes)) limit("Environment-package blob exceeds the blob limit.");
    if (entries.length - 1 > ENVIRONMENT_PACKAGE_LIMITS.payloadEntries) limit("Environment package exceeds the payload-entry limit.");
    const archive = createDeterministicArchiveStream(entries, {
        limits: {
            archiveBytes: ENVIRONMENT_PACKAGE_LIMITS.archiveBytes,
            entryBytes: ENVIRONMENT_PACKAGE_LIMITS.blobBytes,
            entries: ENVIRONMENT_PACKAGE_LIMITS.entries,
            temporaryBytes: ENVIRONMENT_PACKAGE_LIMITS.temporaryBytes,
            inodes: ENVIRONMENT_PACKAGE_LIMITS.inodes,
        },
        signal,
    });
    if (output) {
        await pipeline(archive.stream, output, { signal });
        return Object.freeze({ manifest: captured.manifest, ...await archive.completion });
    }
    return Object.freeze({ manifest: captured.manifest, stream: archive.stream, completion: archive.completion });
}

export function environmentPackagePreparationHash(verified) {
    return packagePreparationHash({
        archiveSha256: verified.archiveSha256,
        manifestSha256: verified.manifestSha256,
        entries: verified.entries,
    });
}

export async function prepareEnvironmentPackage({ archivePath, workDirectory, limits, signal }) {
    const stagingRoot = path.join(workDirectory, "environment-package-staging");
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const verified = await verifyEnvironmentPackage(archivePath, { stagingRoot, limits, signal, retainStaging: true });
    const { preparationHash, index } = createPackagePreparationIndex({
        kind: "cev-sim.environment-package-preparation",
        archiveSha256: verified.archiveSha256,
        manifestSha256: verified.manifestSha256,
        entries: verified.entries,
    });
    const bytes = Buffer.from(canonicalMarketplaceBytes(index));
    const root = path.join(workDirectory, "environment-packages");
    const destination = path.join(root, preparationHash);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(verified.stagingDir, "preparation.json"), bytes, { flag: "wx", mode: 0o600 });
    try {
        await fs.rename(verified.stagingDir, destination);
    } catch (error) {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        const existing = await fs.readFile(path.join(destination, "preparation.json"));
        if (!existing.equals(bytes)) invalid("Existing environment-package preparation does not match the verified artifact.");
        await verified.cleanup();
    }
    return Object.freeze({ verified, preparationHash, preparationDir: destination, index });
}

export async function readEnvironmentPackagePreparation({ workDirectory, preparationHash, archiveSha256 = null }) {
    return readPackagePreparation({
        workDirectory,
        directoryName: "environment-packages",
        preparationHash,
        archiveSha256,
        kind: "cev-sim.environment-package-preparation",
        manifestName: ENVIRONMENT_PACKAGE_MANIFEST,
        recordPrefix: ENVIRONMENT_PACKAGE_RECORD_PREFIX,
        blobPrefix: ENVIRONMENT_PACKAGE_BLOB_PREFIX,
    });
}

export async function readPreparedEnvironmentJsonRecord(preparation, recordSha256) {
    digest(recordSha256, "$recordSha256");
    const descriptor = preparation.entry(`${ENVIRONMENT_PACKAGE_RECORD_PREFIX}${recordSha256}`);
    const bytes = await fs.readFile(descriptor.path);
    return parseCanonicalRecord(bytes, recordSha256, descriptor.sizeBytes, `Prepared record ${recordSha256}`);
}
