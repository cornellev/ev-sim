import { MARKETPLACE_CONTENT_KINDS, MARKETPLACE_TRACKS } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import {
    assertCanonicalTimestamp,
    assertCanonicalUuid,
    assertMarketplaceId,
    assertReleaseVersion,
    assertSha256,
} from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";

export const MARKETPLACE_PUBLISHER_PROFILE_KIND = "cev-sim.marketplace-publisher-profiles";
export const MARKETPLACE_PUBLISHER_SECRET_KIND = "cev-sim.marketplace-publisher-secret";
export const MARKETPLACE_PUBLICATION_DRAFT_KIND = "cev-sim.marketplace-publication-drafts";
export const MARKETPLACE_PUBLICATION_DOCUMENT_VERSION = 1;

export const PUBLISHABLE_CONTENT_KINDS = Object.freeze([
    "plugin", "vehicle", "run-template", "environment", "asset-pack", "collection",
]);
export const PUBLICATION_DRAFT_STATES = Object.freeze([
    "incomplete", "ready", "preflight-failed", "prepared", "publishing", "needs-attention", "published",
]);

function invalid(path, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${path}: ${message}`, { path });
}

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "expected an object");
    return value;
}

function exactKeys(value, required, optional, path) {
    object(value, path);
    const allowed = new Set([...required, ...optional]);
    for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "is required");
    for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${path}.${key}`, "is not allowed");
}

function string(value, path, { min = 0, max = 262_144 } = {}) {
    if (typeof value !== "string" || value.length < min || value.length > max || value.includes("\u0000")) {
        invalid(path, `expected a string from ${min} through ${max} characters`);
    }
    return value;
}

function integer(value, path, { min = 0 } = {}) {
    if (!Number.isSafeInteger(value) || value < min) invalid(path, `expected a safe integer greater than or equal to ${min}`);
    return value;
}

function denseArray(value, path, max = 1024) {
    if (!Array.isArray(value) || Object.keys(value).length !== value.length || value.length > max) {
        invalid(path, `expected a dense array with at most ${max} entries`);
    }
    return value;
}

function unique(values, key, path) {
    const seen = new Set();
    values.forEach((entry, index) => {
        const current = key(entry);
        if (seen.has(current)) invalid(`${path}.${index}`, "is a duplicate");
        seen.add(current);
    });
}

function cloneFreeze(value) {
    const clone = structuredClone(value);
    const freeze = (entry) => {
        if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
        Object.values(entry).forEach(freeze);
        return Object.freeze(entry);
    };
    return freeze(clone);
}

function assertProfile(value, path) {
    exactKeys(value, [
        "profileId", "sourceId", "registryId", "name", "publisherId", "keyId", "secretRef",
        "revision", "createdAt", "updatedAt",
    ], [], path);
    assertCanonicalUuid(value.profileId, `${path}.profileId`);
    assertCanonicalUuid(value.sourceId, `${path}.sourceId`);
    assertCanonicalUuid(value.registryId, `${path}.registryId`);
    string(value.name, `${path}.name`, { min: 1, max: 128 });
    assertMarketplaceId(value.publisherId, `${path}.publisherId`);
    assertSha256(value.keyId, `${path}.keyId`);
    assertCanonicalUuid(value.secretRef, `${path}.secretRef`);
    integer(value.revision, `${path}.revision`);
    assertCanonicalTimestamp(value.createdAt, `${path}.createdAt`);
    assertCanonicalTimestamp(value.updatedAt, `${path}.updatedAt`);
    return value;
}

export function assertPublisherProfilesDocument(value) {
    exactKeys(value, ["kind", "version", "revision", "profiles"], [], "$profiles");
    if (value.kind !== MARKETPLACE_PUBLISHER_PROFILE_KIND || value.version !== MARKETPLACE_PUBLICATION_DOCUMENT_VERSION) {
        invalid("$profiles.kind", "unsupported publisher-profile document");
    }
    integer(value.revision, "$profiles.revision");
    denseArray(value.profiles, "$profiles.profiles", 256).forEach((entry, index) => assertProfile(entry, `$profiles.profiles.${index}`));
    unique(value.profiles, (entry) => entry.profileId, "$profiles.profiles");
    return cloneFreeze(value);
}

