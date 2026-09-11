/**
 * Kernel-safe authoring core for environment objects. Importing this module
 * registers the built-in object types on the shared registry.
 */

import { registerBuiltinObjectTypes } from "./builtinObjectTypes.js";

export * from "./ObjectOptions.js";
export * from "./ObjectTypeRegistry.js";
export * from "./objectRecord.js";
export * from "./objectGraph.js";
export * from "./builtinObjectTypes.js";
export {
    BUILTIN_PROP_ASSETS,
    BUILTIN_PROP_IDS,
    BUILTIN_PROP_TYPE_ID,
    DEFAULT_FEATURE_RADIUS,
    DEFAULT_MAP_COLOR,
    FEATURE_GEOMETRY_BY_TYPE,
    FEATURE_RADIUS_BY_TYPE,
    FEATURE_SEMANTIC_LABEL_BY_TYPE,
    getBuiltinPropAsset,
} from "./types/builtinProp.js";
export { GROUP_TYPE_ID } from "./types/group.js";
export { SKYBOX_TYPE_ID } from "./types/skybox.js";
export { TILE_TYPE_ID } from "./types/tile.js";
export { ROAD_TYPE_ID } from "./types/road.js";
export { INTERSECTION_TYPE_ID, isJunctionNode } from "./types/intersection.js";
export { BUILDING_TYPE_ID } from "./types/building.js";
export { ASSET_INSTANCE_TYPE_ID } from "./types/assetInstance.js";

registerBuiltinObjectTypes();
