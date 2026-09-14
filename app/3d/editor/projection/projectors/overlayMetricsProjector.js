/**
 * Overlay-only metric records: types with `legacy: null` may compile a metric
 * payload that exists only as an editor registry entity. Never feeds
 * `createWorldDescription`.
 */

import { objectTypeRegistry } from "../../objects/ObjectTypeRegistry.js";

function entityId(objectId) {
    return `overlay-metric:${objectId}`;
}

export function createOverlayMetricsProjector() {
    const entries = new Map();
    let lastContext = null;

    const remove = (context, id) => {
        entries.delete(String(id));
        context?.registry?.unregisterEntity(entityId(id), { affectsPersistence: false });
    };

    const project = (context, id, record) => {
        const types = context.runtime?.objectRegistry ?? objectTypeRegistry;
        const type = record
            ? (types.get(record.typeId, record.typeVersion) ?? types.get(record.typeId))
            : null;
        if (!type || type.legacy !== null) {
            remove(context, id);
            return;
        }
        const metric = type.compileMetric(record, {
            document: context.document,
            runtime: context.runtime,
        });
        if (!metric) {
            remove(context, id);
            return;
        }
        entries.set(String(id), metric);
        context.registry?.registerEntity({
            id: entityId(id),
            sourceId: String(record.id),
            kind: "overlay-metric",
            editorOnly: true,
            record: metric,
        }, { affectsPersistence: false });
    };

    const reset = (context = lastContext) => {
        for (const id of [...entries.keys()]) remove(context, id);
    };

    const sync = (context = lastContext) => {
        if (!context) return;
        lastContext = context;
        const records = new Map((context.document?.objects ?? []).map((record) => [String(record.id), record]));
        for (const id of [...entries.keys()]) if (!records.has(id)) remove(context, id);
        for (const [id, record] of records) project(context, id, record);
    };

    return {
        id: "overlay-metrics",
        entries,
        apply(context) {
            lastContext = context;
            const domain = context.changeSet?.domains?.objects;
            if (!domain || !context.registry) return;
            for (const id of domain.after.keys()) {
                const record = domain.after.get(id);
                project(context, id, record);
            }
        },
        sync,
        reset,
        dispose() {
            reset(lastContext);
            lastContext = null;
        },
    };
}
