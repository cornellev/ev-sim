import { StorageRequestError } from "../../../client/storageClient.js";
import { sha256ExactBytes, VISUAL_ASSET_UPLOAD_OPERATIONS } from "../../../simulation/visual/VisualLayer.js";
import { createGltfImportPlan } from "../../../editor-assets/GltfImportPlan.js";
import { VisualAssetClient } from "../../environment/visual/VisualAssetClient.js";

export class AssetRepository {
    constructor({
        baseUrl = "/api/storage/editor-assets",
        fetch: fetchImpl = globalThis.fetch.bind(globalThis),
        visualAssets = new VisualAssetClient({ fetch: fetchImpl }),
    } = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, "");
        this.fetch = fetchImpl;
        this.visualAssets = visualAssets;
        this.catalogRevision = null;
        this.subscribers = new Set();
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    list(query = {}, { signal } = {}) { return this.json("GET", `/?${new URLSearchParams(query)}`, undefined, signal); }
    capabilities({ signal } = {}) { return this.json("GET", "/capabilities", undefined, signal); }
    get(assetId, { signal } = {}) { return this.json("GET", `/${encodeURIComponent(assetId)}`, undefined, signal); }
    getRevision(assetId, revision, { signal } = {}) { return this.json("GET", `/${encodeURIComponent(assetId)}/revisions/${revision}`, undefined, signal); }
    listRevisions(assetId, { signal } = {}) { return this.json("GET", `/${encodeURIComponent(assetId)}/revisions`, undefined, signal); }
    publish(draft, expectedRevision, { signal } = {}) { return this.json("POST", "/", { ...draft, expectedRevision }, signal); }
    publishRevision(assetId, draft, expectedRevision, { signal } = {}) { return this.json("POST", `/${encodeURIComponent(assetId)}/revisions`, { ...draft, expectedRevision }, signal); }
    update(assetId, patch, expectedRevision, { signal } = {}) { return this.json("PATCH", `/${encodeURIComponent(assetId)}`, { ...patch, expectedRevision }, signal); }
    setArchived(assetId, archived, expectedRevision, options) { return this.update(assetId, { archived }, expectedRevision, options); }
    createFolder(input, expectedRevision, { signal } = {}) { return this.json("POST", "/folders", { ...input, expectedRevision }, signal); }
    updateFolder(folderId, patch, expectedRevision, { signal } = {}) { return this.json("PATCH", `/folders/${encodeURIComponent(folderId)}`, { ...patch, expectedRevision }, signal); }
    deleteFolder(folderId, expectedRevision, { signal } = {}) { return this.json("DELETE", `/folders/${encodeURIComponent(folderId)}?expectedRevision=${expectedRevision}`, undefined, signal); }
    setThumbnail(assetId, revision, useHash, expectedRevision, { signal } = {}) { return this.json("PUT", `/${encodeURIComponent(assetId)}/revisions/${revision}/thumbnail`, { useHash, expectedRevision }, signal); }
    references(assetId, revision, { signal } = {}) { return this.json("GET", `/${encodeURIComponent(assetId)}/references${revision ? `?revision=${revision}` : ""}`, undefined, signal); }

    async import(files, sourceId, signal, { entryPath } = {}) {
        const plan = createGltfImportPlan(files, { entryPath });
        const unfinished = new Set();
        const upload = async (asset, bytes, dependencies = {}) => {
            const session = await this.visualAssets.createUpload({ asset, sourceIds: [sourceId], dependencies }, signal);
            unfinished.add(session.id);
            const published = await this.visualAssets.putUploadContent(session.id, bytes, { mediaType: asset.mediaType, signal });
            unfinished.delete(session.id);
            return published;
        };
        try {
            const dependencyUses = new Map();
            for (const dependency of plan.dependencies) {
                if (signal?.aborted) throw signal.reason ?? new DOMException("Import cancelled.", "AbortError");
                const role = dependency.mediaType.startsWith("image/") ? "texture" : "buffer";
                const published = await upload({
                    sha256: dependency.sha256, mediaType: dependency.mediaType,
                    sizeBytes: dependency.bytes.byteLength, role,
                }, dependency.bytes);
                dependencyUses.set(`sha256:${dependency.sha256}`, published.useHash);
            }
            const published = await upload({
                sha256: plan.modelSha256, mediaType: plan.mediaType,
                sizeBytes: plan.modelBytes.byteLength, role: "mesh",
            }, plan.modelBytes, Object.fromEntries(dependencyUses));
            await this.visualAssets.validateClosure({ useHash: published.useHash, operations: VISUAL_ASSET_UPLOAD_OPERATIONS }, signal);
            return {
                publicationId: globalThis.crypto?.randomUUID?.() ?? `publication-${Date.now().toString(36)}`,
                modelUseHash: published.useHash,
                suggestedName: plan.entryPath.split("/").at(-1).replace(/\.(gltf|glb)$/i, ""),
            };
        } catch (error) {
            await Promise.allSettled([...unfinished].map((id) => this.visualAssets.cancelUpload(id)));
            throw error;
        }
    }

    async generateThumbnail(assetId, revision, expectedRevision, previewRenderer, { signal } = {}) {
        const record = await this.getRevision(assetId, revision, { signal });
        const modelUse = await this.visualAssets.getUse(record.modelUseHash, { signal });
        await this.visualAssets.validateClosure({
            useHash: record.modelUseHash,
            operations: [...VISUAL_ASSET_UPLOAD_OPERATIONS, "derivatives"],
        }, signal);
        const models = previewRenderer?.models;
        if (!models) throw new TypeError("Thumbnail rendering requires the shared model loader.");
        const lease = await models.acquireRevision(record, { signal });
        let uploadId = null;
        try {
            const blob = await previewRenderer.render(lease, { signal });
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const digest = sha256ExactBytes(bytes);
            const upload = await this.visualAssets.createUpload({
                asset: { sha256: digest, mediaType: "image/png", sizeBytes: bytes.byteLength, role: "texture" },
                sourceIds: [...(modelUse.sourceIds ?? [])],
                dependencies: {},
            }, signal);
            uploadId = upload.id;
            const published = await this.visualAssets.putUploadContent(upload.id, bytes, { mediaType: "image/png", signal });
            uploadId = null;
            return this.setThumbnail(assetId, revision, published.useHash, expectedRevision, { signal });
        } finally {
            lease.release();
            if (uploadId) await this.visualAssets.cancelUpload(uploadId).catch(() => {});
        }
    }

    async json(method, pathname, body, signal) {
        const response = await this.fetch(`${this.baseUrl}${pathname}`, {
            method, signal,
            cache: method === "GET" ? "no-store" : undefined,
            headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok) {
            let payload = null;
            try { payload = await response.json(); } catch { payload = null; }
            throw new StorageRequestError(payload?.error ?? `Editor asset request failed (${response.status}).`, {
                status: response.status, code: payload?.code ?? null, payload,
            });
        }
        const payload = await response.json();
        if (Number.isInteger(payload?.catalogRevision) && payload.catalogRevision !== this.catalogRevision) {
            this.catalogRevision = payload.catalogRevision;
            this.subscribers.forEach((callback) => callback(payload.catalogRevision));
        }
        return payload;
    }
}
