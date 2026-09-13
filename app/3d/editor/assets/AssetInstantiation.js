import { createId } from "../document/EnvironmentDocument.js";
import { placeAssetInstance, updateAssetInstances } from "../commands/assetCommands.js";

export class AssetInstantiation {
    constructor({ repository, document } = {}) {
        if (!repository || !document) throw new TypeError("AssetInstantiation requires a repository and document.");
        this.repository = repository;
        this.document = document;
    }

    async place({ assetId, revision, position = { x: 0, y: 0, z: 0 }, rotationY = 0, scale = { x: 1, y: 1, z: 1 }, name, parentId = null, signal } = {}) {
        await this.repository.getRevision(assetId, revision, { signal });
        const record = {
            id: createId("asset"), typeId: "asset-instance", typeVersion: 1,
            name: name ?? assetId, parentId, order: this.document.objects.length,
            components: {
                tags: [], locked: false, editorHidden: false,
                asset: { assetId, revision, position: { ...position }, rotationY, scale: { ...scale }, overrides: {} },
            },
        };
        return placeAssetInstance({ record });
    }

    async update({ assetId, targetRevision, objectIds = null, signal } = {}) {
        await this.repository.getRevision(assetId, targetRevision, { signal });
        const wanted = objectIds ? new Set(objectIds.map(String)) : null;
        const changes = this.document.objects
            .filter((record) => record.typeId === "asset-instance"
                && record.components?.asset?.assetId === assetId
                && (!wanted || wanted.has(String(record.id))))
            .map((record) => {
                const beforeAsset = structuredClone(record.components.asset);
                return { objectId: String(record.id), beforeAsset, afterAsset: { ...structuredClone(beforeAsset), revision: targetRevision } };
            });
        return updateAssetInstances({ expectedDocumentVersion: this.document.version, targetRevision, changes });
    }
}
