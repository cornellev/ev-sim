import https from "node:https";
import { Readable } from "node:stream";

import { MARKETPLACE_CLIENT_LIMITS, MARKETPLACE_CONTENT_KINDS } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertSourceUrl } from "../MarketplaceFormats.js";

const EXACT_PATHS = new Set(["/v1/previews", "/v1/items", "/v1/releases"]);
const ARTIFACT_PATH = /^\/v1\/artifacts\/([a-z-]+)$/u;

function failForStatus(status) {
    if (status === 401) return marketplaceError(MARKETPLACE_ERROR_CODES.AUTHENTICATION_REQUIRED, "Marketplace publisher authentication failed.");
    if (status === 403) return marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Marketplace publisher operation is not authorized.");
    if (status === 409) return marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace registry rejected a conflicting publication.");
    if (status === 413) return marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, "Marketplace registry rejected an oversized publication.");
    if (status >= 400 && status < 500) return marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Marketplace registry rejected the publication document.");
    return marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace registry is unavailable.");
}

function privateTlsFetch(credential) {
    return (url, init = {}) => new Promise((resolve, reject) => {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") {
            reject(marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Private publisher TLS requires HTTPS."));
            return;
        }
        const request = https.request(parsed, {
            method: init.method,
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            signal: init.signal,
            ca: credential.privateCaCertificates,
            cert: credential.clientCertificate,
            key: credential.clientPrivateKey,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
        }, (response) => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
                if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
                else if (value !== undefined) headers.set(name, value);
            }
            resolve(new Response(Readable.toWeb(response), {
                status: response.statusCode,
                statusText: response.statusMessage,
                headers,
            }));
        });
        request.once("error", reject);
        const body = init.body;
        if (!body) request.end();
        else if (Buffer.isBuffer(body) || body instanceof Uint8Array) request.end(body);
        else if (typeof body.pipe === "function") body.once("error", reject).pipe(request);
        else Readable.fromWeb(body).once("error", reject).pipe(request);
    });
}

export class MarketplacePublisherClient {
    constructor({ baseUrl, writeToken, transportCredential = null, fetchImpl = globalThis.fetch, timeoutMs = MARKETPLACE_CLIENT_LIMITS.requestTimeoutMs }) {
        assertSourceUrl(baseUrl);
        if (typeof writeToken !== "string" || !writeToken || /\s/u.test(writeToken)) throw new TypeError("Publisher write token is invalid.");
        this.baseUrl = baseUrl;
        this.origin = new URL(baseUrl).origin;
        this.writeToken = writeToken;
        this.timeoutMs = timeoutMs;
        const privateTls = Boolean(transportCredential?.privateCaCertificates?.length || transportCredential?.clientCertificate);
        this.fetchImpl = privateTls ? privateTlsFetch(transportCredential) : fetchImpl;
    }

    #url(pathName) {
        const artifact = ARTIFACT_PATH.exec(pathName);
        if (!EXACT_PATHS.has(pathName) && (!artifact || !MARKETPLACE_CONTENT_KINDS.includes(artifact[1]))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace publisher request path is not allowed.");
        }
        const url = new URL(pathName, this.baseUrl);
        if (url.origin !== this.origin || url.username || url.password || url.search || url.hash || url.pathname !== pathName) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace publisher request escaped the configured origin.");
        }
        return url.href;
    }

    async request(pathName, { method, body, mediaType, sizeBytes, track = null, signal = null } = {}) {
        if (!["POST", "PUT"].includes(method)) throw new TypeError("Publisher method is not allowed.");
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const headers = {
            authorization: `Bearer ${this.writeToken}`,
            "content-type": mediaType,
            ...(Number.isSafeInteger(sizeBytes) ? { "content-length": String(sizeBytes) } : {}),
            ...(track ? { "x-cev-marketplace-track": track } : {}),
        };
        let response;
        try {
            response = await this.fetchImpl(this.#url(pathName), {
                method,
                body,
                headers,
                redirect: "manual",
                signal: combined,
                ...(body && !(Buffer.isBuffer(body) || body instanceof Uint8Array) ? { duplex: "half" } : {}),
            });
        } catch (error) {
            if (signal?.aborted) throw marketplaceError(MARKETPLACE_ERROR_CODES.CANCELLED, "Marketplace publication was cancelled.");
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace registry is unavailable.", { cause: error });
        }
        if (response.status >= 300 && response.status < 400) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace publisher redirects are not allowed.");
        }
        if (response.url) {
            const finalUrl = new URL(response.url);
            if (finalUrl.origin !== this.origin || finalUrl.pathname !== pathName || finalUrl.search || finalUrl.hash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace publisher response changed the configured origin or path.");
            }
        }
        if (!response.ok) throw failForStatus(response.status);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > 1024 * 1024) throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, "Marketplace publisher response is too large.");
        try { return JSON.parse(bytes.toString("utf8")); } catch {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace publisher response is invalid.");
        }
    }

    publishArtifact(contentKind, body, descriptor, options = {}) {
        return this.request(`/v1/artifacts/${contentKind}`, {
            method: "POST", body, mediaType: descriptor.mediaType, sizeBytes: descriptor.sizeBytes, ...options,
        });
    }

    publishPreview(body, descriptor, options = {}) {
        return this.request("/v1/previews", {
            method: "POST", body, mediaType: descriptor.mediaType, sizeBytes: descriptor.sizeBytes, ...options,
        });
    }

    publishItem(bytes, options = {}) {
        return this.request("/v1/items", {
            method: "PUT", body: bytes, mediaType: "application/vnd.cev-sim.marketplace-item+json", sizeBytes: bytes.byteLength, ...options,
        });
    }

    publishRelease(bytes, { track = null, ...options } = {}) {
        return this.request("/v1/releases", {
            method: "PUT", body: bytes, mediaType: "application/vnd.dsse.envelope.v1+json", sizeBytes: bytes.byteLength, track, ...options,
        });
    }
}
