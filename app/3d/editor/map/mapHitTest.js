import { getEdgeRenderEndpoints, findNearestIntersection } from "../document/documentMutations.js";
import { screenRadiusToWorld } from "./mapCoords.js";
import { projectPointToRoad } from "../../../roads/RoadGeometry.js";
import { planRoadNetworkGeometry } from "../../../roads/RoadNetworkGeometry.js";
import { nearestLaneIndexForOffset, roadLaneId, roadWidth } from "../../../roads/RoadLaneModel.js";

/** Lane under a pointer projected onto a compiled edge, or null on the shoulder. */
function laneSubAtProjection(worldPoint, entry, projection) {
    const tangents = entry.samples?.tangents ?? [];
    const tangent = tangents[Math.min(Number(projection.segment ?? 0), tangents.length - 1)];
    if (!tangent) return null;
    const length = Math.hypot(tangent.x, tangent.z) || 1;
    const normal = { x: -tangent.z / length, z: tangent.x / length };
    const rightOffset = (worldPoint.x - projection.point.x) * normal.x + (worldPoint.z - projection.point.z) * normal.z;
    if (Math.abs(rightOffset) > roadWidth(entry.edge) * 0.5) return null;
    const laneId = roadLaneId(entry.edge, nearestLaneIndexForOffset(entry.edge, rightOffset));
    return laneId ? { kind: "road-lane", edgeId: String(entry.edge.id), laneId } : null;
}

/**
 * @param {{ x: number, z: number }} point
 * @param {{ x: number, z: number }[]} footprint
 */
export function pointInPolygonXZ(point, footprint) {
    let inside = false;

    for (let index = 0, previous = footprint.length - 1; index < footprint.length; previous = index++) {
        const current = footprint[index];
        const prior = footprint[previous];
        const intersects = ((current.z > point.z) !== (prior.z > point.z))
            && (point.x < ((prior.x - current.x) * (point.z - current.z)) / (prior.z - current.z) + current.x);
        if (intersects) inside = !inside;
    }

    return inside;
}

/**
 * @param {{ x: number, z: number }} point
 * @param {{ x: number, z: number }} start
 * @param {{ x: number, z: number }} end
 */
export function distanceToSegmentXZ(point, start, end) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;

    if (lengthSquared === 0) {
        return Math.hypot(point.x - start.x, point.z - start.z);
    }

    let t = ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared;
    t = Math.max(0, Math.min(1, t));

    const projectedX = start.x + t * dx;
    const projectedZ = start.z + t * dz;
    return Math.hypot(point.x - projectedX, point.z - projectedZ);
}

/**
 * @param {{ x: number, z: number }} worldPoint
 * @param {ReturnType<import("../document/EnvironmentDocument.js").EnvironmentDocument["snapshot"]>} documentSnapshot
 * @param {{ zoom: number }} viewport
 * @param {{ buildings?: boolean, roads?: boolean, props?: boolean, detail?: boolean }} layers
 * @param {number} [screenRadius]
 */
export function pickMapTarget(worldPoint, documentSnapshot, viewport, layers, screenRadius = 12) {
    const radiusWorld = screenRadiusToWorld(screenRadius, viewport);
    const showDetail = layers.detail !== false;
    let nearestRoad = null;

    if (showDetail && layers.props) {
        let nearestFeature = null;
        let nearestFeatureDistance = radiusWorld;

        for (const feature of documentSnapshot.features) {
            const distance = Math.hypot(feature.x - worldPoint.x, feature.z - worldPoint.z);
            if (distance <= nearestFeatureDistance) {
                nearestFeatureDistance = distance;
                nearestFeature = feature;
            }
        }

        if (nearestFeature) {
            return { type: "feature", id: nearestFeature.id };
        }
    }

    if (showDetail && layers.roads) {
        const intersection = findNearestIntersection(worldPoint, documentSnapshot, radiusWorld);
        if (intersection) {
            return { type: "intersection", id: intersection.id };
        }
    }

    if (layers.buildings) {
        for (const building of documentSnapshot.buildings) {
            if (pointInPolygonXZ(worldPoint, building.footprint)) {
                return { type: "building", id: building.buildingId };
            }
        }
    }

    if (layers.roads) {
        if (Number(documentSnapshot.roads?.geometryVersion ?? 1) === 2) {
            try {
                const plan = planRoadNetworkGeometry(documentSnapshot.roads);
                const selectedRoadId = layers.selectedRoadId === undefined ? null : String(layers.selectedRoadId);
                if (showDetail || selectedRoadId) {
                    for (const entry of plan.edges) {
                        if (!showDetail && String(entry.edge.id) !== selectedRoadId) continue;
                        for (const [index, knot] of entry.edge.geometry.knots.entries()) {
                            const endpoint = index === 0 || index === entry.edge.geometry.knots.length - 1;
                            if (!endpoint && Math.hypot(worldPoint.x - knot.position.x, worldPoint.z - knot.position.z) <= radiusWorld) {
                                return { type: "road", id: entry.edge.id, sub: { kind: "road-knot", edgeId: entry.edge.id, knotId: knot.id } };
                            }
                            for (const [side, handle] of [["in", knot.handleIn], ["out", knot.handleOut]]) {
                                if (!handle) continue;
                                const handlePoint = { x: knot.position.x + handle.x, z: knot.position.z + handle.z };
                                if (Math.hypot(worldPoint.x - handlePoint.x, worldPoint.z - handlePoint.z) <= radiusWorld) {
                                    return { type: "road", id: entry.edge.id, sub: { kind: "road-handle", edgeId: entry.edge.id, knotId: knot.id, side } };
                                }
                            }
                        }
                    }
                }
                for (const junction of plan.junctions) {
                    if (pointInPolygonXZ(worldPoint, junction.surface.vertices)) return { type: "intersection", id: junction.node.id };
                }
                for (const entry of plan.edges) {
                    const projection = projectPointToRoad(worldPoint, { samples: entry.samples });
                    const threshold = Math.max(radiusWorld, (Number(entry.edge.width ?? 7) + 2 * Number(entry.edge.shoulderWidth ?? 0)) * 0.5);
                    if (projection && projection.distance <= threshold && (!nearestRoad || projection.distance < nearestRoad.distance)) {
                        nearestRoad = { type: "road", id: entry.edge.id, distance: projection.distance, entry, projection };
                    }
                }
                if (!nearestRoad) return null;
                // ED-05: a second click on the selected road picks the lane
                // under the pointer (within the carriageway, not the shoulder).
                if (selectedRoadId && String(nearestRoad.id) === selectedRoadId) {
                    const sub = laneSubAtProjection(worldPoint, nearestRoad.entry, nearestRoad.projection);
                    if (sub) return { type: "road", id: nearestRoad.id, sub };
                }
                return { type: nearestRoad.type, id: nearestRoad.id };
            } catch {
                return null;
            }
        }
        for (const edge of documentSnapshot.roads.edges) {
            const endpoints = getEdgeRenderEndpoints(documentSnapshot, edge);
            if (!endpoints) continue;

            const distance = distanceToSegmentXZ(
                worldPoint,
                endpoints.startPoint,
                endpoints.endPoint,
            );
            const halfWidth = (edge.width ?? 7) * 0.5;
            const threshold = Math.max(radiusWorld, halfWidth);

            if (distance <= threshold && (!nearestRoad || distance < nearestRoad.distance)) {
                nearestRoad = { type: "road", id: edge.id, distance };
            }
        }
    }

    return nearestRoad ? { type: nearestRoad.type, id: nearestRoad.id } : null;
}
