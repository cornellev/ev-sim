/**
 * Registration of the built-in object types. Idempotent per registry so the
 * singleton can be populated by `index.js` while tests build fresh registries.
 */

import { ObjectTypeRegistry, objectTypeRegistry } from "./ObjectTypeRegistry.js";
import { createAssetInstanceType, ASSET_INSTANCE_TYPE_ID } from "./types/assetInstance.js";
import { createBuildingType, BUILDING_TYPE_ID } from "./types/building.js";
import { createBuiltinPropType, BUILTIN_PROP_TYPE_ID } from "./types/builtinProp.js";
import { createGroupType, GROUP_TYPE_ID } from "./types/group.js";
import { createIntersectionType, INTERSECTION_TYPE_ID } from "./types/intersection.js";
import { createRoadType, ROAD_TYPE_ID } from "./types/road.js";
import { createSkyboxType, SKYBOX_TYPE_ID } from "./types/skybox.js";
import { createTileType, TILE_TYPE_ID } from "./types/tile.js";

export const BUILTIN_OBJECT_TYPE_IDS = Object.freeze([
    GROUP_TYPE_ID,
    SKYBOX_TYPE_ID,
    TILE_TYPE_ID,
    ROAD_TYPE_ID,
    INTERSECTION_TYPE_ID,
    BUILDING_TYPE_ID,
    BUILTIN_PROP_TYPE_ID,
    ASSET_INSTANCE_TYPE_ID,
]);

const FACTORIES = Object.freeze([
    createGroupType,
    createSkyboxType,
    createTileType,
    createRoadType,
    createIntersectionType,
    createBuildingType,
    createBuiltinPropType,
    createAssetInstanceType,
]);

/** @param {ObjectTypeRegistry} [registry] */
export function registerBuiltinObjectTypes(registry = objectTypeRegistry) {
    for (const factory of FACTORIES) {
        const definition = factory();
        if (!registry.has(definition.typeId, definition.version)) registry.register(definition);
    }
    return registry;
}

/** Fresh registry with only the built-ins; for tests and isolated validation. */
export function createBuiltinObjectTypeRegistry() {
    return registerBuiltinObjectTypes(new ObjectTypeRegistry());
}
