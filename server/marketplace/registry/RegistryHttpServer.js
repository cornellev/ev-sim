import { createHash } from "node:crypto";
import http from "node:http";

import { assertMarketplaceId, assertReleaseVersion, assertSha256 } from "../MarketplaceFormats.js";
import { MarketplaceRegistryReader, REGISTRY_HTTP_MAX_RANGE_BYTES } from "./RegistryReader.js";

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
    if (host !== "127.0.0.1" && host !== "::1") throw new TypeError("Marketplace registry host must be 127.0.0.1 or ::1 until secure LAN hosting is implemented.");
    return host;
}

function targetContentType(relativePath) {
    if (relativePath.startsWith("catalog/")) return "application/vnd.cev-sim.marketplace-catalog+json";
    if (relativePath.startsWith("items/")) return "application/vnd.cev-sim.marketplace-item+json";
    if (relativePath.startsWith("releases/")) return "application/vnd.cev-sim.marketplace-release+json";
    return "application/vnd.cev-sim.marketplace-advisory+json";
}

export class MarketplaceRegistryHttpServer {
    constructor(reader) {
        this.reader = reader;
        this.server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
            this.#handle(request, response).catch(() => {
                if (!response.headersSent) sendError(response, 500, "INTERNAL", "Marketplace registry request failed.");
                else response.destroy();
            });
        });
        this.server.headersTimeout = 15_000;
        this.server.requestTimeout = 30_000;
        this.server.keepAliveTimeout = 5_000;
    }

    static async open(root, options = {}) {
        const reader = await MarketplaceRegistryReader.open(root, options);
        await reader.verify();
        return new MarketplaceRegistryHttpServer(reader);
    }

    async listen({ host = "127.0.0.1", port = 8080 } = {}) {
        assertLoopbackHost(host);
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
        if (!this.server.listening) return;
        await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }

    async #handle(request, response) {
        const parts = parseRequestPath(request.url);
        if (!parts) {
            sendError(response, 400, "INVALID_PATH", "Request path is not canonical.");
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
        if (parts.length === 5 && parts[0] === "v1" && parts[1] === "items" && parts[3] === "releases") {
            try { assertMarketplaceId(parts[2], "itemId"); assertReleaseVersion(parts[4], "releaseVersion"); } catch { sendError(response, 400, "INVALID_RELEASE_ID", "Release identity is invalid."); return; }
            const result = await this.reader.readPublishedRelease(parts[2], parts[4]);
            if (!result) { sendError(response, 404, "NOT_FOUND", "Marketplace release was not found."); return; }
            sendBytes(request, response, { ...result, etag: result.target.hashes.sha256, contentType: "application/vnd.cev-sim.marketplace-release+json" });
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
