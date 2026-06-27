import { generateBuildings } from "../../../city/BuildingGenerator.js";

/**
 * Sync building records from document into bake config and scene.
 * @param {THREE.Scene} scene
 * @param {import("../../../data/Data").Data} data
 * @param {import("../EnvironmentDocument.js").EnvironmentDocument} document
 */
export function syncBuildingsFromDocument(scene, data, document) {
    const bakeConfig = data.bakeRunConfig?.();
    if (bakeConfig) {
        bakeConfig.buildings = document.buildings.map((record) => ({
            ...record,
            footprint: record.footprint.map((point) => ({ ...point })),
            tags: [...(record.tags ?? ["building"])],
        }));
    }

    if (!document.buildings.length) {
        return [];
    }

    return generateBuildings(scene, data, {
        records: document.buildings,
    });
}
