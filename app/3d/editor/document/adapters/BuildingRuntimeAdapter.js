import { generateBuildings } from "../../../city/BuildingGenerator.js";
import { syncBakeBuildingsFromDocument } from "../../map/bakeBuildingSync.js";

/**
 * Sync building records from document into bake config and scene.
 * @param {THREE.Scene} scene
 * @param {import("../../../data/Data").Data} data
 * @param {import("../EnvironmentDocument.js").EnvironmentDocument} document
 */
export function syncBuildingsFromDocument(scene, data, document) {
    syncBakeBuildingsFromDocument(data, document);

    if (!document.buildings.length) {
        return [];
    }

    return generateBuildings(scene, data, {
        records: document.buildings,
    });
}
