import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
    createEmptyEditorAssetCatalog,
    normalizeEditorAssetCatalog,
    normalizeEditorAssetRevision,
    validateEditorAssetCatalog,
    validateEditorAssetRevision,
} from "../../app/editor-assets/EditorAssetContract.js";
import { VISUAL_ASSET_UPLOAD_OPERATIONS } from "../../app/simulation/visual/VisualLayer.js";
import { JsonFileStore } from "./JsonFileStore.js";
import { EDITOR_ASSET_ERROR_CODES, editorAssetError } from "./StorageErrors.js";
import { fsyncDir, maybeFault, writeExclusiveFile } from "./visual-assets/atomicFs.js";

function safeId(value, label = "id") {
    const id = String(value ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
        throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, `${label} must be a non-empty portable id.`);
    }
    return id;
}

function equal(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
    return structuredClone(value);
}

export class EditorAssetStore {
    constructor(dataDir, { visualAssets, now = () => new Date(), faults = {} } = {}) {
        if (!visualAssets) throw new TypeError("EditorAssetStore requires VisualAssetStore.");
        this.dataDir = dataDir;
        this.visualAssets = visualAssets;
        this.now = now;
        this.faults = faults;
        this.rootDir = path.join(dataDir, "editor-assets");
        this.catalogPath = path.join(this.rootDir, "catalog.json");
        this.revisionsDir = path.join(this.rootDir, "revisions");
        this.transactionsDir = path.join(this.rootDir, "transactions");
        this.catalogStore = new JsonFileStore(this.catalogPath, { fallback: createEmptyEditorAssetCatalog() });
        this._ready = null;
        this._writeChain = Promise.resolve();
    }

    async initialize() {
        if (!this._ready) this._ready = (async () => {
            await fs.mkdir(this.transactionsDir, { recursive: true });
            await this.visualAssets.initialize();
            await this._recoverPublications();
            await this._readCatalog();
        })();
        return this._ready;
    }

    async _enqueue(operation) {
        await this.initialize();
        const request = this._writeChain.catch(() => {}).then(operation);
        this._writeChain = request;
        return request;
    }

