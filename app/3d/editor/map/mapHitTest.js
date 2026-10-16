import { getEdgeRenderEndpoints, findNearestIntersection } from "../document/documentMutations.js";
import { screenRadiusToWorld, shouldShowMapAssetFootprint } from "./mapCoords.js";
import { projectPointToRoad } from "../../../roads/RoadGeometry.js";
import { planRoadNetworkGeometry } from "../../../roads/RoadNetworkGeometry.js";
import { nearestLaneIndexForOffset, roadLaneId, roadWidth } from "../../../roads/RoadLaneModel.js";
import { assetBindingRevisionVersion, isAssetBackedObject, readAssetBinding } from "../../../editor-assets/AssetBackedObject.js";
import { assetMetricKey } from "../../../editor-assets/AssetMetricSnapshot.js";
import { indexObjectsById } from "../commands/objectMutations.js";
import { isObjectHidden } from "../projection/projectors/objectsProjector.js";

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
 * @param {{ components?: { asset?: { position: { x: number, z: number }, rotationY: number, scale: { x: number, z: number } } } }} record
 * @param {{ min?: { x?: number, z?: number }, max?: { x?: number, z?: number } } | null} [bounds]
 */
export function assetMapFootprint(record, bounds = null) {
    const asset = record?.components?.asset;
    if (!asset) return [];
    const minX = Number(bounds?.min?.x ?? -0.5);
    const maxX = Number(bounds?.max?.x ?? 0.5);
    const minZ = Number(bounds?.min?.z ?? -0.5);
    const maxZ = Number(bounds?.max?.z ?? 0.5);
    const c = Math.cos(asset.rotationY);
    const s = Math.sin(asset.rotationY);
    return [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]].map(([x, z]) => {
        const sx = x * asset.scale.x;
        const sz = z * asset.scale.z;
        return { x: asset.position.x + c * sx + s * sz, z: asset.position.z - s * sx + c * sz };
    });
}

function crossXZ(origin, left, right) {
    return (left.x - origin.x) * (right.z - origin.z) - (left.z - origin.z) * (right.x - origin.x);
}

