import { isObjectHidden } from "./objectsProjector.js";
import { indexObjectsById } from "../../commands/objectMutations.js";
import { isAssetBackedObject, readAssetBinding } from "../../../../editor-assets/AssetBackedObject.js";

function entityId(objectId) {
    return `asset:${objectId}`;
}

function applyTransform(root, asset) {
    root.position.set(asset.position.x, asset.position.y, asset.position.z);
    root.rotation.set(0, asset.rotationY, 0);
    root.scale.set(asset.scale.x, asset.scale.y, asset.scale.z);
    root.updateMatrixWorld(true);
}

export function createAssetInstancesProjector() {
    const entries = new Map();
    let enabled = false;
    let epoch = 0;
    let lastContext = null;

    const remove = (objectId, context = lastContext) => {
        const entry = entries.get(String(objectId));
        if (!entry) return;
        entry.generation += 1;
        entry.abortController?.abort();
        entry.root?.removeFromParent?.();
        entry.release?.();
        context?.registry?.unregisterEntity(entityId(objectId), { affectsPersistence: false });
        entries.delete(String(objectId));
    };

    const load = async (record, context) => {
        const objectId = String(record.id);
        const environmentOwned = record.typeId === "tile";
        remove(objectId, context);
        const generation = (entries.get(objectId)?.generation ?? 0) + 1;
        const abortController = new AbortController();
        const entry = { generation, modelUseHash: null, root: null, release: null, abortController, status: "loading", bounds: null, error: null };
        entries.set(objectId, entry);
        const currentEpoch = epoch;
        const binding = readAssetBinding(record);
        const pin = { assetId: binding.assetId, revision: binding.revision };
        try {
            const revision = await context.runtime.editorAssets.repository.getRevision(pin.assetId, pin.revision, { signal: abortController.signal });
            if ((!enabled && !environmentOwned) || epoch !== currentEpoch || entries.get(objectId) !== entry) return;
            entry.modelUseHash = revision.modelUseHash;
            const lease = await context.runtime.editorAssets.models.acquire(revision.modelUseHash, { signal: abortController.signal });
            const current = context.document.getObject(objectId);
            if ((!enabled && !environmentOwned) || epoch !== currentEpoch || entries.get(objectId) !== entry
                || readAssetBinding(current)?.assetId !== pin.assetId
                || readAssetBinding(current)?.revision !== pin.revision) {
                lease.release();
                return;
            }
            entry.root = lease.root;
            entry.release = lease.release;
            entry.bounds = lease.localBounds;
            entry.status = "ready";
            applyTransform(entry.root, readAssetBinding(current));
            const hidden = isObjectHidden(indexObjectsById(context.document.objects), objectId);
            entry.root.visible = !hidden;
            context.scene?.add?.(entry.root);
            context.registry?.registerEntity({
                id: entityId(objectId), sourceId: objectId, kind: record.typeId === "tile" ? "tile" : "asset-instance",
                layer: record.typeId === "tile" ? "environment" : "props", editorOnly: record.typeId !== "tile", object3D: entry.root,
                bounds: entry.bounds, visible: !hidden, record: { assetId: pin.assetId, revision: pin.revision },
            }, { affectsPersistence: false });
            context.data?.simulation?.()?.render?.();
        } catch (error) {
            if (abortController.signal.aborted || entries.get(objectId) !== entry || epoch !== currentEpoch) return;
            entry.status = "error";
            entry.error = error;
            context.registry?.notify?.({ affectsPersistence: false });
        }
    };

    const syncRecord = (record, before, context) => {
        const objectId = String(record.id);
        if (!enabled && record.typeId !== "tile") return remove(objectId, context);
        const asset = readAssetBinding(record);
        if (!asset) return remove(objectId, context);
        const entry = entries.get(objectId);
        const beforeAsset = readAssetBinding(before);
        const pinChanged = !entry || beforeAsset?.assetId !== asset.assetId || beforeAsset?.revision !== asset.revision;
        if (pinChanged || (entry.modelUseHash === null && entry.status !== "loading")) {
            void load(record, context);
            return;
        }
        if (entry.root) {
            applyTransform(entry.root, asset);
            context.registry?.updateEntityTransform(entityId(objectId), entry.root, { affectsPersistence: false });
        }
    };

    const projector = {
        id: "asset-instances",
        entries,
        apply(context) {
            lastContext = context;
            const domain = context.changeSet?.domains?.objects;
            if (!domain) return;
            for (const [id, after] of domain.after) {
                const before = domain.before.get(id) ?? null;
                if (isAssetBackedObject(after)) syncRecord(after, before, context);
                else if (isAssetBackedObject(before)) remove(id, context);
            }
        },
        sync(context = lastContext) {
            if (context) lastContext = context;
            if (!lastContext) return;
            const present = new Set();
            for (const record of lastContext.document.objects) {
                if (!isAssetBackedObject(record)) continue;
                if (!enabled && record.typeId !== "tile") continue;
                present.add(String(record.id));
                const entry = entries.get(String(record.id));
                if (!entry) syncRecord(record, null, lastContext);
                else if (entry.root) applyTransform(entry.root, readAssetBinding(record));
            }
            for (const id of [...entries.keys()]) if (!present.has(id)) remove(id, lastContext);
        },
        setEnabled(value, context = lastContext) {
            enabled = value === true;
            if (context) lastContext = context;
            projector.sync(lastContext);
        },
        reset(context = lastContext) {
            epoch += 1;
            for (const id of [...entries.keys()]) remove(id, context);
        },
        dispose() {
            enabled = false;
            projector.reset(lastContext);
            lastContext = null;
        },
    };
    return projector;
}
