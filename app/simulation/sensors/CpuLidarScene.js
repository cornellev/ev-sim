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
import { transformRigidBodyPoint } from "../world/RigidBodyRecords.js";
import { assertLidarGeometryResource } from "../lidar/LidarGeometry.js";
import { BOX_FACES } from "./BoxFaces.js";

export const CPU_LIDAR_NEAR_METERS = 1e-4;

const UNIT_SCALE = new Vector3(1, 1, 1);

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
    return new Matrix4().compose(position, quaternion, UNIT_SCALE);
}

export function lidarSensorWorldPose(vehicle, pose) {
    const matrix = sensorMatrix(vehicle, pose);
    const origin = new Vector3().setFromMatrixPosition(matrix);
    const quaternion = new Quaternion().setFromRotationMatrix(matrix);
    return {
        origin: { x: origin.x, y: origin.y, z: origin.z },
        quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
    };
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
        UNIT_SCALE,
    );
    return vehicleMatrix(vehicle).multiply(local);
}

function hitOrder(left, right) {
    return left.distance - right.distance
        || compareUtf8(left.primitiveId, right.primitiveId)
        || left.triangleIndex - right.triangleIndex;
}

function raycastPlanes(planes, ray, range, near = CPU_LIDAR_NEAR_METERS) {
    const hits = [];
    for (const plane of planes ?? []) {
        const denom = ray.direction.y;
        if (Math.abs(denom) <= 1e-7) continue;
        const distance = (plane.y - ray.origin.y) / denom;
        if (distance < near || distance > range) continue;
        hits.push({
            primitiveId: plane.id,
            triangleIndex: 0,
            semanticId: plane.semanticId,
            instanceId: plane.instanceId,
            distance,
            incidence: Math.abs(denom),
        });
    }
    return hits;
}

function hitFromFace(index, faceIndex, ray, distance) {
    const metadata = index.faces[faceIndex];
    return {
        primitiveId: metadata.primitiveId,
        triangleIndex: metadata.triangleIndex,
        semanticId: metadata.semanticId,
        instanceId: metadata.instanceId,
        distance,
        incidence: Math.abs(metadata.normal.dot(ray.direction)),
    };
}

function nearestIndexHit(index, ray, near, far) {
    if (!index) return null;
    const first = index.bvh.raycastFirst(ray, DoubleSide, near, far);
    if (!first) return null;
    const ties = index.bvh.raycast(ray, DoubleSide, first.distance, first.distance);
    let best = null;
    for (const hit of ties) {
        const candidate = hitFromFace(index, hit.faceIndex, ray, hit.distance);
        if (!best || hitOrder(candidate, best) < 0) best = candidate;
    }
    return best ?? hitFromFace(index, first.faceIndex, ray, first.distance);
}

function poseMoved(pose) {
    const position = pose?.position;
    const spawn = pose?.spawnPosition;
    const rotation = pose?.rotation;
    const spawnRotation = pose?.spawnRotation;
    if (!position || !spawn || !rotation || !spawnRotation) return false;
    return Math.abs(position.x - spawn.x) > 1e-6
        || Math.abs(position.y - spawn.y) > 1e-6
        || Math.abs(position.z - spawn.z) > 1e-6
        || Math.abs(rotation.x - spawnRotation.x) > 1e-6
        || Math.abs(rotation.y - spawnRotation.y) > 1e-6
        || Math.abs(rotation.z - spawnRotation.z) > 1e-6
        || Math.abs(rotation.w - spawnRotation.w) > 1e-6;
}

function movePrimitive(primitive, pose) {
    if (primitive.shape === "box" && primitive.center) {
        return { ...primitive, center: transformRigidBodyPoint(primitive.center, pose) };
    }
    if (!Array.isArray(primitive.vertices)) return primitive;
    return {
        ...primitive,
        vertices: primitive.vertices.map((vertex) => transformRigidBodyPoint(vertex, pose)),
    };
}

function poseKey(pose) {
    const position = pose.position;
    const rotation = pose.rotation;
    return [
        pose.id,
        position.x, position.y, position.z,
        rotation.x, rotation.y, rotation.z, rotation.w,
    ].join(",");
}