export function assertPublisherSecretDocument(value) {
    exactKeys(value, ["kind", "version", "writeToken", "privateKeyPem"], [], "$secret");
    if (value.kind !== MARKETPLACE_PUBLISHER_SECRET_KIND || value.version !== MARKETPLACE_PUBLICATION_DOCUMENT_VERSION) {
        invalid("$secret.kind", "unsupported publisher-secret document");
    }
    string(value.writeToken, "$secret.writeToken", { min: 1, max: 8192 });
    if (/\s/u.test(value.writeToken)) invalid("$secret.writeToken", "must not contain whitespace");
    string(value.privateKeyPem, "$secret.privateKeyPem", { min: 32, max: 65_536 });
    if (!value.privateKeyPem.includes("PRIVATE KEY")) invalid("$secret.privateKeyPem", "expected a PEM private key");
    return cloneFreeze(value);
}

function assertPreview(value, path) {
    exactKeys(value, ["mediaType", "sha256", "sizeBytes", "alt"], [], path);
    if (!["image/png", "image/jpeg", "image/webp"].includes(value.mediaType)) invalid(`${path}.mediaType`, "unsupported preview media type");
    assertSha256(value.sha256, `${path}.sha256`);
    integer(value.sizeBytes, `${path}.sizeBytes`, { min: 1 });
    string(value.alt, `${path}.alt`, { min: 1, max: 512 });
    return value;
}

function assertItemInput(value, path) {
    exactKeys(value, [
        "itemId", "displayName", "summary", "description", "categories", "tags", "links", "previews",
    ], [], path);
    assertMarketplaceId(value.itemId, `${path}.itemId`);
    string(value.displayName, `${path}.displayName`, { min: 1, max: 256 });
    string(value.summary, `${path}.summary`, { min: 1, max: 1024 });
    string(value.description, `${path}.description`);
    for (const field of ["categories", "tags"]) {
        denseArray(value[field], `${path}.${field}`, 128).forEach((entry, index) => {
            if (typeof entry !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(entry)) invalid(`${path}.${field}.${index}`, "expected a marketplace label");
        });
        unique(value[field], (entry) => entry, `${path}.${field}`);
    }
    denseArray(value.links, `${path}.links`, 64).forEach((entry, index) => {
        const current = `${path}.links.${index}`;
        exactKeys(entry, ["label", "url"], [], current);
        string(entry.label, `${current}.label`, { min: 1, max: 128 });
        string(entry.url, `${current}.url`, { min: 1, max: 2048 });
        let parsed;
        try { parsed = new URL(entry.url); } catch { invalid(`${current}.url`, "expected an absolute URL"); }
        if (!["http:", "https:"].includes(parsed.protocol)) invalid(`${current}.url`, "expected HTTP or HTTPS");
    });
    denseArray(value.previews, `${path}.previews`, 32).forEach((entry, index) => assertPreview(entry, `${path}.previews.${index}`));
    unique(value.previews, (entry) => entry.sha256, `${path}.previews`);
    return value;
}

function assertCompatibility(value, path) {
    exactKeys(value, ["cevSim", "contracts", "platforms", "architectures", "runtimes", "backends", "features"], [], path);
    string(value.cevSim, `${path}.cevSim`, { min: 1, max: 256 });
    denseArray(value.contracts, `${path}.contracts`, 64).forEach((entry, index) => {
        const current = `${path}.contracts.${index}`;
        exactKeys(entry, ["kind", "versions"], [], current);
        string(entry.kind, `${current}.kind`, { min: 1, max: 128 });
        denseArray(entry.versions, `${current}.versions`, 32).forEach((version, versionIndex) => integer(version, `${current}.versions.${versionIndex}`, { min: 1 }));
    });
    for (const field of ["platforms", "architectures", "runtimes", "features"]) {
        denseArray(value[field], `${path}.${field}`, 64).forEach((entry, index) => string(entry, `${path}.${field}.${index}`, { min: 1, max: 128 }));
    }
    denseArray(value.backends, `${path}.backends`, 64).forEach((entry, index) => {
        const current = `${path}.backends.${index}`;
        exactKeys(entry, ["kind", "id", "version"], [], current);
        string(entry.kind, `${current}.kind`, { min: 1, max: 128 });
        string(entry.id, `${current}.id`, { min: 1, max: 128 });
        integer(entry.version, `${current}.version`, { min: 1 });
    });
    return value;
}

