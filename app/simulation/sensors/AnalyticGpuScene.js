/**
 * World-space triangles and sensor poses for analytic GPU capture.
 * Prepared in Node so the Chromium page only uploads and draws.
 */

import { eulerToQuaternion, quaternionMultiply } from "../../autonomy/CoordinateFrames.js";
import { cross3a, sub3a } from "../../math/linalg.js";
import { rigidBodyPoseMoved, transformRigidBodyPoint } from "../world/RigidBodyRecords.js";
import { RigidBodyPoseTracker } from "../world/RigidBodyPoseTracker.js";
import { BOX_FACES } from "./BoxFaces.js";
import { isScanningLidarType } from "./SensorTypeRegistry.js";

function quaternionOf(rotation = {}) {
    return eulerToQuaternion(rotation);
}

function conjugate(quaternion) {
    return { x: -quaternion.x, y: -quaternion.y, z: -quaternion.z, w: quaternion.w };
}

function rotate(value, quaternion) {
    const vector = { x: value[0], y: value[1], z: value[2], w: 0 };
    const rotated = quaternionMultiply(quaternionMultiply(quaternion, vector), conjugate(quaternion));
    return [rotated.x, rotated.y, rotated.z];
}

function boxCorners(primitive) {
    const center = primitive.center;
    const size = primitive.size;
    const hx = size.x * 0.5;
    const hy = size.y * 0.5;
    const hz = size.z * 0.5;
    return [
        [center.x - hx, center.y - hy, center.z - hz],
        [center.x + hx, center.y - hy, center.z - hz],
        [center.x + hx, center.y + hy, center.z - hz],
        [center.x - hx, center.y + hy, center.z - hz],
        [center.x - hx, center.y - hy, center.z + hz],
        [center.x + hx, center.y - hy, center.z + hz],
        [center.x + hx, center.y + hy, center.z + hz],
        [center.x - hx, center.y + hy, center.z + hz],
    ];
}

function primitiveTriangles(primitive) {
    if (primitive.shape === "triangle") {
        return [primitive.vertices.map((value) => [value.x, value.y, value.z])];
    }
    const corners = boxCorners(primitive);
    return BOX_FACES.map((face) => face.map((index) => corners[index]));
}

function appendTriangles(triangles, primitive, transform = null, source = primitiveTriangles(primitive)) {
    for (let vertices of source) {
        if (transform) {
            vertices = vertices.map((vertex) => {
                const rotated = rotate(vertex, transform.quaternion);
                return rotated.map((value, index) => value + transform.position[index]);
            });
        }
        const [a, b, c] = vertices;
        const normal = cross3a(sub3a(b, a), sub3a(c, a));
        const length = Math.hypot(...normal) || 1;
        triangles.push({
            vertices,
            normal: normal.map((value) => value / length),
            semanticId: Number(primitive.semanticId || 0),
            instanceId: Number(primitive.instanceId || 0),
        });
    }
}

function posedStaticPrimitive(primitive, pose) {
    if (!pose || !rigidBodyPoseMoved(pose)) return primitive;
    if (primitive.shape === "box" && primitive.center) {
        return { ...primitive, center: transformRigidBodyPoint(primitive.center, pose) };
    }
    if (!Array.isArray(primitive.vertices)) return primitive;
    return {
        ...primitive,
        vertices: primitive.vertices.map((vertex) => transformRigidBodyPoint(vertex, pose)),
    };
}

function rigidBodyPosesForJob(job, scene) {
    const liveCamera = job?.type === "camera"
        && (job.cameraObjectMotion ?? job.captureInput?.objectMotion) === "live-rigid-bodies@1";
    if (!isScanningLidarType(job?.type) && !liveCamera) return [];
    const poses = job.rigidBodyPoses ?? job.captureInput?.objectPoses ?? [];
    if (!liveCamera) return poses;
    const bindings = new Map((scene?.objectMotionBindings || []).map((binding) => [String(binding.id), binding]));
    return poses.map((pose) => {
        const binding = bindings.get(String(pose.id));
        return binding ? {
            ...pose,
            spawnPosition: pose.spawnPosition ?? binding.spawnPosition,
            spawnRotation: pose.spawnRotation ?? binding.spawnRotation,
        } : pose;
    });
}

function authoredEntry(primitive) {
    const source = primitiveTriangles(primitive);
    const triangles = [];
    appendTriangles(triangles, primitive, null, source);
    return { primitive, source, triangles };
}

/** One owner per environment, scene generation and GL context; never shared by hash. */
export class AnalyticGpuScene {
    constructor(scene) {
        this.scene = scene;
        this.statics = (scene?.staticPrimitives || []).map(authoredEntry);
        this.actors = (scene?.actors || []).map((actor) => ({
            actorId: actor.actorId,
            entries: (actor.primitives || []).map(authoredEntry),
        }));
        this.frames = new Map();
    }

