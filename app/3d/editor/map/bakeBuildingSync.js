/**
 * Canonical bake-config building synchronization from the environment document.
 * Map edits never append-only patch; every add/transform/delete/hydration
 * replaces the building set through BakeRunConfig.setBuildings().
 */

export function recordsFromBuildings(buildings = []) {
    return buildings.map((record) => ({
        ...record,
        footprint: (record.footprint ?? []).map((point) => ({ ...point })),
        tags: [...(record.tags ?? ["building"])],
    }));
}

export function syncBakeBuildingsFromDocument(data, document) {
    const bakeConfig = data?.bakeRunConfig?.();
    if (!bakeConfig || typeof bakeConfig.setBuildings !== "function") return false;
    bakeConfig.setBuildings(recordsFromBuildings(document?.buildings ?? []));
    return true;
}

/** @deprecated Use syncBakeBuildingsFromDocument after the document mutation. */
export function upsertBakeBuildingRecord(data, record) {
    const document = data?.environment?.()?.getDocument?.();
    if (document && record?.buildingId) {
        const existing = document.buildings?.some((building) => building.buildingId === record.buildingId);
        if (!existing && Array.isArray(document.buildings)) {
            // Document is the authority; callers should mutate it first.
        }
        return syncBakeBuildingsFromDocument(data, document);
    }
    const bakeConfig = data?.bakeRunConfig?.();
    if (!bakeConfig || !record?.buildingId || typeof bakeConfig.setBuildings !== "function") return false;
    const next = [
        ...bakeConfig.buildings.filter((building) => building.buildingId !== record.buildingId),
        record,
    ];
    bakeConfig.setBuildings(recordsFromBuildings(next));
    return true;
}