function assertReleaseInput(value, path) {
    exactKeys(value, ["releaseVersion", "licenseExpression", "changelog", "track", "compatibility"], [], path);
    assertReleaseVersion(value.releaseVersion, `${path}.releaseVersion`);
    string(value.licenseExpression, `${path}.licenseExpression`, { min: 1, max: 1024 });
    string(value.changelog, `${path}.changelog`);
    if (value.track !== null && !MARKETPLACE_TRACKS.includes(value.track)) invalid(`${path}.track`, "expected null, stable, or beta");
    assertCompatibility(value.compatibility, `${path}.compatibility`);
    return value;
}

function assertExactRelease(value, path) {
    exactKeys(value, ["itemId", "releaseVersion", "artifactSha256"], [], path);
    assertMarketplaceId(value.itemId, `${path}.itemId`);
    assertReleaseVersion(value.releaseVersion, `${path}.releaseVersion`);
    assertSha256(value.artifactSha256, `${path}.artifactSha256`);
    return value;
}

function assertTarget(value, path) {
    object(value, path);
    if (value.type === "draft") {
        exactKeys(value, ["type", "draftId"], [], path);
        assertCanonicalUuid(value.draftId, `${path}.draftId`);
    } else if (value.type === "release") {
        exactKeys(value, ["type", "itemId", "releaseVersion", "artifactSha256"], [], path);
        assertMarketplaceId(value.itemId, `${path}.itemId`);
        assertReleaseVersion(value.releaseVersion, `${path}.releaseVersion`);
        assertSha256(value.artifactSha256, `${path}.artifactSha256`);
    } else invalid(`${path}.type`, "expected draft or release");
    return value;
}

function assertLocalSelection(value, contentKind, path) {
    object(value, path);
    if (value.kind !== contentKind) invalid(`${path}.kind`, `expected ${contentKind}`);
    if (contentKind === "plugin") {
        exactKeys(value, ["kind", "packageHash", "libraryRevision"], [], path);
        assertSha256(value.packageHash, `${path}.packageHash`);
        integer(value.libraryRevision, `${path}.libraryRevision`);
    } else if (contentKind === "vehicle") {
        exactKeys(value, ["kind", "vehicleId", "expectedRevision", "definitionHash"], [], path);
        string(value.vehicleId, `${path}.vehicleId`, { min: 1, max: 256 });
        integer(value.expectedRevision, `${path}.expectedRevision`);
        assertSha256(value.definitionHash, `${path}.definitionHash`);
    } else if (contentKind === "run-template") {
        exactKeys(value, ["kind", "manifestId", "expectedRevision", "definitionHash", "pluginBindings"], [], path);
        string(value.manifestId, `${path}.manifestId`, { min: 1, max: 256 });
        integer(value.expectedRevision, `${path}.expectedRevision`);
        assertSha256(value.definitionHash, `${path}.definitionHash`);
        denseArray(value.pluginBindings, `${path}.pluginBindings`, 256).forEach((entry, index) => {
            const current = `${path}.pluginBindings.${index}`;
            exactKeys(entry, ["packageHash", "target"], [], current);
            assertSha256(entry.packageHash, `${current}.packageHash`);
            assertTarget(entry.target, `${current}.target`);
        });
        unique(value.pluginBindings, (entry) => entry.packageHash, `${path}.pluginBindings`);
    } else if (contentKind === "environment") {
        exactKeys(value, ["kind", "environmentId", "expectedRevision"], [], path);
        string(value.environmentId, `${path}.environmentId`, { min: 1, max: 256 });
        integer(value.expectedRevision, `${path}.expectedRevision`);
    } else if (contentKind === "asset-pack") {
        exactKeys(value, ["kind", "roots", "catalogRevision"], [], path);
        integer(value.catalogRevision, `${path}.catalogRevision`);
        denseArray(value.roots, `${path}.roots`, 1024).forEach((entry, index) => {
            const current = `${path}.roots.${index}`;
            exactKeys(entry, ["assetId", "revision"], [], current);
            string(entry.assetId, `${current}.assetId`, { min: 1, max: 256 });
            integer(entry.revision, `${current}.revision`, { min: 1 });
        });
        if (value.roots.length < 1) invalid(`${path}.roots`, "requires at least one asset revision");
        unique(value.roots, (entry) => `${entry.assetId}@${entry.revision}`, `${path}.roots`);
    } else if (contentKind === "collection") {
        exactKeys(value, ["kind"], [], path);
    } else invalid(`${path}.kind`, "unsupported publication selection");
    return value;
}

