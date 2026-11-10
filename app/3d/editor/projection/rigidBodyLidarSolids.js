/**
 * Move the hidden shader solids that browser GPU LiDAR samples.
 * The environment document stays at the authored spawn pose.
 */

import {
    ASSET_LIDAR_TYPE,
    PRIMITIVE_LIDAR_TYPE,
    semanticOf,
    sphereFromPrimitive,
    trianglesFromSolid,
} from "./lidarSolidTriangles.js";
import { compilePrimitiveSolid } from "../../../simulation/world/PrimitiveSolids.js";
import { normalizePrimitiveRecord } from "../../../simulation/world/PrimitiveRecords.js";
import { compileAssetProxy } from "../../../simulation/world/WorldDescription.js";
import { rigidBodyPoseMoved, transformRigidBodyPoint } from "../../../simulation/world/RigidBodyRecords.js";

function list(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.values === "function") return [...value.values()];
    return [];
}

function movePoint(point, pose) {
    if (!pose || !rigidBodyPoseMoved(pose)) return point;
    const moved = transformRigidBodyPoint(point, pose);
    point.set(moved.x, moved.y, moved.z);
    return point;
}

function poseTriangles(triangles, pose) {
    if (!pose || !rigidBodyPoseMoved(pose)) return triangles;
    for (const triangle of triangles) {
        movePoint(triangle.a, pose);
        movePoint(triangle.b, pose);
        movePoint(triangle.c, pose);
    }
    return triangles;
}

function poseSphere(sphere, pose) {
    movePoint(sphere.position, pose);
    return sphere;
}

function matchingTriangles(objects, geometryType, sourceId) {
    return objects.triangles().filter((triangle) => (
        triangle.environmentGeometryType === geometryType
        && String(triangle.environmentSourceId) === sourceId
    ));
}

function writeTriangles(objects, geometryType, sourceId, next) {
    const existing = matchingTriangles(objects, geometryType, sourceId);
    const byId = new Map(existing.map((triangle) => [triangle.lidarTwinId, triangle]));
    const same = next.length === existing.length && next.every((triangle) => byId.has(triangle.lidarTwinId));
    if (!same) {
        objects.replaceTriangles(
            (triangle) => triangle.environmentGeometryType === geometryType
                && String(triangle.environmentSourceId) === sourceId,
            next,
        );
        return;
    }
    for (const fresh of next) {
        const current = byId.get(fresh.lidarTwinId);
        current.a.copy(fresh.a);
        current.b.copy(fresh.b);
        current.c.copy(fresh.c);
        current.notifyTextureUpdate?.();
    }
}

function writeSphere(objects, sourceId, sphere) {
    const existing = objects.spheres().filter((entry) => (
        entry.environmentGeometryType === PRIMITIVE_LIDAR_TYPE
        && String(entry.environmentSourceId) === sourceId
    ));
    if (existing.length === 1) {
        existing[0].position.copy(sphere.position);
        existing[0].radius = sphere.radius;
        existing[0].notifyTextureUpdate?.();
        return;
    }
    objects.replaceSpheres(
        (entry) => entry.environmentGeometryType === PRIMITIVE_LIDAR_TYPE
            && String(entry.environmentSourceId) === sourceId,
        [sphere],
    );
}

function writePrimitive(document, objects, record, pose) {
    const raw = list(document.primitives).find((entry) => String(entry.id) === String(record.id));
    if (!raw) return;
    const normalized = normalizePrimitiveRecord(raw);
    const sourceId = String(normalized.id);
    if (normalized.shape === "sphere") {
        writeSphere(objects, sourceId, poseSphere(sphereFromPrimitive(raw, document), pose));
        return;
    }
    const solid = compilePrimitiveSolid(raw, semanticOf(document, normalized));
    writeTriangles(objects, PRIMITIVE_LIDAR_TYPE, sourceId, poseTriangles(trianglesFromSolid(solid, {
        geometryType: PRIMITIVE_LIDAR_TYPE,
        sourceId,
    }), pose));
}

function writeAsset(document, objects, record, pose) {
    const sourceId = String(record.id);
    if (matchingTriangles(objects, ASSET_LIDAR_TYPE, sourceId).length === 0) return;
    const proxy = compileAssetProxy(document, record);
    if (!proxy?.lidar?.length) return;
    const triangles = [];
    for (const solid of proxy.lidar) {
        triangles.push(...trianglesFromSolid(solid, {
            geometryType: ASSET_LIDAR_TYPE,
            sourceId,
            idPrefix: solid.id,
        }));
    }
    writeTriangles(objects, ASSET_LIDAR_TYPE, sourceId, poseTriangles(triangles, pose));
}

/** `poses` null writes the authored spawn solids. A pose list writes those bodies only. */
export function syncRigidBodyLidarSolids(data, poses = null) {
    const document = data?.environment?.()?.getDocument?.();
    const objects = data?.objects?.();
    if (!document || typeof objects?.triangles !== "function" || typeof objects?.spheres !== "function") return;
    const poseById = poses ? new Map(poses.map((pose) => [String(pose.id), pose])) : null;
    for (const record of list(document.objects)) {
        if (record?.components?.rigidBody === undefined) continue;
        if (poseById && !poseById.has(String(record.id))) continue;
        const pose = poseById ? poseById.get(String(record.id)) : null;
        if (record.typeId === "primitive") writePrimitive(document, objects, record, pose);
        else if (record.typeId === "asset-instance") writeAsset(document, objects, record, pose);
    }
}
