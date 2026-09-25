/**
 * World-space triangles and sensor poses for analytic GPU capture.
 * Prepared in Node so the Chromium page only uploads and draws.
 */

import { eulerToQuaternion, quaternionMultiply } from "../../autonomy/CoordinateFrames.js";
import { cross3a, sub3a } from "../../math/linalg.js";
import { BOX_FACES } from "./BoxFaces.js";

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

function appendTriangles(triangles, primitive, transform = null) {
    for (let vertices of primitiveTriangles(primitive)) {
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

function worldTriangles(scene, job) {
    const triangles = [];
    for (const primitive of scene?.staticPrimitives || []) appendTriangles(triangles, primitive);
    const vehicles = new Map((job.vehicles || []).map((vehicle) => [vehicle.id, vehicle]));
    for (const actor of scene?.actors || []) {
        if (job.sensor?.poseReference !== "map" && actor.actorId === job.sensor?.parentId) continue;
        const vehicle = vehicles.get(actor.actorId);
        if (!vehicle) continue;
        const transform = {
            position: [vehicle.position.x, vehicle.position.y, vehicle.position.z],
            quaternion: quaternionOf(vehicle.rotation),
        };
        for (const primitive of actor.primitives || []) appendTriangles(triangles, primitive, transform);
    }
    return triangles;
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
    const localPosition = [pose.position?.x || 0, pose.position?.z || 0, pose.position?.y || 0];
    const rotatedPosition = rotate(localPosition, vehicleQ);
    const origin = rotatedPosition.map((value, index) => value
        + [parent.position.x, parent.position.y, parent.position.z][index]);
    const mountQ = quaternionMultiply(vehicleQ, quaternionOf({
        x: pose.rotation?.x || 0,
        y: pose.rotation?.z || 0,
        z: pose.rotation?.y || 0,
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

export function prepareAnalyticGpuFrame({ scene, jobs }) {
    return jobs.map((job) => {
        const triangles = worldTriangles(scene, job);
        const next = { ...job, triangles };
        if (triangles.length === 0) return next;
        if (job.type === "camera") {
            if (job.captureMode === "calibrated-projection@1" && job.products?.depth !== true) return next;
            if (!job.sensor) throw new Error(`GPU camera ${job.id} is missing its sensor.`);
            if (!next.analyticPose) next.analyticPose = fallbackCameraPose(job);
            return next;
        }
        if (job.type === "lidar3d") next.lidarPose = lidarPose(job);
        return next;
    });
}
