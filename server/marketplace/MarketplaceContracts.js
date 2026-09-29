import semver from "semver";

import { compareUtf8 } from "../../app/math/compareUtf8.js";

import {
    MARKETPLACE_AUTHORITY_KINDS,
    MARKETPLACE_KINDS,
    MARKETPLACE_LIMITS,
    MARKETPLACE_SCHEMA_VERSION,
} from "./MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "./MarketplaceErrors.js";
import {
    assertArtifactDescriptor,
    assertPlainMarketplaceTree,
} from "./MarketplaceFormats.js";
import {
    canonicalMarketplaceBytes,
    hashMarketplaceBytes,
    parseMarketplaceJsonBytes,
} from "./MarketplaceJson.js";
import { marketplaceSchemaName, marketplaceSchemaValidator } from "./MarketplaceSchemas.js";

function invalid(path, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${path}: ${message}`, { path });
}

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const entry of Object.values(value)) deepFreeze(entry, seen);
    return Object.freeze(value);
}

function unique(values, key, path, label) {
    const seen = new Set();
    values.forEach((entry, index) => {
        const current = key(entry);
        if (seen.has(current)) invalid(`${path}.${index}`, `duplicate ${label}`);
        seen.add(current);
    });
}

function releaseKey(value) {
    return `${value.itemId}\u0000${value.releaseVersion}`;
}

function exactReleaseKey(value) {
    return `${releaseKey(value)}\u0000${value.artifactSha256}`;
}

function assertCompatibility(value, path) {
    unique(value.contracts, (entry) => entry.kind, `${path}.contracts`, "contract kind");
    unique(value.backends, (entry) => `${entry.kind}\u0000${entry.id}\u0000${entry.version}`, `${path}.backends`, "backend requirement");
}

function assertRelease(value, path = "$") {
    assertArtifactDescriptor(value.artifact, value.contentKind, `${path}.artifact`);
    assertCompatibility(value.compatibility, `${path}.compatibility`);
    if (value.contentKind !== "plugin" && value.capabilities.length > 0) {
        invalid(`${path}.capabilities`, "only plugin releases may declare plugin capabilities");
    }
    if (value.executable && value.contentKind !== "plugin") {
        invalid(`${path}.executable`, "only plugin releases may declare a direct executable identity");
    }
    unique(value.dependencies, releaseKey, `${path}.dependencies`, "dependency release");
    if (value.dependencies.some((entry) => releaseKey(entry) === releaseKey(value))) {
        invalid(`${path}.dependencies`, "release cannot depend on itself");
    }
    const embeddedPlugins = value.embeddedPlugins ?? [];
    if (embeddedPlugins.length > 0 && !["vehicle", "run-template", "run-package"].includes(value.contentKind)) {
        invalid(`${path}.embeddedPlugins`, "only executable-containing releases may declare embedded plugins");
    }
    unique(embeddedPlugins, (entry) => entry.pluginId, `${path}.embeddedPlugins`, "embedded plugin ID");
    unique(embeddedPlugins, (entry) => entry.packageHash, `${path}.embeddedPlugins`, "embedded plugin package");
    for (let index = 1; index < embeddedPlugins.length; index += 1) {
        const previous = embeddedPlugins[index - 1];
        const current = embeddedPlugins[index];
        if (compareUtf8(previous.pluginId, current.pluginId) >= 0) {
            invalid(`${path}.embeddedPlugins`, "embedded plugins must be in canonical pluginId order");
        }
    }
}

function assertCatalog(value) {
    const publishers = value.publishers ?? [];
    unique(publishers, (entry) => entry.publisherId, "$.publishers", "publisher ID");
    unique(value.items, (entry) => entry.itemId, "$.items", "item ID");
    unique(value.releases, releaseKey, "$.releases", "release tuple");
    const items = new Map(value.items.map((entry) => [entry.itemId, entry]));
    const releases = new Map();
    value.releases.forEach((entry, index) => {
        assertRelease(entry, `$.releases.${index}`);
        const item = items.get(entry.itemId);
        if (!item) invalid(`$.releases.${index}.itemId`, "release summary refers to an item missing from the catalog");
        if (item.publisherId !== entry.publisherId || item.contentKind !== entry.contentKind) {
            invalid(`$.releases.${index}`, "release publisher and content kind must match its item summary");
        }
        releases.set(releaseKey(entry), entry);
    });
    unique(value.tracks, (entry) => `${entry.itemId}\u0000${entry.track}`, "$.tracks", "item track");
    value.tracks.forEach((entry, index) => {
        const release = releases.get(releaseKey(entry));
        if (!release) invalid(`$.tracks.${index}`, "track refers to a release missing from the catalog");
        if (entry.track === "stable" && semver.prerelease(entry.releaseVersion) !== null) {
            invalid(`$.tracks.${index}.releaseVersion`, "stable track cannot select a prerelease");
        }
    });
    unique(value.yanks, (entry) => exactReleaseKey(entry.release), "$.yanks", "yanked release");
    value.yanks.forEach((entry, index) => {
        const release = releases.get(releaseKey(entry.release));
        if (!release || release.artifact.sha256 !== entry.release.artifactSha256) {
            invalid(`$.yanks.${index}.release`, "yank does not match an exact catalog release");
        }
    });
    unique(value.advisories, (entry) => entry.advisoryId, "$.advisories", "advisory reference");
}

function assertSemantic(value) {
    switch (value.kind) {
    case MARKETPLACE_AUTHORITY_KINDS.publisher:
        unique(value.namespaces, (entry) => entry, "$.namespaces", "publisher namespace");
        unique(value.keys, (entry) => entry.keyId, "$.keys", "publisher key ID");
        return;
    case MARKETPLACE_AUTHORITY_KINDS.bootstrap:
        return;
    case MARKETPLACE_KINDS.item:
        return;
    case MARKETPLACE_KINDS.release:
        assertRelease(value);
        return;
    case MARKETPLACE_KINDS.catalog:
        assertCatalog(value);
        return;
    case MARKETPLACE_KINDS.advisory:
        unique(value.affected, (entry) => entry.itemId
            ? `release:${releaseKey(entry)}`
            : entry.artifactSha256
                ? `artifact:${entry.artifactSha256}`
                : `package:${entry.packageHash}`, "$.affected", "affected reference");
        unique(value.supersedes ?? [], (entry) => entry, "$.supersedes", "superseded advisory");
        if (value.action === "clear" && !(value.supersedes?.length > 0)) {
            invalid("$.supersedes", "clear advisories must supersede at least one advisory");
        }
        return;
    case MARKETPLACE_KINDS.collection:
        unique(value.members, (entry) => exactReleaseKey(entry.release), "$.members", "collection release");
        return;
    case MARKETPLACE_KINDS.sources:
        unique(value.sources, (entry) => entry.sourceId, "$.sources", "source ID");
        value.sources.forEach((entry, index) => {
            if (index === 0) return;
            const previous = value.sources[index - 1];
            if (previous.priority > entry.priority
                || (previous.priority === entry.priority && previous.sourceId > entry.sourceId)) {
                invalid("$.sources", "sources must be ordered by priority and then sourceId");
            }
        });
        return;
    case MARKETPLACE_KINDS.installed:
        unique(value.installations, (entry) => `${entry.sourceId}\u0000${exactReleaseKey(entry.release)}`, "$.installations", "installed release");
        unique(value.installations.flatMap((entry) => entry.receiptHashes), (entry) => entry, "$.installations", "receipt reference");
        return;
    case MARKETPLACE_KINDS.installReceipt:
        unique(value.dependencyLock, releaseKey, "$.dependencyLock", "dependency release");
        unique(value.mappings, (entry) => `${entry.resourceKind}\u0000${entry.sourceId}\u0000${entry.sourceRevision ?? ""}`, "$.mappings", "local mapping");
        return;
    default:
        invalid("$.kind", "unsupported marketplace document kind");
    }
}

function schemaError(validate) {
    const issue = validate.errors?.[0];
    const path = issue?.instancePath ? `$${issue.instancePath.replaceAll("/", ".")}` : "$";
    return marketplaceError(
        MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID,
        `${path}: ${issue?.message ?? "marketplace schema validation failed"}`,
        { path },
    );
}

export function assertMarketplaceDocument(value) {
    assertPlainMarketplaceTree(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || !marketplaceSchemaName(value.kind)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.UNSUPPORTED_SCHEMA, "Unsupported marketplace document kind.", { path: "$.kind" });
    }
    if (value.version !== MARKETPLACE_SCHEMA_VERSION) {
        throw marketplaceError(
            MARKETPLACE_ERROR_CODES.UNSUPPORTED_SCHEMA,
            `Unsupported ${value.kind} version ${JSON.stringify(value.version)}.`,
            { path: "$.version" },
        );
    }
    const validate = marketplaceSchemaValidator(value.kind);
    if (!validate(value)) throw schemaError(validate);
    assertSemantic(value);
    return deepFreeze(structuredClone(value));
}

export function validateMarketplaceDocument(value) {
    try {
        return { ok: true, document: assertMarketplaceDocument(value), issues: [] };
    } catch (error) {
        const resolved = error instanceof MarketplaceError
            ? error
            : marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, error.message, { cause: error });
        return {
            ok: false,
            document: null,
            issues: [{ path: resolved.path ?? "$", code: resolved.code, message: resolved.message }],
        };
    }
}

function expectedKind(value, kind) {
    const document = assertMarketplaceDocument(value);
    if (document.kind !== kind) invalid("$.kind", `expected ${kind}`);
    return document;
}

export const assertMarketplaceItem = (value) => expectedKind(value, MARKETPLACE_KINDS.item);
export const assertMarketplacePublisher = (value) => expectedKind(value, MARKETPLACE_AUTHORITY_KINDS.publisher);
export const assertMarketplaceBootstrap = (value) => expectedKind(value, MARKETPLACE_AUTHORITY_KINDS.bootstrap);
export const assertMarketplaceRelease = (value) => expectedKind(value, MARKETPLACE_KINDS.release);
export const assertMarketplaceCatalog = (value) => expectedKind(value, MARKETPLACE_KINDS.catalog);
export const assertMarketplaceAdvisory = (value) => expectedKind(value, MARKETPLACE_KINDS.advisory);
export const assertMarketplaceCollection = (value) => expectedKind(value, MARKETPLACE_KINDS.collection);
export const assertMarketplaceSources = (value) => expectedKind(value, MARKETPLACE_KINDS.sources);
export const assertMarketplaceInstalled = (value) => expectedKind(value, MARKETPLACE_KINDS.installed);
export const assertMarketplaceInstallReceipt = (value) => expectedKind(value, MARKETPLACE_KINDS.installReceipt);

export function parseMarketplaceDocument(input) {
    const { document, byteLength } = parseMarketplaceJsonBytes(input);
    const limit = document?.kind === MARKETPLACE_KINDS.catalog
        ? MARKETPLACE_LIMITS.catalogBytes
        : MARKETPLACE_LIMITS.jsonBytes;
    if (byteLength > limit) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, `${document?.kind ?? "Marketplace document"} exceeds ${limit} bytes.`);
    }
    return assertMarketplaceDocument(document);
}

export function marketplaceDocumentBytes(document) {
    const validated = assertMarketplaceDocument(document);
    const bytes = canonicalMarketplaceBytes(validated);
    const limit = validated.kind === MARKETPLACE_KINDS.catalog
        ? MARKETPLACE_LIMITS.catalogBytes
        : MARKETPLACE_LIMITS.jsonBytes;
    if (bytes.byteLength > limit) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, `${validated.kind} exceeds ${limit} bytes.`);
    }
    return bytes;
}

export function hashMarketplaceDocument(document) {
    return hashMarketplaceBytes(marketplaceDocumentBytes(document));
}

export function hashMarketplaceRelease(release) {
    return hashMarketplaceBytes(marketplaceDocumentBytes(assertMarketplaceRelease(release)));
}
