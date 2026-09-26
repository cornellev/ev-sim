import semver from "semver";
import spdxParse from "spdx-expression-parse";

import { PLUGIN_CAPABILITIES } from "../../app/plugin-api/capabilities.js";
import {
    MARKETPLACE_LIMITS,
    artifactContractFor,
} from "./MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";

const MARKETPLACE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAPABILITIES = new Set(PLUGIN_CAPABILITIES);
const PROHIBITED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function invalid(path, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${path}: ${message}`, { path });
}

export function assertMarketplaceId(value, path = "id") {
    if (typeof value !== "string" || value.length > 255 || !MARKETPLACE_ID.test(value)) {
        invalid(path, "expected a lowercase dotted marketplace identifier of at most 255 characters");
    }
    return value;
}

export function assertReleaseVersion(value, path = "releaseVersion") {
    if (typeof value !== "string" || value.includes("+") || semver.valid(value) !== value) {
        invalid(path, "expected canonical SemVer without a leading v or build metadata");
    }
    return value;
}

export function assertSha256(value, path = "sha256") {
    if (typeof value !== "string" || !SHA256.test(value)) invalid(path, "expected a lowercase SHA-256 digest");
    return value;
}

export function assertCanonicalUuid(value, path = "id") {
    if (typeof value !== "string" || !UUID.test(value)) invalid(path, "expected a canonical lowercase UUID");
    return value;
}

export function assertCanonicalTimestamp(value, path = "timestamp") {
    if (typeof value !== "string" || !TIMESTAMP.test(value)) invalid(path, "expected a UTC timestamp with millisecond precision");
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) invalid(path, "expected a valid canonical UTC timestamp");
    return value;
}

export function assertTargetPath(value, path = "target.path") {
    if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")
        || /[%?#]/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
        invalid(path, "expected a normalized relative target path");
    }
    return value;
}

export function assertSourceUrl(value, path = "baseUrl") {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        invalid(path, "expected a canonical HTTP(S) origin URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.pathname !== "/" || parsed.search || parsed.hash || `${parsed.origin}/` !== value) {
        invalid(path, "expected a canonical HTTP(S) origin URL with one trailing slash");
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
        invalid(path, "plain HTTP is restricted to loopback origins");
    }
    return value;
}

export function assertAbsoluteUrl(value, path = "url") {
    try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
    } catch {
        invalid(path, "expected an absolute HTTP(S) URL");
    }
    return value;
}

export function assertSpdxExpression(value, path = "licenseExpression") {
    if (typeof value !== "string" || !value || value.length > 1024) invalid(path, "expected an SPDX license expression");
    try {
        spdxParse(value);
    } catch {
        invalid(path, "expected a valid SPDX license expression");
    }
    return value;
}

export function assertPluginCapability(value, path = "capability") {
    if (!CAPABILITIES.has(value)) invalid(path, `unknown plugin capability ${JSON.stringify(value)}`);
    return value;
}

export function assertArtifactDescriptor(value, contentKind, path = "artifact") {
    const expected = artifactContractFor(contentKind);
    if (!expected) invalid(path, `unknown marketplace content kind ${JSON.stringify(contentKind)}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "expected an artifact descriptor");
    if (value.mediaType !== expected.mediaType) {
        invalid(`${path}.mediaType`, `expected ${expected.mediaType} for ${contentKind}`);
    }
    assertSha256(value.sha256, `${path}.sha256`);
    if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || value.sizeBytes > MARKETPLACE_LIMITS.artifactBytes) {
        invalid(`${path}.sizeBytes`, `expected a safe integer no larger than ${MARKETPLACE_LIMITS.artifactBytes}`);
    }
    return value;
}

export function assertPlainMarketplaceTree(value, path = "$", depth = 0, seen = new WeakSet()) {
    if (depth > MARKETPLACE_LIMITS.jsonDepth) invalid(path, `JSON nesting exceeds ${MARKETPLACE_LIMITS.jsonDepth}`);
    if (typeof value === "string") {
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code >= 0xd800 && code <= 0xdbff) {
                const next = value.charCodeAt(index + 1);
                if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(path, "contains a lone surrogate");
                index += 1;
            } else if (code >= 0xdc00 && code <= 0xdfff) invalid(path, "contains a lone surrogate");
        }
        return;
    }
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) invalid(path, "expected a finite JSON number");
        return;
    }
    if (!value || typeof value !== "object" || typeof value === "bigint") invalid(path, "value is outside the JSON data model");
    if (seen.has(value)) invalid(path, "circular value");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const keys = Object.keys(value);
            if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
                invalid(path, "sparse or extended arrays are outside the JSON data model");
            }
            value.forEach((entry, index) => assertPlainMarketplaceTree(entry, `${path}.${index}`, depth + 1, seen));
            return;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) invalid(path, "expected a plain object");
        for (const [key, entry] of Object.entries(value)) {
            if (PROHIBITED_KEYS.has(key)) invalid(`${path}.${key}`, "prohibited object key");
            assertPlainMarketplaceTree(key, `${path} key`, depth, seen);
            assertPlainMarketplaceTree(entry, `${path}.${key}`, depth + 1, seen);
        }
    } finally {
        seen.delete(value);
    }
}

export function registerMarketplaceFormats(ajv) {
    const wrap = (assertion) => (value) => {
        try {
            assertion(value);
            return true;
        } catch {
            return false;
        }
    };
    ajv.addFormat("marketplace-id", wrap(assertMarketplaceId));
    ajv.addFormat("release-version", wrap(assertReleaseVersion));
    ajv.addFormat("sha256", wrap(assertSha256));
    ajv.addFormat("uuid-lower", wrap(assertCanonicalUuid));
    ajv.addFormat("canonical-timestamp", wrap(assertCanonicalTimestamp));
    ajv.addFormat("target-path", wrap(assertTargetPath));
    ajv.addFormat("source-url", wrap(assertSourceUrl));
    ajv.addFormat("absolute-url", wrap(assertAbsoluteUrl));
    ajv.addFormat("spdx-expression", wrap(assertSpdxExpression));
    ajv.addFormat("plugin-capability", wrap(assertPluginCapability));
    ajv.addFormat("semver-range", (value) => typeof value === "string" && semver.validRange(value) !== null);
    return ajv;
}
