/**
 * Placement catalog for built-in props. A Three-free view over
 * `BUILTIN_PROP_ASSETS` so the server, MCP tools, and map rendering share one
 * table with the object registry. Shape and order are frozen contracts.
 */

import {
    BUILTIN_PROP_ASSETS,
    DEFAULT_MAP_COLOR,
    getBuiltinPropAsset,
} from "../objects/types/builtinProp.js";

export const PLACEMENT_CATALOG = Object.freeze(BUILTIN_PROP_ASSETS.map((asset) => Object.freeze({
    id: asset.id,
    label: asset.label,
    kind: asset.kind,
    mapColor: asset.mapColor,
})));

const CATALOG_BY_ID = new Map(PLACEMENT_CATALOG.map((asset) => [asset.id, asset]));
const CATALOG_ID_BY_CONSTRUCTOR = new Map(BUILTIN_PROP_ASSETS.map((asset) => [asset.constructorName, asset.id]));

export function getPlacementAsset(assetId) {
    return CATALOG_BY_ID.get(assetId) ?? null;
}

export function getMapColorForAsset(assetId) {
    return getBuiltinPropAsset(assetId)?.mapColor ?? DEFAULT_MAP_COLOR;
}

/**
 * @param {Object} fusionObject
 * @returns {string | null}
 */
export function fusionObjectToCatalogType(fusionObject) {
    const byConstructor = CATALOG_ID_BY_CONSTRUCTOR.get(fusionObject?.constructor?.name);
    if (byConstructor) return byConstructor;

    const tags = fusionObject?.tags ?? [];
    if (tags.includes("cone")) return "cone";
    if (tags.includes("barrel")) return "barrel";
    if (tags.includes("tire")) return "tire";
    if (tags.includes("sign")) return "stop-sign";
    return null;
}
