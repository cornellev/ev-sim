import { StorageRequestError } from "../../../client/storageClient.js";

/**
 * Browser client for VIS-08 environment-scoped bake promotion.
 * Root/pin mutation stays server-internal; the client only begins, commits,
 * and cancels reserved generations.
 */
export class BakePromotionClient {
    constructor({
        baseUrl = "/api/storage/environments",
        fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    } = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, "");
        this.fetch = fetchImpl;
    }

    async begin(environmentId, body) {
        return this.json("POST", `/${encodeURIComponent(environmentId)}/bake-promotions`, body);
    }

    async commit(environmentId, generation, body) {
        return this.json(
            "POST",
            `/${encodeURIComponent(environmentId)}/bake-promotions/${encodeURIComponent(generation)}/commit`,
            body,
        );
    }

    async cancel(environmentId, generation) {
        return this.json(
            "DELETE",
            `/${encodeURIComponent(environmentId)}/bake-promotions/${encodeURIComponent(generation)}`,
        );
    }

    async json(method, pathname, body) {
        const response = await this.fetch(`${this.baseUrl}${pathname}`, {
            method,
            headers: body === undefined ? { Accept: "application/json" } : {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: body === undefined || method === "DELETE" ? undefined : JSON.stringify(body),
        });
        await this.assertOk(response, method === "DELETE" ? "cancel" : "save");
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
                currentRevision: payload?.currentRevision,
            },
        );
    }
}
