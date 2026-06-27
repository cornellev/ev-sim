import { getEdgeRenderEndpoints, findNearestIntersection } from "../document/documentMutations.js";
import { screenRadiusToWorld } from "./mapCoords.js";

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
