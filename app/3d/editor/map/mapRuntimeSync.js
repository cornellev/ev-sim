/**
 * Runtime removal helpers shared by the projectors and the loader. Document
 * mutations no longer live here: map tools dispatch commands and the
 * SceneProjector applies the resulting change sets.
 */

/**
 * @param {THREE.Scene} scene
 * @param {string} buildingId
 */
export function removeBuildingMeshesFromScene(scene, buildingId) {
    const meshes = [];

    scene?.traverse?.((object) => {
        if (object.isMesh && object.userData?.buildingId === buildingId) {
            meshes.push(object);
        }
    });

    for (const mesh of meshes) {
        mesh.parent?.remove?.(mesh);
    }

    return meshes.length;
}

/**
 * @param {import("../../data/Data").Data} data
 * @param {THREE.Scene} scene
 * @param {string} featureId
 */
export function removeFeatureFromRuntime(data, scene, featureId) {
    const registry = data.environment().objects();
    const entityId = `fusion:${featureId}`;
    const entity = registry.getEntity(entityId);
    const fusionObject = entity?.fusionObject;

    if (fusionObject?._mesh) {
        fusionObject._mesh.parent?.remove?.(fusionObject._mesh);
    }

    const objectDatabase = data.objects();
    const objectIndex = objectDatabase.objects.findIndex((object) => object._uuid === featureId);
    if (objectIndex >= 0) {
        objectDatabase.objects.splice(objectIndex, 1);
        objectDatabase.rebuildTextureData?.();
    }

    const sceneIndex = objectDatabase.inScene.indexOf(featureId);
    if (sceneIndex >= 0) {
        objectDatabase.inScene.splice(sceneIndex, 1);
    }

    registry.unregisterEntity(entityId);
}

/**
 * Move a placed prop's runtime objects to its record position.
 * @param {import("../../data/Data").Data} data
 * @param {{ id: string, x: number, z: number, rotationY?: number }} feature
 */
export function syncFeaturePosition(data, feature) {
    const registry = data.environment().objects();
    const entity = registry.getEntity(`fusion:${feature.id}`);
    const fusionObject = entity?.fusionObject;

    if (!fusionObject) return false;

    fusionObject.setPosition?.(feature.x, 0, feature.z);
    if (fusionObject._mesh) {
        fusionObject._mesh.position.set(feature.x, 0, feature.z);
        if (Number.isFinite(feature.rotationY)) fusionObject._mesh.rotation.y = feature.rotationY;
    }

    registry.updateEntityTransform(entity.id);
    return true;
}