function assertDraft(value, path) {
    exactKeys(value, [
        "draftId", "revision", "profileId", "mode", "contentKind", "localSelection", "item", "release",
        "members", "state", "createdAt", "updatedAt",
    ], [], path);
    assertCanonicalUuid(value.draftId, `${path}.draftId`);
    integer(value.revision, `${path}.revision`);
    assertCanonicalUuid(value.profileId, `${path}.profileId`);
    if (!["create-item", "new-release"].includes(value.mode)) invalid(`${path}.mode`, "expected create-item or new-release");
    if (!PUBLISHABLE_CONTENT_KINDS.includes(value.contentKind) || !MARKETPLACE_CONTENT_KINDS.includes(value.contentKind)) {
        invalid(`${path}.contentKind`, "unsupported publisher content kind");
    }
    assertLocalSelection(value.localSelection, value.contentKind, `${path}.localSelection`);
    assertItemInput(value.item, `${path}.item`);
    assertReleaseInput(value.release, `${path}.release`);
    denseArray(value.members, `${path}.members`, 1024).forEach((entry, index) => {
        const current = `${path}.members.${index}`;
        exactKeys(entry, ["target", "group"], [], current);
        assertTarget(entry.target, `${current}.target`);
        if (entry.group !== null) string(entry.group, `${current}.group`, { min: 1, max: 256 });
    });
    if (value.contentKind !== "collection" && value.members.length > 0) invalid(`${path}.members`, "only collection drafts may have members");
    unique(value.members, (entry) => entry.target.type === "draft"
        ? `draft:${entry.target.draftId}`
        : `release:${entry.target.itemId}@${entry.target.releaseVersion}#${entry.target.artifactSha256}`, `${path}.members`);
    if (value.members.some((entry) => entry.target.type === "draft" && entry.target.draftId === value.draftId)) invalid(`${path}.members`, "draft cannot contain itself");
    if (!PUBLICATION_DRAFT_STATES.includes(value.state)) invalid(`${path}.state`, "unknown publication state");
    assertCanonicalTimestamp(value.createdAt, `${path}.createdAt`);
    assertCanonicalTimestamp(value.updatedAt, `${path}.updatedAt`);
    return value;
}

export function assertPublicationDraftsDocument(value) {
    exactKeys(value, ["kind", "version", "revision", "drafts"], [], "$drafts");
    if (value.kind !== MARKETPLACE_PUBLICATION_DRAFT_KIND || value.version !== MARKETPLACE_PUBLICATION_DOCUMENT_VERSION) {
        invalid("$drafts.kind", "unsupported publication-draft document");
    }
    integer(value.revision, "$drafts.revision");
    denseArray(value.drafts, "$drafts.drafts", 4096).forEach((entry, index) => assertDraft(entry, `$drafts.drafts.${index}`));
    unique(value.drafts, (entry) => entry.draftId, "$drafts.drafts");
    return cloneFreeze(value);
}

export function publicationDocumentBytes(value, assertion) {
    return canonicalMarketplaceBytes(assertion(value));
}

export function parsePublicationDocument(bytes, assertion) {
    const { document } = parseMarketplaceJsonBytes(bytes);
    return assertion(document);
}
