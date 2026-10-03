import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";

import { assertCanonicalUuid, assertMarketplaceId, assertReleaseVersion, assertSha256 } from "../MarketplaceFormats.js";
import { MARKETPLACE_CLIENT_LIMITS, MARKETPLACE_LIMITS, MARKETPLACE_PREVIEW_MEDIA_TYPES, MARKETPLACE_PUBLISHER_TRANSFER } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { MarketplaceRegistryReader, REGISTRY_HTTP_MAX_RANGE_BYTES } from "./RegistryReader.js";
import { MarketplaceRegistryStore } from "./RegistryStore.js";
import { assertEnrollmentConfig, MarketplaceRegistryService } from "./RegistryService.js";
import { RegistryAuthStore } from "./RegistryAuthStore.js";

const JSON_TYPE = "application/json; charset=utf-8";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const MUTABLE_CACHE = "no-cache";

function jsonBytes(value) {
    return Buffer.from(JSON.stringify(value));
}

function quotedEtag(value) {
    return `"${value}"`;
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function isNumberedRootPath(parts) {
    return parts.length === 3 && parts[0] === "tuf" && parts[1] === "metadata" && /^[1-9][0-9]*\.root\.json$/u.test(parts[2]);
}

function matchesEtag(header, etag) {
    if (typeof header !== "string") return false;
    return header.split(",").map((value) => value.trim()).some((value) => value === "*" || value === etag);
}

function commonHeaders({ contentType, contentLength, etag = null, cacheControl = MUTABLE_CACHE }) {
    return {
        "Cache-Control": cacheControl,
        "Content-Length": String(contentLength),
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        ...(etag ? { ETag: quotedEtag(etag) } : {}),
    };
}

function sendError(response, status, code, message, headers = {}) {
    const bytes = jsonBytes({ error: { code, message } });
    response.writeHead(status, {
        ...commonHeaders({ contentType: JSON_TYPE, contentLength: bytes.byteLength, etag: sha256(bytes), cacheControl: "no-store" }),
        ...headers,
    });
    response.end(response.req?.method === "HEAD" ? undefined : bytes);
}

function sendBytes(request, response, { bytes, contentType, etag, cacheControl = MUTABLE_CACHE, status = 200 }) {
    const renderedEtag = quotedEtag(etag);
    if (matchesEtag(request.headers["if-none-match"], renderedEtag)) {
        response.writeHead(304, {
            "Cache-Control": cacheControl,
            ETag: renderedEtag,
            "X-Content-Type-Options": "nosniff",
        });
        response.end();
        return;
    }
    response.writeHead(status, commonHeaders({ contentType, contentLength: bytes.byteLength, etag, cacheControl }));
    response.end(request.method === "HEAD" ? undefined : bytes);
}

function parseRequestPath(rawUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length > 8192 || rawUrl.includes("?") || rawUrl.includes("#")
        || rawUrl.includes("\\") || rawUrl.includes("%")) return null;
    const rawParts = rawUrl.split("/");
    if (rawParts[0] !== "" || rawParts.slice(1).some((part) => part === "")) {
        return rawUrl === "/" ? [] : null;
    }
    try {
        const parts = rawParts.slice(1).map((part) => decodeURIComponent(part));
        if (parts.some((part) => part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0"))) return null;
        return parts;
    } catch {
        return null;
    }
}

function parseRange(header, sizeBytes) {
    if (header === undefined) return null;
    if (typeof header !== "string" || header.includes(",")) return false;
    const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
    if (!match || (match[1] === "" && match[2] === "")) return false;
    let start;
    let end;
    if (match[1] === "") {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
        start = Math.max(0, sizeBytes - suffix);
        end = sizeBytes - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === "" ? sizeBytes - 1 : Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= sizeBytes) return false;
    end = Math.min(end, sizeBytes - 1);
    if (end - start + 1 > REGISTRY_HTTP_MAX_RANGE_BYTES) return false;
    return { start, end, length: end - start + 1 };
}

function assertLoopbackHost(host) {
    if (host !== "127.0.0.1" && host !== "::1") throw new TypeError("Marketplace registry host must be loopback.");
    return host;
}

function assertHostSecurity(host, { tlsEnabled, readAuthentication, unsafeDevelopmentLan }) {
    if (host === "127.0.0.1" || host === "::1") return host;
    if ((!tlsEnabled || !readAuthentication) && !unsafeDevelopmentLan) {
        throw new TypeError("Non-loopback Marketplace registry binds require TLS and read authentication.");
    }
    return host;
}

function targetContentType(relativePath) {
    if (relativePath.startsWith("catalog/")) return "application/vnd.cev-sim.marketplace-catalog+json";
    if (relativePath.startsWith("items/")) return "application/vnd.cev-sim.marketplace-item+json";
    if (relativePath.startsWith("publishers/")) return "application/vnd.cev-sim.marketplace-publisher+json";
    if (relativePath.startsWith("releases/")) return "application/vnd.dsse.envelope.v1+json";
    return "application/vnd.cev-sim.marketplace-advisory+json";
}

async function requestBytes(request, maxBytes) {
    const declared = request.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) throw new RangeError("Request body is too large.");
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new RangeError("Request body is too large.");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
}

async function requestJson(request, maxBytes = MARKETPLACE_LIMITS.jsonBytes) {
    const bytes = await requestBytes(request, maxBytes);
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new SyntaxError("Request body must be valid JSON.");
    }
}

