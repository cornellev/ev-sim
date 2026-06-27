export const PLACEMENT_CATALOG = Object.freeze([
    {
        id: "stop-sign",
        label: "Stop Sign",
        kind: "sign",
        mapColor: "#ef4444",
    },
    {
        id: "one-way-sign",
        label: "One Way",
        kind: "sign",
        mapColor: "#38bdf8",
    },
    {
        id: "barrel",
        label: "Barrel",
        kind: "barrel",
        mapColor: "#f97316",
    },
    {
        id: "tire",
        label: "Tire",
        kind: "tire",
        mapColor: "#71717a",
    },
]);

const CATALOG_BY_ID = new Map(PLACEMENT_CATALOG.map((asset) => [asset.id, asset]));

export function getPlacementAsset(assetId) {
    return CATALOG_BY_ID.get(assetId) ?? null;
}

export function getMapColorForAsset(assetId) {
    return getPlacementAsset(assetId)?.mapColor ?? "#a1a1aa";
}

/**
 * @param {Object} fusionObject
 * @returns {string | null}
 */
export function fusionObjectToCatalogType(fusionObject) {
    const name = fusionObject?.constructor?.name;
    if (name === "StopSign") return "stop-sign";
    if (name === "OneWaySign") return "one-way-sign";
    if (name === "Tire") return "tire";
    if (name === "Barrel") return "barrel";

    const tags = fusionObject?.tags ?? [];
    if (tags.includes("barrel")) return "barrel";
    if (tags.includes("tire")) return "tire";
    if (tags.includes("sign")) return "stop-sign";
    return null;
}
