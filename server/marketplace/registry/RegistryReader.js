import { promises as fs } from "node:fs";
import path from "node:path";

import { openRegularFile } from "../../storage/visual-assets/atomicFs.js";
import { MARKETPLACE_LIMITS } from "../MarketplaceContract.js";
import { marketplaceDocumentBytes, parseMarketplaceDocument } from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertMarketplaceId, assertReleaseVersion } from "../MarketplaceFormats.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";
import {
    assertBlobRecord,
    assertRegistryDiscoveryDocument,
    assertRegistryDocument,
    parseRegistryDocumentBytes,
    registryDocumentBytes,
} from "./RegistryDocuments.js";
import { readRegularBytes, requireDirectory } from "./RegistryFs.js";
import {
    blobPath,
    blobRecordPath,
    registryPaths,
    resolveRegistryPath,
    tufCatalogTargetPath,
    tufConsistentTargetPath,
    tufItemTargetPath,
    tufReleaseTargetPath,
} from "./RegistryLayout.js";
import { TUF_ROLES, hashTufBytes } from "./TufMetadata.js";
import { TufRepository } from "./TufRepository.js";

export const REGISTRY_HTTP_MAX_RANGE_BYTES = 64 * 1024 * 1024;

function recovery(message, pathName = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName });
}

function roleForTarget(targetPath) {
    if (targetPath === tufCatalogTargetPath()) return TUF_ROLES.CATALOG;
    if (targetPath.startsWith("items/")) return TUF_ROLES.ITEMS;
    if (targetPath.startsWith("releases/")) return TUF_ROLES.RELEASES;
    if (targetPath.startsWith("advisories/")) return TUF_ROLES.ADVISORIES;
    return null;
}

function logicalPathForConsistentTarget(relativePath) {
    let match = /^catalog\/([a-f0-9]{64})\.catalog\.json$/u.exec(relativePath);
    if (match) return { logicalPath: tufCatalogTargetPath(), sha256: match[1] };
    match = /^items\/([a-f0-9]{64})\.([a-z0-9.-]+)\.json$/u.exec(relativePath);
    if (match) {
        try { assertMarketplaceId(match[2], "itemId"); } catch { return null; }
        return { logicalPath: tufItemTargetPath(match[2]), sha256: match[1] };
    }
    match = /^releases\/([a-z0-9.-]+)\/([a-f0-9]{64})\.([0-9A-Za-z.-]+)\.json$/u.exec(relativePath);
    if (match) {
        try { assertMarketplaceId(match[1], "itemId"); assertReleaseVersion(match[3], "releaseVersion"); } catch { return null; }
        return { logicalPath: tufReleaseTargetPath(match[1], match[3]), sha256: match[2] };
    }
    match = /^advisories\/([a-f0-9]{64})\.([a-z0-9.-]+)\.json$/u.exec(relativePath);
    if (match) {
        try { assertMarketplaceId(match[2], "advisoryId"); } catch { return null; }
        return { logicalPath: `advisories/${match[2]}.json`, sha256: match[1] };
    }
    return null;
}

export class MarketplaceRegistryReader {
    constructor(paths, registry, tufRepository) {
        this.paths = paths;
        this.registry = registry;
        this.tufRepository = tufRepository;
        this.verifiedTimestampEtag = null;
    }

    static async open(root, options = {}) {
        const paths = registryPaths(root);
        await requireDirectory(paths.root);
        await requireDirectory(paths.tuf);
        for (const directory of [
            paths.blobs, paths.blobRecords, paths.catalog, paths.transactions,
            paths.tufMetadata, paths.tufTargets, paths.tufTransactions,
        ]) {
            await requireDirectory(directory);
        }
        const registryBytes = await readRegularBytes(paths.registry);
        const registry = parseRegistryDocumentBytes(registryBytes, assertRegistryDocument);
        if (!Buffer.from(registryBytes).equals(Buffer.from(registryDocumentBytes(registry, assertRegistryDocument)))) {
            throw recovery("registry.json is not canonical.", paths.registry);
        }
        return new MarketplaceRegistryReader(paths, registry, new TufRepository(paths, registry, options));
    }