function httpFailure(error) {
    if (error instanceof RangeError) return { status: 413, code: "LIMIT_EXCEEDED", message: "Request body is too large." };
    if (error instanceof SyntaxError || error instanceof TypeError) return { status: 400, code: "DOCUMENT_INVALID", message: error.message };
    if (error instanceof MarketplaceError) {
        if (error.code === "AUTHENTICATION_REQUIRED") return { status: 401, code: error.code, message: "Bearer authentication is required." };
        if (error.code === "RIGHTS_DENIED") return { status: 403, code: error.code, message: "Registry operation is not authorized." };
        if (error.code === "CONFLICT") return { status: 409, code: error.code, message: error.message };
        return { status: 400, code: error.code, message: error.message };
    }
    return { status: 500, code: "INTERNAL", message: "Marketplace registry request failed." };
}

export class MarketplaceRegistryHttpServer {
    constructor(reader, { store = null, authStore = null, tls = null, readAuthentication = false, unsafeDevelopmentLan = false, enrollment = null } = {}) {
        this.reader = reader;
        this.store = store;
        this.service = store ? new MarketplaceRegistryService(store) : null;
        this.authStore = authStore;
        this.readAuthentication = readAuthentication;
        this.unsafeDevelopmentLan = unsafeDevelopmentLan;
        this.enrollment = enrollment ? assertEnrollmentConfig(enrollment) : null;
        this.tlsEnabled = Boolean(tls);
        const handler = (request, response) => {
            this.#handle(request, response).catch((error) => {
                const failure = httpFailure(error);
                if (!response.headersSent) sendError(response, failure.status, failure.code, failure.message);
                else response.destroy();
            });
        };
        this.server = tls
            ? https.createServer({ ...tls, maxHeaderSize: 16 * 1024 }, handler)
            : http.createServer({ maxHeaderSize: 16 * 1024 }, handler);
        this.server.headersTimeout = MARKETPLACE_CLIENT_LIMITS.requestTimeoutMs;
        this.server.requestTimeout = MARKETPLACE_PUBLISHER_TRANSFER.capMs;
        this.server.keepAliveTimeout = 5_000;
    }

    static async open(root, options = {}) {
        const readAuthentication = options.readAuthentication === true;
        const reader = await MarketplaceRegistryReader.open(root, { ...options, readAuthentication });
        await reader.verify();
        const store = options.writable === true ? await MarketplaceRegistryStore.open(root, options) : null;
        const authStore = await RegistryAuthStore.open(reader.paths, options);
        return new MarketplaceRegistryHttpServer(reader, { ...options, store, authStore, readAuthentication });
    }

    async listen({ host = "127.0.0.1", port = 8080 } = {}) {
        assertHostSecurity(host, {
            tlsEnabled: this.tlsEnabled,
            readAuthentication: this.readAuthentication,
            unsafeDevelopmentLan: this.unsafeDevelopmentLan,
        });
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError("Marketplace registry port must be an integer from 0 through 65535.");
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                this.server.off("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                this.server.off("error", onError);
                resolve();
            };
            this.server.once("error", onError);
            this.server.once("listening", onListening);
            this.server.listen({ host, port });
        });
        return this.server.address();
    }

    async close() {
        if (this.server.listening) await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
        await this.store?.close();
    }

    async #actor(request, scope) {
        const authorization = request.headers.authorization;
        if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || authorization.length > 8192) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.AUTHENTICATION_REQUIRED, "Registry bearer authentication is required.");
        }
        return this.authStore.authenticate(authorization.slice(7), { scope });
    }

    async #adminActor(request, scope) {
        const actor = await this.#actor(request, scope);
        if (actor.subject !== "admin") {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Registry operation requires an administrator token.");
        }
        return actor;
    }

    async #handle(request, response) {
        const parts = parseRequestPath(request.url);
        if (!parts) {
            sendError(response, 400, "INVALID_PATH", "Request path is not canonical.");
            return;
        }
        const publicRead = parts.join("/") === ".well-known/cev-sim-marketplace" || parts.join("/") === "healthz"
            || (this.enrollment !== null && isNumberedRootPath(parts));
        if (this.readAuthentication && !publicRead && (request.method === "GET" || request.method === "HEAD")) {
            try { await this.#actor(request, "read"); } catch { sendError(response, 401, "AUTHENTICATION_REQUIRED", "Bearer authentication is required.", { "WWW-Authenticate": "Bearer" }); return; }
        }
        if (request.method === "POST" && parts.join("/") === "v1/enroll") {
            if (!this.enrollment) {
                sendError(response, 404, "NOT_FOUND", "Enrollment is not enabled.");
                return;
            }
            if (!this.service) {
                sendError(response, 405, "READ_ONLY", "Registry is read-only.");
                return;
            }
            await requestBytes(request, 1024);
            const enrolled = await this.service.enrollPublisher(this.enrollment);
            const discovery = (await this.reader.wellKnown()).document;
            const bytes = jsonBytes({
                publisherId: enrolled.publisherId,
                displayName: enrolled.displayName,
                keyId: enrolled.keyId,
                privateKeyPem: enrolled.privateKeyPem,
                readToken: enrolled.readToken,
                writeToken: enrolled.writeToken,
                bootstrapRootSha256: discovery.tuf.bootstrapRootSha256,
            });
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        if (request.method === "POST" && parts.length === 3 && parts[0] === "v1" && parts[1] === "artifacts") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            let actor;
            try { actor = await this.#actor(request, "publish:blob"); } catch { sendError(response, 403, "RIGHTS_DENIED", "Artifact publication is not authorized."); return; }
            const contentKind = parts[2];
            const size = Number(request.headers["content-length"]);
            const result = await this.service.admitArtifact(request, { contentKind, sizeBytes: Number.isSafeInteger(size) ? size : undefined, actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        if (request.method === "POST" && parts.join("/") === "v1/previews") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            let actor;
            try { actor = await this.#actor(request, "publish:blob"); } catch { sendError(response, 403, "RIGHTS_DENIED", "Preview publication is not authorized."); return; }
            const mediaType = String(request.headers["content-type"] ?? "").toLowerCase();
            if (!MARKETPLACE_PREVIEW_MEDIA_TYPES.includes(mediaType)) {
                sendError(response, 400, "DOCUMENT_INVALID", "Preview Content-Type must be image/png, image/jpeg, or image/webp.");
                return;
            }
            const size = Number(request.headers["content-length"]);
            const result = await this.service.admitPreview(request, {
                mediaType,
                sizeBytes: Number.isSafeInteger(size) ? size : undefined,
                actor,
            });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        if (request.method === "PUT" && parts.join("/") === "v1/items") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            let actor;
            try { actor = await this.#actor(request, "publish:item"); } catch { sendError(response, 403, "RIGHTS_DENIED", "Item publication is not authorized."); return; }
            const result = await this.service.admitItem(await requestBytes(request, MARKETPLACE_LIMITS.jsonBytes), { actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        if (request.method === "PUT" && parts.join("/") === "v1/releases") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            let actor;
            try { actor = await this.#actor(request, "publish:release"); } catch { sendError(response, 403, "RIGHTS_DENIED", "Release publication is not authorized."); return; }
            const track = request.headers["x-cev-marketplace-track"] ?? null;
            const result = await this.service.admitReleaseEnvelope(await requestBytes(request, MARKETPLACE_LIMITS.jsonBytes), { actor, track });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        if (request.method === "PUT" && parts.join("/") === "v1/publishers") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            const actor = await this.#adminActor(request, "manage:publisher");
            const result = await this.service.registerPublisher(await requestBytes(request, MARKETPLACE_LIMITS.jsonBytes), { actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        if (request.method === "POST" && parts.length === 4 && parts[0] === "v1" && parts[1] === "publishers" && parts[3] === "keys") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            assertMarketplaceId(parts[2], "publisherId");
            const actor = await this.#adminActor(request, "manage:publisher");
            const result = await this.service.addPublisherKey(parts[2], await requestJson(request), { actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        if (request.method === "PUT" && parts.length === 6 && parts[0] === "v1" && parts[1] === "publishers" && parts[3] === "keys" && parts[5] === "status") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            assertMarketplaceId(parts[2], "publisherId");
            assertSha256(parts[4], "keyId");
            const actor = await this.#adminActor(request, "manage:publisher");
            const body = await requestJson(request);
            if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, "status")) throw new TypeError("Key status body is invalid.");
            const result = await this.service.setPublisherKeyStatus(parts[2], parts[4], body.status, { actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store" });
            return;
        }
        if (request.method === "POST" && parts.length === 6 && parts[0] === "v1" && parts[1] === "publishers" && parts[3] === "keys" && parts[5] === "compromise") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            assertMarketplaceId(parts[2], "publisherId");
            assertSha256(parts[4], "keyId");
            const actor = await this.#adminActor(request, "manage:advisory");
            const result = await this.service.compromisePublisherKey(parts[2], parts[4], { ...await requestJson(request), actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store" });
            return;
        }
        if (request.method === "POST" && parts.join("/") === "v1/tokens") {
            await this.#adminActor(request, "manage:token");
            const result = await this.authStore.createToken(await requestJson(request));
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        if (request.method === "DELETE" && parts.length === 3 && parts[0] === "v1" && parts[1] === "tokens") {
            await this.#adminActor(request, "manage:token");
            assertCanonicalUuid(parts[2], "tokenId");
            const revoked = await this.authStore.revokeToken(parts[2]);
            const bytes = jsonBytes({ revoked });
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store" });
            return;
        }
        if (request.method === "PUT" && parts.length === 5 && parts[0] === "v1" && parts[1] === "items" && parts[3] === "tracks") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            assertMarketplaceId(parts[2], "itemId");
            const actor = await this.#actor(request, "manage:track");
            const body = await requestJson(request);
            const result = await this.service.setTrack(parts[2], parts[4], body.releaseVersion, { actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store" });
            return;
        }
        if (request.method === "PUT" && parts.length === 4 && parts[0] === "v1" && parts[1] === "items" && parts[3] === "yanks") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            assertMarketplaceId(parts[2], "itemId");
            const actor = await this.#actor(request, "manage:yank");
            const body = await requestJson(request);
            const result = await this.service.yankRelease({ itemId: parts[2], ...body }, { actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store" });
            return;
        }
        if (request.method === "PUT" && parts.join("/") === "v1/advisories") {
            if (!this.service) { sendError(response, 405, "READ_ONLY", "Registry is read-only."); return; }
            const actor = await this.#actor(request, "manage:advisory");
            const result = await this.service.admitAdvisory(await requestBytes(request, MARKETPLACE_LIMITS.jsonBytes), { actor });
            const bytes = jsonBytes(result);
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store", status: 201 });
            return;
        }
        const blobRoute = parts.length === 4 && parts[0] === "v1" && parts[1] === "blobs" && parts[2] === "sha256";
        const allowed = blobRoute ? new Set(["GET", "HEAD"]) : new Set(["GET"]);
        if (!allowed.has(request.method)) {
            sendError(response, 405, "METHOD_NOT_ALLOWED", "Method is not allowed.", { Allow: [...allowed].join(", ") });
            return;
        }
        if (parts.join("/") === ".well-known/cev-sim-marketplace") {
            const result = await this.reader.wellKnown();
            sendBytes(request, response, { ...result, contentType: JSON_TYPE });
            return;
        }
        if (parts.length === 1 && parts[0] === "healthz") {
            const bytes = jsonBytes({ ok: true });
            sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store" });
            return;
        }
        if (parts.length === 1 && parts[0] === "readyz") {
            const result = await this.reader.checkReady();
            const bytes = jsonBytes(result.ok ? result : { ok: false, code: result.code });
            if (result.ok) sendBytes(request, response, { bytes, etag: sha256(bytes), contentType: JSON_TYPE, cacheControl: "no-store" });
            else sendError(response, 503, result.code, "Marketplace registry is not ready.");
            return;
        }
        if (parts.length === 2 && parts[0] === "v1" && parts[1] === "catalog") {
            const result = await this.reader.readPublishedCatalog();
            sendBytes(request, response, { ...result, etag: result.target.hashes.sha256, contentType: "application/vnd.cev-sim.marketplace-catalog+json" });
            return;
        }
        if (parts.length === 3 && parts[0] === "v1" && parts[1] === "items") {
            try { assertMarketplaceId(parts[2], "itemId"); } catch { sendError(response, 400, "INVALID_ITEM_ID", "Item ID is invalid."); return; }
            const result = await this.reader.readPublishedItem(parts[2]);
            if (!result) { sendError(response, 404, "NOT_FOUND", "Marketplace item was not found."); return; }
            sendBytes(request, response, { ...result, etag: result.target.hashes.sha256, contentType: "application/vnd.cev-sim.marketplace-item+json" });
            return;
        }
        if (parts.length === 3 && parts[0] === "v1" && parts[1] === "publishers") {
            try { assertMarketplaceId(parts[2], "publisherId"); } catch { sendError(response, 400, "INVALID_PUBLISHER_ID", "Publisher ID is invalid."); return; }
            const result = await this.reader.readPublishedPublisher(parts[2]);
            if (!result) { sendError(response, 404, "NOT_FOUND", "Marketplace publisher was not found."); return; }
            sendBytes(request, response, { ...result, etag: result.target.hashes.sha256, contentType: "application/vnd.cev-sim.marketplace-publisher+json" });
            return;
        }
        if (parts.length === 3 && parts[0] === "v1" && parts[1] === "advisories") {
            try { assertMarketplaceId(parts[2], "advisoryId"); } catch { sendError(response, 400, "INVALID_ADVISORY_ID", "Advisory ID is invalid."); return; }
            const result = await this.reader.readPublishedAdvisory(parts[2]);
            if (!result) { sendError(response, 404, "NOT_FOUND", "Marketplace advisory was not found."); return; }
            sendBytes(request, response, { ...result, etag: result.target.hashes.sha256, contentType: "application/vnd.cev-sim.marketplace-advisory+json" });
            return;
        }
        if (parts.length === 5 && parts[0] === "v1" && parts[1] === "items" && parts[3] === "releases") {
            try { assertMarketplaceId(parts[2], "itemId"); assertReleaseVersion(parts[4], "releaseVersion"); } catch { sendError(response, 400, "INVALID_RELEASE_ID", "Release identity is invalid."); return; }
            const result = await this.reader.readPublishedRelease(parts[2], parts[4]);
            if (!result) { sendError(response, 404, "NOT_FOUND", "Marketplace release was not found."); return; }
            sendBytes(request, response, { ...result, etag: result.target.hashes.sha256, contentType: "application/vnd.dsse.envelope.v1+json" });
            return;
        }
        if (blobRoute) {
            const digest = parts[3];
            try { assertSha256(digest, "sha256"); } catch { sendError(response, 400, "INVALID_DIGEST", "Blob digest is invalid."); return; }
            const blob = await this.reader.openBlob(digest);
            if (!blob) { sendError(response, 404, "NOT_FOUND", "Marketplace blob was not found."); return; }
            await this.#sendBlob(request, response, blob);
            return;
        }
        if (parts.length === 3 && parts[0] === "tuf" && parts[1] === "metadata") {
            const result = await this.reader.readTufMetadata(parts[2]);
            if (!result) { sendError(response, 404, "NOT_FOUND", "TUF metadata was not found."); return; }
            sendBytes(request, response, {
                ...result,
                contentType: JSON_TYPE,
                cacheControl: parts[2] === "timestamp.json" ? MUTABLE_CACHE : IMMUTABLE_CACHE,
            });
            return;
        }
        if (parts.length >= 4 && parts[0] === "tuf" && parts[1] === "targets") {
            const relativePath = parts.slice(2).join("/");
            const result = await this.reader.openTufTarget(relativePath);
            if (!result) { sendError(response, 404, "NOT_FOUND", "TUF target was not found."); return; }
            sendBytes(request, response, { ...result, contentType: targetContentType(relativePath), cacheControl: IMMUTABLE_CACHE });
            return;
        }
        sendError(response, 404, "NOT_FOUND", "Resource was not found.");
    }

    async #sendBlob(request, response, blob) {
        const etag = quotedEtag(blob.etag);
        if (matchesEtag(request.headers["if-none-match"], etag)) {
            await blob.handle.close();
            response.writeHead(304, { ETag: etag, "Cache-Control": IMMUTABLE_CACHE, "X-Content-Type-Options": "nosniff" });
            response.end();
            return;
        }
        const honorRange = request.headers.range !== undefined
            && (request.headers["if-range"] === undefined || request.headers["if-range"] === etag);
        const range = honorRange ? parseRange(request.headers.range, blob.sizeBytes) : null;
        if (range === false) {
            await blob.handle.close();
            sendError(response, 416, "RANGE_NOT_SATISFIABLE", "Requested byte range is not satisfiable.", {
                "Content-Range": `bytes */${blob.sizeBytes}`,
            });
            return;
        }
        const contentLength = range ? range.length : blob.sizeBytes;
        response.writeHead(range ? 206 : 200, {
            ...commonHeaders({ contentType: blob.record.mediaType, contentLength, etag: blob.etag, cacheControl: IMMUTABLE_CACHE }),
            "Accept-Ranges": "bytes",
            ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${blob.sizeBytes}` } : {}),
        });
        if (request.method === "HEAD") { await blob.handle.close(); response.end(); return; }
        const stream = blob.handle.createReadStream({
            start: range?.start ?? 0,
            ...(range ? { end: range.end } : {}),
            autoClose: false,
        });
        let closed = false;
        const closeHandle = () => {
            if (closed) return;
            closed = true;
            blob.handle.close().catch(() => {});
        };
        const abort = () => { stream.destroy(); closeHandle(); };
        request.once("aborted", abort);
        response.once("close", abort);
        stream.once("error", () => response.destroy());
        stream.once("close", () => {
            request.off("aborted", abort);
            response.off("close", abort);
            closeHandle();
        });
        stream.pipe(response);
    }
}

export { assertLoopbackHost, parseRange, parseRequestPath };
