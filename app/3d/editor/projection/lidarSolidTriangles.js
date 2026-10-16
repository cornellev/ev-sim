import { Vector3 } from "three";

import { normalizePerceptionClassName } from "../../../autonomy/PerceptionLabelCatalog.js";
import { Sphere } from "../../data/objects/Sphere.js";
import { Triangle } from "../../data/objects/Triangle.js";
import { normalizePrimitiveRecord } from "../../../simulation/world/PrimitiveRecords.js";

export const PRIMITIVE_LIDAR_TYPE = "primitive";
export const ASSET_LIDAR_TYPE = "asset-lidar";

/**
 * Signed distance of a point from a sphere. Matches the LiDAR shader.
 * @param {{ x: number, y: number, z: number }} point
 * @param {{ x: number, y: number, z: number }} center
 * @param {number} radius
 */
export function sphereSignedDistance(point, center, radius) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const dz = point.z - center.z;
    return Math.hypot(dx, dy, dz) - radius;
}

/**
 * Nearest positive root of {@link sphereSignedDistance} along a normalized ray.
 * Returns -1 when the ray misses.
 * @param {{ x: number, y: number, z: number }} origin
 * @param {{ x: number, y: number, z: number }} direction
 * @param {{ x: number, y: number, z: number }} center
 * @param {number} radius
 */
export function sphereRayDistance(origin, direction, center, radius) {
    const ocx = origin.x - center.x;
    const ocy = origin.y - center.y;
    const ocz = origin.z - center.z;
    const b = ocx * direction.x + ocy * direction.y + ocz * direction.z;
    const c = ocx * ocx + ocy * ocy + ocz * ocz - radius * radius;
    const h = b * b - c;
    if (h < 0) return -1;
    const root = Math.sqrt(h);
    const near = -b - root;
    const far = -b + root;
    const hit = near > 1e-4 ? near : far;
    return hit > 1e-4 ? hit : -1;
}

function point(value) {
    return new Vector3(value[0], value[1], value[2]);
}

function semanticOf(document, record) {
    const object = (document?.objects ?? []).find((entry) => String(entry.id) === String(record.id));
    const tags = Array.isArray(object?.components?.tags) && object.components.tags.length > 0
        ? object.components.tags
        : record?.tags;
    const first = (Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim()).find(Boolean);
    return normalizePerceptionClassName(first || "unknown");
}

/**
 * Hidden triangles for one world-space solid. These are not added to the scene.
 * @param {{ vertices: number[][], triangles: number[][], semantic?: string }} solid
 * @param {{ geometryType: string, sourceId: string, idPrefix?: string }} identity
 */
export function trianglesFromSolid(solid, { geometryType, sourceId, idPrefix = null }) {
    const semantic = solid.semantic || "unknown";
    const prefix = idPrefix || `${geometryType}:${sourceId}`;
    return (solid.triangles ?? []).map((face, index) => {
        const triangle = new Triangle(
            point(solid.vertices[face[0]]),
            point(solid.vertices[face[1]]),
            point(solid.vertices[face[2]]),
        );
        triangle.visible = false;
        triangle.environmentGeometryType = geometryType;
        triangle.environmentSourceId = String(sourceId);
        triangle.lidarTwinId = `${prefix}:${index}`;
        triangle.lidarTriangleIndex = index;
        triangle.setTags([semantic]);
        return triangle;
    });
}

/**
 * @param {object} record
 * @param {object} [document]
 */
export function sphereFromPrimitive(record, document = null) {
    const normalized = normalizePrimitiveRecord(record);
    const sphere = new Sphere(normalized.position, normalized.size.x * 0.5);
    sphere.environmentGeometryType = PRIMITIVE_LIDAR_TYPE;
    sphere.environmentSourceId = normalized.id;
    sphere.lidarTwinId = `primitive:${normalized.id}:sphere`;
    sphere.setTags([semanticOf(document, normalized)]);
    return sphere;
}

export { semanticOf };
