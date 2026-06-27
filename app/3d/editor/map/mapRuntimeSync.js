import { syncRoadsFromDocument } from "../document/DocumentSync.js";
import {
    removeBuilding,
    removeFeature,
    removeIntersectionNode,
    removeRoadEdge,
} from "../document/documentMutations.js";

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
    }

    const sceneIndex = objectDatabase.inScene.indexOf(featureId);
    if (sceneIndex >= 0) {
        objectDatabase.inScene.splice(sceneIndex, 1);
    }

    registry.unregisterEntity(entityId);
}

/**
 * @param {import("../../data/Data").Data} data
 * @param {{ id: string, x: number, z: number }} feature
 */
export function syncFeaturePosition(data, feature) {
    const registry = data.environment().objects();
    const entity = registry.getEntity(`fusion:${feature.id}`);
    const fusionObject = entity?.fusionObject;

    if (!fusionObject) return false;

    fusionObject.setPosition?.(feature.x, 0, feature.z);
    if (fusionObject._mesh) {
        fusionObject._mesh.position.set(feature.x, 0, feature.z);
    }

    registry.updateEntityTransform(entity.id);
    return true;
}

/**
 * @param {import("../../data/Data").Data} data
 * @param {THREE.Scene} scene
 * @param {import("../document/EnvironmentDocument.js").EnvironmentDocument} document
 * @param {{ type: string, id: string }} selection
 */
export function deleteMapSelectionFromRuntime(data, scene, document, selection) {
    if (!selection) {
        return { ok: false, error: "Nothing selected." };
    }

    if (selection.type === "building") {
        const result = removeBuilding(document, selection.id);
        if (!result.ok) return result;

        removeBuildingMeshesFromScene(scene, selection.id);

        const bakeConfig = data.bakeRunConfig?.();
        if (bakeConfig) {
            bakeConfig.buildings = bakeConfig.buildings.filter(
                (building) => building.buildingId !== selection.id,
            );
        }

        data.environment().objects().unregisterEntity(`building:${selection.id}`);
        return { ok: true };
    }

    if (selection.type === "feature") {
        const result = removeFeature(document, selection.id);
        if (!result.ok) return result;

        removeFeatureFromRuntime(data, scene, selection.id);
        return { ok: true };
    }

    if (selection.type === "road") {
        const result = removeRoadEdge(document, selection.id);
        if (!result.ok) return result;

        syncRoadsFromDocument(data, scene, document);
        data.environment().objects().registerExistingContent(scene, data);
        return { ok: true };
    }

    if (selection.type === "intersection") {
        const result = removeIntersectionNode(document, selection.id);
        if (!result.ok) return result;

        syncRoadsFromDocument(data, scene, document);
        data.environment().objects().registerExistingContent(scene, data);
        return { ok: true };
    }

    return { ok: false, error: "Unsupported selection." };
}