function disposeIndex(index) {
    index?.geometry.dispose();
}

export class CpuLidarScene {
    constructor(resource) {
        const description = assertLidarGeometryResource(resource);
        this.authoredPrimitives = description.staticPrimitives;
        this.fullStaticIndex = createIndex(description.staticPrimitives);
        this.staticIndex = this.fullStaticIndex;
        this.planes = description.planes ?? [];
        this.actorIndexes = new Map(description.actors.map((actor) => [
            actor.actorId,
            createIndex(actor.primitives),
        ]));
        this.episodeIndex = null;
        this._bodyGroups = new Map();
        this._bodyIndex = null;
        this._bodyBakeKey = "";
        this._rigidBodyPoses = [];
        this._rigidBodySplitKey = "";
        this._activeStaticIndex = this.fullStaticIndex;
        this._queryBodyIndex = null;
        this._localRay = new Ray();
        this.disposed = false;
    }

    setRigidBodyPoses(poses = []) {
        if (this.disposed) throw new Error("CPU LiDAR scene is disposed.");
        const byId = new Map();
        for (const pose of Array.isArray(poses) ? poses : []) {
            if (pose?.id == null || pose.id === "") continue;
            byId.set(String(pose.id), pose);
        }
        const ids = [...byId.keys()].sort(compareUtf8);
        const key = ids.join("\0");
        if (key !== this._rigidBodySplitKey) {
            this._splitRigidBodies(ids);
            this._rigidBodySplitKey = key;
        }
        this._rigidBodyPoses = ids.map((id) => byId.get(id));
    }

    _dropBodyIndex() {
        disposeIndex(this._bodyIndex);
        this._bodyIndex = null;
        this._bodyBakeKey = "";
        this._queryBodyIndex = null;
    }

    _splitRigidBodies(ids) {
        this._dropBodyIndex();
        if (this.staticIndex !== this.fullStaticIndex) disposeIndex(this.staticIndex);
        if (ids.length === 0) {
            this.staticIndex = this.fullStaticIndex;
            this._bodyGroups = new Map();
            return;
        }
        const grouped = new Map(ids.map((id) => [id, []]));
        const staticPrimitives = [];
        for (const primitive of this.authoredPrimitives) {
            const bucket = grouped.get(String(primitive.sourceId));
            if (bucket) bucket.push(primitive);
            else staticPrimitives.push(primitive);
        }
        this._bodyGroups = grouped;
        this.staticIndex = createIndex(staticPrimitives);
    }

    _syncRigidBodyQuery() {
        const poses = this._rigidBodyPoses;
        if (!poses.some(poseMoved)) {
            this._activeStaticIndex = this.fullStaticIndex;
            this._queryBodyIndex = null;
            return;
        }
        const key = poses.map(poseKey).join("\n");
        if (key !== this._bodyBakeKey) {
            disposeIndex(this._bodyIndex);
            const baked = [];
            for (const pose of poses) {
                for (const primitive of this._bodyGroups.get(String(pose.id)) ?? []) {
                    baked.push(poseMoved(pose) ? movePrimitive(primitive, pose) : primitive);
                }
            }
            this._bodyIndex = createIndex(baked);
            this._bodyBakeKey = key;
        }
        this._activeStaticIndex = this.staticIndex;
        this._queryBodyIndex = this._bodyIndex;
    }

    setEpisodePrimitives(primitives = []) {
        if (this.disposed) throw new Error("CPU LiDAR scene is disposed.");
        disposeIndex(this.episodeIndex);
        this.episodeIndex = createIndex(Array.isArray(primitives) ? primitives : []);
    }

    _movers(parentId, vehicles) {
        const movers = [];
        for (const [actorId, index] of this.actorIndexes) {
            if (actorId === parentId || !index) continue;
            const actor = vehicles.find((entry) => (entry.telemetryId || entry.id) === actorId);
            if (!actor) continue;
            movers.push({ index, inverse: vehicleMatrix(actor).invert() });
        }
        return movers;
    }

