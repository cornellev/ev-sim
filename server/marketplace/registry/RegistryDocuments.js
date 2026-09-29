import {
    MARKETPLACE_CONTENT_KINDS,
    MARKETPLACE_PREVIEW_MEDIA_TYPES,
} from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import {
    assertCanonicalTimestamp,
    assertCanonicalUuid,
    assertMarketplaceId,
    assertPlainMarketplaceTree,
    assertSha256,
    assertTargetPath,
} from "../MarketplaceFormats.js";
import {
    canonicalMarketplaceBytes,
    hashMarketplaceBytes,
    parseMarketplaceJsonBytes,
} from "../MarketplaceJson.js";

export const REGISTRY_DOCUMENT_KIND = "cev-sim.marketplace-registry";
export const BLOB_RECORD_KIND = "cev-sim.marketplace-registry-blob";
export const TRANSACTION_JOURNAL_KIND = "cev-sim.marketplace-registry-transaction";
export const TUF_TRANSACTION_JOURNAL_KIND = "cev-sim.marketplace-tuf-transaction";
export const REGISTRY_DISCOVERY_KIND = "cev-sim.marketplace-registry-discovery";
export const REGISTRY_DOCUMENT_VERSION = 1;

const contentKinds = new Set(MARKETPLACE_CONTENT_KINDS);
const previewMediaTypes = new Set(MARKETPLACE_PREVIEW_MEDIA_TYPES);