    prepare(job) {
        const geometryKey = JSON.stringify([job.type, job.id]);
        const vehicles = new Map((job.vehicles || []).map((vehicle) => [vehicle.id, vehicle]));
        const actors = this.actors.filter((actor) => vehicles.has(actor.actorId)
            && (job.sensor?.poseReference === "map" || actor.actorId !== job.sensor?.parentId));
        const topology = JSON.stringify(actors.map((actor) => actor.actorId));
        let frame = this.frames.get(geometryKey);
        const full = !frame || frame.topology !== topology;
        if (full) {
            frame = { topology, triangles: [], bodies: new RigidBodyPoseTracker(), actorPoses: new Map(), revision: (frame?.revision || 0) + 1, ranges: new Map() };
            for (const entry of this.statics) {
                const start = frame.triangles.length;
                frame.triangles.push(...entry.triangles);
                const id = String(entry.primitive.sourceId);
                if (!frame.ranges.has(id)) frame.ranges.set(id, []);
                frame.ranges.get(id).push({ start, entry });
            }
            this.frames.set(geometryKey, frame);
        }
        const updates = [];
        for (const id of frame.bodies.sync(rigidBodyPosesForJob(job, this.scene))) {
            for (const { start, entry } of frame.ranges.get(id) || []) {
                const pose = frame.bodies.get(id);
                const triangles = [];
                if (pose && rigidBodyPoseMoved(pose)) appendTriangles(triangles, posedStaticPrimitive(entry.primitive, pose));
                else triangles.push(...entry.triangles);
                if (triangles.every((triangle, index) => triangle === frame.triangles[start + index])) continue;
                for (let index = 0; index < triangles.length; index += 1) frame.triangles[start + index] = triangles[index];
                updates.push({ start, triangles });
            }
        }
        let start = this.statics.reduce((total, entry) => total + entry.triangles.length, 0);
        for (const actor of actors) {
            const vehicle = vehicles.get(actor.actorId);
            const position = [vehicle.position.x, vehicle.position.y, vehicle.position.z];
            const rotation = vehicle.rotation || {};
            const poseKey = JSON.stringify([...position, rotation.x || 0, rotation.y || 0, rotation.z || 0]);
            const count = actor.entries.reduce((total, entry) => total + entry.triangles.length, 0);
            if (frame.actorPoses.get(actor.actorId) !== poseKey) {
                const triangles = [];
                const transform = { position, quaternion: quaternionOf(vehicle.rotation) };
                for (const entry of actor.entries) appendTriangles(triangles, entry.primitive, transform, entry.source);
                for (let index = 0; index < triangles.length; index += 1) frame.triangles[start + index] = triangles[index];
                frame.actorPoses.set(actor.actorId, poseKey);
                updates.push({ start, triangles });
            }
            start += count;
        }
        if (!full && updates.length > 0) frame.revision += 1;
        return {
            geometryKey,
            geometryRevision: frame.revision,
            triangleCount: frame.triangles.length,
            triangles: frame.triangles,
            triangleUpdates: full ? [{ start: 0, triangles: frame.triangles }] : updates,
            geometryFull: full,
        };
    }

    dispose() {
        this.frames.clear();
        this.statics = [];
        this.actors = [];
    }
}

function parentVehicle(job, { mapIdentity = false } = {}) {
    if (mapIdentity && job.sensor?.poseReference === "map") {
        return { position: { x: 0, y: 0, z: 0 }, rotation: {} };
    }
    const parent = (job.vehicles || []).find((vehicle) => vehicle.id === job.sensor.parentId);
    if (!parent) throw new Error(`GPU sensor parent ${job.sensor.parentId} is missing.`);
    return parent;
}

function composedSensor(job, { mapIdentity = false, opticalYaw = false } = {}) {
    const parent = parentVehicle(job, { mapIdentity });
    const vehicleQ = quaternionOf(parent.rotation);
    const pose = job.sensor.pose || {};
    // REP-103 mount pose -> Three.js: +Y (left) is -Z, so pitch about Y flips sign too.
    const localPosition = [pose.position?.x || 0, pose.position?.z || 0, 0 - (pose.position?.y || 0)];
    const rotatedPosition = rotate(localPosition, vehicleQ);
    const origin = rotatedPosition.map((value, index) => value
        + [parent.position.x, parent.position.y, parent.position.z][index]);
    const mountQ = quaternionMultiply(vehicleQ, quaternionOf({
        x: pose.rotation?.x || 0,
        y: pose.rotation?.z || 0,
        z: 0 - (pose.rotation?.y || 0),
    }));
    const cameraQ = opticalYaw
        ? quaternionMultiply(mountQ, quaternionOf({ y: -Math.PI / 2 }))
        : mountQ;
    return { origin, quaternion: cameraQ };
}

function lidarPose(job) {
    const sensor = composedSensor(job);
    return {
        origin: sensor.origin,
        quaternion: [sensor.quaternion.x, sensor.quaternion.y, sensor.quaternion.z, sensor.quaternion.w],
    };
}

function fallbackCameraPose(job) {
    const sensor = composedSensor(job, { mapIdentity: true, opticalYaw: true });
    return {
        origin: sensor.origin,
        inverseQ: [-sensor.quaternion.x, -sensor.quaternion.y, -sensor.quaternion.z, sensor.quaternion.w],
        projection: [
            1 / Math.tan(job.sensor.calibration.verticalFovDeg * Math.PI / 360),
            job.width / job.height,
            job.sensor.calibration.near,
            job.sensor.calibration.far,
        ],
    };
}

export function prepareAnalyticGpuFrame({ scene, jobs, geometry = new AnalyticGpuScene(scene) }) {
    return jobs.map((job) => {
        const prepared = geometry.prepare(job);
        const { triangles } = prepared;
        const planes = Array.isArray(scene?.planes) ? scene.planes : [];
        const next = { ...job, ...prepared, planes };
        if (triangles.length === 0 && planes.length === 0) return next;
        if (job.type === "camera") {
            if (job.captureMode === "calibrated-projection@1" && job.products?.depth !== true) return next;
            if (!job.sensor) throw new Error(`GPU camera ${job.id} is missing its sensor.`);
            if (!next.analyticPose) next.analyticPose = fallbackCameraPose(job);
            return next;
        }
        if (isScanningLidarType(job.type)) next.lidarPose = lidarPose(job);
        return next;
    });
}
