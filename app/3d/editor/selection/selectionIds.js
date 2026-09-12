/**
 * Mapping between object ids (document record ids, the editor's selection
 * identity) and runtime registry entity ids. Registry ids are derived here
 * and never stored in editor state.
 */

const ENTITY_PREFIX_BY_TYPE = Object.freeze({
    road: "road",
    intersection: "intersection",
    building: "building",
    "builtin-prop": "fusion",
});

const TYPE_BY_ENTITY_KIND = Object.freeze({
    road: "road",
    intersection: "intersection",
    building: "building",
    "road-node": null,
});

/**
 * Registry entity id for an object record, or null for records without a
 * runtime entity (groups, skybox, tile, unknown types). Props register by
 * runtime uuid, so their entity must be resolved through `sourceId`.
 */
export function entityIdForObject(record, registry = null) {
    if (!record?.id) return null;
    const prefix = ENTITY_PREFIX_BY_TYPE[record.typeId];
    if (!prefix) return null;
    if (prefix === "fusion") {
        const entity = registry ? findEntityBySource(registry, String(record.id), "props") : null;
        return entity?.id ?? null;
    }
    return `${prefix}:${record.id}`;
}

export function entityIdForSub(sub) {
    if (sub?.kind === "road-node" && sub.id !== undefined && sub.id !== null) return `road-node:${sub.id}`;
    return null;
}

/** Object id (document id) for a registry entity summary or entity. */
export function objectIdForEntity(entity) {
    if (!entity) return null;
    if (entity.kind === "road-node") return null;
    if (entity.sourceId !== undefined && entity.sourceId !== null) return String(entity.sourceId);
    const id = String(entity.id ?? "");
    const separator = id.indexOf(":");
    return separator > 0 ? id.slice(separator + 1) : null;
}

export function subForEntity(entity) {
    if (entity?.kind === "road-node" && entity.sourceId !== undefined && entity.sourceId !== null) {
        return { kind: "road-node", id: String(entity.sourceId) };
    }
    return null;
}

export function typeIdForEntityKind(kind, layer = null) {
    if (kind in TYPE_BY_ENTITY_KIND) return TYPE_BY_ENTITY_KIND[kind];
    if (layer === "props") return "builtin-prop";
    return null;
}

/** Find the registry entity whose `sourceId` matches, optionally by layer. */
export function findEntityBySource(registry, sourceId, layer = null) {
    if (!registry?.listEntities) return null;
    const summary = registry.listEntities().find((entity) => (
        String(entity.sourceId ?? "") === String(sourceId) && (layer === null || entity.layer === layer)
    ));
    return summary ? (registry.getEntity?.(summary.id) ?? summary) : null;
}

/** Object ids selected by a map hit `{ type, id }` (legacy map selection shape). */
export function objectIdForMapTarget(target) {
    if (!target?.id) return null;
    return String(target.id);
}

const MAP_TYPE_BY_TYPE_ID = Object.freeze({
    building: "building",
    "builtin-prop": "feature",
    road: "road",
    intersection: "intersection",
});

/** Legacy map-selection shape `{ type, id }` for the primary selected record, or null. */
export function mapSelectionForRecord(record) {
    if (!record?.id) return null;
    const type = MAP_TYPE_BY_TYPE_ID[record.typeId];
    return type ? { type, id: String(record.id) } : null;
}

/** Resolve the map-selection shape from a selection snapshot and a document (or snapshot). */
export function mapSelectionFromSelection(selectionSnapshot, document) {
    const primary = selectionSnapshot?.primary ?? selectionSnapshot?.ids?.at?.(-1) ?? null;
    if (!primary) return null;
    const record = typeof document?.getObject === "function"
        ? document.getObject(primary)
        : (document?.objects ?? []).find((entry) => String(entry.id) === String(primary)) ?? null;
    return mapSelectionForRecord(record);
}
