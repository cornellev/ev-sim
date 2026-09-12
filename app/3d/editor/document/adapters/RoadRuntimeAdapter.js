import { documentToRoadNetworkInputs } from "../documentMutations.js";
import buildRoadNetwork from "../../../city/RoadNetwork.js";
import {
    getRoadRegistry,
    registerRoadEntities,
    roadNetworkOptions,
    tagRoadTriangles,
    toVector3Map,
    unregisterRoadEntities,
} from "../../projection/roadRuntimeEntities.js";

/**
 * Rebuild ALL city roads and intersections from the environment document.
 * Load-time path only (EnvironmentLoader.apply, Earth import apply); editor
 * commands project incrementally through SceneProjector.
 * @param {import("../../data/Data").Data} data
 * @param {THREE.Scene} scene
 * @param {import("../EnvironmentDocument.js").EnvironmentDocument} document
 */
export function syncRoadsFromDocument(data, scene, document) {
    const city = data.city();
    const { vectorMap: rawMap, connections } = documentToRoadNetworkInputs(document);
    const registry = getRoadRegistry(data);
    const threeVectorMap = toVector3Map(rawMap);

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
            data.objects?.()?.replaceTriangles?.(
                (triangle) => triangle.environmentGeometryType === "road",
                [],
            );
            return { roads: [], intersections: [] };
        }

        const result = buildRoadNetwork(scene, threeVectorMap, connections, roadNetworkOptions(data));
        result.roads.forEach((road, index) => {
            if (!road.network) road.network = {};
            // Connections now carry the edge id; keep the positional fallback for callers that omit it.
            road.network.edgeId ??= document.roads.edges[index]?.id ?? null;
        });
        city.addRoads(result.roads);
        for (const intersection of result.intersections) {
            city.addIntersection(intersection);
        }
        data.objects?.()?.replaceTriangles?.(
            (triangle) => triangle.environmentGeometryType === "road",
            tagRoadTriangles(result.roads, result.intersections),
        );
        registerRoadEntities(registry, result, document, scene, { withIndexAliases: true });

        return result;
    };

    return registry?.batch
        ? registry.batch(rebuild)
        : rebuild();
}
