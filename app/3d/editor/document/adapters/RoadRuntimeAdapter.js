import * as THREE from "three";
import { documentToRoadNetworkInputs } from "../documentMutations.js";
import buildRoadNetwork from "../../../city/RoadNetwork.js";
import { EDITOR_LAYERS } from "../../EditorState.js";

function getRoadRegistry(data) {
    return data?.environment?.()?.objects?.() ?? null;
}

function unregisterRoadEntities(registry) {
    registry?.listEntities?.()
        ?.filter((entity) => entity.kind === "road" || entity.kind === "intersection")
        ?.forEach((entity) => registry.unregisterEntity(entity.id));
}

function registerRoadEntities(registry, result) {
    if (!registry) return;

    result.roads.forEach((road, index) => {
        if (!road?.root) return;
        registry.registerEntity({
            id: `road:${index}`,
            sourceId: `road:${index}`,
            kind: "road",
            label: `Road ${index + 1}`,
            layer: EDITOR_LAYERS.ROADS,
            object3D: road.root,
            road,
        });
    });

    result.intersections.forEach((intersection, index) => {
        if (!intersection?.root) return;
        registry.registerEntity({
            id: `intersection:${index}`,
            sourceId: `intersection:${index}`,
            kind: "intersection",
            label: `Intersection ${index + 1}`,
            layer: EDITOR_LAYERS.ROADS,
            object3D: intersection.root,
            intersection,
        });
    });
}

/**
 * Rebuild city roads and intersections from the environment document.
 * @param {import("../../data/Data").Data} data
 * @param {THREE.Scene} scene
 * @param {import("../EnvironmentDocument.js").EnvironmentDocument} document
 */
export function syncRoadsFromDocument(data, scene, document) {
    const city = data.city();
    const { vectorMap: rawMap, connections } = documentToRoadNetworkInputs(document);
    const registry = getRoadRegistry(data);

    const threeVectorMap = new Map();
    for (const [id, point] of rawMap.entries()) {
        threeVectorMap.set(id, new THREE.Vector3(point.x, point.y ?? 0, point.z));
    }

    const rebuild = () => {
        unregisterRoadEntities(registry);

        for (const road of [...city.getRoads()]) {
            road.root?.parent?.remove?.(road.root);
        }
        for (const intersection of [...city.getIntersections()]) {
            intersection.root?.parent?.remove?.(intersection.root);
        }

        city.roads = [];
        city.intersections = [];
        city.roadSetup = false;
        city.intersectionSetup = false;

        if (!connections.length) {
            return { roads: [], intersections: [] };
        }

        const result = buildRoadNetwork(scene, threeVectorMap, connections);
        city.addRoads(result.roads);
        for (const intersection of result.intersections) {
            city.addIntersection(intersection);
        }
        registerRoadEntities(registry, result);

        return result;
    };

    return registry?.batch
        ? registry.batch(rebuild)
        : rebuild();
}
