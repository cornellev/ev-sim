/** ED-07 runtime truth projection for immutable per-instance asset metrics. */

import { createWorldDescription } from "../../../../simulation/world/WorldDescription.js";

function entityId(objectId) {
    return `asset-metric:${objectId}`;
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
    };

    return {
        id: "asset-metrics",
        entries,
        apply(context) {
            lastContext = context;
            if (context.changeSet?.domains?.objects || context.changeSet?.domains?.["assetMetrics.definitions"]) sync(context);
        },
        sync,
        reset,
        dispose() {
            reset(lastContext);
            lastContext = null;
        },
    };
}
