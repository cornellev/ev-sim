/**
 * Roads: rebuild only the local closure of a change.
 *
 *   E1 = edges changed or incident to a changed node
 *   J1 = junction nodes at E1's endpoints (and changed nodes) that are, or were,
 *        rendered as intersections
 *   E2 = E1 plus every edge incident to J1 (their trim depends on the
 *        junction inset and the Intersection needs their Road objects)
 *
 * Insets are planned over the whole graph (cheap math); only E2 and J1 are
 * materialized. Roads and intersections are torn down and re-registered by id;
 * intersections outside J1 are relinked to replaced Road objects; LiDAR
 * triangles are replaced only for the affected source ids.
 */

import { planRoadNetwork, materializeRoadNetwork } from "../../../city/RoadNetwork.js";
import { documentToRoadNetworkInputs } from "../../document/documentMutations.js";
import {
    intersectionEntityId,
    registerRoadEntities,
    removeRoadNodeHandle,
    roadEntityId,
    roadNetworkOptions,
    tagRoadTriangles,
    toVector3Map,
} from "../roadRuntimeEntities.js";

function endpointsOf(edgeIds, edgeMap) {
    const result = [];
    for (const id of edgeIds) {
        const edge = edgeMap.get(String(id));
        if (edge) result.push(String(edge.startNodeId), String(edge.endNodeId));
    }
    return result;
}

/** Compute the local closure for a road change set. Exported for tests. */
export function computeRoadClosure({ changeSet, document, registry, plan }) {
    const nodesDomain = changeSet.domains?.["roads.nodes"] ?? null;
    const edgesDomain = changeSet.domains?.["roads.edges"] ?? null;
    const index = document.index();
    const changedNodeIds = new Set(nodesDomain ? [...nodesDomain.after.keys()].map(String) : []);
    const beforeEdges = new Map();
    for (const [id, record] of edgesDomain?.before ?? []) {
        if (record) beforeEdges.set(String(id), record);
    }
    const E1 = new Set(edgesDomain ? [...edgesDomain.after.keys()].map(String) : []);
    for (const edge of [...index.edges.values(), ...beforeEdges.values()]) {
        if (changedNodeIds.has(String(edge.startNodeId)) || changedNodeIds.has(String(edge.endNodeId))) E1.add(String(edge.id));
    }
    const candidates = new Set([
        ...endpointsOf(E1, index.edges),
        ...endpointsOf(E1, beforeEdges),
        ...changedNodeIds,
        ...(nodesDomain ? [...nodesDomain.before.keys()].map(String) : []),
    ]);
    const J1 = new Set();
    for (const nodeId of candidates) {
        if (plan.intersectionNodes.has(nodeId) || registry?.getEntity?.(intersectionEntityId(nodeId))) J1.add(nodeId);
    }
    const E2 = new Set(E1);
    for (const nodeId of J1) {
        for (const edge of plan.adjacency.get(nodeId) ?? []) {
            if (edge.id !== null && edge.id !== undefined) E2.add(String(edge.id));
        }
    }
    const touchedNodeIds = new Set([
        ...changedNodeIds,
        ...endpointsOf(E2, index.edges),
        ...endpointsOf(E1, beforeEdges),
        ...(nodesDomain ? [...nodesDomain.before.keys()].map(String) : []),
    ]);
    return { E1, J1, E2, touchedNodeIds, beforeEdges, changedNodeIds };
}

export function createRoadsProjector() {
    return {
        id: "roads",
        apply({ changeSet, data, scene, registry, document }) {
            if (!changeSet.domains?.["roads.nodes"] && !changeSet.domains?.["roads.edges"]) return;
            const city = data.city();
            const index = document.index();
            const { vectorMap, connections } = documentToRoadNetworkInputs(document);
            const plan = planRoadNetwork(toVector3Map(vectorMap), connections, roadNetworkOptions(data));
            const { J1, E2, touchedNodeIds, beforeEdges } = computeRoadClosure({ changeSet, document, registry, plan });

            // Tear down by id.
            const removedRoads = city.roads.filter((road) => {
                const edgeId = String(road.network?.edgeId ?? "");
                return E2.has(edgeId) || beforeEdges.has(edgeId) || !index.edges.has(edgeId);
            });
            for (const road of removedRoads) {
                road.root?.parent?.remove?.(road.root);
                registry?.unregisterEntity(roadEntityId(road.network?.edgeId ?? ""));
            }
            city.roads = city.roads.filter((road) => !removedRoads.includes(road));
            const removedIntersections = city.intersections.filter((intersection) => {
                const nodeId = String(intersection.networkNodeId ?? "");
                return J1.has(nodeId) || !index.nodes.has(nodeId) || !plan.intersectionNodes.has(nodeId);
            });
            for (const intersection of removedIntersections) {
                intersection.root?.parent?.remove?.(intersection.root);
                registry?.unregisterEntity(intersectionEntityId(intersection.networkNodeId ?? ""));
                J1.add(String(intersection.networkNodeId ?? ""));
            }
            city.intersections = city.intersections.filter((intersection) => !removedIntersections.includes(intersection));
            for (const nodeId of touchedNodeIds) removeRoadNodeHandle(registry, nodeId);

            // Rebuild the closure with whole-graph insets.
            const existingRoads = new Map(city.roads.map((road) => [String(road.network?.edgeId ?? ""), road]));
            const built = materializeRoadNetwork(scene, plan, {
                edgeIds: E2,
                nodeIds: [...J1].filter((nodeId) => plan.intersectionNodes.has(nodeId)),
                existingRoads,
            });
            city.addRoads(built.roads);
            for (const intersection of built.intersections) city.addIntersection(intersection);

            // Relink intersections outside J1 that referenced a replaced Road.
            for (const intersection of city.intersections) {
                if (J1.has(String(intersection.networkNodeId ?? ""))) continue;
                intersection.roads = intersection.roads.map((road) => built.roadByEdge.get(String(road.network?.edgeId ?? "")) ?? road);
            }

            // LiDAR truth scoped by source id.
            const affected = new Set([
                ...E2,
                ...beforeEdges.keys(),
                ...J1,
                ...removedRoads.map((road) => String(road.network?.edgeId ?? "")),
            ]);
            data.objects?.()?.replaceTriangles?.(
                (triangle) => triangle.environmentGeometryType === "road" && affected.has(String(triangle.environmentSourceId)),
                tagRoadTriangles(built.roads, built.intersections),
            );
            registerRoadEntities(registry, built, document, scene, { nodeIds: touchedNodeIds });
        },
    };
}
