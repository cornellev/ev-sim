import { createFusionObject, getPlacementAsset } from "./PlacementCatalog.js";

/**
 * Create a fusion prop, add it to the scene/object database, and register it in the environment registry.
 * Shared by scene PlaceTool and map feature placement.
 */
export function placeFusionObjectInScene({
    data,
    scene,
    registry,
    assetId,
    point,
    label = null,
}) {
    const asset = getPlacementAsset(assetId);
    const object = createFusionObject(assetId, point);
    const objectDatabase = data.objects();

    objectDatabase.addObject(object);
    object.addToScene(scene);

    if (!objectDatabase.inScene.includes(object._uuid)) {
        objectDatabase.inScene.push(object._uuid);
    }

    const entity = registry.registerEntity({
        id: `fusion:${object._uuid}`,
        sourceId: object._uuid,
        kind: asset?.kind ?? "prop",
        layer: "props",
        object3D: object._mesh,
        fusionObject: object,
        tags: [...(object.tags ?? [])],
        label: label ?? asset?.label ?? assetId,
    });

    return { object, entity, asset };
}
