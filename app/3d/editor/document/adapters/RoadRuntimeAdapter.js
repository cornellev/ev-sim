import * as THREE from "three";
import {
    canMoveNode,
    documentToRoadNetworkInputs,
} from "../documentMutations.js";
import buildRoadNetwork from "../../../city/RoadNetwork.js";
import { EDITOR_LAYERS } from "../../EditorState.js";
import { getRoadStylePreset } from "../../../environment/road/RoadStylePresets.js";

function getRoadRegistry(data) {
    return data?.environment?.()?.objects?.() ?? null;
}

function unregisterRoadEntities(registry) {
    registry?.listEntities?.()
        ?.filter((entity) => (
            entity.kind === "road"
            || entity.kind === "intersection"
            || entity.kind === "road-node"
        ))
        ?.forEach((entity) => {
            if (entity.kind === "road-node") {
                entity.object3D?.parent?.remove?.(entity.object3D);
            }
            registry.unregisterEntity(entity.id);
        });
}

function createEndpointHandle(node) {
    const geometry = new THREE.SphereGeometry(0.45, 12, 12);
    const material = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.35,
        roughness: 0.45,
        metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "RoadNodeHandle";
    mesh.position.set(node.x, Number.isFinite(Number(node.y)) ? Number(node.y) : 0, node.z);
    mesh.userData.bakeIgnore = true;
    mesh.userData.roadNodeId = node.id;
    return mesh;
}

function registerRoadEntities(registry, result, document, scene) {
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

    for (const node of document.roads.nodes) {
        if (!canMoveNode(document, node.id)) continue;
        const handle = createEndpointHandle(node);
        scene.add(handle);
        registry.registerEntity({
            id: `road-node:${node.id}`,
            sourceId: node.id,
            kind: "road-node",
            label: `Road node ${node.id}`,
            layer: EDITOR_LAYERS.ROADS,
            object3D: handle,
            node,
        });
    }
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
        const roadTriangles = [
            ...result.roads.flatMap((road) => (road.triangles ?? []).map((triangle, triangleIndex) => {
                const sourceId = road.network?.edgeId ?? "road";
                triangle.environmentGeometryType = "road";
                triangle.environmentSourceId = sourceId;
                triangle.lidarTwinId = `road:${sourceId}:${triangleIndex}`;
                triangle.lidarTriangleIndex = triangleIndex;
                return triangle;
            })),
            ...result.intersections.flatMap((intersection) => (intersection.triangles ?? []).map((triangle, triangleIndex) => {
                const sourceId = intersection.networkNodeId ?? "intersection";
                triangle.environmentGeometryType = "road";
                triangle.environmentSourceId = sourceId;
                triangle.lidarTwinId = `intersection:${sourceId}:${triangleIndex}`;
                triangle.lidarTriangleIndex = triangleIndex;
                return triangle;
            })),
        ];
        data.objects?.()?.replaceTriangles?.(
            (triangle) => triangle.environmentGeometryType === "road",
            roadTriangles,
        );
        registerRoadEntities(registry, result, document, scene);

        return result;
    };

    return registry?.batch
        ? registry.batch(rebuild)
        : rebuild();
}
