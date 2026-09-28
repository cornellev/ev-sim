import { MetadataKind } from "@tufjs/models";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Updater } from "tuf-js";

import { MARKETPLACE_CLIENT_LIMITS } from "../MarketplaceContract.js";
import {
    assertMarketplaceCatalog,
    assertMarketplaceItem,
    assertMarketplaceRelease,
    hashMarketplaceRelease,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { assertSourceUrl } from "../MarketplaceFormats.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";
import { projectItemSummary, projectReleaseSummary } from "../registry/RegistryCatalog.js";
import {
    assertRegistryDiscoveryDocument,
    hashRegistryBytes,
    parseRegistryDocumentBytes,
    registryDocumentBytes,
} from "../registry/RegistryDocuments.js";
import {
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import {
    tufCatalogTargetPath,
    tufItemTargetPath,
    tufReleaseTargetPath,
} from "../registry/RegistryLayout.js";
import {
    TUF_DELEGATED_ROLES,
    TUF_ROLES,
    canonicalTufBytes,
    hashTufBytes,
    parseTufMetadata,
    rootRegistryId,
    verifyCanonicalTufMetadata,
    verifyTufDelegationContract,
    verifyTufDelegate,
    verifyTufMetadataContract,
    verifyTufMetaFile,
    verifyTufRootContract,
} from "../registry/TufMetadata.js";
import {
    MARKETPLACE_CACHE_MANIFEST_KIND,
    MARKETPLACE_CLIENT_DOCUMENT_VERSION,
    assertCacheManifest,
} from "./MarketplaceClientLayout.js";
import { MARKETPLACE_DISCOVERY_PATH, MarketplaceFixedOriginFetcher } from "./MarketplaceFixedOriginFetcher.js";

const TUF_METADATA_MAX_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_ROLES = [TUF_ROLES.TARGETS, ...TUF_DELEGATED_ROLES];

function signature(message, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, message, { cause });
}

function canonicalDocument(bytes, assertion, label) {
    const document = assertion(parseMarketplaceDocument(bytes));
    if (!Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(document)))) {
        throw signature(`${label} is not canonically serialized.`);
    }
    return document;
}

function sameStringSet(left, right) {
    return left.length === right.length
        && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function expiresAt(metadata) {
    return new Date(metadata.signed.expires).toISOString();
}

function metadataRecord(entry) {
    return Object.freeze({
        version: entry.metadata.signed.version,
        sha256: hashTufBytes(entry.bytes),
        expiresAt: expiresAt(entry.metadata),
    });
}

function targetDescriptor(target) {
    const sha256 = target?.hashes?.sha256;
    if (typeof sha256 !== "string" || !Number.isSafeInteger(target.length) || target.length < 0) {
        throw signature(`TUF target ${target?.path ?? "unknown"} has an invalid hash or size.`);
    }
    return Object.freeze({ path: target.path, sha256, sizeBytes: target.length });
}

async function readMetadata(metadataDir, role, type = MetadataKind.Targets) {
    const bytes = await readRegularBytes(path.join(metadataDir, `${role}.json`), { maxBytes: TUF_METADATA_MAX_BYTES });
    const metadata = parseTufMetadata(bytes, type);
    return verifyCanonicalTufMetadata({ bytes, metadata }, `${role}.json`);
}

async function readRootHistory(rootsDir, bootstrapVersion) {
    const entries = await fs.readdir(rootsDir, { withFileTypes: true });
    const versions = [];
    for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile()) throw signature("TUF root history contains a hostile node.");
        const match = /^([1-9][0-9]*)\.root\.json$/u.exec(entry.name);
        if (!match) throw signature("TUF root history contains an unexpected file.");
        versions.push(Number(match[1]));
    }
    versions.sort((left, right) => left - right);
    if (versions.length < 1 || versions[0] !== bootstrapVersion
        || versions.some((version, index) => version !== bootstrapVersion + index)) {
        throw signature("TUF root history is missing or discontinuous.");
    }
    return Promise.all(versions.map(async (version) => {
        const bytes = await readRegularBytes(path.join(rootsDir, `${version}.root.json`), {
            maxBytes: MARKETPLACE_CLIENT_LIMITS.rootBytes,
        });
        const metadata = parseTufMetadata(bytes, MetadataKind.Root);
        if (metadata.signed.version !== version) throw signature("TUF root history filename has the wrong version.");
        return verifyCanonicalTufMetadata({ bytes, metadata }, `${version}.root.json`);
    }));
}

