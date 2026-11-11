import {
    BufferGeometry,
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
import { rigidBodyPoseMoved, transformRigidBodyPoint } from "../world/RigidBodyRecords.js";
import { RigidBodyPoseTracker } from "../world/RigidBodyPoseTracker.js";
import { assertLidarGeometryResource } from "../lidar/LidarGeometry.js";
import { BOX_FACES } from "./BoxFaces.js";

export const CPU_LIDAR_NEAR_METERS = 1e-4;

const UNIT_SCALE = new Vector3(1, 1, 1);
const BOX_CORNERS = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

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

function createIndex(primitives, bodies = null) {
    if (primitives.length === 0) return null;
    const positions = [];
    const faces = [];
    for (const primitive of [...primitives].sort((left, right) => compareUtf8(left.id, right.id))) {
        const offset = positions.length;
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
        bodies?.get(String(primitive.sourceId)).ranges.push({ primitive, offset, end: positions.length });
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const bvh = new MeshBVH(geometry, { indirect: true });
    const index = { geometry, bvh, faces };
    index.query = createNearestQuery(index);
    if (bodies) {
        index.bodies = bodies;
        // Keep authored doubles: transforming the Float32 buffer changes scan bytes.
        index.originalPositions = new Float64Array(positions);
        index.originalNormals = new Float64Array(faces.flatMap(({ normal }) => [normal.x, normal.y, normal.z]));
        index.motion = { vertices: [new Vector3(), new Vector3(), new Vector3()], ab: new Vector3(), ac: new Vector3() };
        cacheBodyRefitNodes(index);
    }
    return index;
}

function cacheBodyRefitNodes(index) {
    const bodyForFace = new Array(index.faces.length);
    for (const body of index.bodies.values()) {
        for (const range of body.ranges) bodyForFace.fill(body, range.offset / 9, range.end / 9);
    }
    // These geometries have one root; shapecast reports it only for a root leaf.
    const ancestors = [0];
    index.bvh.shapecast({
        intersectsBounds(_box, _leaf, _score, depth, nodeIndex) {
            ancestors[depth] = nodeIndex;
            return true;
        },
        intersectsRange(offset, count, _contained, depth, nodeIndex) {
            for (let i = offset; i < offset + count; i += 1) {
                const body = bodyForFace[index.bvh.resolveTriangleIndex(i)];
                body.nodeIndices.add(nodeIndex);
                for (let level = 0; level < depth; level += 1) body.nodeIndices.add(ancestors[level]);
            }
            return false;
        },
    });
}

function updateBodyCoordinates(index, body, pose) {
    const positions = index.geometry.attributes.position;
    const original = index.originalPositions;
    const moved = rigidBodyPoseMoved(pose);
    const { vertices, ab, ac } = index.motion;
    const [a, b, c] = vertices;
    for (const { primitive, offset, end } of body.ranges) {
        if (!moved) {
            positions.array.set(original.subarray(offset, end), offset);
            for (let face = offset / 9; face < end / 9; face += 1) {
                index.faces[face].normal.fromArray(index.originalNormals, face * 3);
            }
            continue;
        }
        const center = primitive.shape === "box" ? transformRigidBodyPoint(primitive.center, pose) : null;
        for (let start = offset; start < end; start += 9) {
            for (let vertex = 0; vertex < 3; vertex += 1) {
                const point = vertices[vertex];
                if (center) {
                    // Legacy boxes move their center only and stay axis-aligned.
                    const corner = BOX_CORNERS[BOX_FACES[(start - offset) / 9][vertex]];
                    point.set(
                        corner[0] < 0 ? center.x - primitive.size.x * 0.5 : center.x + primitive.size.x * 0.5,
                        corner[1] < 0 ? center.y - primitive.size.y * 0.5 : center.y + primitive.size.y * 0.5,
                        corner[2] < 0 ? center.z - primitive.size.z * 0.5 : center.z + primitive.size.z * 0.5,
                    );
                } else {
                    const transformed = transformRigidBodyPoint(point.fromArray(original, start + vertex * 3), pose);
                    point.set(transformed.x, transformed.y, transformed.z);
                }
                positions.setXYZ(start / 3 + vertex, point.x, point.y, point.z);
            }
            index.faces[start / 9].normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
        }
    }
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

function createNearestQuery(index) {
    const point = new Vector3();
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const positions = index.geometry.attributes.position;
    const vertices = index.geometry.index;
    const query = { ray: null, near: 0, far: 0, distance: 0, faceIndex: -1, hit: {} };
    query.callbacks = {
        boundsTraverseOrder(box) {
            if (box.containsPoint(query.ray.origin)) return 0;
            return query.ray.intersectBox(box, point)
                ? query.ray.origin.distanceTo(point) : Infinity;
        },
        intersectsBounds(_box, _leaf, score) {
            // Pad bounds pruning only; hit distances and ties remain exact.
            return score <= query.distance + Math.max(1e-9, query.distance * Number.EPSILON * 8);
        },
        intersectsRange(offset, count) {
            for (let i = offset, end = offset + count; i < end; i += 1) {
                const faceIndex = index.bvh.resolveTriangleIndex(i);
                const start = faceIndex * 3;
                a.fromBufferAttribute(positions, vertices ? vertices.getX(start) : start);
                b.fromBufferAttribute(positions, vertices ? vertices.getX(start + 1) : start + 1);
                c.fromBufferAttribute(positions, vertices ? vertices.getX(start + 2) : start + 2);
                if (!query.ray.intersectTriangle(a, b, c, false, point)) continue;
                const distance = query.ray.origin.distanceTo(point);
                if (distance < query.near || distance > query.far || distance > query.distance) continue;
                const previous = index.faces[query.faceIndex];
                const candidate = index.faces[faceIndex];
                // Equal-id episode triangles can arrive in authored index order.
                const earlier = !previous || (candidate.primitiveId === previous.primitiveId
                    ? candidate.triangleIndex < previous.triangleIndex : faceIndex < query.faceIndex);
                if (distance < query.distance || earlier) {
                    query.distance = distance;
                    query.faceIndex = faceIndex;
                }
            }
            return false;
        },
    };
    return query;
}

function nearestIndexHit(index, ray, near, far) {
    if (!index) return null;
    const query = index.query;
    query.ray = ray;
    query.near = near;
    query.far = far;
    query.distance = far;
    query.faceIndex = -1;
    index.bvh.shapecast(query.callbacks);
    if (query.faceIndex < 0) return null;
    const metadata = index.faces[query.faceIndex];
    const hit = query.hit;
    hit.primitiveId = metadata.primitiveId;
    hit.triangleIndex = metadata.triangleIndex;
    hit.semanticId = metadata.semanticId;
    hit.instanceId = metadata.instanceId;
    hit.distance = query.distance;
    hit.incidence = Math.abs(metadata.normal.dot(ray.direction));
    return hit;
}

function disposeIndex(index) {
    index?.geometry.dispose();
}

export class CpuLidarScene {
    constructor(resource) {
        const start = performance.now();
        const description = assertLidarGeometryResource(resource);
        const validatedAt = performance.now();
        this.authoredPrimitives = description.staticPrimitives;
        this.fullStaticIndex = createIndex(description.staticPrimitives);
        this.staticIndex = this.fullStaticIndex;
        this.planes = description.planes ?? [];
        this._planeHits = this.planes.map((plane) => ({ ...plane, primitiveId: plane.id, triangleIndex: 0 }));
        this._directions = new WeakMap();
        this.actorIndexes = new Map(description.actors.map((actor) => [
            actor.actorId,
            createIndex(actor.primitives),
        ]));
        this.preparationTimings = { validationMs: validatedAt - start, bvhBuildMs: performance.now() - validatedAt };
        this.episodeIndex = null;
        this._bodyGroups = new Map();
        this._bodyIndex = null;
        this._poseTracker = new RigidBodyPoseTracker();
        this._changedBodyIds = new Set();
        this._movedBodyIds = new Set();
        this._bodyRefitNodes = new Set();
        this._bodyPrimitiveCount = 0;
        this._activeStaticIndex = this.fullStaticIndex;
        this._queryBodyIndex = null;
        this._localRay = new Ray();
        this.disposed = false;
    }

    setRigidBodyPoses(poses = []) {
        if (this.disposed) throw new Error("CPU LiDAR scene is disposed.");
        const changed = this._poseTracker.sync(poses);
        const membershipChanged = [...changed].some((id) => this._poseTracker.records.has(id) !== this._bodyGroups.has(id));
        if (membershipChanged) {
            this._splitRigidBodies([...this._poseTracker.records.keys()].sort(compareUtf8));
        }
        for (const id of changed) {
            const pose = this._poseTracker.get(id);
            if (rigidBodyPoseMoved(pose)) this._movedBodyIds.add(id);
            else this._movedBodyIds.delete(id);
            if (pose) this._changedBodyIds.add(id);
            else this._changedBodyIds.delete(id);
        }
    }

    _dropBodyIndex() {
        disposeIndex(this._bodyIndex);
        this._bodyIndex = null;
        this._changedBodyIds.clear();
        this._bodyRefitNodes.clear();
        this._queryBodyIndex = null;
    }

    _splitRigidBodies(ids) {
        this._dropBodyIndex();
        if (this.staticIndex !== this.fullStaticIndex) disposeIndex(this.staticIndex);
        if (ids.length === 0) {
            this.staticIndex = this.fullStaticIndex;
            this._bodyGroups = new Map();
            this._bodyPrimitiveCount = 0;
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
        this._bodyPrimitiveCount = this.authoredPrimitives.length - staticPrimitives.length;
        this.staticIndex = createIndex(staticPrimitives);
    }

    _syncRigidBodyQuery() {
        if (!this._bodyIndex && this._movedBodyIds.size > 0 && this._bodyPrimitiveCount > 0) {
            const bodies = new Map([...this._bodyGroups.keys()].map((id) => [id, { ranges: [], nodeIndices: new Set() }]));
            this._bodyIndex = createIndex([...this._bodyGroups.values()].flat(), bodies);
            for (const id of bodies.keys()) this._changedBodyIds.add(id);
        }
        if (this._bodyIndex && this._changedBodyIds.size > 0) {
            const nodes = this._bodyRefitNodes;
            nodes.clear();
            for (const id of this._changedBodyIds) {
                const body = this._bodyIndex.bodies.get(id);
                updateBodyCoordinates(this._bodyIndex, body, this._poseTracker.get(id));
                for (const node of body.nodeIndices) nodes.add(node);
            }
            if (nodes.size > 0) {
                this._bodyIndex.geometry.attributes.position.needsUpdate = true;
                this._bodyIndex.bvh.refit(nodes);
            }
        }
        this._changedBodyIds.clear();
        if (this._movedBodyIds.size === 0) {
            this._activeStaticIndex = this.fullStaticIndex;
            this._queryBodyIndex = null;
            return;
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
        let best = nearestIndexHit(this._activeStaticIndex, worldRay, near, far);
        const episode = nearestIndexHit(this.episodeIndex, worldRay, near, far);
        if (episode && (!best || hitOrder(episode, best) < 0)) best = episode;
        const body = nearestIndexHit(this._queryBodyIndex, worldRay, near, far);
        if (body && (!best || hitOrder(body, best) < 0)) best = body;
        for (const mover of movers) {
            const ray = mover.inverse ? this._localRay.copy(worldRay).applyMatrix4(mover.inverse) : worldRay;
            const hit = nearestIndexHit(mover.index, ray, near, far);
            if (hit && (!best || hitOrder(hit, best) < 0)) best = hit;
        }
        const denom = worldRay.direction.y;
        if (Math.abs(denom) > 1e-7) {
            for (const hit of this._planeHits) {
                const distance = (hit.y - worldRay.origin.y) / denom;
                if (distance < near || distance > far) continue;
                hit.distance = distance;
                hit.incidence = Math.abs(denom);
                if (!best || hitOrder(hit, best) < 0) best = hit;
            }
        }
        return best;
    }

    _scanDirections(calibration) {
        let scan = this._directions.get(calibration);
        if (scan) return scan;
        const layout = calibration.scanLayout;
        const width = layout ? layout.azimuthsDeg.length
            : Math.ceil((calibration.azimuth.endDeg - calibration.azimuth.startDeg) / calibration.azimuth.stepDeg);
        const height = layout ? layout.channels.length
            : Math.ceil((calibration.elevation.endDeg - calibration.elevation.startDeg) / calibration.elevation.stepDeg);
        const directions = new Float64Array(width * height * 3);
        for (let row = 0; row < height; row += 1) {
            const phi = (layout ? layout.channels[row].elevationDeg
                : calibration.elevation.startDeg + row * calibration.elevation.stepDeg) * Math.PI / 180;
            const cosPhi = Math.cos(phi);
            for (let column = 0; column < width; column += 1) {
                const theta = (layout ? layout.azimuthsDeg[column] + layout.channels[row].azimuthOffsetDeg
                    : calibration.azimuth.startDeg + column * calibration.azimuth.stepDeg) * Math.PI / 180;
                const offset = (row * width + column) * 3;
                directions[offset] = cosPhi * Math.cos(theta);
                directions[offset + 1] = Math.sin(phi);
                directions[offset + 2] = cosPhi * Math.sin(theta);
            }
        }
        scan = { width, height, directions };
        this._directions.set(calibration, scan);
        return scan;
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
        const { width, height, directions } = this._scanDirections(config.calibration);
        const minRange = Number(layout.minRangeM);
        const maxRange = Number(layout.maxRangeM);
        const buffer = new Float32Array(width * height * 4);
        const worldRay = new Ray(origin, new Vector3());
        this._syncRigidBodyQuery();
        const movers = this._movers(config.parentId, vehicles);

        for (let channelIndex = 0; channelIndex < height; channelIndex += 1) {
            for (let azimuthIndex = 0; azimuthIndex < width; azimuthIndex += 1) {
                worldRay.direction.fromArray(directions, (channelIndex * width + azimuthIndex) * 3)
                    .applyQuaternion(sensorQuaternion).normalize();
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
        const { width, height, directions } = this._scanDirections(config.calibration);
        const range = Number(config.calibration.range);
        const buffer = new Float32Array(width * height * 4);
        const worldRay = new Ray(origin, new Vector3());
        this._syncRigidBodyQuery();
        const movers = this._movers(config.parentId, vehicles);

        for (let elevationIndex = 0; elevationIndex < height; elevationIndex += 1) {
            for (let azimuthIndex = 0; azimuthIndex < width; azimuthIndex += 1) {
                worldRay.direction.fromArray(directions, (elevationIndex * width + azimuthIndex) * 3)
                    .applyQuaternion(sensorQuaternion).normalize();
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
        this._poseTracker.clear();
        this._changedBodyIds.clear();
        this._movedBodyIds.clear();
        this._bodyRefitNodes.clear();
        this.disposed = true;
    }
}
