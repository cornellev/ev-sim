import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { fsyncDir } from "../../storage/visual-assets/atomicFs.js";
import {
    assertMarketplaceItem,
    assertMarketplaceRelease,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertMarketplaceId, assertReleaseVersion } from "../MarketplaceFormats.js";
import {
    atomicReplaceDurable,
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    removeDirectoryDurable,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import {
    MARKETPLACE_CACHE_POINTER_KIND,
    MARKETPLACE_CLIENT_DOCUMENT_VERSION,
    assertCacheManifest,
    assertCachePointer,
    localDocumentBytes,
    marketplaceClientPaths,
    parseLocalDocument,
    snapshotPaths,
    sourceCachePaths,
} from "./MarketplaceClientLayout.js";
import { verifyClientSnapshot } from "./MarketplaceTrustClient.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function recovery(message, pathName = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName });
}

async function readCanonical(filePath, assertion, maxBytes = 64 * 1024 * 1024) {
    const bytes = await readRegularBytes(filePath, { maxBytes });
    const document = parseLocalDocument(bytes, assertion);
    if (!Buffer.from(bytes).equals(Buffer.from(localDocumentBytes(document, assertion)))) {
        throw recovery("Marketplace client document is not canonical.", filePath);
    }
    return document;
}

async function hardenTree(nodePath) {
    const stat = await fs.lstat(nodePath);
    if (stat.isSymbolicLink()) throw recovery("Marketplace cache contains a symbolic link.", nodePath);
    if (stat.isDirectory()) {
        await fs.chmod(nodePath, DIRECTORY_MODE);
        for (const entry of await fs.readdir(nodePath)) await hardenTree(path.join(nodePath, entry));
        await fsyncDir(nodePath);
        return;
    }
    if (!stat.isFile()) throw recovery("Marketplace cache contains a non-regular node.", nodePath);
    const handle = await fs.open(nodePath, "r+");
    try {
        await handle.chmod(FILE_MODE);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export class MarketplaceVerifiedCache {
    constructor(paths, { now = () => new Date(), fault = null } = {}) {
        this.paths = paths;
        this.now = now;
        this.fault = fault;
    }

    static async open(dataDir, options = {}) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.root);
        await ensureDirectory(paths.cache);
        return new MarketplaceVerifiedCache(paths, options);
    }

    async stageRefresh(sourceId) {
        const sourcePaths = sourceCachePaths(this.paths, sourceId);
        await ensureDirectory(sourcePaths.root);
        await ensureDirectory(sourcePaths.snapshots);
        await ensureDirectory(sourcePaths.staging);
        const snapshotId = randomUUID();
        const root = path.join(sourcePaths.staging, snapshotId);
        await ensureDirectory(root);
        return Object.freeze({
            snapshotId,
            root,
            manifest: path.join(root, "manifest.json"),
            roots: path.join(root, "roots"),
            metadata: path.join(root, "metadata"),
            targets: path.join(root, "targets"),
        });
    }

    async publish(source, staging, result) {
        const manifest = assertCacheManifest(result.manifest);
        if (manifest.sourceId !== source.sourceId || manifest.snapshotId !== staging.snapshotId) {
            throw recovery("Marketplace staged snapshot identity is invalid.", staging.root);
        }
        await writeExclusiveDurable(staging.manifest, localDocumentBytes(manifest, assertCacheManifest));
        await this.fault?.("after-manifest", { source, staging, manifest });
        await verifyClientSnapshot(staging.root, source, {
            now: new Date(manifest.verifiedAt),
            expectedManifest: manifest,
            requireFresh: true,
        });
        await hardenTree(staging.root);
        await this.fault?.("before-snapshot-rename", { source, staging, manifest });
        const final = snapshotPaths(this.paths, source.sourceId, staging.snapshotId);
        if (await lstatOrNull(final.root)) throw recovery("Marketplace snapshot ID already exists.", final.root);
        await fs.rename(staging.root, final.root);
        await fsyncDir(path.dirname(staging.root));
        await fsyncDir(path.dirname(final.root));
        await this.fault?.("before-current-pointer", { source, staging, manifest });
        const pointer = assertCachePointer({
            kind: MARKETPLACE_CACHE_POINTER_KIND,
            version: MARKETPLACE_CLIENT_DOCUMENT_VERSION,
            sourceId: source.sourceId,
            snapshotId: staging.snapshotId,
        });
        await atomicReplaceDurable(
            sourceCachePaths(this.paths, source.sourceId).current,
            localDocumentBytes(pointer, assertCachePointer),
        );
        await this.fault?.("after-current-pointer", { source, staging, manifest });
        return Object.freeze({ manifest, snapshotRoot: final.root });
    }

    async readCurrent(source, { requireFresh = false } = {}) {
        const currentPath = sourceCachePaths(this.paths, source.sourceId).current;
        if (!await lstatOrNull(currentPath)) return null;
        const pointer = await readCanonical(currentPath, assertCachePointer, 16 * 1024);
        if (pointer.sourceId !== source.sourceId) throw recovery("Marketplace cache pointer has the wrong source ID.", currentPath);
        return this.readSnapshot(source, pointer.snapshotId, { requireFresh });
    }

    async readSnapshot(source, snapshotId, { requireFresh = false } = {}) {
        const snapshot = snapshotPaths(this.paths, source.sourceId, snapshotId);
        const manifest = await readCanonical(snapshot.manifest, assertCacheManifest);
        if (manifest.sourceId !== source.sourceId || manifest.registryId !== source.registryId
            || manifest.trustedRootFingerprint !== source.trustedRootFingerprint) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace cache does not match configured trust state.");
        }
        const verified = await verifyClientSnapshot(snapshot.root, source, {
            now: this.now(),
            expectedManifest: manifest,
            requireFresh,
        });
        return Object.freeze({ ...verified, manifest, snapshotRoot: snapshot.root, fresh: !verified.expired });
    }

    async readCatalog(source, options = {}) {
        const current = await this.readCurrent(source, options);
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace source has no verified catalog snapshot.");
        return Object.freeze({ document: current.catalog, fresh: current.fresh, manifest: current.manifest });
    }

    async readItem(source, itemId, options = {}) {
        assertMarketplaceId(itemId, "itemId");
        const current = await this.readCurrent(source, options);
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace source has no verified snapshot.");
        const target = current.manifest.items.find((entry) => entry.itemId === itemId);
        if (!target) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace item is not present in the verified snapshot.");
        const bytes = await readRegularBytes(path.join(current.snapshotRoot, "targets", ...target.path.split("/")));
        const document = assertMarketplaceItem(parseMarketplaceDocument(bytes));
        if (!Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(document)))) {
            throw recovery("Marketplace item cache entry is not canonical.");
        }
        return Object.freeze({ document, fresh: current.fresh, manifest: current.manifest });
    }

    async readRelease(source, itemId, releaseVersion, options = {}) {
        assertMarketplaceId(itemId, "itemId");
        assertReleaseVersion(releaseVersion, "releaseVersion");
        const current = await this.readCurrent(source, options);
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace source has no verified snapshot.");
        const target = current.manifest.releases.find((entry) => entry.itemId === itemId && entry.releaseVersion === releaseVersion);
        if (!target) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace release is not present in the verified snapshot.");
        const bytes = await readRegularBytes(path.join(current.snapshotRoot, "targets", ...target.path.split("/")));
        const document = assertMarketplaceRelease(parseMarketplaceDocument(bytes));
        if (!Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(document)))) {
            throw recovery("Marketplace release cache entry is not canonical.");
        }
        return Object.freeze({ document, fresh: current.fresh, manifest: current.manifest });
    }

    async removeSource(sourceId) {
        const sourcePaths = sourceCachePaths(this.paths, sourceId);
        if (!await lstatOrNull(sourcePaths.root)) return false;
        await removeDirectoryDurable(sourcePaths.root);
        return true;
    }

    async recover(configuredSourceIds) {
        const configured = new Set(configuredSourceIds);
        for (const entry of await fs.readdir(this.paths.cache, { withFileTypes: true })) {
            const sourceRoot = path.join(this.paths.cache, entry.name);
            if (entry.isSymbolicLink() || !entry.isDirectory()) throw recovery("Marketplace cache contains a hostile node.", sourceRoot);
            if (!configured.has(entry.name)) {
                await removeDirectoryDurable(sourceRoot);
                continue;
            }
            const paths = sourceCachePaths(this.paths, entry.name);
            await ensureDirectory(paths.staging);
            for (const staged of await fs.readdir(paths.staging, { withFileTypes: true })) {
                const stagedPath = path.join(paths.staging, staged.name);
                if (staged.isSymbolicLink() || !staged.isDirectory()) throw recovery("Marketplace staging contains a hostile node.", stagedPath);
                await removeDirectoryDurable(stagedPath);
            }
        }
    }
}