/** Monotone-chain convex hull. Collinear points stay off the boundary. */
function convexHullXZ(points) {
    const unique = [];
    const seen = new Set();
    for (const point of points) {
        const x = Number(point?.x);
        const z = Number(point?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const key = `${x}:${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({ x, z });
    }
    unique.sort((left, right) => left.x - right.x || left.z - right.z);
    if (unique.length < 3) return [];
    const lower = [];
    for (const point of unique) {
        while (lower.length >= 2 && crossXZ(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
        lower.push(point);
    }
    const upper = [];
    for (let index = unique.length - 1; index >= 0; index -= 1) {
        const point = unique[index];
        while (upper.length >= 2 && crossXZ(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
        upper.push(point);
    }
    lower.pop();
    upper.pop();
    const hull = lower.concat(upper);
    return hull.length >= 3 ? hull : [];
}

function projectCollisionPoint(point, asset) {
    if (!Array.isArray(point) || point.length < 3) return null;
    const localX = Number(point[0]);
    const localZ = Number(point[2]);
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return null;
    const yaw = Number(asset.rotationY) || 0;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const scaleX = Number(asset.scale?.x);
    const scaleZ = Number(asset.scale?.z);
    const scaledX = (Number.isFinite(scaleX) ? scaleX : 1) * localX;
    const scaledZ = (Number.isFinite(scaleZ) ? scaleZ : 1) * localZ;
    const positionX = Number(asset.position?.x);
    const positionZ = Number(asset.position?.z);
    if (!Number.isFinite(positionX) || !Number.isFinite(positionZ)) return null;
    return {
        x: positionX + cosine * scaledX + sine * scaledZ,
        z: positionZ - sine * scaledX + cosine * scaledZ,
    };
}

function collisionMetric(record, document) {
    if (assetBindingRevisionVersion(record) !== 2) return null;
    const binding = readAssetBinding(record);
    if (!binding || String(binding.assetId ?? "").trim() === "") return null;
    const definitions = document?.assetMetrics?.definitions;
    if (!Array.isArray(definitions)) return null;
    const key = assetMetricKey(binding.assetId, binding.revision);
    return definitions.find((entry) => entry && assetMetricKey(entry.assetId, entry.revision) === key) ?? null;
}

/**
 * One XZ convex hull per published collision proxy, in the instance frame
 * used by world compile: yaw about Y, scale, then position.
 * @param {object} record
 * @param {object | null | undefined} document
 * @returns {{ x: number, z: number }[][]}
 */
export function assetCollisionFootprints(record, document) {
    const asset = readAssetBinding(record);
    const metric = collisionMetric(record, document);
    if (!asset || !Array.isArray(metric?.collision)) return [];
    const footprints = [];
    for (const proxy of metric.collision) {
        if (!proxy || proxy.enabled === false || !Array.isArray(proxy.vertices)) continue;
        const projected = [];
        for (const vertex of proxy.vertices) {
            const point = projectCollisionPoint(vertex, asset);
            if (point) projected.push(point);
        }
        const hull = convexHullXZ(projected);
        if (hull.length >= 3) footprints.push(hull);
    }
    return footprints;
}

/**
 * Map polygons for an asset. Published collision hulls win; otherwise the
 * visual-mesh quad; otherwise the ±0.5 m placeholder.
 * @param {object} record
 * @param {object | null | undefined} [document]
 * @param {{ min?: { x?: number, z?: number }, max?: { x?: number, z?: number } } | null} [visualBounds]
 * @returns {{ footprints: { x: number, z: number }[][], source: "collision" | "visual" | "placeholder" }}
 */
export function assetMapShapes(record, document = null, visualBounds = null) {
    const collision = assetCollisionFootprints(record, document);
    if (collision.length > 0) return { footprints: collision, source: "collision" };
    const visual = assetMapFootprint(record, visualBounds);
    if (visual.length === 0) return { footprints: [], source: "placeholder" };
    return { footprints: [visual], source: visualBounds == null ? "placeholder" : "visual" };
}

/** Asset-backed map records that are not editor-hidden (including inherited hide). */
export function mapVisibleAssetRecords(documentSnapshot) {
    const objects = documentSnapshot?.objects ?? [];
    const byId = indexObjectsById(objects);
    return objects.filter((record) => isAssetBackedObject(record) && !isObjectHidden(byId, record.id));
}

function pickAssetTarget(worldPoint, documentSnapshot, viewport, layers, radiusWorld, runtimeAssetBounds, size) {
    if (!layers.props) return null;
    const showDetail = layers.detail !== false;
    for (const record of mapVisibleAssetRecords(documentSnapshot)) {
        const shapes = assetMapShapes(record, documentSnapshot, runtimeAssetBounds?.get?.(String(record.id)) ?? null);
        if (!shapes.footprints.some((footprint) => shouldShowMapAssetFootprint(footprint, viewport, size, { showDetail }))) continue;
        if (shapes.footprints.some((footprint) => pointInPolygonXZ(worldPoint, footprint))) {
            return { type: "asset", id: String(record.id) };
        }
        const position = record.components?.asset?.position;
        if (position && Math.hypot(position.x - worldPoint.x, position.z - worldPoint.z) <= radiusWorld) {
            return { type: "asset", id: String(record.id) };
        }
    }
    return null;
}

/**
 * @param {{ x: number, z: number }} worldPoint
 * @param {ReturnType<import("../document/EnvironmentDocument.js").EnvironmentDocument["snapshot"]>} documentSnapshot
 * @param {{ zoom: number }} viewport
 * @param {{ buildings?: boolean, roads?: boolean, props?: boolean, detail?: boolean, selectedRoadId?: string | null }} layers
 * @param {number} [screenRadius]
 * @param {Map<string, { min: { x: number, z: number }, max: { x: number, z: number } }> | null} [runtimeAssetBounds]
 * @param {{ width: number, height: number } | null} [size]
 */
export function pickMapTarget(worldPoint, documentSnapshot, viewport, layers, screenRadius = 12, runtimeAssetBounds = null, size = null) {
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

        let nearestPrimitive = null;
        let nearestPrimitiveDistance = radiusWorld;
        for (const primitive of documentSnapshot.primitives ?? []) {
            const radius = Math.max(Number(primitive.size?.x) || 1, Number(primitive.size?.z) || 1) * 0.5;
            const distance = Math.hypot(primitive.position.x - worldPoint.x, primitive.position.z - worldPoint.z);
            if (distance <= Math.max(nearestPrimitiveDistance, radius) && distance <= nearestPrimitiveDistance + radius) {
                nearestPrimitiveDistance = distance;
                nearestPrimitive = primitive;
            }
        }
        if (nearestPrimitive && nearestPrimitiveDistance <= radiusWorld + Math.max(Number(nearestPrimitive.size?.x) || 1, Number(nearestPrimitive.size?.z) || 1) * 0.5) {
            return { type: "primitive", id: nearestPrimitive.id };
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
                if (nearestRoad) {
                    if (selectedRoadId && String(nearestRoad.id) === selectedRoadId) {
                        const sub = laneSubAtProjection(worldPoint, nearestRoad.entry, nearestRoad.projection);
                        if (sub) return { type: "road", id: nearestRoad.id, sub };
                    }
                    return { type: nearestRoad.type, id: nearestRoad.id };
                }
            } catch {
                // Fall through to asset footprints when the compiled plan is unavailable.
            }
        } else {
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
            if (nearestRoad) return { type: nearestRoad.type, id: nearestRoad.id };
        }
    }

    return pickAssetTarget(worldPoint, documentSnapshot, viewport, layers, radiusWorld, runtimeAssetBounds, size);
}
