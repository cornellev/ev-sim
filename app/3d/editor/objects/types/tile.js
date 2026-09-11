/**
 * Tile objects anchor an environment's terrain source. ED-01 knows the
 * Google-tiles source stored in `document.earth`; GLTF tile bases arrive with
 * the asset catalog (ED-06/ED-08). Bounds checks are restated here rather than
 * imported from `EarthImportConfig.js`, which reads `process.env`.
 */

import { ObjectOptions, field, finite, isPlainObject, issue, stringList, text, validateFieldConstraints } from "../ObjectOptions.js";
import { TILE_OBJECT_ID } from "../objectRecord.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";

export const TILE_TYPE_ID = "tile";
export const TILE_PROVIDERS = Object.freeze(["google-photorealistic", "gltf"]);

const TILE_FIELDS = Object.freeze([
    field({ path: ["tileProvider"], label: "Provider", control: "enum", options: TILE_PROVIDERS, group: "Source", readOnly: true }),
    field({ path: ["anchor", "lat"], label: "Anchor latitude", control: "number", units: "deg", min: -90, max: 90, group: "Georeference", readOnly: true }),
    field({ path: ["anchor", "lng"], label: "Anchor longitude", control: "number", units: "deg", min: -180, max: 180, group: "Georeference", readOnly: true }),
    field({ path: ["bounds", "north"], label: "North", control: "number", units: "deg", min: -90, max: 90, group: "Bounds" }),
    field({ path: ["bounds", "south"], label: "South", control: "number", units: "deg", min: -90, max: 90, group: "Bounds" }),
    field({ path: ["bounds", "east"], label: "East", control: "number", units: "deg", min: -180, max: 180, group: "Bounds" }),
    field({ path: ["bounds", "west"], label: "West", control: "number", units: "deg", min: -180, max: 180, group: "Bounds" }),
]);

export class TileOptions extends ObjectOptions {
    getDefaults() {
        return {
            tileProvider: TILE_PROVIDERS[0],
            roadProvider: "overpass",
            anchor: { lat: 0, lng: 0 },
            // A degenerate box fails validation; default to ~100 m around the anchor.
            bounds: { north: 0.0005, south: -0.0005, east: 0.0005, west: -0.0005 },
            importedLayerIds: [],
        };
    }

    getFields() {
        return TILE_FIELDS;
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        const anchor = isPlainObject(source.anchor) ? source.anchor : {};
        const bounds = isPlainObject(source.bounds) ? source.bounds : {};
        return {
            tileProvider: text(source.tileProvider, TILE_PROVIDERS[0]),
            roadProvider: text(source.roadProvider, "overpass"),
            anchor: { lat: finite(anchor.lat, 0), lng: finite(anchor.lng, 0) },
            bounds: {
                north: finite(bounds.north, 0),
                south: finite(bounds.south, 0),
                east: finite(bounds.east, 0),
                west: finite(bounds.west, 0),
            },
            importedLayerIds: stringList(source.importedLayerIds),
        };
    }

    validate(value = {}) {
        const issues = validateFieldConstraints(TILE_FIELDS, value);
        const bounds = value?.bounds ?? {};
        if (Number.isFinite(bounds.north) && Number.isFinite(bounds.south) && bounds.north <= bounds.south) {
            issues.push(issue(["bounds"], "option.range", "Tile bounds require north > south."));
        }
        if (Number.isFinite(bounds.east) && Number.isFinite(bounds.west) && bounds.east <= bounds.west) {
            issues.push(issue(["bounds"], "option.range", "Tile bounds require east > west."));
        }
        if (value?.tileProvider !== undefined && !TILE_PROVIDERS.includes(value.tileProvider)) {
            issues.push(issue(["tileProvider"], "option.enum", `Unknown tile provider "${value.tileProvider}".`));
        }
        return issues;
    }
}

export function createTileType() {
    const options = new TileOptions();
    return defineObjectType({
        typeId: TILE_TYPE_ID,
        version: 1,
        label: "Tile",
        catalog: { label: "Tile", kind: "tile", layer: "environment" },
        legacy: { domain: "earth", idField: "id" },
        options,
        singleton: TILE_OBJECT_ID,
        capabilities: { selectable: true, transformable: false, deletable: false, groupable: false, hasOptions: true },
        create(input = {}) {
            return { id: TILE_OBJECT_ID, name: input.name ?? "Tile" };
        },
        getDependencies() {
            return [{ kind: "earth", id: TILE_OBJECT_ID }];
        },
    });
}
