import { createId } from "../document/EnvironmentDocument.js";
import { placeAssetInstance, updateAssetInstances } from "../commands/assetCommands.js";
import { readAssetBinding } from "../../../editor-assets/AssetBackedObject.js";

export class AssetInstantiation {
    constructor({ repository, document } = {}) {
        if (!repository || !document) throw new TypeError("AssetInstantiation requires a repository and document.");
        this.repository = repository;
        this.document = document;
    }

    async place({ assetId, revision, position = { x: 0, y: 0, z: 0 }, rotationY = 0, scale = { x: 1, y: 1, z: 1 }, name, parentId = null, signal } = {}) {
        const published = await this.repository.getRevision(assetId, revision, { signal });
        const record = {
            id: createId("asset"), typeId: "asset-instance", typeVersion: published.version === 2 ? 2 : 1,
            name: name ?? assetId, parentId, order: this.document.objects.length,
            components: {
                tags: [], locked: false, editorHidden: false,
                asset: { assetId, revision, position: { ...position }, rotationY, scale: { ...scale }, overrides: {} },
            },
        };
        return placeAssetInstance({ record, publishedRevision: published });
    }

    async placeTile({ assetId, revision, position = { x: 0, y: 0, z: 0 }, rotationY = 0, scale = { x: 1, y: 1, z: 1 }, name, signal } = {}) {
        const published = await this.repository.getRevision(assetId, revision, { signal });
        const record = {
            id: "tile", typeId: "tile", typeVersion: 2, name: name ?? "GLTF Tile", parentId: null,
            order: this.document.objects.length,
            components: {
                tags: [], locked: false, editorHidden: false,
                asset: { assetId, revision, position: { ...position }, rotationY, scale: { ...scale }, overrides: {} },
                tile: { provider: "gltf", assetTypeVersion: published.version === 2 ? 2 : 1 },
            },
        };
        return placeAssetInstance({ record, publishedRevision: published, label: "Place GLTF Tile" });
    }

    async update({ assetId, targetRevision, objectIds = null, signal } = {}) {
        const published = await this.repository.getRevision(assetId, targetRevision, { signal });
        const wanted = objectIds ? new Set(objectIds.map(String)) : null;
        const changes = this.document.objects
            .filter((record) => readAssetBinding(record)?.assetId === assetId
                && (!wanted || wanted.has(String(record.id))))
            .map((record) => {
                const beforeAsset = structuredClone(readAssetBinding(record));
                return { objectId: String(record.id), beforeAsset, afterAsset: { ...structuredClone(beforeAsset), revision: targetRevision } };
            });
        return updateAssetInstances({
            expectedDocumentVersion: this.document.version,
            targetRevision,
            changes,
            publishedRevision: published,
        });
    }
}