    _nearestHit(worldRay, near, far, movers) {
        const candidates = [];
        const consider = (index, ray) => {
            const hit = nearestIndexHit(index, ray, near, far);
            if (hit) candidates.push(hit);
        };
        consider(this._activeStaticIndex, worldRay);
        consider(this.episodeIndex, worldRay);
        consider(this._queryBodyIndex, worldRay);
        for (const mover of movers) {
            if (!mover.inverse) {
                consider(mover.index, worldRay);
                continue;
            }
            consider(mover.index, this._localRay.copy(worldRay).applyMatrix4(mover.inverse));
        }
        candidates.push(...raycastPlanes(this.planes, worldRay, far, near));
        candidates.sort(hitOrder);
        return candidates[0] ?? null;
    }

    _writeHit(buffer, offset, hit) {
        if (!hit) return;
        buffer[offset] = hit.distance;
        buffer[offset + 1] = hit.incidence;
        buffer[offset + 2] = hit.semanticId;
        buffer[offset + 3] = hit.instanceId;
    }

    _captureExplicitLayout(config, vehicles, vehicle) {
        const matrix = sensorMatrix(vehicle, config.pose);
        const origin = new Vector3().setFromMatrixPosition(matrix);
        const sensorQuaternion = new Quaternion().setFromRotationMatrix(matrix);
        const layout = config.calibration.scanLayout;
        const width = layout.azimuthsDeg.length;
        const height = layout.channels.length;
        const minRange = Number(layout.minRangeM);
        const maxRange = Number(layout.maxRangeM);
        const buffer = new Float32Array(width * height * 4);
        const worldRay = new Ray(origin, new Vector3());
        this._syncRigidBodyQuery();
        const movers = this._movers(config.parentId, vehicles);

        for (let channelIndex = 0; channelIndex < height; channelIndex += 1) {
            const channel = layout.channels[channelIndex];
            const phi = channel.elevationDeg * Math.PI / 180;
            const cosPhi = Math.cos(phi);
            for (let azimuthIndex = 0; azimuthIndex < width; azimuthIndex += 1) {
                const theta = (layout.azimuthsDeg[azimuthIndex] + channel.azimuthOffsetDeg) * Math.PI / 180;
                worldRay.direction.set(
                    cosPhi * Math.cos(theta),
                    Math.sin(phi),
                    cosPhi * Math.sin(theta),
                ).applyQuaternion(sensorQuaternion).normalize();
                this._writeHit(
                    buffer,
                    (channelIndex * width + azimuthIndex) * 4,
                    this._nearestHit(worldRay, minRange, maxRange, movers),
                );
            }
        }
        return buffer;
    }

    capture(config, vehicles) {
        if (this.disposed) throw new Error("CPU LiDAR scene is disposed.");
        const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === config.parentId);
        if (!vehicle) throw new Error(`LiDAR sensor "${config.id}" references unknown parent vehicle "${config.parentId}".`);
        if (config.calibration?.scanLayout) {
            return this._captureExplicitLayout(config, vehicles, vehicle);
        }
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
        this._syncRigidBodyQuery();
        const movers = this._movers(config.parentId, vehicles);

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
                this._writeHit(
                    buffer,
                    (elevationIndex * width + azimuthIndex) * 4,
                    this._nearestHit(worldRay, CPU_LIDAR_NEAR_METERS, range, movers),
                );
            }
        }
        return buffer;
    }

    dispose() {
        disposeIndex(this.fullStaticIndex);
        if (this.staticIndex !== this.fullStaticIndex) disposeIndex(this.staticIndex);
        disposeIndex(this.episodeIndex);
        disposeIndex(this._bodyIndex);
        for (const index of this.actorIndexes.values()) disposeIndex(index);
        this.fullStaticIndex = null;
        this.staticIndex = null;
        this._activeStaticIndex = null;
        this._bodyIndex = null;
        this._queryBodyIndex = null;
        this.episodeIndex = null;
        this.actorIndexes.clear();
        this._bodyGroups.clear();
        this.disposed = true;
    }
}
