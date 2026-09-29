import { BaseFetcher } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error.js";
import https from "node:https";
import { Readable } from "node:stream";

import { MARKETPLACE_CLIENT_LIMITS } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertSourceUrl } from "../MarketplaceFormats.js";
import { assertSha256 } from "../MarketplaceFormats.js";

const DISCOVERY_PATH = "/.well-known/cev-sim-marketplace";
const METADATA_PATH = /^\/tuf\/metadata\/(?:timestamp|[1-9][0-9]*\.(?:root|snapshot|targets|catalog|items|publishers|releases|advisories))\.json$/u;
const TARGET_PATH = /^\/tuf\/targets\/(?:catalog\/[a-f0-9]{64}\.catalog\.json|(?:items|publishers|advisories)\/[a-f0-9]{64}\.[a-z][a-z0-9.-]*\.json|releases\/[a-z][a-z0-9.-]*\/[a-f0-9]{64}\.[0-9A-Za-z.-]+\.json)$/u;
const NUMBERED_ROOT_PATH = /^\/tuf\/metadata\/([1-9][0-9]*)\.root\.json$/u;

function unavailable(message, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, message, { cause });
}

function tlsFetch(credential) {
    return (rawUrl, init = {}) => new Promise((resolve, reject) => {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "https:") {
            reject(new TypeError("Private CA and client-certificate credentials require HTTPS."));
            return;
        }
        const request = https.request(parsed, {
            method: init.method ?? "GET",
            headers: init.headers,
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
        request.end();
    });
}

export class MarketplaceFixedOriginFetcher extends BaseFetcher {
    constructor({
        baseUrl,
        bearerToken = null,
        credential = null,
        fetchImpl = globalThis.fetch,
        signal = null,
        allowTuf = false,
        allowedPaths = [],
        onRootBytes = null,
        timeoutMs = MARKETPLACE_CLIENT_LIMITS.requestTimeoutMs,
    }) {
        super();
        assertSourceUrl(baseUrl);
        if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
        this.baseUrl = baseUrl;
        this.origin = new URL(baseUrl).origin;
        this.bearerToken = credential?.token ?? bearerToken;
        const usesPrivateTls = Boolean(credential?.privateCaCertificates?.length || credential?.clientCertificate);
        this.fetchImpl = usesPrivateTls ? tlsFetch(credential) : fetchImpl;
        this.signal = signal;
        this.allowTuf = allowTuf;
        this.allowedPaths = new Set(allowedPaths);
        this.onRootBytes = onRootBytes;
        this.timeoutMs = timeoutMs;
        this.lastTransportError = null;
    }

    allowPath(pathName) {
        this.allowedPaths.add(pathName);
    }

    url(pathName) {
        return new URL(pathName, this.baseUrl).href;
    }

    #validateUrl(rawUrl) {
        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch (error) {
            throw unavailable("Marketplace registry URL is invalid.", error);
        }
        if (parsed.origin !== this.origin || parsed.username || parsed.password || parsed.search || parsed.hash
            || parsed.pathname.includes("%") || parsed.href !== `${parsed.origin}${parsed.pathname}`) {
            throw unavailable("Marketplace registry request escaped the configured origin.");
        }
        const explicitlyAllowed = parsed.pathname === DISCOVERY_PATH || this.allowedPaths.has(parsed.pathname);
        const tufAllowed = this.allowTuf && (METADATA_PATH.test(parsed.pathname) || TARGET_PATH.test(parsed.pathname));
        if (!explicitlyAllowed && !tufAllowed) {
            throw unavailable("Marketplace registry request path is not allowed.");
        }
        return parsed;
    }

    async fetch(rawUrl) {
        const parsed = this.#validateUrl(rawUrl);
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = this.signal ? AbortSignal.any([this.signal, timeoutSignal]) : timeoutSignal;
        let response;
        try {
            response = await this.fetchImpl(parsed.href, {
                method: "GET",
                headers: this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {},
                redirect: "manual",
                signal,
            });
        } catch (error) {
            if (this.signal?.aborted) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CANCELLED, "Marketplace request was cancelled.", { cause: error });
            }
            this.lastTransportError = unavailable("Marketplace registry is unavailable.", error);
            throw this.lastTransportError;
        }
        if (response.status >= 300 && response.status < 400) {
            this.lastTransportError = unavailable("Marketplace registry redirects are not allowed.");
            throw this.lastTransportError;
        }
        if (!response.ok || !response.body) {
            if (response.status >= 500) {
                this.lastTransportError = unavailable("Marketplace registry is unavailable.");
                throw this.lastTransportError;
            }
            throw new DownloadHTTPError("Marketplace registry request failed.", response.status);
        }
        return response.body;
    }

    async fetchBlob(digest) {
        assertSha256(digest, "artifactSha256");
        const pathName = `/v1/blobs/sha256/${digest}`;
        this.allowPath(pathName);
        return this.fetch(this.url(pathName));
    }

    async downloadBytes(rawUrl, maxLength) {
        const parsed = this.#validateUrl(rawUrl);
        const bytes = await super.downloadBytes(parsed.href, maxLength);
        const rootMatch = NUMBERED_ROOT_PATH.exec(parsed.pathname);
        if (rootMatch && this.onRootBytes) await this.onRootBytes(Number(rootMatch[1]), bytes);
        return bytes;
    }
}

export const MARKETPLACE_DISCOVERY_PATH = DISCOVERY_PATH;
