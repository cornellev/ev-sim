import * as THREE from "three";
import { documentToRoadNetworkInputs } from "../documentMutations.js";
import buildRoadNetwork from "../../../city/RoadNetwork.js";
import { EDITOR_LAYERS } from "../../EditorState.js";
import { getRoadStylePreset } from "../../../environment/road/RoadStylePresets.js";

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
        const sourceId = String(road.network?.edgeId ?? `road:${index}`);
        const id = sourceId.startsWith("road:") ? sourceId : `road:${sourceId}`;
        registry.registerEntity({
            id,
            sourceId,
            legacyIds: [`road:${index}`],
            kind: "road",
            label: `Road ${index + 1}`,
            layer: EDITOR_LAYERS.ROADS,
            object3D: road.root,
            road,
        });
    });

    result.intersections.forEach((intersection, index) => {
        if (!intersection?.root) return;
        const sourceId = String(intersection.networkNodeId ?? `intersection:${index}`);
        const id = sourceId.startsWith("intersection:") ? sourceId : `intersection:${sourceId}`;
        registry.registerEntity({
            id,
            sourceId,
            legacyIds: [`intersection:${index}`],
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
    const preset = getRoadStylePreset(data.environment?.()?.roadStylePreset);

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
            data.objects?.()?.replaceTriangles?.(
                (triangle) => triangle.environmentGeometryType === "road",
                [],
            );
            return { roads: [], intersections: [] };
        }

        const result = buildRoadNetwork(scene, threeVectorMap, connections, {
            ...(preset.networkOptions ?? {}),
            roadOptions: {
                ...(preset.roadOptions ?? {}),
            },
        });
        result.roads.forEach((road, index) => {
            if (!road.network) road.network = {};
            road.network.edgeId = document.roads.edges[index]?.id ?? null;
        });
        city.addRoads(result.roads);
        for (const intersection of result.intersections) {
            city.addIntersection(intersection);
        }
        const roadTriangles = result.roads.flatMap((road) => road.triangles ?? []);
        roadTriangles.forEach((triangle) => {
            triangle.environmentGeometryType = "road";
        });
        data.objects?.()?.replaceTriangles?.(
            (triangle) => triangle.environmentGeometryType === "road",
            roadTriangles,
        );
        registerRoadEntities(registry, result);

        return result;
    };

    return registry?.batch
        ? registry.batch(rebuild)
        : rebuild();
}
