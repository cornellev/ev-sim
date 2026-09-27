import path from "node:path";

import {
    assertMarketplaceId,
    assertReleaseVersion,
    assertSha256,
    assertTargetPath,
} from "../MarketplaceFormats.js";

export const REGISTRY_DIRECTORY_MODE = 0o700;
export const REGISTRY_FILE_MODE = 0o600;
export const DEFAULT_STAGING_GRACE_MS = 24 * 60 * 60 * 1000;

export function registryPaths(root) {
    const resolvedRoot = path.resolve(root);
    return Object.freeze({
        root: resolvedRoot,
        registry: path.join(resolvedRoot, "registry.json"),
        writerLock: path.join(resolvedRoot, ".writer-lock"),
        writerOwner: path.join(resolvedRoot, ".writer-lock", "owner.json"),
        writerRecovery: path.join(resolvedRoot, ".writer-lock.recovery"),
        blobs: path.join(resolvedRoot, "blobs", "sha256"),
        blobRecords: path.join(resolvedRoot, "blob-records", "sha256"),
        itemTargets: path.join(resolvedRoot, "targets", "items"),
        releaseTargets: path.join(resolvedRoot, "targets", "releases"),
        catalog: path.join(resolvedRoot, "catalog"),
        catalogCurrent: path.join(resolvedRoot, "catalog", "current.json"),
        catalogRevisions: path.join(resolvedRoot, "catalog", "revisions"),
        transactions: path.join(resolvedRoot, "transactions"),
        uploadStaging: path.join(resolvedRoot, "staging", "uploads"),
        tuf: path.join(resolvedRoot, "tuf"),
        tufMetadata: path.join(resolvedRoot, "tuf", "metadata"),
        tufTargets: path.join(resolvedRoot, "tuf", "targets"),
        tufOnlineKeys: path.join(resolvedRoot, "tuf", "keys", "online"),
        tufTransactions: path.join(resolvedRoot, "tuf", "transactions"),
    });
}

export function itemTargetPath(itemId, itemHash) {
    assertMarketplaceId(itemId, "itemId");
    assertSha256(itemHash, "itemHash");
    return `targets/items/${itemId}/${itemHash}.json`;
}

export function releaseTargetPath(itemId, releaseVersion, releaseHash) {
    assertMarketplaceId(itemId, "itemId");
    assertReleaseVersion(releaseVersion, "releaseVersion");
    assertSha256(releaseHash, "releaseHash");
    return `targets/releases/${itemId}/${releaseVersion}/${releaseHash}.json`;
}

export function catalogRevisionPath(revision, catalogHash) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("Catalog revision must be a positive safe integer.");
    assertSha256(catalogHash, "catalogHash");
    return `catalog/revisions/${revision}-${catalogHash}.json`;
}

export function blobPath(digest) {
    assertSha256(digest, "sha256");
    return `blobs/sha256/${digest}`;
}

export function blobRecordPath(digest) {
    assertSha256(digest, "sha256");
    return `blob-records/sha256/${digest}.json`;
}

export function tufCatalogTargetPath() {
    return "catalog/catalog.json";
}

export function tufItemTargetPath(itemId) {
    assertMarketplaceId(itemId, "itemId");
    return `items/${itemId}.json`;
}

export function tufReleaseTargetPath(itemId, releaseVersion) {
    assertMarketplaceId(itemId, "itemId");
    assertReleaseVersion(releaseVersion, "releaseVersion");
    return `releases/${itemId}/${releaseVersion}.json`;
}

export function tufAdvisoryTargetPath(advisoryId) {
    assertMarketplaceId(advisoryId, "advisoryId");
    return `advisories/${advisoryId}.json`;
}

export function tufConsistentTargetPath(targetPath, sha256) {
    assertTargetPath(targetPath, "targetPath");
    assertSha256(sha256, "sha256");
    const parsed = path.posix.parse(targetPath);
    return path.posix.join(parsed.dir, `${sha256}.${parsed.base}`);
}

export function resolveRegistryPath(paths, relativePath) {
    const destination = path.resolve(paths.root, relativePath);
    if (destination === paths.root || !destination.startsWith(`${paths.root}${path.sep}`)) {
        throw new TypeError("Registry path escapes the registry root.");
    }
    return destination;
}

export function requiredRegistryCoreDirectories(paths) {
    return [
        paths.blobs,
        paths.blobRecords,
        paths.itemTargets,
        paths.releaseTargets,
        paths.catalogRevisions,
        paths.transactions,
        paths.uploadStaging,
    ];
}

export function requiredRegistryDirectories(paths) {
    return [
        ...requiredRegistryCoreDirectories(paths),
        paths.tufMetadata,
        paths.tufTargets,
        paths.tufOnlineKeys,
        paths.tufTransactions,
    ];
}
