import path from "node:path";

import {
    assertCanonicalTimestamp,
    assertCanonicalUuid,
    assertMarketplaceId,
    assertReleaseVersion,
    assertSha256,
    assertTargetPath,
} from "../MarketplaceFormats.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";

export const MARKETPLACE_CREDENTIAL_KIND = "cev-sim.marketplace-credential";
export const MARKETPLACE_HEALTH_KIND = "cev-sim.marketplace-source-health";
export const MARKETPLACE_CACHE_POINTER_KIND = "cev-sim.marketplace-cache-current";
export const MARKETPLACE_CACHE_MANIFEST_KIND = "cev-sim.marketplace-cache-snapshot";
export const MARKETPLACE_CLIENT_DOCUMENT_VERSION = 1;

function invalid(pathName, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${pathName}: ${message}`, { path: pathName });
}

function object(value, pathName) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(pathName, "expected an object");
    return value;
}

function exactKeys(value, keys, pathName) {
    const expected = new Set(keys);
    for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${pathName}.${key}`, "is required");
    for (const key of Object.keys(value)) if (!expected.has(key)) invalid(`${pathName}.${key}`, "is not allowed");
}

function nullableTimestamp(value, pathName) {
    if (value !== null) assertCanonicalTimestamp(value, pathName);
}

function nullableString(value, pathName) {
    if (value !== null && (typeof value !== "string" || !value || value.length > 128)) {
        invalid(pathName, "expected null or a bounded non-empty string");
    }
}

function positiveInteger(value, pathName) {
    if (!Number.isSafeInteger(value) || value < 1) invalid(pathName, "expected a positive safe integer");
}

function nonNegativeInteger(value, pathName) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(pathName, "expected a non-negative safe integer");
}

function frozenClone(value) {
    const copy = structuredClone(value);
    const freeze = (entry) => {
        if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
        Object.values(entry).forEach(freeze);
        return Object.freeze(entry);
    };
    return freeze(copy);
}

export function marketplaceClientPaths(dataDir) {
    const root = path.resolve(dataDir, "marketplace");
    return Object.freeze({
        root,
        sources: path.join(root, "sources.json"),
        credentials: path.join(root, "credentials"),
        trust: path.join(root, "trust"),
        health: path.join(root, "health"),
        cache: path.join(root, "cache"),
    });
}

export function credentialPath(paths, credentialRef) {
    assertCanonicalUuid(credentialRef, "credentialRef");
    return path.join(paths.credentials, `${credentialRef}.json`);
}

export function trustRootPath(paths, sourceId) {
    assertCanonicalUuid(sourceId, "sourceId");
    return path.join(paths.trust, sourceId, "root.json");
}

export function healthPath(paths, sourceId) {
    assertCanonicalUuid(sourceId, "sourceId");
    return path.join(paths.health, `${sourceId}.json`);
}

export function sourceCachePaths(paths, sourceId) {
    assertCanonicalUuid(sourceId, "sourceId");
    const root = path.join(paths.cache, sourceId);
    return Object.freeze({
        root,
        current: path.join(root, "current.json"),
        snapshots: path.join(root, "snapshots"),
        staging: path.join(root, "staging"),
    });
}

export function snapshotPaths(paths, sourceId, snapshotId) {
    assertCanonicalUuid(snapshotId, "snapshotId");
    const source = sourceCachePaths(paths, sourceId);
    const root = path.join(source.snapshots, snapshotId);
    return Object.freeze({
        root,
        manifest: path.join(root, "manifest.json"),
        roots: path.join(root, "roots"),
        metadata: path.join(root, "metadata"),
        targets: path.join(root, "targets"),
    });
}

export function assertCredentialDocument(value) {
    object(value, "$credential");
    exactKeys(value, ["kind", "version", "type", "token"], "$credential");
    if (value.kind !== MARKETPLACE_CREDENTIAL_KIND || value.version !== MARKETPLACE_CLIENT_DOCUMENT_VERSION) {
        invalid("$credential.kind", "unsupported credential document");
    }
    if (value.type !== "bearer") invalid("$credential.type", "expected bearer");
    if (typeof value.token !== "string" || value.token.length < 1 || Buffer.byteLength(value.token) > 8 * 1024
        || /[\u0000-\u0020\u007f]/u.test(value.token)) {
        invalid("$credential.token", "expected a non-empty bearer token without control characters or whitespace");
    }
    return frozenClone(value);
}

export function assertHealthDocument(value) {
    object(value, "$health");
    exactKeys(value, [
        "kind", "version", "sourceId", "lastAttemptAt", "lastSuccessAt", "lastErrorCode",
        "snapshotId", "catalogRevision", "catalogSha256", "earliestExpiryAt",
    ], "$health");
    if (value.kind !== MARKETPLACE_HEALTH_KIND || value.version !== MARKETPLACE_CLIENT_DOCUMENT_VERSION) {
        invalid("$health.kind", "unsupported health document");
    }
    assertCanonicalUuid(value.sourceId, "$health.sourceId");
    nullableTimestamp(value.lastAttemptAt, "$health.lastAttemptAt");
    nullableTimestamp(value.lastSuccessAt, "$health.lastSuccessAt");
    nullableString(value.lastErrorCode, "$health.lastErrorCode");
    if (value.lastErrorCode !== null && !Object.values(MARKETPLACE_ERROR_CODES).includes(value.lastErrorCode)) {
        invalid("$health.lastErrorCode", "unknown marketplace error code");
    }
    if (value.snapshotId !== null) assertCanonicalUuid(value.snapshotId, "$health.snapshotId");
    if (value.catalogRevision !== null) positiveInteger(value.catalogRevision, "$health.catalogRevision");
    if (value.catalogSha256 !== null) assertSha256(value.catalogSha256, "$health.catalogSha256");
    nullableTimestamp(value.earliestExpiryAt, "$health.earliestExpiryAt");
    return frozenClone(value);
}

