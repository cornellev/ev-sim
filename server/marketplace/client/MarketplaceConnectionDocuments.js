import path from "node:path";

import {
    assertMarketplaceId,
    assertSha256,
    assertSourceUrl,
    assertSpdxExpression,
} from "../MarketplaceFormats.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { parseMarketplaceJsonBytes } from "../MarketplaceJson.js";

export const MARKETPLACE_CONNECTION_KIND = "cev-sim.marketplace-connection";
export const MARKETPLACE_CONNECTION_VERSION = 1;

export function normalizeMarketplaceOrigin(value) {
    let parsed;
    try { parsed = new URL(value); } catch { invalid("baseUrl", "expected an HTTP(S) registry origin"); }
    if (parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)
        || !["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash) {
        invalid("baseUrl", "expected an HTTP(S) registry origin without a path, credentials, query, or fragment");
    }
    const normalized = `${parsed.origin}/`;
    assertSourceUrl(normalized, "baseUrl");
    return normalized;
}

function invalid(pathName, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, `${pathName}: ${message}`, { path: pathName });
}

function object(value, pathName) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(pathName, "expected an object");
}

function exactKeys(value, required, optional, pathName) {
    object(value, pathName);
    const allowed = new Set([...required, ...optional]);
    for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${pathName}.${key}`, "is required");
    for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${pathName}.${key}`, "is not allowed");
}

function boundedString(value, pathName, { max = 256 } = {}) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || value.includes("\u0000")) {
        invalid(pathName, "expected a bounded non-empty string without surrounding whitespace");
    }
    return value;
}

function relativeFile(value, pathName) {
    boundedString(value, pathName, { max: 512 });
    if (path.isAbsolute(value) || value.includes("\\") || value.includes("/")) {
        invalid(pathName, "expected a file name contained directly by the connection bundle");
    }
    return value;
}

function assertIdentity(value, pathName) {
    exactKeys(value, ["name", "publisherId", "writeTokenFile", "privateKeyFile", "default", "defaults"], [], pathName);
    boundedString(value.name, `${pathName}.name`);
    assertMarketplaceId(value.publisherId, `${pathName}.publisherId`);
    relativeFile(value.writeTokenFile, `${pathName}.writeTokenFile`);
    relativeFile(value.privateKeyFile, `${pathName}.privateKeyFile`);
    if (typeof value.default !== "boolean") invalid(`${pathName}.default`, "expected a boolean");
    exactKeys(value.defaults, ["track", "license"], [], `${pathName}.defaults`);
    if (!["stable", "beta"].includes(value.defaults.track)) invalid(`${pathName}.defaults.track`, "expected stable or beta");
    assertSpdxExpression(value.defaults.license, `${pathName}.defaults.license`);
}

function freeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
}

export function assertMarketplaceConnectionDocument(value) {
    exactKeys(value, [
        "kind", "version", "origin", "displayName", "trustedRootSha256", "readCredentialFile",
        "autoApprovePublisherIds", "publishingIdentities",
    ], [], "$connection");
    if (value.kind !== MARKETPLACE_CONNECTION_KIND || value.version !== MARKETPLACE_CONNECTION_VERSION) {
        invalid("$connection.kind", "unsupported marketplace connection document");
    }
    assertSourceUrl(value.origin, "$connection.origin");
    boundedString(value.displayName, "$connection.displayName");
    assertSha256(value.trustedRootSha256, "$connection.trustedRootSha256");
    relativeFile(value.readCredentialFile, "$connection.readCredentialFile");
    if (!Array.isArray(value.autoApprovePublisherIds) || !Array.isArray(value.publishingIdentities)) {
        invalid("$connection", "expected publisher approval and identity arrays");
    }
    const approvals = new Set();
    value.autoApprovePublisherIds.forEach((publisherId, index) => {
        assertMarketplaceId(publisherId, `$connection.autoApprovePublisherIds.${index}`);
        if (approvals.has(publisherId)) invalid(`$connection.autoApprovePublisherIds.${index}`, "duplicate publisher ID");
        approvals.add(publisherId);
    });
    const identities = new Set();
    let defaultCount = 0;
    value.publishingIdentities.forEach((identity, index) => {
        assertIdentity(identity, `$connection.publishingIdentities.${index}`);
        if (identities.has(identity.publisherId)) invalid(`$connection.publishingIdentities.${index}.publisherId`, "duplicate publisher identity");
        identities.add(identity.publisherId);
        if (identity.default) defaultCount += 1;
    });
    if (defaultCount > 1 || (value.publishingIdentities.length > 0 && defaultCount !== 1)) {
        invalid("$connection.publishingIdentities", "exactly one configured publishing identity must be the default");
    }
    return freeze(structuredClone(value));
}

export function parseMarketplaceConnectionDocument(bytes) {
    const { document } = parseMarketplaceJsonBytes(bytes);
    return assertMarketplaceConnectionDocument(document);
}
