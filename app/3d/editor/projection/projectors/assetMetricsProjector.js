/** ED-07 runtime truth projection for immutable per-instance asset metrics. */

import { assetBindingRevisionVersion, readAssetBinding } from "../../../../editor-assets/AssetBackedObject.js";
import { compileAssetProxy, createWorldDescription } from "../../../../simulation/world/WorldDescription.js";
import { ASSET_LIDAR_TYPE, trianglesFromSolid } from "../lidarSolidTriangles.js";

function uploadAssetLidar(context, entries, ids = null) {
    const objects = context?.data?.objects?.();
    if (typeof objects?.replaceTriangles !== "function") return;
    const selected = ids === null ? [...entries.values()] : [...ids].map((id) => entries.get(String(id))).filter(Boolean);
    const triangles = [];
    for (const entry of selected) {
        for (const proxy of entry.lidar ?? []) {
            triangles.push(...trianglesFromSolid(proxy, {
                geometryType: ASSET_LIDAR_TYPE,
                sourceId: entry.sourceId,
                idPrefix: proxy.id,
            }));
        }
    }
    const idSet = ids === null ? null : new Set([...ids].map(String));
    objects.replaceTriangles(
        (triangle) => triangle.environmentGeometryType === ASSET_LIDAR_TYPE
            && (idSet === null || idSet.has(String(triangle.environmentSourceId))),
        triangles,
    );
}

function entityId(objectId) {
    return `asset-metric:${objectId}`;
}

function coarse(domain) {
    return Boolean(domain) && !(domain.before instanceof Map) && !(domain.after instanceof Map);
}

function changedRecords(domain) {
    const records = [];
    if (domain?.before instanceof Map) records.push(...domain.before);
    if (domain?.after instanceof Map) records.push(...domain.after);
    return records;
}

function isV2Asset(record) {
    return assetBindingRevisionVersion(record) === 2;
}

function pinOf(record) {
    const asset = readAssetBinding(record);
    if (!asset || !isV2Asset(record)) return null;
    return `${asset.assetId}@${Number(asset.revision)}`;
}

function affectedAssetIds(document, objects, definitions) {
    const ids = new Set();
    for (const [id, record] of changedRecords(objects)) {
        if (isV2Asset(record)) ids.add(String(id));
    }
    const pins = new Set();
    for (const [key] of changedRecords(definitions)) pins.add(String(key));
    if (pins.size > 0) {
        for (const record of document?.objects ?? []) {
            const pin = pinOf(record);
            if (pin && pins.has(pin)) ids.add(String(record.id));
        }
    }
    return ids;
}

function combinedBounds(entry) {
    const bounds = [...entry.collision, ...entry.lidar].map((proxy) => proxy.bounds);
    if (bounds.length === 0) return null;
    return {
        min: {
            x: Math.min(...bounds.map((value) => value.min.x)),
            y: Math.min(...bounds.map((value) => value.min.y)),
            z: Math.min(...bounds.map((value) => value.min.z)),
        },
        max: {
            x: Math.max(...bounds.map((value) => value.max.x)),
            y: Math.max(...bounds.map((value) => value.max.y)),
            z: Math.max(...bounds.map((value) => value.max.z)),
        },
    };
}

export function createAssetMetricsProjector() {
    const entries = new Map();
    let lastContext = null;

    const reset = (context = lastContext) => {
        for (const id of entries.keys()) context?.registry?.unregisterEntity(entityId(id), { affectsPersistence: false });
        entries.clear();
        uploadAssetLidar(context, entries);
    };

    const sync = (context = lastContext) => {
        if (!context) return;
        lastContext = context;
        const description = createWorldDescription({
            environmentId: context.document.environmentId,
            templateId: context.document.environmentId === "igvc" ? "igvc" : "blank",
            document: context.document.snapshot(),
        });
        const next = new Map((description.assetProxies ?? []).map((entry) => [String(entry.sourceId), entry]));
        for (const id of entries.keys()) if (!next.has(id)) {
            entries.delete(id);
            context.registry?.unregisterEntity(entityId(id), { affectsPersistence: false });
        }
        for (const [id, entry] of next) {
            entries.set(id, entry);
            context.registry?.registerEntity({
                id: entityId(id),
                sourceId: id,
                kind: "asset-metric",
                layer: "props",
                editorOnly: false,
                visible: true,
                bounds: combinedBounds(entry),
                record: entry,
            }, { affectsPersistence: false });
        }
        uploadAssetLidar(context, entries);
    };

    const remember = (context, id, entry) => {
        if (!entry) {
            entries.delete(String(id));
            context.registry?.unregisterEntity(entityId(id), { affectsPersistence: false });
            return;
        }
        entries.set(String(id), entry);
        context.registry?.registerEntity({
            id: entityId(id),
            sourceId: id,
            kind: "asset-metric",
            layer: "props",
            editorOnly: false,
            visible: true,
            bounds: combinedBounds(entry),
            record: entry,
        }, { affectsPersistence: false });
    };

    const syncIds = (context, ids) => {
        lastContext = context;
        const records = new Map((context.document?.objects ?? []).map((record) => [String(record.id), record]));
        for (const id of ids) {
            const record = records.get(String(id)) ?? null;
            remember(context, id, record ? compileAssetProxy(context.document, record) : null);
        }
        uploadAssetLidar(context, entries, ids);
    };

    return {
        id: "asset-metrics",
        entries,
        apply(context) {
            lastContext = context;
            if (context.transient) return;
            const objects = context.changeSet?.domains?.objects;
            const definitions = context.changeSet?.domains?.["assetMetrics.definitions"];
            if (!objects && !definitions) return;
            if (coarse(objects) || coarse(definitions)) {
                sync(context);
                return;
            }
            const ids = affectedAssetIds(context.document, objects, definitions);
            if (ids.size === 0) return;
            syncIds(context, ids);
        },
        sync,
        reset,
        dispose() {
            reset(lastContext);
            lastContext = null;
        },
    };
}
