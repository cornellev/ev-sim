import * as THREE from "three";
import { documentToRoadNetworkInputs } from "../documentMutations.js";
import buildRoadNetwork from "@/app/3d/city/RoadNetwork.js";

/**
 * Rebuild city roads and intersections from the environment document.
 * @param {import("../../data/Data").Data} data
 * @param {THREE.Scene} scene
 * @param {import("../EnvironmentDocument.js").EnvironmentDocument} document
 */
export function syncRoadsFromDocument(data, scene, document) {
    const city = data.city();
    const { vectorMap: rawMap, connections } = documentToRoadNetworkInputs(document);

    const threeVectorMap = new Map();
    for (const [id, point] of rawMap.entries()) {
        threeVectorMap.set(id, new THREE.Vector3(point.x, point.y ?? 0, point.z));
    }

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

    return result;
}