async function readTarget(snapshotRoot, target, assertion, label) {
    const descriptor = targetDescriptor(target);
    const filePath = path.join(snapshotRoot, "targets", ...descriptor.path.split("/"));
    const bytes = await readRegularBytes(filePath, { maxBytes: TUF_METADATA_MAX_BYTES });
    if (bytes.byteLength !== descriptor.sizeBytes || hashMarketplaceBytes(bytes) !== descriptor.sha256) {
        throw signature(`${label} does not match its TUF target descriptor.`);
    }
    return { bytes, document: canonicalDocument(bytes, assertion, label), descriptor };
}

function assertNotExpired(entries, now) {
    const expired = entries.some((entry) => new Date(entry.metadata.signed.expires).getTime() <= now.getTime());
    return expired;
}

export async function verifyClientSnapshot(snapshotRoot, source, {
    now = new Date(),
    expectedManifest = null,
    bootstrapRootVersion = expectedManifest?.bootstrapRootVersion ?? 1,
    snapshotId = expectedManifest?.snapshotId ?? randomUUID(),
    verifiedAt = expectedManifest?.verifiedAt ?? now.toISOString(),
    requireFresh = false,
} = {}) {
    const bootstrapRoot = parseTufMetadata(
        await readRegularBytes(path.join(snapshotRoot, "roots", `${bootstrapRootVersion}.root.json`), {
            maxBytes: MARKETPLACE_CLIENT_LIMITS.rootBytes,
        }),
        MetadataKind.Root,
    );
    if (bootstrapRoot.signed.version !== bootstrapRootVersion) throw signature("Marketplace bootstrap root version is invalid.");
    const roots = await readRootHistory(path.join(snapshotRoot, "roots"), bootstrapRootVersion);
    let trusted = null;
    for (const entry of roots) {
        verifyTufRootContract(entry.metadata);
        if (rootRegistryId(entry.metadata) !== source.registryId) throw signature("TUF root registry UUID does not match the trusted source.");
        if (!trusted) {
            if (hashTufBytes(entry.bytes) !== source.trustedRootFingerprint) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace bootstrap root fingerprint no longer matches trust state.");
            }
            verifyTufDelegate(entry.metadata, TUF_ROLES.ROOT, entry.metadata);
        } else {
            verifyTufDelegate(trusted.metadata, TUF_ROLES.ROOT, entry.metadata);
            verifyTufDelegate(entry.metadata, TUF_ROLES.ROOT, entry.metadata);
        }
        trusted = entry;
    }
    const currentRoot = await readMetadata(path.join(snapshotRoot, "metadata"), TUF_ROLES.ROOT, MetadataKind.Root);
    if (!Buffer.from(currentRoot.bytes).equals(Buffer.from(trusted.bytes))) {
        throw signature("Current TUF root does not match the verified root history.");
    }
    const timestamp = await readMetadata(path.join(snapshotRoot, "metadata"), TUF_ROLES.TIMESTAMP, MetadataKind.Timestamp);
    const snapshot = await readMetadata(path.join(snapshotRoot, "metadata"), TUF_ROLES.SNAPSHOT, MetadataKind.Snapshot);
    const roles = {};
    for (const role of SNAPSHOT_ROLES) roles[role] = await readMetadata(path.join(snapshotRoot, "metadata"), role);

    verifyTufMetadataContract(timestamp.metadata, MetadataKind.Timestamp, "timestamp.json");
    verifyTufDelegate(trusted.metadata, TUF_ROLES.TIMESTAMP, timestamp.metadata);
    verifyTufMetaFile(timestamp.metadata.signed.snapshotMeta, snapshot.bytes, "snapshot.json");
    verifyTufMetadataContract(snapshot.metadata, MetadataKind.Snapshot, "snapshot.json");
    verifyTufDelegate(trusted.metadata, TUF_ROLES.SNAPSHOT, snapshot.metadata);
    const expectedMeta = SNAPSHOT_ROLES.map((role) => `${role}.json`);
    if (!sameStringSet(Object.keys(snapshot.metadata.signed.meta), expectedMeta)) {
        throw signature("TUF snapshot metadata set is invalid.");
    }
    for (const role of SNAPSHOT_ROLES) {
        verifyTufMetaFile(snapshot.metadata.signed.meta[`${role}.json`], roles[role].bytes, `${role}.json`);
        verifyTufMetadataContract(roles[role].metadata, MetadataKind.Targets, `${role}.json`);
        verifyTufDelegate(role === TUF_ROLES.TARGETS ? trusted.metadata : roles.targets.metadata, role, roles[role].metadata);
    }
    verifyTufDelegationContract(roles.targets.metadata);
    if (Object.keys(roles.advisories.metadata.signed.targets).length !== 0) {
        throw signature("Marketplace advisory delegation must be empty.");
    }

    const catalogTargets = roles.catalog.metadata.signed.targets;
    if (!sameStringSet(Object.keys(catalogTargets), [tufCatalogTargetPath()])) {
        throw signature("TUF catalog delegation has an invalid target set.");
    }
    const catalogEntry = await readTarget(snapshotRoot, catalogTargets[tufCatalogTargetPath()], assertMarketplaceCatalog, "Marketplace catalog");
    const catalog = catalogEntry.document;
    if (catalog.registryId !== source.registryId) throw signature("Marketplace catalog registry UUID is invalid.");
    const expectedItems = catalog.items.map((entry) => tufItemTargetPath(entry.itemId));
    const expectedReleases = catalog.releases.map((entry) => tufReleaseTargetPath(entry.itemId, entry.releaseVersion));
    if (!sameStringSet(Object.keys(roles.items.metadata.signed.targets), expectedItems)
        || !sameStringSet(Object.keys(roles.releases.metadata.signed.targets), expectedReleases)) {
        throw signature("TUF item or release target set does not exactly match the catalog.");
    }

    const items = [];
    const itemDocuments = [];
    for (const summary of catalog.items) {
        const logicalPath = tufItemTargetPath(summary.itemId);
        const entry = await readTarget(snapshotRoot, roles.items.metadata.signed.targets[logicalPath], assertMarketplaceItem, `Marketplace item ${summary.itemId}`);
        if (entry.document.itemId !== summary.itemId || !isDeepStrictEqual(projectItemSummary(entry.document, summary.target), summary)
            || entry.descriptor.sha256 !== summary.target.sha256 || entry.descriptor.sizeBytes !== summary.target.sizeBytes) {
            throw signature(`Marketplace item ${summary.itemId} does not match its catalog summary.`);
        }
        items.push({ ...entry.descriptor, itemId: summary.itemId });
        itemDocuments.push(entry.document);
    }
    const releases = [];
    const releaseDocuments = [];
    for (const summary of catalog.releases) {
        const logicalPath = tufReleaseTargetPath(summary.itemId, summary.releaseVersion);
        const entry = await readTarget(snapshotRoot, roles.releases.metadata.signed.targets[logicalPath], assertMarketplaceRelease, `Marketplace release ${summary.itemId}@${summary.releaseVersion}`);
        const releaseHash = hashMarketplaceRelease(entry.document);
        if (entry.document.itemId !== summary.itemId || entry.document.releaseVersion !== summary.releaseVersion
            || !isDeepStrictEqual(projectReleaseSummary(entry.document, releaseHash, summary.target), summary)
            || entry.descriptor.sha256 !== summary.target.sha256 || entry.descriptor.sizeBytes !== summary.target.sizeBytes) {
            throw signature(`Marketplace release ${summary.itemId}@${summary.releaseVersion} does not match its catalog summary.`);
        }
        releases.push({
            ...entry.descriptor,
            itemId: summary.itemId,
            releaseVersion: summary.releaseVersion,
            releaseHash,
            artifactSha256: entry.document.artifact.sha256,
        });
        releaseDocuments.push(entry.document);
    }

    const requiredMetadata = [trusted, timestamp, snapshot, ...Object.values(roles)];
    const expired = assertNotExpired(requiredMetadata, now);
    if (requireFresh && expired) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.METADATA_EXPIRED, "Marketplace metadata is expired.");
    }
    const manifest = assertCacheManifest({
        kind: MARKETPLACE_CACHE_MANIFEST_KIND,
        version: MARKETPLACE_CLIENT_DOCUMENT_VERSION,
        snapshotId,
        sourceId: source.sourceId,
        registryId: source.registryId,
        verifiedAt,
        bootstrapRootVersion,
        trustedRootFingerprint: source.trustedRootFingerprint,
        root: metadataRecord(trusted),
        timestamp: metadataRecord(timestamp),
        snapshot: metadataRecord(snapshot),
        roles: Object.fromEntries(SNAPSHOT_ROLES.map((role) => [role, metadataRecord(roles[role])])),
        catalog: { ...catalogEntry.descriptor, revision: catalog.revision },
        items,
        releases,
    });
    if (expectedManifest) {
        const comparable = { ...manifest, verifiedAt: expectedManifest.verifiedAt, snapshotId: expectedManifest.snapshotId };
        if (!isDeepStrictEqual(comparable, expectedManifest)) throw signature("Marketplace cache manifest does not match its verified snapshot.");
    }
    const earliestExpiryAt = requiredMetadata
        .map((entry) => expiresAt(entry.metadata))
        .sort()[0];
    const releasesRole = roles.targets.metadata.signed.delegations?.roles?.[TUF_ROLES.RELEASES];
    const verification = Object.freeze({
        registryId: source.registryId,
        trustedRootFingerprint: source.trustedRootFingerprint,
        verifiedAt,
        rootVersion: trusted.metadata.signed.version,
        role: TUF_ROLES.RELEASES,
        roleVersion: roles.releases.metadata.signed.version,
        roleKeyIds: Object.freeze([...(releasesRole?.keyIDs ?? [])].sort()),
        roleExpiresAt: expiresAt(roles.releases.metadata),
    });
    return Object.freeze({
        manifest,
        catalog,
        expired,
        earliestExpiryAt,
        verification,
        documents: Object.freeze({
            items: Object.freeze(itemDocuments),
            releases: Object.freeze(releaseDocuments),
        }),
    });
}