    async verify(options = {}) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const before = await this.readTufMetadata("timestamp.json");
            if (!before) throw recovery("Published TUF timestamp is missing.");
            const result = await this.tufRepository.verify(options);
            const after = await this.readTufMetadata("timestamp.json");
            if (after?.etag === before.etag) {
                this.verifiedTimestampEtag = after.etag;
                return result;
            }
        }
        throw recovery("Published TUF timestamp changed repeatedly during verification.");
    }

    async readPublishedState() {
        const timestamp = await this.readTufMetadata("timestamp.json");
        if (!timestamp) throw recovery("Published TUF timestamp is missing.");
        if (timestamp.etag !== this.verifiedTimestampEtag) await this.verify();
        return this.tufRepository.readPublishedState();
    }

    async readPublishedTarget(targetPath) {
        const role = roleForTarget(targetPath);
        if (!role) return null;
        const state = await this.readPublishedState();
        const target = state.roles[role].metadata.signed.targets[targetPath];
        if (!target) return null;
        const sha256 = target.hashes.sha256;
        const relativePath = tufConsistentTargetPath(target.path, sha256);
        const filePath = path.join(this.paths.tufTargets, ...relativePath.split("/"));
        const bytes = await readRegularBytes(filePath, { maxBytes: MARKETPLACE_LIMITS.catalogBytes });
        if (bytes.byteLength !== target.length || hashTufBytes(bytes) !== sha256) {
            throw recovery("Published TUF target does not match its signed descriptor.", relativePath);
        }
        return Object.freeze({ target, relativePath, filePath, bytes });
    }

    async readPublishedCatalog() {
        return this.readPublishedTarget(tufCatalogTargetPath());
    }

    async readPublishedItem(itemId) {
        return this.readPublishedTarget(tufItemTargetPath(itemId));
    }

    async readPublishedRelease(itemId, releaseVersion) {
        return this.readPublishedTarget(tufReleaseTargetPath(itemId, releaseVersion));
    }

    async openBlob(digest) {
        const recordFile = resolveRegistryPath(this.paths, blobRecordPath(digest));
        const recordStat = await fs.lstat(recordFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!recordStat) return null;
        if (!recordStat.isFile() || recordStat.isSymbolicLink()) throw recovery("Blob record is not a regular file.", recordFile);
        let recordBytes;
        recordBytes = await readRegularBytes(recordFile, { maxBytes: MARKETPLACE_LIMITS.jsonBytes });
        const record = parseRegistryDocumentBytes(recordBytes, assertBlobRecord);
        if (record.sha256 !== digest
            || !Buffer.from(recordBytes).equals(Buffer.from(registryDocumentBytes(record, assertBlobRecord)))) {
            throw recovery("Blob record path, digest, or canonical bytes are invalid.", recordFile);
        }
        const filePath = resolveRegistryPath(this.paths, blobPath(digest));
        const opened = await openRegularFile(filePath).catch((error) => {
            throw recovery("CAS blob is not a stable regular file.", filePath, error);
        });
        if (!opened) return null;
        try {
            if (opened.stat.size !== record.sizeBytes) throw recovery("CAS blob has the wrong size.", filePath);
        } catch (error) {
            await opened.handle.close().catch(() => {});
            throw error;
        }
        return Object.freeze({ record, filePath, handle: opened.handle, sizeBytes: record.sizeBytes, etag: record.sha256 });
    }

    async readTufMetadata(filename) {
        if (!/^(?:timestamp|[1-9][0-9]*\.(?:root|targets|catalog|items|releases|advisories|snapshot))\.json$/u.test(filename)) return null;
        if (filename !== "timestamp.json") {
            const [rawVersion, role] = filename.split(".");
            const version = Number(rawVersion);
            if (role === TUF_ROLES.ROOT) {
                const latest = await this.tufRepository.latestRoot();
                if (version > latest.version) return null;
            } else {
                const state = await this.readPublishedState();
                const publishedVersion = role === TUF_ROLES.SNAPSHOT
                    ? state.snapshot.metadata.signed.version
                    : state.roles[role]?.metadata.signed.version;
                if (version !== publishedVersion) return null;
            }
        }
        const filePath = path.join(this.paths.tufMetadata, filename);
        const stat = await fs.lstat(filePath).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!stat) return null;
        if (!stat.isFile() || stat.isSymbolicLink()) throw recovery("TUF metadata is not a regular file.", filePath);
        const bytes = await readRegularBytes(filePath, { maxBytes: MARKETPLACE_LIMITS.catalogBytes });
        return Object.freeze({ bytes, filePath, etag: hashTufBytes(bytes) });
    }

    async openTufTarget(relativePath) {
        const parsed = logicalPathForConsistentTarget(relativePath);
        if (!parsed) return null;
        const role = roleForTarget(parsed.logicalPath);
        const state = await this.readPublishedState();
        const target = state.roles[role]?.metadata.signed.targets[parsed.logicalPath];
        if (!target || target.hashes.sha256 !== parsed.sha256
            || tufConsistentTargetPath(parsed.logicalPath, parsed.sha256) !== relativePath) return null;
        const filePath = path.join(this.paths.tufTargets, ...relativePath.split("/"));
        const stat = await fs.lstat(filePath).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!stat) return null;
        if (!stat.isFile() || stat.isSymbolicLink()) throw recovery("TUF target is not a regular file.", filePath);
        const bytes = await readRegularBytes(filePath, { maxBytes: MARKETPLACE_LIMITS.catalogBytes });
        if (bytes.byteLength !== target.length || hashTufBytes(bytes) !== parsed.sha256) {
            throw recovery("TUF target filename or descriptor does not match its bytes.", relativePath);
        }
        return Object.freeze({ bytes, filePath, etag: parsed.sha256 });
    }

    async readTufTarget(relativePath) {
        return this.openTufTarget(relativePath);
    }

    async wellKnown() {
        const timestamp = await this.readTufMetadata("timestamp.json");
        if (!timestamp || timestamp.etag !== this.verifiedTimestampEtag) await this.verify();
        const root = await this.tufRepository.latestRoot();
        const rootSha256 = hashTufBytes(root.bytes);
        const document = assertRegistryDiscoveryDocument({
            kind: "cev-sim.marketplace-registry-discovery",
            version: 1,
            registryId: this.registry.registryId,
            apiVersions: ["v1"],
            tuf: {
                metadataBasePath: "/tuf/metadata/",
                targetsBasePath: "/tuf/targets/",
                bootstrapRootPath: `/tuf/metadata/${root.version}.root.json`,
                bootstrapRootSha256: rootSha256,
            },
            authentication: { required: false, schemes: [] },
            limits: {
                ...MARKETPLACE_LIMITS,
                maxRangeBytes: REGISTRY_HTTP_MAX_RANGE_BYTES,
            },
            dnsSd: { serviceType: "_cev-market._tcp", registryId: this.registry.registryId },
        });
        const bytes = registryDocumentBytes(document, assertRegistryDiscoveryDocument);
        return Object.freeze({ document, bytes, etag: hashMarketplaceBytes(bytes) });
    }

    async checkReady() {
        try {
            const tuf = await this.verify();
            const catalog = await this.readPublishedCatalog();
            const document = parseMarketplaceDocument(catalog.bytes);
            if (!Buffer.from(catalog.bytes).equals(Buffer.from(marketplaceDocumentBytes(document)))) {
                throw recovery("Published catalog is not canonical.");
            }
            const currentBytes = await readRegularBytes(this.paths.catalogCurrent, { maxBytes: MARKETPLACE_LIMITS.catalogBytes });
            if (hashMarketplaceBytes(currentBytes) !== catalog.target.hashes.sha256) {
                throw recovery("Published TUF catalog is not reconciled with catalog/current.json.");
            }
            if ((await fs.readdir(this.paths.transactions)).length > 0
                || (await fs.readdir(this.paths.tufTransactions)).length > 0) {
                throw recovery("Registry contains an incomplete durable transaction.");
            }
            return { ok: true, registryId: this.registry.registryId, tuf };
        } catch (error) {
            return { ok: false, code: error?.code ?? "NOT_READY", message: "Marketplace registry is not ready." };
        }
    }
}