function invalid(path, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${path}: ${message}`, { path });
}

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "expected an object");
    return value;
}

function exactKeys(value, required, path) {
    const expected = new Set(required);
    for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "is required");
    for (const key of Object.keys(value)) if (!expected.has(key)) invalid(`${path}.${key}`, "is not allowed");
}

function nonNegativeSize(value, path) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(path, "expected a non-negative safe integer");
}

function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

function validatedClone(value) {
    assertPlainMarketplaceTree(value);
    return freeze(structuredClone(value));
}

export function assertRegistryDocument(value) {
    object(value, "$");
    exactKeys(value, ["kind", "version", "registryId", "createdAt"], "$");
    if (value.kind !== REGISTRY_DOCUMENT_KIND) invalid("$.kind", `expected ${REGISTRY_DOCUMENT_KIND}`);
    if (value.version !== REGISTRY_DOCUMENT_VERSION) invalid("$.version", "expected version 1");
    assertCanonicalUuid(value.registryId, "$.registryId");
    assertCanonicalTimestamp(value.createdAt, "$.createdAt");
    return validatedClone(value);
}

export function assertBlobRecord(value) {
    object(value, "$");
    exactKeys(value, ["kind", "version", "sha256", "sizeBytes", "mediaType", "usage"], "$");
    if (value.kind !== BLOB_RECORD_KIND) invalid("$.kind", `expected ${BLOB_RECORD_KIND}`);
    if (value.version !== REGISTRY_DOCUMENT_VERSION) invalid("$.version", "expected version 1");
    assertSha256(value.sha256, "$.sha256");
    nonNegativeSize(value.sizeBytes, "$.sizeBytes");
    if (typeof value.mediaType !== "string" || !value.mediaType || value.mediaType.length > 255) {
        invalid("$.mediaType", "expected a non-empty media type");
    }
    object(value.usage, "$.usage");
    if (value.usage.type === "artifact") {
        exactKeys(value.usage, ["type", "contentKind", "adapterId", "inspection"], "$.usage");
        if (!contentKinds.has(value.usage.contentKind)) invalid("$.usage.contentKind", "unsupported content kind");
        if (typeof value.usage.adapterId !== "string" || !value.usage.adapterId) invalid("$.usage.adapterId", "expected adapter ID");
        object(value.usage.inspection, "$.usage.inspection");
    } else if (value.usage.type === "preview") {
        exactKeys(value.usage, ["type", "format", "width", "height", "pages"], "$.usage");
        if (!previewMediaTypes.has(value.mediaType)) invalid("$.mediaType", "unsupported preview media type");
        if (typeof value.usage.format !== "string" || !value.usage.format) invalid("$.usage.format", "expected image format");
        for (const key of ["width", "height", "pages"]) {
            if (!Number.isSafeInteger(value.usage[key]) || value.usage[key] < 1) invalid(`$.usage.${key}`, "expected a positive integer");
        }
    } else {
        invalid("$.usage.type", "expected artifact or preview");
    }
    return validatedClone(value);
}

function catalogIdentity(value, path) {
    object(value, path);
    exactKeys(value, ["revision", "sha256"], path);
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) invalid(`${path}.revision`, "expected a positive catalog revision");
    assertSha256(value.sha256, `${path}.sha256`);
}

export function assertTransactionJournal(value) {
    object(value, "$");
    exactKeys(value, ["kind", "version", "transactionId", "operation", "baseCatalog", "targetCatalog", "writes"], "$");
    if (value.kind !== TRANSACTION_JOURNAL_KIND) invalid("$.kind", `expected ${TRANSACTION_JOURNAL_KIND}`);
    if (value.version !== REGISTRY_DOCUMENT_VERSION) invalid("$.version", "expected version 1");
    assertCanonicalUuid(value.transactionId, "$.transactionId");
    if (typeof value.operation !== "string" || !value.operation || value.operation.length > 128) invalid("$.operation", "expected operation name");
    catalogIdentity(value.baseCatalog, "$.baseCatalog");
    object(value.targetCatalog, "$.targetCatalog");
    exactKeys(value.targetCatalog, ["revision", "sha256", "sizeBytes"], "$.targetCatalog");
    if (!Number.isSafeInteger(value.targetCatalog.revision) || value.targetCatalog.revision < 1) invalid("$.targetCatalog.revision", "expected a positive catalog revision");
    assertSha256(value.targetCatalog.sha256, "$.targetCatalog.sha256");
    nonNegativeSize(value.targetCatalog.sizeBytes, "$.targetCatalog.sizeBytes");
    if (value.targetCatalog.revision !== value.baseCatalog.revision + 1) invalid("$.targetCatalog.revision", "must increment the base revision exactly once");
    if (!Array.isArray(value.writes) || value.writes.length < 2) invalid("$.writes", "expected transaction writes");
    const destinations = new Set();
    value.writes.forEach((write, index) => {
        const pathName = `$.writes.${index}`;
        object(write, pathName);
        exactKeys(write, ["stagedPath", "destinationPath", "sha256", "sizeBytes"], pathName);
        assertTargetPath(write.stagedPath, `${pathName}.stagedPath`);
        assertTargetPath(write.destinationPath, `${pathName}.destinationPath`);
        assertSha256(write.sha256, `${pathName}.sha256`);
        nonNegativeSize(write.sizeBytes, `${pathName}.sizeBytes`);
        if (destinations.has(write.destinationPath)) invalid(`${pathName}.destinationPath`, "duplicate transaction destination");
        destinations.add(write.destinationPath);
    });
    if (!destinations.has("catalog/current.json")) invalid("$.writes", "must replace catalog/current.json");
    return validatedClone(value);
}

function timestampIdentity(value, path) {
    object(value, path);
    exactKeys(value, ["version", "sha256"], path);
    if (!Number.isSafeInteger(value.version) || value.version < 1) invalid(`${path}.version`, "expected a positive timestamp version");
    assertSha256(value.sha256, `${path}.sha256`);
}

function tufTransactionWrite(value, path) {
    object(value, path);
    exactKeys(value, ["phase", "stagedPath", "destinationPath", "sha256", "sizeBytes"], path);
    if (!["target", "delegated", "targets", "snapshot", "timestamp-history", "root"].includes(value.phase)) invalid(`${path}.phase`, "unsupported TUF write phase");
    assertTargetPath(value.stagedPath, `${path}.stagedPath`);
    assertTargetPath(value.destinationPath, `${path}.destinationPath`);
    assertSha256(value.sha256, `${path}.sha256`);
    nonNegativeSize(value.sizeBytes, `${path}.sizeBytes`);
}

export function assertTufTransactionJournal(value) {
    object(value, "$");
    exactKeys(value, [
        "kind", "version", "transactionId", "operation", "registryId", "catalog",
        "baseTimestamp", "targetTimestamp", "writes", "timestampWrite", "postTimestampWrites",
    ], "$");
    if (value.kind !== TUF_TRANSACTION_JOURNAL_KIND) invalid("$.kind", `expected ${TUF_TRANSACTION_JOURNAL_KIND}`);
    if (value.version !== REGISTRY_DOCUMENT_VERSION) invalid("$.version", "expected version 1");
    assertCanonicalUuid(value.transactionId, "$.transactionId");
    assertCanonicalUuid(value.registryId, "$.registryId");
    if (typeof value.operation !== "string" || !value.operation || value.operation.length > 128) invalid("$.operation", "expected operation name");
    catalogIdentity(value.catalog, "$.catalog");
    timestampIdentity(value.baseTimestamp, "$.baseTimestamp");
    timestampIdentity(value.targetTimestamp, "$.targetTimestamp");
    if (value.targetTimestamp.version !== value.baseTimestamp.version + 1) {
        invalid("$.targetTimestamp.version", "must increment the base timestamp version exactly once");
    }
    if (!Array.isArray(value.writes)) invalid("$.writes", "expected an ordered write array");
    const destinations = new Set();
    value.writes.forEach((write, index) => {
        tufTransactionWrite(write, `$.writes.${index}`);
        if (write.destinationPath === "metadata/timestamp.json") invalid(`$.writes.${index}.destinationPath`, "timestamp must be the final replacement");
        if (destinations.has(write.destinationPath)) invalid(`$.writes.${index}.destinationPath`, "duplicate TUF destination");
        destinations.add(write.destinationPath);
    });
    object(value.timestampWrite, "$.timestampWrite");
    exactKeys(value.timestampWrite, ["stagedPath", "destinationPath", "sha256", "sizeBytes"], "$.timestampWrite");
    assertTargetPath(value.timestampWrite.stagedPath, "$.timestampWrite.stagedPath");
    if (value.timestampWrite.destinationPath !== "metadata/timestamp.json") invalid("$.timestampWrite.destinationPath", "must replace metadata/timestamp.json");
    assertSha256(value.timestampWrite.sha256, "$.timestampWrite.sha256");
    nonNegativeSize(value.timestampWrite.sizeBytes, "$.timestampWrite.sizeBytes");
    if (value.timestampWrite.sha256 !== value.targetTimestamp.sha256) invalid("$.timestampWrite.sha256", "must match targetTimestamp.sha256");
    if (!Array.isArray(value.postTimestampWrites)) invalid("$.postTimestampWrites", "expected an ordered write array");
    value.postTimestampWrites.forEach((write, index) => {
        const writePath = `$.postTimestampWrites.${index}`;
        tufTransactionWrite(write, writePath);
        if (write.phase !== "root") invalid(`${writePath}.phase`, "only root metadata may follow timestamp publication");
        if (destinations.has(write.destinationPath)) invalid(`${writePath}.destinationPath`, "duplicate TUF destination");
        destinations.add(write.destinationPath);
    });
    return validatedClone(value);
}

export function assertRegistryDiscoveryDocument(value) {
    object(value, "$");
    exactKeys(value, ["kind", "version", "registryId", "apiVersions", "tuf", "authentication", "limits", "dnsSd"], "$");
    if (value.kind !== REGISTRY_DISCOVERY_KIND) invalid("$.kind", `expected ${REGISTRY_DISCOVERY_KIND}`);
    if (value.version !== REGISTRY_DOCUMENT_VERSION) invalid("$.version", "expected version 1");
    assertCanonicalUuid(value.registryId, "$.registryId");
    if (!Array.isArray(value.apiVersions) || value.apiVersions.length !== 1 || value.apiVersions[0] !== "v1") invalid("$.apiVersions", "expected only v1");
    object(value.tuf, "$.tuf");
    exactKeys(value.tuf, ["metadataBasePath", "targetsBasePath", "bootstrapRootPath", "bootstrapRootSha256"], "$.tuf");
    if (value.tuf.metadataBasePath !== "/tuf/metadata/") invalid("$.tuf.metadataBasePath", "unexpected TUF metadata path");
    if (value.tuf.targetsBasePath !== "/tuf/targets/") invalid("$.tuf.targetsBasePath", "unexpected TUF targets path");
    if (!/^\/tuf\/metadata\/[1-9][0-9]*\.root\.json$/u.test(value.tuf.bootstrapRootPath)) invalid("$.tuf.bootstrapRootPath", "expected a numbered root path");
    assertSha256(value.tuf.bootstrapRootSha256, "$.tuf.bootstrapRootSha256");
    object(value.authentication, "$.authentication");
    exactKeys(value.authentication, ["required", "schemes"], "$.authentication");
    if (typeof value.authentication.required !== "boolean" || !Array.isArray(value.authentication.schemes)
        || value.authentication.schemes.some((scheme) => scheme !== "bearer")
        || (value.authentication.required && value.authentication.schemes.length !== 1)
        || (!value.authentication.required && value.authentication.schemes.length !== 0)) {
        invalid("$.authentication", "expected disabled authentication or required bearer authentication");
    }
    object(value.limits, "$.limits");
    exactKeys(value.limits, ["jsonBytes", "catalogBytes", "jsonDepth", "artifactBytes", "previewBytes", "maxRangeBytes"], "$.limits");
    for (const key of Object.keys(value.limits)) nonNegativeSize(value.limits[key], `$.limits.${key}`);
    object(value.dnsSd, "$.dnsSd");
    exactKeys(value.dnsSd, ["serviceType", "registryId"], "$.dnsSd");
    if (value.dnsSd.serviceType !== "_cev-market._tcp") invalid("$.dnsSd.serviceType", "unexpected DNS-SD service type");
    assertCanonicalUuid(value.dnsSd.registryId, "$.dnsSd.registryId");
    if (value.dnsSd.registryId !== value.registryId) invalid("$.dnsSd.registryId", "must match registryId");
    return validatedClone(value);
}

export function registryDocumentBytes(document, assertion) {
    return canonicalMarketplaceBytes(assertion(document));
}

export function parseRegistryDocumentBytes(bytes, assertion) {
    const { document } = parseMarketplaceJsonBytes(bytes);
    return assertion(document);
}

export function hashRegistryBytes(bytes) {
    return hashMarketplaceBytes(bytes);
}

export function createRegistryDocument(registryId, now = () => new Date()) {
    assertCanonicalUuid(registryId, "registryId");
    return assertRegistryDocument({
        kind: REGISTRY_DOCUMENT_KIND,
        version: REGISTRY_DOCUMENT_VERSION,
        registryId,
        createdAt: now().toISOString(),
    });
}
