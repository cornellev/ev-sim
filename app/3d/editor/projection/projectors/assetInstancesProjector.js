import { isObjectHidden } from "./objectsProjector.js";
import { indexObjectsById } from "../../commands/objectMutations.js";

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
        remove(objectId, context);
        const generation = (entries.get(objectId)?.generation ?? 0) + 1;
        const abortController = new AbortController();
        const entry = { generation, modelUseHash: null, root: null, release: null, abortController, status: "loading", bounds: null, error: null };
        entries.set(objectId, entry);
        const currentEpoch = epoch;
        const pin = { assetId: record.components.asset.assetId, revision: record.components.asset.revision };
        try {
            const revision = await context.runtime.editorAssets.repository.getRevision(pin.assetId, pin.revision, { signal: abortController.signal });
            if (!enabled || epoch !== currentEpoch || entries.get(objectId) !== entry) return;
            entry.modelUseHash = revision.modelUseHash;
            const lease = await context.runtime.editorAssets.models.acquire(revision.modelUseHash, { signal: abortController.signal });
            const current = context.document.getObject(objectId);
            if (!enabled || epoch !== currentEpoch || entries.get(objectId) !== entry
                || current?.components?.asset?.assetId !== pin.assetId
                || current?.components?.asset?.revision !== pin.revision) {
                lease.release();
                return;
            }
            entry.root = lease.root;
            entry.release = lease.release;
            entry.bounds = lease.localBounds;
            entry.status = "ready";
            applyTransform(entry.root, current.components.asset);
            const hidden = isObjectHidden(indexObjectsById(context.document.objects), objectId);
            entry.root.visible = !hidden;
            context.scene?.add?.(entry.root);
            context.registry?.registerEntity({
                id: entityId(objectId), sourceId: objectId, kind: "asset-instance",
                layer: "props", editorOnly: true, object3D: entry.root,
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
        const asset = record.components?.asset;
        if (!asset) return remove(objectId, context);
        const entry = entries.get(objectId);
        const pinChanged = !entry || before?.components?.asset?.assetId !== asset.assetId || before?.components?.asset?.revision !== asset.revision;
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
            if (!enabled) return;
            const domain = context.changeSet?.domains?.objects;
            if (!domain) return;
            for (const [id, after] of domain.after) {
                const before = domain.before.get(id) ?? null;
                if (after?.typeId === "asset-instance") syncRecord(after, before, context);
                else if (before?.typeId === "asset-instance") remove(id, context);
            }
        },
        sync(context = lastContext) {
            if (context) lastContext = context;
            if (!enabled || !lastContext) return;
            const present = new Set();
            for (const record of lastContext.document.objects) {
                if (record.typeId !== "asset-instance") continue;
                present.add(String(record.id));
                const entry = entries.get(String(record.id));
                if (!entry) syncRecord(record, null, lastContext);
                else if (entry.root) applyTransform(entry.root, record.components.asset);
            }
            for (const id of [...entries.keys()]) if (!present.has(id)) remove(id, lastContext);
        },
        setEnabled(value, context = lastContext) {
            enabled = value === true;
            if (context) lastContext = context;
            if (!enabled) projector.reset(lastContext);
            else projector.sync(lastContext);
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