export class MarketplaceTrustClient {
    constructor({ fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
        this.fetchImpl = fetchImpl;
        this.now = now;
    }

    async previewSource({ baseUrl, credential = null, signal = null }) {
        assertSourceUrl(baseUrl);
        const fetcher = new MarketplaceFixedOriginFetcher({
            baseUrl,
            bearerToken: credential?.token ?? credential,
            fetchImpl: this.fetchImpl,
            signal,
        });
        try {
            const discoveryBytes = await fetcher.downloadBytes(
                fetcher.url(MARKETPLACE_DISCOVERY_PATH),
                MARKETPLACE_CLIENT_LIMITS.discoveryBytes,
            );
            const discovery = parseRegistryDocumentBytes(discoveryBytes, assertRegistryDiscoveryDocument);
            if (!Buffer.from(discoveryBytes).equals(Buffer.from(registryDocumentBytes(discovery, assertRegistryDiscoveryDocument)))) {
                throw signature("Marketplace discovery document is not canonically serialized.");
            }
            fetcher.allowPath(discovery.tuf.bootstrapRootPath);
            const rootBytes = await fetcher.downloadBytes(
                fetcher.url(discovery.tuf.bootstrapRootPath),
                MARKETPLACE_CLIENT_LIMITS.rootBytes,
            );
            const fingerprint = hashRegistryBytes(rootBytes);
            if (fingerprint !== discovery.tuf.bootstrapRootSha256) throw signature("Marketplace bootstrap root fingerprint does not match discovery.");
            const root = parseTufMetadata(rootBytes, MetadataKind.Root);
            verifyCanonicalTufMetadata({ bytes: rootBytes, metadata: root }, "bootstrap root");
            verifyTufRootContract(root);
            verifyTufDelegate(root, TUF_ROLES.ROOT, root);
            if (rootRegistryId(root) !== discovery.registryId) throw signature("Marketplace bootstrap root registry UUID does not match discovery.");
            return Object.freeze({
                baseUrl,
                registryId: discovery.registryId,
                trustedRootFingerprint: fingerprint,
                rootVersion: root.signed.version,
                rootExpiresAt: expiresAt(root),
                authentication: discovery.authentication,
                limits: discovery.limits,
                rootBytes: Buffer.from(rootBytes),
            });
        } catch (error) {
            if (error instanceof MarketplaceError) throw error;
            if (fetcher.lastTransportError) throw fetcher.lastTransportError;
            throw signature("Marketplace trust preview failed.", error);
        }
    }

    async refreshSource({ source, bearerToken = null, bootstrapRootBytes, staging, previousSnapshotRoot = null, signal = null }) {
        const operationNow = this.now();
        await ensureDirectory(staging.root);
        if (previousSnapshotRoot) {
            await fs.cp(path.join(previousSnapshotRoot, "metadata"), staging.metadata, { recursive: true, force: false, errorOnExist: true });
            await fs.cp(path.join(previousSnapshotRoot, "roots"), staging.roots, { recursive: true, force: false, errorOnExist: true });
        } else {
            await ensureDirectory(staging.metadata);
            await ensureDirectory(staging.roots);
            const bootstrap = parseTufMetadata(bootstrapRootBytes, MetadataKind.Root);
            await writeExclusiveDurable(path.join(staging.metadata, "root.json"), bootstrapRootBytes);
            await writeExclusiveDurable(path.join(staging.roots, `${bootstrap.signed.version}.root.json`), bootstrapRootBytes);
        }
        await ensureDirectory(staging.targets);
        const fetcher = new MarketplaceFixedOriginFetcher({
            baseUrl: source.baseUrl,
            bearerToken,
            fetchImpl: this.fetchImpl,
            signal,
            allowTuf: true,
            onRootBytes: async (version, bytes) => {
                const destination = path.join(staging.roots, `${version}.root.json`);
                if (await lstatOrNull(destination)) return;
                await writeExclusiveDurable(destination, bytes);
            },
        });
        const updater = new Updater({
            metadataDir: staging.metadata,
            metadataBaseUrl: new URL("/tuf/metadata/", source.baseUrl).href,
            targetDir: staging.targets,
            targetBaseUrl: new URL("/tuf/targets/", source.baseUrl).href,
            fetcher,
            config: {
                maxRootRotations: 64,
                maxDelegations: 16,
                rootMaxLength: MARKETPLACE_CLIENT_LIMITS.rootBytes,
                timestampMaxLength: TUF_METADATA_MAX_BYTES,
                snapshotMaxLength: TUF_METADATA_MAX_BYTES,
                targetsMaxLength: TUF_METADATA_MAX_BYTES,
                prefixTargetsWithHash: true,
                fetchTimeout: MARKETPLACE_CLIENT_LIMITS.requestTimeoutMs,
                fetchRetries: 0,
            },
        });
        const download = async (logicalPath) => {
            const target = await updater.getTargetInfo(logicalPath);
            if (!target) throw signature(`Required marketplace target ${logicalPath} is missing.`);
            const destination = path.join(staging.targets, ...logicalPath.split("/"));
            await ensureDirectory(path.dirname(destination));
            await updater.downloadTarget(target, destination);
        };
        try {
            await updater.refresh();
            await download(tufCatalogTargetPath());
            const catalog = canonicalDocument(
                await readRegularBytes(path.join(staging.targets, "catalog", "catalog.json"), { maxBytes: TUF_METADATA_MAX_BYTES }),
                assertMarketplaceCatalog,
                "Marketplace catalog",
            );
            for (const item of catalog.items) await download(tufItemTargetPath(item.itemId));
            if (catalog.items.length === 0) await updater.getTargetInfo("items/cev.empty.json");
            for (const release of catalog.releases) await download(tufReleaseTargetPath(release.itemId, release.releaseVersion));
            if (catalog.releases.length === 0) await updater.getTargetInfo("releases/cev.empty/0.0.0.json");
            await updater.getTargetInfo("advisories/cev.empty.json");
            const bootstrap = parseTufMetadata(bootstrapRootBytes, MetadataKind.Root);
            const result = await verifyClientSnapshot(staging.root, source, {
                now: operationNow,
                bootstrapRootVersion: bootstrap.signed.version,
                snapshotId: staging.snapshotId,
                verifiedAt: operationNow.toISOString(),
                requireFresh: true,
            });
            return result;
        } catch (error) {
            if (error instanceof MarketplaceError) throw error;
            if (signal?.aborted) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CANCELLED, "Marketplace refresh was cancelled.", { cause: error });
            }
            if (fetcher.lastTransportError) throw fetcher.lastTransportError;
            throw signature("Marketplace TUF refresh failed.", error);
        }
    }
}
