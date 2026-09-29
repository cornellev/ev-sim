import {
    createHash,
    randomBytes,
    randomUUID,
    timingSafeEqual,
} from "node:crypto";

import { MARKETPLACE_TOKEN_SCOPES } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalTimestamp, assertCanonicalUuid, assertMarketplaceId } from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import {
    atomicReplaceDurable,
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "./RegistryFs.js";

const AUTH_KIND = "cev-sim.marketplace-registry-auth";
const AUTH_VERSION = 1;
const TOKEN_SUBJECTS = new Set(["reader", "publisher", "admin"]);
const TOKEN_SCOPES = new Set(MARKETPLACE_TOKEN_SCOPES);
const TOKEN_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;
const DUMMY_DIGEST = Buffer.alloc(32, 0xa5);

function invalid(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, message);
}

function assertTokenRecord(record) {
    const allowed = new Set([
        "tokenId", "digest", "subject", "publisherId", "namespaces", "scopes", "createdAt", "revokedAt",
    ]);
    if (!record || typeof record !== "object" || Array.isArray(record)) throw invalid("Registry token record must be an object.");
    if (Object.keys(record).some((key) => !allowed.has(key))) throw invalid("Registry token record has unsupported fields.");
    assertCanonicalUuid(record.tokenId, "tokenId");
    if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)) throw invalid("Registry token digest is invalid.");
    if (!TOKEN_SUBJECTS.has(record.subject)) throw invalid("Registry token subject is invalid.");
    if (!Array.isArray(record.scopes) || record.scopes.length < 1 || new Set(record.scopes).size !== record.scopes.length
        || record.scopes.some((scope) => !TOKEN_SCOPES.has(scope))) throw invalid("Registry token scopes are invalid.");
    if (!Array.isArray(record.namespaces) || new Set(record.namespaces).size !== record.namespaces.length) {
        throw invalid("Registry token namespaces are invalid.");
    }
    record.namespaces.forEach((namespace) => assertMarketplaceId(namespace, "namespace"));
    if (record.subject === "publisher") {
        assertMarketplaceId(record.publisherId, "publisherId");
        if (record.namespaces.length < 1) throw invalid("Publisher tokens require at least one namespace.");
    } else if (record.publisherId !== null || record.namespaces.length !== 0) {
        throw invalid("Only publisher tokens may bind a publisher and namespaces.");
    }
    assertCanonicalTimestamp(record.createdAt, "createdAt");
    if (record.revokedAt !== null) assertCanonicalTimestamp(record.revokedAt, "revokedAt");
    return record;
}

function assertAuthDocument(document) {
    if (!document || typeof document !== "object" || Array.isArray(document)
        || document.kind !== AUTH_KIND || document.version !== AUTH_VERSION || !Array.isArray(document.tokens)
        || Object.keys(document).some((key) => !["kind", "version", "revision", "tokens"].includes(key))
        || !Number.isSafeInteger(document.revision) || document.revision < 0) {
        throw invalid("Registry authentication document is invalid.");
    }
    const ids = new Set();
    document.tokens.forEach((record) => {
        assertTokenRecord(record);
        if (ids.has(record.tokenId)) throw invalid("Registry authentication document has duplicate token IDs.");
        ids.add(record.tokenId);
    });
    return document;
}

function digestToken(token) {
    return createHash("sha256").update(token, "utf8").digest();
}

function publicActor(record) {
    return Object.freeze({
        tokenId: record.tokenId,
        subject: record.subject,
        publisherId: record.publisherId,
        namespaces: Object.freeze([...record.namespaces]),
        scopes: Object.freeze([...record.scopes]),
    });
}

export class RegistryAuthStore {
    #queue = Promise.resolve();

    constructor(paths, { now = () => new Date() } = {}) {
        this.paths = paths;
        this.now = now;
    }

    static async open(paths, options = {}) {
        await ensureDirectory(paths.auth);
        const existing = await lstatOrNull(paths.authTokens);
        if (!existing) {
            await writeExclusiveDurable(paths.authTokens, canonicalMarketplaceBytes({
                kind: AUTH_KIND,
                version: AUTH_VERSION,
                revision: 0,
                tokens: [],
            }));
        }
        const store = new RegistryAuthStore(paths, options);
        await store.read();
        return store;
    }

    async read() {
        const bytes = await readRegularBytes(this.paths.authTokens, { maxBytes: 8 * 1024 * 1024 });
        const { document } = parseMarketplaceJsonBytes(bytes);
        assertAuthDocument(document);
        if (!Buffer.from(canonicalMarketplaceBytes(document)).equals(bytes)) throw invalid("Registry authentication document is not canonical.");
        return structuredClone(document);
    }

    async #mutate(operation) {
        const current = this.#queue.catch(() => {}).then(async () => {
            const document = await this.read();
            const result = await operation(document);
            document.revision += 1;
            document.tokens.sort((left, right) => left.tokenId.localeCompare(right.tokenId));
            assertAuthDocument(document);
            await atomicReplaceDurable(this.paths.authTokens, canonicalMarketplaceBytes(document));
            return result;
        });
        this.#queue = current.catch(() => {});
        return current;
    }

    async createToken({ subject, publisherId = null, namespaces = [], scopes }) {
        if (!TOKEN_SUBJECTS.has(subject)) throw invalid("Registry token subject is invalid.");
        if (!Array.isArray(scopes) || scopes.length < 1) throw invalid("Registry token requires scopes.");
        const tokenId = randomUUID();
        const token = `${tokenId}.${randomBytes(32).toString("base64url")}`;
        const createdAt = this.now().toISOString();
        const record = assertTokenRecord({
            tokenId,
            digest: digestToken(token).toString("hex"),
            subject,
            publisherId,
            namespaces: [...new Set(namespaces)].sort(),
            scopes: [...new Set(scopes)].sort(),
            createdAt,
            revokedAt: null,
        });
        await this.#mutate((document) => { document.tokens.push(record); });
        return Object.freeze({ token, actor: publicActor(record), createdAt });
    }

    async revokeToken(tokenId) {
        assertCanonicalUuid(tokenId, "tokenId");
        return this.#mutate((document) => {
            const record = document.tokens.find((entry) => entry.tokenId === tokenId);
            if (!record) return false;
            if (record.revokedAt === null) record.revokedAt = this.now().toISOString();
            return true;
        });
    }

    async authenticate(token, { scope = null, namespace = null } = {}) {
        const match = typeof token === "string" ? TOKEN_PATTERN.exec(token) : null;
        const tokenId = match?.[1] ?? "00000000-0000-4000-8000-000000000000";
        const document = await this.read();
        const record = document.tokens.find((entry) => entry.tokenId === tokenId);
        const candidate = digestToken(typeof token === "string" ? token : "");
        const expected = record ? Buffer.from(record.digest, "hex") : DUMMY_DIGEST;
        const digestMatches = timingSafeEqual(candidate, expected);
        if (!match || !record || !digestMatches || record.revokedAt !== null) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Registry bearer token is invalid or revoked.");
        }
        if (scope !== null && !record.scopes.includes(scope)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Registry bearer token lacks the required scope.");
        }
        if (namespace !== null && record.subject !== "admin"
            && !record.namespaces.some((owned) => namespace === owned || namespace.startsWith(`${owned}.`))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Registry bearer token does not authorize the namespace.");
        }
        return publicActor(record);
    }
}

export const REGISTRY_TOKEN_SUBJECTS = Object.freeze([...TOKEN_SUBJECTS]);