    async _readCatalog() {
        const catalog = normalizeEditorAssetCatalog(await this.catalogStore.read());
        const issues = validateEditorAssetCatalog(catalog);
        if (issues.length > 0) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.RECOVERY_CONFLICT, "Editor asset catalog is invalid.", { issues });
        return catalog;
    }

    async _writeCatalog(catalog) {
        const normalized = normalizeEditorAssetCatalog(catalog);
        const issues = validateEditorAssetCatalog(normalized);
        if (issues.length > 0) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "Editor asset catalog mutation is invalid.", { issues });
        return this.catalogStore.write(normalized);
    }

    _assertExpected(expectedRevision, catalog) {
        if (!Number.isInteger(expectedRevision) || expectedRevision !== catalog.revision) {
            throw editorAssetError(
                EDITOR_ASSET_ERROR_CODES.REVISION_CONFLICT,
                `Editor asset catalog revision conflict: expected ${expectedRevision ?? "a revision"}, current revision is ${catalog.revision}.`,
                { currentRevision: catalog.revision },
            );
        }
    }

    async list(query = {}) {
        await this.initialize();
        const catalog = await this._readCatalog();
        const search = String(query.search ?? "").trim().toLowerCase();
        const tags = String(query.tags ?? "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
        const folderId = query.folderId === undefined ? undefined : (query.folderId === "" ? null : String(query.folderId));
        const includeArchived = query.archived === true || query.archived === "true";
        const assets = catalog.assets.filter((asset) => (
            (includeArchived || !asset.archived)
            && (folderId === undefined || asset.folderId === folderId)
            && (!search || `${asset.name} ${asset.tags.join(" ")}`.toLowerCase().includes(search))
            && tags.every((tag) => asset.tags.some((entry) => entry.toLowerCase() === tag))
        ));
        const sort = query.sort === "updated" ? "updatedAt" : "name";
        const direction = query.direction === "desc" ? -1 : 1;
        assets.sort((left, right) => direction * String(left[sort]).localeCompare(String(right[sort])) || left.id.localeCompare(right.id));
        return { catalogRevision: catalog.revision, folders: clone(catalog.folders), assets: clone(assets) };
    }

    async get(assetId) {
        await this.initialize();
        const catalog = await this._readCatalog();
        const asset = catalog.assets.find((entry) => entry.id === String(assetId));
        if (!asset) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.NOT_FOUND, `Editor asset "${assetId}" was not found.`);
        return { catalogRevision: catalog.revision, asset: clone(asset) };
    }

    _revisionPath(assetId, revision) {
        return path.join(this.revisionsDir, safeId(assetId, "assetId"), `${revision}.json`);
    }

    _journalPath(publicationId) {
        return path.join(this.transactionsDir, `${safeId(publicationId, "publicationId")}.json`);
    }

    async _readRevisionFile(assetId, revision, { optional = false } = {}) {
        let value;
        try {
            value = JSON.parse(await fs.readFile(this._revisionPath(assetId, revision), "utf8"));
        } catch (error) {
            if (optional && error.code === "ENOENT") return null;
            if (error.code === "ENOENT") throw editorAssetError(EDITOR_ASSET_ERROR_CODES.NOT_FOUND, `Editor asset revision ${assetId}@${revision} was not found.`);
            throw error;
        }
        const record = normalizeEditorAssetRevision(value);
        const issues = validateEditorAssetRevision(record);
        if (issues.length > 0) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.RECOVERY_CONFLICT, `Editor asset revision ${assetId}@${revision} is invalid.`, { issues });
        return record;
    }

    async getRevision(assetId, revision) {
        await this.initialize();
        const number = Number(revision);
        const { asset } = await this.get(assetId);
        if (!Number.isInteger(number) || number <= 0 || number > asset.latestRevision) {
            throw editorAssetError(EDITOR_ASSET_ERROR_CODES.NOT_FOUND, `Editor asset revision ${assetId}@${revision} was not found.`);
        }
        return this._readRevisionFile(assetId, number);
    }

    async listRevisions(assetId) {
        const { asset, catalogRevision } = await this.get(assetId);
        const revisions = [];
        for (let revision = 1; revision <= asset.latestRevision; revision += 1) revisions.push(await this._readRevisionFile(assetId, revision));
        return { catalogRevision, assetId: asset.id, revisions };
    }

    async _findPublication(publicationId) {
        const catalog = await this._readCatalog();
        for (const asset of catalog.assets) {
            for (let revision = 1; revision <= asset.latestRevision; revision += 1) {
                const record = await this._readRevisionFile(asset.id, revision);
                if (record.publicationId === publicationId) return { catalogRevision: catalog.revision, asset: clone(asset), revision: record };
            }
        }
        return null;
    }

    async publishRevision(draft = {}, expectedRevision) {
        return this._enqueue(async () => {
            const publicationId = safeId(draft.publicationId, "publicationId");
            const replay = await this._findPublication(publicationId);
            if (replay) return replay;
            const catalog = await this._readCatalog();
            this._assertExpected(expectedRevision, catalog);
            const assetId = safeId(draft.assetId ?? draft.id, "assetId");
            const existing = catalog.assets.find((entry) => entry.id === assetId) ?? null;
            const revisionNumber = (existing?.latestRevision ?? 0) + 1;
            if (!existing && (typeof draft.name !== "string" || !draft.name.trim())) {
                throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "A name is required when publishing a new editor asset.");
            }
            const folderId = draft.folderId === undefined ? (existing?.folderId ?? null) : (draft.folderId === null || draft.folderId === "" ? null : safeId(draft.folderId, "folderId"));
            if (folderId && !catalog.folders.some((folder) => folder.id === folderId)) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, `Folder "${folderId}" does not exist.`);
            const createdAt = this.now().toISOString();
            const revision = normalizeEditorAssetRevision({
                assetId, revision: revisionNumber, publicationId,
                modelUseHash: draft.modelUseHash, createdAt,
            });
            const revisionIssues = validateEditorAssetRevision(revision);
            if (revisionIssues.length > 0) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "Editor asset revision is invalid.", { issues: revisionIssues });
            const modelUse = await this.visualAssets.getUse(revision.modelUseHash);
            if (!new Set(["model/gltf+json", "model/gltf-binary"]).has(modelUse.asset?.mediaType) || modelUse.asset?.role !== "mesh") {
                throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "Editor asset revisions require a GLTF mesh use.");
            }
            await this.visualAssets.validateClosure({ useHash: revision.modelUseHash, operations: VISUAL_ASSET_UPLOAD_OPERATIONS });
            const nextAsset = {
                id: assetId,
                name: typeof draft.name === "string" && draft.name.trim() ? draft.name.trim() : existing.name,
                folderId,
                tags: Array.isArray(draft.tags) ? [...new Set(draft.tags.map(String).map((tag) => tag.trim()).filter(Boolean))] : (existing?.tags ?? []),
                archived: false,
                latestRevision: revisionNumber,
                thumbnails: clone(existing?.thumbnails ?? {}),
                createdAt: existing?.createdAt ?? createdAt,
                updatedAt: createdAt,
            };
            const targetCatalog = normalizeEditorAssetCatalog({
                ...catalog,
                revision: catalog.revision + 1,
                assets: [...catalog.assets.filter((entry) => entry.id !== assetId), nextAsset],
            });
            const ownerId = `editor-asset:${assetId}:revision:${revisionNumber}`;
            const journal = {
                kind: "cev-sim.editor-asset-publication", version: 1,
                publicationId, expectedCatalogRevision: catalog.revision,
                ownerId, revision, targetCatalog,
            };
            const journalPath = this._journalPath(publicationId);
            await new JsonFileStore(journalPath).write(journal);
            await maybeFault(this.faults, "editorAssetAfterJournal");
            const root = await this.visualAssets.acquireRoot({
                ownerId, ownerKind: "editor-asset-revision", useHash: revision.modelUseHash,
                operations: VISUAL_ASSET_UPLOAD_OPERATIONS,
            });
            await maybeFault(this.faults, "editorAssetAfterRoot");
            const bytes = `${JSON.stringify(revision, null, 2)}\n`;
            const write = await writeExclusiveFile(this._revisionPath(assetId, revisionNumber), bytes, { faults: this.faults });
            if (write.existed) {
                const current = await this._readRevisionFile(assetId, revisionNumber);
                if (!equal(current, revision)) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.IMMUTABLE_CONFLICT, `Immutable editor asset revision ${assetId}@${revisionNumber} already differs.`);
            }
            await maybeFault(this.faults, "editorAssetAfterRevision");
            await this._writeCatalog(targetCatalog);
            await maybeFault(this.faults, "editorAssetAfterCatalog");
            await fs.rm(journalPath, { force: true });
            await fsyncDir(this.transactionsDir, this.faults);
            return { catalogRevision: targetCatalog.revision, asset: nextAsset, revision, rootGeneration: root.generation };
        });
    }

    async _mutate(expectedRevision, mutation) {
        return this._enqueue(async () => {
            const catalog = await this._readCatalog();
            this._assertExpected(expectedRevision, catalog);
            const next = await mutation(clone(catalog));
            next.revision = catalog.revision + 1;
            const committed = await this._writeCatalog(next);
            return { catalogRevision: committed.revision, catalog: committed };
        });
    }

    async updateMetadata(assetId, patch = {}, expectedRevision) {
        const id = safeId(assetId, "assetId");
        return this._mutate(expectedRevision, (catalog) => {
            const asset = catalog.assets.find((entry) => entry.id === id);
            if (!asset) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.NOT_FOUND, `Editor asset "${id}" was not found.`);
            if (patch.name !== undefined) {
                if (typeof patch.name !== "string" || !patch.name.trim()) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "Asset name is required.");
                asset.name = patch.name.trim();
            }
            if (patch.folderId !== undefined) {
                const folderId = patch.folderId === null || patch.folderId === "" ? null : safeId(patch.folderId, "folderId");
                if (folderId && !catalog.folders.some((folder) => folder.id === folderId)) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, `Folder "${folderId}" does not exist.`);
                asset.folderId = folderId;
            }
            if (patch.tags !== undefined) asset.tags = [...new Set((Array.isArray(patch.tags) ? patch.tags : []).map(String).map((tag) => tag.trim()).filter(Boolean))];
            if (patch.archived !== undefined) asset.archived = patch.archived === true;
            asset.updatedAt = this.now().toISOString();
            return catalog;
        });
    }

    setArchived(assetId, archived, expectedRevision) {
        return this.updateMetadata(assetId, { archived: archived === true }, expectedRevision);
    }

    createFolder(input = {}, expectedRevision) {
        return this._mutate(expectedRevision, (catalog) => {
            const id = safeId(input.id ?? `folder-${randomUUID()}`, "folderId");
            if (catalog.folders.some((entry) => entry.id === id)) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, `Folder "${id}" already exists.`);
            const name = typeof input.name === "string" ? input.name.trim() : "";
            if (!name) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "Folder name is required.");
            const parentId = input.parentId === null || input.parentId === undefined || input.parentId === "" ? null : safeId(input.parentId, "parentId");
            if (parentId && !catalog.folders.some((entry) => entry.id === parentId)) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, `Folder parent "${parentId}" does not exist.`);
            catalog.folders.push({ id, name, parentId });
            return catalog;
        });
    }

    updateFolder(folderId, patch = {}, expectedRevision) {
        const id = safeId(folderId, "folderId");
        return this._mutate(expectedRevision, (catalog) => {
            const folder = catalog.folders.find((entry) => entry.id === id);
            if (!folder) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.NOT_FOUND, `Folder "${id}" was not found.`);
            if (patch.name !== undefined) {
                if (typeof patch.name !== "string" || !patch.name.trim()) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "Folder name is required.");
                folder.name = patch.name.trim();
            }
            if (patch.parentId !== undefined) {
                const parentId = patch.parentId === null || patch.parentId === "" ? null : safeId(patch.parentId, "parentId");
                if (parentId && !catalog.folders.some((entry) => entry.id === parentId)) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, `Folder parent "${parentId}" does not exist.`);
                folder.parentId = parentId;
            }
            const issues = validateEditorAssetCatalog(normalizeEditorAssetCatalog(catalog));
            if (issues.length > 0) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "Folder move is invalid.", { issues });
            return catalog;
        });
    }

    deleteFolder(folderId, expectedRevision) {
        const id = safeId(folderId, "folderId");
        return this._mutate(expectedRevision, (catalog) => {
            if (!catalog.folders.some((entry) => entry.id === id)) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.NOT_FOUND, `Folder "${id}" was not found.`);
            if (catalog.folders.some((entry) => entry.parentId === id) || catalog.assets.some((entry) => entry.folderId === id)) {
                throw editorAssetError(EDITOR_ASSET_ERROR_CODES.FOLDER_NOT_EMPTY, `Folder "${id}" is not empty.`);
            }
            catalog.folders = catalog.folders.filter((entry) => entry.id !== id);
            return catalog;
        });
    }

    async setThumbnail(assetId, revision, useHash, expectedRevision) {
        const id = safeId(assetId, "assetId");
        const number = Number(revision);
        return this._enqueue(async () => {
            const catalog = await this._readCatalog();
            this._assertExpected(expectedRevision, catalog);
            const asset = catalog.assets.find((entry) => entry.id === id);
            if (!asset || !Number.isInteger(number) || number <= 0 || number > asset.latestRevision) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.NOT_FOUND, `Editor asset revision ${id}@${revision} was not found.`);
            const use = await this.visualAssets.getUse(useHash);
            if (!String(use.asset?.mediaType).startsWith("image/")) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.INVALID, "Thumbnail use must be an image.");
            await this.visualAssets.validateClosure({ useHash, operations: VISUAL_ASSET_UPLOAD_OPERATIONS });
            const ownerId = `editor-asset:${id}:revision:${number}:thumbnail`;
            const currentRoot = await this.visualAssets.getRoot(ownerId);
            if (currentRoot) await this.visualAssets.replaceRoot({ ownerId, expectedGeneration: currentRoot.generation, useHash, operations: VISUAL_ASSET_UPLOAD_OPERATIONS, ownerKind: "editor-asset-thumbnail" });
            else await this.visualAssets.acquireRoot({ ownerId, ownerKind: "editor-asset-thumbnail", useHash, operations: VISUAL_ASSET_UPLOAD_OPERATIONS });
            asset.thumbnails[String(number)] = { useHash, rendererVersion: 1 };
            asset.updatedAt = this.now().toISOString();
            catalog.revision += 1;
            const committed = await this._writeCatalog(catalog);
            return { catalogRevision: committed.revision, asset: clone(asset) };
        });
    }

    async _recoverPublications() {
        const names = await fs.readdir(this.transactionsDir).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
        for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
            const journalPath = path.join(this.transactionsDir, name);
            let journal;
            try { journal = JSON.parse(await fs.readFile(journalPath, "utf8")); } catch (error) {
                throw editorAssetError(EDITOR_ASSET_ERROR_CODES.RECOVERY_CONFLICT, `Editor asset transaction ${name} is corrupt: ${error.message}`);
            }
            if (journal?.kind !== "cev-sim.editor-asset-publication" || journal.version !== 1) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.RECOVERY_CONFLICT, `Editor asset transaction ${name} has an unsupported contract.`);
            const catalog = normalizeEditorAssetCatalog(await this.catalogStore.read());
            const record = await this._readRevisionFile(journal.revision.assetId, journal.revision.revision, { optional: true });
            const root = await this.visualAssets.getRoot(journal.ownerId);
            if (equal(catalog, journal.targetCatalog)) {
                if (!equal(record, journal.revision) || root?.useHash !== journal.revision.modelUseHash) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.RECOVERY_CONFLICT, `Committed editor asset transaction ${name} is incomplete; protective roots were retained.`);
                await fs.rm(journalPath, { force: true });
                continue;
            }
            if (catalog.revision !== journal.expectedCatalogRevision) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.RECOVERY_CONFLICT, `Editor asset transaction ${name} is ambiguous; protective roots were retained.`);
            if (record && !equal(record, journal.revision)) throw editorAssetError(EDITOR_ASSET_ERROR_CODES.RECOVERY_CONFLICT, `Editor asset transaction ${name} collided with immutable revision state; protective roots were retained.`);
            if (record) await fs.rm(this._revisionPath(record.assetId, record.revision), { force: true });
            if (root) await this.visualAssets.releaseRoot({ ownerId: journal.ownerId, expectedGeneration: root.generation });
            await fs.rm(journalPath, { force: true });
        }
    }
}