export function createEmptyHealth(sourceId) {
    return assertHealthDocument({
        kind: MARKETPLACE_HEALTH_KIND,
        version: MARKETPLACE_CLIENT_DOCUMENT_VERSION,
        sourceId,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        snapshotId: null,
        catalogRevision: null,
        catalogSha256: null,
        earliestExpiryAt: null,
    });
}

export function assertCachePointer(value) {
    object(value, "$pointer");
    exactKeys(value, ["kind", "version", "sourceId", "snapshotId"], "$pointer");
    if (value.kind !== MARKETPLACE_CACHE_POINTER_KIND || value.version !== MARKETPLACE_CLIENT_DOCUMENT_VERSION) {
        invalid("$pointer.kind", "unsupported cache pointer");
    }
    assertCanonicalUuid(value.sourceId, "$pointer.sourceId");
    assertCanonicalUuid(value.snapshotId, "$pointer.snapshotId");
    return frozenClone(value);
}

function assertMetadataRecord(value, pathName) {
    object(value, pathName);
    exactKeys(value, ["version", "sha256", "expiresAt"], pathName);
    positiveInteger(value.version, `${pathName}.version`);
    assertSha256(value.sha256, `${pathName}.sha256`);
    assertCanonicalTimestamp(value.expiresAt, `${pathName}.expiresAt`);
}

function assertTargetRecord(value, pathName, kind) {
    object(value, pathName);
    const keys = kind === "catalog"
        ? ["path", "sha256", "sizeBytes", "revision"]
        : kind === "item"
            ? ["path", "sha256", "sizeBytes", "itemId"]
            : ["path", "sha256", "sizeBytes", "itemId", "releaseVersion", "releaseHash", "artifactSha256"];
    exactKeys(value, keys, pathName);
    assertTargetPath(value.path, `${pathName}.path`);
    assertSha256(value.sha256, `${pathName}.sha256`);
    nonNegativeInteger(value.sizeBytes, `${pathName}.sizeBytes`);
    if (kind === "catalog") positiveInteger(value.revision, `${pathName}.revision`);
    else {
        assertMarketplaceId(value.itemId, `${pathName}.itemId`);
        if (kind === "release") {
            assertReleaseVersion(value.releaseVersion, `${pathName}.releaseVersion`);
            assertSha256(value.releaseHash, `${pathName}.releaseHash`);
            assertSha256(value.artifactSha256, `${pathName}.artifactSha256`);
        }
    }
}

export function assertCacheManifest(value) {
    object(value, "$manifest");
    exactKeys(value, [
        "kind", "version", "snapshotId", "sourceId", "registryId", "verifiedAt",
        "bootstrapRootVersion", "trustedRootFingerprint", "root", "timestamp", "snapshot",
        "roles", "catalog", "items", "releases",
    ], "$manifest");
    if (value.kind !== MARKETPLACE_CACHE_MANIFEST_KIND || value.version !== MARKETPLACE_CLIENT_DOCUMENT_VERSION) {
        invalid("$manifest.kind", "unsupported cache manifest");
    }
    assertCanonicalUuid(value.snapshotId, "$manifest.snapshotId");
    assertCanonicalUuid(value.sourceId, "$manifest.sourceId");
    assertCanonicalUuid(value.registryId, "$manifest.registryId");
    assertCanonicalTimestamp(value.verifiedAt, "$manifest.verifiedAt");
    positiveInteger(value.bootstrapRootVersion, "$manifest.bootstrapRootVersion");
    assertSha256(value.trustedRootFingerprint, "$manifest.trustedRootFingerprint");
    assertMetadataRecord(value.root, "$manifest.root");
    assertMetadataRecord(value.timestamp, "$manifest.timestamp");
    assertMetadataRecord(value.snapshot, "$manifest.snapshot");
    object(value.roles, "$manifest.roles");
    exactKeys(value.roles, ["targets", "catalog", "items", "releases", "advisories"], "$manifest.roles");
    for (const [role, entry] of Object.entries(value.roles)) assertMetadataRecord(entry, `$manifest.roles.${role}`);
    assertTargetRecord(value.catalog, "$manifest.catalog", "catalog");
    if (!Array.isArray(value.items) || !Array.isArray(value.releases)) invalid("$manifest", "expected item and release arrays");
    value.items.forEach((entry, index) => assertTargetRecord(entry, `$manifest.items.${index}`, "item"));
    value.releases.forEach((entry, index) => assertTargetRecord(entry, `$manifest.releases.${index}`, "release"));
    return frozenClone(value);
}

export function localDocumentBytes(value, assertion) {
    return canonicalMarketplaceBytes(assertion(value));
}

export function parseLocalDocument(bytes, assertion) {
    const { document } = parseMarketplaceJsonBytes(bytes);
    return assertion(document);
}
