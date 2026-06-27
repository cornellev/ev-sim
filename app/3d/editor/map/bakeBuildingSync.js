/**
 * Add or update a building record in the active bake run config.
 * Map edits patch bake config incrementally; full resync uses BuildingRuntimeAdapter.
 */
export function upsertBakeBuildingRecord(data, record) {
    const bakeConfig = data.bakeRunConfig?.();
    if (!bakeConfig || !record?.buildingId) return false;

    const existing = bakeConfig.buildings.find((building) => building.buildingId === record.buildingId);
    if (existing) return false;

    bakeConfig.buildings.push({ ...record });
    return true;
}
