import {
    BufferGeometry,
    DoubleSide,
    Euler,
    Float32BufferAttribute,
    Matrix4,
    Quaternion,
    Ray,
    Vector3,
} from "three";
import { MeshBVH } from "three-mesh-bvh";

import { rep103PoseToThree } from "../../autonomy/CoordinateFrames.js";
import { compareUtf8 } from "../world/WorldDescription.js";
import { assertLidarGeometryResource } from "../lidar/LidarGeometry.js";

export const CPU_LIDAR_NEAR_METERS = 1e-4;

const BOX_FACES = Object.freeze([
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
]);

function boxVertices(primitive) {
    const { center, size } = primitive;
    const hx = size.x * 0.5;
    const hy = size.y * 0.5;
    const hz = size.z * 0.5;
    return [
        new Vector3(center.x - hx, center.y - hy, center.z - hz),
        new Vector3(center.x + hx, center.y - hy, center.z - hz),
        new Vector3(center.x + hx, center.y + hy, center.z - hz),
        new Vector3(center.x - hx, center.y + hy, center.z - hz),
        new Vector3(center.x - hx, center.y - hy, center.z + hz),
        new Vector3(center.x + hx, center.y - hy, center.z + hz),
        new Vector3(center.x + hx, center.y + hy, center.z + hz),
        new Vector3(center.x - hx, center.y + hy, center.z + hz),
    ];
}

function primitiveFaces(primitive) {
    if (primitive.shape === "triangle") {
        return [{
            vertices: primitive.vertices.map((value) => new Vector3(value.x, value.y, value.z)),
            triangleIndex: primitive.triangleIndex,
        }];
    }
    const vertices = boxVertices(primitive);
    return BOX_FACES.map((face, triangleIndex) => ({
        vertices: face.map((index) => vertices[index]),
        triangleIndex,
    }));
}

function createIndex(primitives) {
    if (primitives.length === 0) return null;
    const positions = [];
    const faces = [];
    for (const primitive of [...primitives].sort((left, right) => compareUtf8(left.id, right.id))) {
        for (const face of primitiveFaces(primitive)) {
            const [a, b, c] = face.vertices;
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            const normal = new Vector3().crossVectors(
                new Vector3().subVectors(b, a),
                new Vector3().subVectors(c, a),
            ).normalize();
            faces.push({
                primitiveId: primitive.id,
                triangleIndex: face.triangleIndex,
                semanticId: primitive.semanticId,
                instanceId: primitive.instanceId,
                normal,
            });
        }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const bvh = new MeshBVH(geometry, { indirect: true });
    return { geometry, bvh, faces };
}

function vehicleMatrix(vehicle) {
    const position = new Vector3(vehicle.position.x, vehicle.position.y, vehicle.position.z);
    const rotation = vehicle.rotation ?? {};
    const quaternion = new Quaternion().setFromEuler(new Euler(
        Number(rotation.x) || 0,
        Number(rotation.y) || 0,
        Number(rotation.z) || 0,
        rotation.order || "XYZ",
    ));
    return new Matrix4().compose(position, quaternion, new Vector3(1, 1, 1));
}

function sensorMatrix(vehicle, pose) {
    const converted = rep103PoseToThree(pose);
    const local = new Matrix4().compose(
        new Vector3(converted.position.x, converted.position.y, converted.position.z),
        new Quaternion().setFromEuler(new Euler(
            converted.rotation.x,
            converted.rotation.y,
            converted.rotation.z,
            converted.rotation.order || "XYZ",
        )),
        new Vector3(1, 1, 1),
    );
    return vehicleMatrix(vehicle).multiply(local);
}

function hitOrder(left, right) {
    return left.distance - right.distance
        || compareUtf8(left.primitiveId, right.primitiveId)
        || left.triangleIndex - right.triangleIndex;
}

function raycastIndex(index, ray, range) {
    if (!index) return [];
    return index.bvh.raycast(ray, DoubleSide, CPU_LIDAR_NEAR_METERS, range)
        .map((hit) => {
            const metadata = index.faces[hit.faceIndex];
            const normal = metadata.normal.clone();
            return {
                ...metadata,
                distance: hit.distance,
                incidence: Math.abs(normal.dot(ray.direction)),
            };
        })
        .filter((hit) => hit.distance >= CPU_LIDAR_NEAR_METERS && hit.distance <= range);
}

export class CpuLidarScene {
    constructor(resource) {
        const description = assertLidarGeometryResource(resource);
        this.staticIndex = createIndex(description.staticPrimitives);
        this.actorIndexes = new Map(description.actors.map((actor) => [
            actor.actorId,
            createIndex(actor.primitives),
        ]));
        this.disposed = false;
    }

    capture(config, vehicles) {
        if (this.disposed) throw new Error("CPU LiDAR scene is disposed.");
        const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === config.parentId);
        if (!vehicle) throw new Error(`LiDAR sensor "${config.id}" references unknown parent vehicle "${config.parentId}".`);
        const matrix = sensorMatrix(vehicle, config.pose);
        const origin = new Vector3().setFromMatrixPosition(matrix);
        const sensorQuaternion = new Quaternion().setFromRotationMatrix(matrix);
        const azimuth = config.calibration.azimuth;
        const elevation = config.calibration.elevation;
        const width = Math.ceil((azimuth.endDeg - azimuth.startDeg) / azimuth.stepDeg);
        const height = Math.ceil((elevation.endDeg - elevation.startDeg) / elevation.stepDeg);
        const range = Number(config.calibration.range);
        const buffer = new Float32Array(width * height * 4);
        const worldRay = new Ray(origin, new Vector3());

        for (let elevationIndex = 0; elevationIndex < height; elevationIndex += 1) {
            const phi = (elevation.startDeg + elevationIndex * elevation.stepDeg) * Math.PI / 180;
            const cosPhi = Math.cos(phi);
            for (let azimuthIndex = 0; azimuthIndex < width; azimuthIndex += 1) {
                const theta = (azimuth.startDeg + azimuthIndex * azimuth.stepDeg) * Math.PI / 180;
                worldRay.direction.set(
                    cosPhi * Math.cos(theta),
                    Math.sin(phi),
                    cosPhi * Math.sin(theta),
                ).applyQuaternion(sensorQuaternion).normalize();
                const candidates = raycastIndex(this.staticIndex, worldRay, range);
                for (const [actorId, index] of this.actorIndexes) {
                    if (actorId === config.parentId || !index) continue;
                    const actor = vehicles.find((entry) => (entry.telemetryId || entry.id) === actorId);
                    if (!actor) continue;
                    const actorTransform = vehicleMatrix(actor);
                    const localRay = worldRay.clone().applyMatrix4(actorTransform.clone().invert());
                    const hits = raycastIndex(index, localRay, range);
                    candidates.push(...hits);
                }
                const hit = candidates.sort(hitOrder)[0];
                if (!hit) continue;
                const offset = (elevationIndex * width + azimuthIndex) * 4;
                buffer[offset] = hit.distance;
                buffer[offset + 1] = hit.incidence;
                buffer[offset + 2] = hit.semanticId;
                buffer[offset + 3] = hit.instanceId;
            }
        }
        return buffer;
    }

    dispose() {
        this.staticIndex?.geometry.dispose();
        for (const index of this.actorIndexes.values()) index?.geometry.dispose();
        this.staticIndex = null;
        this.actorIndexes.clear();
        this.disposed = true;
    }
}
