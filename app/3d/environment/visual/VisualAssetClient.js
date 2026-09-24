import { StorageRequestError } from "../../../client/storageClient.js";

/**
 * Browser client for the VIS-04 visual-asset store.
 * Digest-only content URLs, filesystem paths, root/pin mutation, and
 * published deletion are intentionally absent.
 */
export class VisualAssetClient {
    constructor({
        baseUrl = "/api/storage/visual-assets",
        fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    } = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, "");
        this.fetch = fetchImpl;
    }

    async createUpload(body, signal) {
        return this.json("POST", "/uploads", body, { signal });
    }

    async putUploadContent(id, bytes, { mediaType = "application/octet-stream", signal } = {}) {
        const buffer = toUint8Array(bytes);
        const response = await this.fetch(`${this.baseUrl}/uploads/${encodeURIComponent(id)}/content`, {
            method: "PUT",
            headers: {
                "Content-Type": mediaType,
                "Content-Length": String(buffer.byteLength),
            },
            body: buffer,
            signal,
        });
        await this.assertOk(response, "upload");
        return response.json();
    }

    async cancelUpload(id, signal) {
        return this.json("DELETE", `/uploads/${encodeURIComponent(id)}`, undefined, { signal });
    }

    async getUse(useHash, { signal } = {}) {
        return this.json("GET", `/uses/sha256/${encodeURIComponent(useHash)}`, undefined, { signal });
    }

    async getUseContent(useHash, { range, signal } = {}) {
        const headers = { Accept: "*/*" };
        if (range) {
            const end = range.end === undefined ? "" : String(range.end);
            headers.Range = `bytes=${range.start}-${end}`;
        }
        const response = await this.fetch(
            `${this.baseUrl}/uses/sha256/${encodeURIComponent(useHash)}/content`,
            { headers, signal },
        );
        await this.assertOk(response, "load");
        return {
            bytes: new Uint8Array(await response.arrayBuffer()),
            status: response.status,
            mediaType: response.headers.get("Content-Type"),
            etag: response.headers.get("ETag"),
            contentRange: response.headers.get("Content-Range"),
            length: Number(response.headers.get("Content-Length")),
        };
    }

    async headUseContent(useHash, { signal } = {}) {
        const response = await this.fetch(
            `${this.baseUrl}/uses/sha256/${encodeURIComponent(useHash)}/content`,
            { method: "HEAD", signal },
        );
        await this.assertOk(response, "load");
        return {
            status: response.status,
            mediaType: response.headers.get("Content-Type"),
            etag: response.headers.get("ETag"),
            length: Number(response.headers.get("Content-Length")),
            acceptRanges: response.headers.get("Accept-Ranges"),
        };
    }

    async validateClosure(body, signal) {
        return this.json("POST", "/closures/validate", body, { signal });
    }

    async validateAccessSet(body, signal) {
        return this.json("POST", "/access-sets/validate", body, { signal });
    }

    async json(method, pathname, body, { signal } = {}) {
        const response = await this.fetch(`${this.baseUrl}${pathname}`, {
            method,
            headers: body === undefined ? { Accept: "application/json" } : {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
        await this.assertOk(response, method === "GET" ? "load" : "save");
        return response.json();
    }

    async assertOk(response, action) {
        if (response.ok || response.status === 206) return;
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
        const detail = payload?.error ? `: ${payload.error}` : "";
        throw new StorageRequestError(
            `Storage ${action} failed (${response.status} ${response.statusText})${detail}`,
            {
                status: response.status,
                code: payload?.code ?? null,
                payload,
            },
        );
    }
}

function toUint8Array(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(bytes)) return new Uint8Array(bytes);
    throw new TypeError("Visual asset content must be a Buffer, ArrayBuffer, or Uint8Array.");
}
