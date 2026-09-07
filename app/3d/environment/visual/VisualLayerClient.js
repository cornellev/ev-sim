import { StorageRequestError } from "../../../client/storageClient.js";

/**
 * Browser client for VIS-05a visual-layer descriptor/access documents.
 * Digest-only descriptor URLs and filesystem paths are intentionally absent.
 */
export class VisualLayerClient {
    constructor({
        baseUrl = "/api/storage/visual-layers",
        fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    } = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, "");
        this.fetch = fetchImpl;
    }

    async publish({ descriptor, assetUses }) {
        return this.json("POST", "", { descriptor, assetUses });
    }

    async getAccess(descriptorHash, accessHash) {
        return this.json(
            "GET",
            `/${encodeURIComponent(descriptorHash)}/access/${encodeURIComponent(accessHash)}`,
        );
    }

    async json(method, pathname, body) {
        const response = await this.fetch(`${this.baseUrl}${pathname}`, {
            method,
            headers: body === undefined ? { Accept: "application/json" } : {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        await this.assertOk(response, method === "GET" ? "load" : "save");
        return response.json();
    }

    async assertOk(response, action) {
        if (response.ok) return;
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
