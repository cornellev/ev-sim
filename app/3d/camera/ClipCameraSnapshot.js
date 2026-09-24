import {
    quaternionToEuler,
    rep103PoseRelativeTo,
    threeCameraPoseToRep103Mount,
    threePoseToRep103,
} from "../../autonomy/CoordinateFrames.js";
import { getRunSessionController } from "../../simulation/RunSessionController.js";

function readVector(value) {
    return {
        x: Number(value?.x || 0),
        y: Number(value?.y || 0),
        z: Number(value?.z || 0),
    };
}

function readWorldCameraPose(camera) {
    if (typeof camera.getWorldPosition === "function" && typeof camera.getWorldQuaternion === "function") {
        const position = camera.getWorldPosition({ x: 0, y: 0, z: 0 });
        const quaternion = camera.getWorldQuaternion({ x: 0, y: 0, z: 0, w: 1 });
        return {
            position: readVector(position),
            rotation: {
                x: Number(quaternion.x || 0),
                y: Number(quaternion.y || 0),
                z: Number(quaternion.z || 0),
                w: Number(quaternion.w ?? 1),
            },
        };
    }
    const rotation = camera.quaternion || camera.rotation || {};
    return {
        position: readVector(camera.position),
        rotation: rotation.w !== undefined
            ? {
                x: Number(rotation.x || 0),
                y: Number(rotation.y || 0),
                z: Number(rotation.z || 0),
                w: Number(rotation.w ?? 1),
            }
            : {
                x: Number(rotation.x || 0),
                y: Number(rotation.y || 0),
                z: Number(rotation.z || 0),
                order: rotation.order || "XYZ",
            },
    };
}

function eulerMount(pose) {
    const rotation = pose.rotation?.w !== undefined ? quaternionToEuler(pose.rotation) : pose.rotation;
    return {
        position: { ...pose.position },
        rotation: {
            x: Number(rotation.x || 0),
            y: Number(rotation.y || 0),
            z: Number(rotation.z || 0),
            order: rotation.order || "XYZ",
        },
    };
}

function projectionFrom(camera) {
    return {
        verticalFovDeg: Number(camera.fov ?? camera.verticalFovDeg ?? 75),
        near: Number(camera.near ?? 0.1),
        far: Number(camera.far ?? 1000),
    };
}

function environmentIdFrom(data) {
    const environment = data?.environment?.();
    return environment?.getDocument?.()?.environmentId
        || environment?.environmentId
        || environment?.document?.environmentId
        || null;
}

/**
 * Snapshot the editor viewport camera as a clip mount.
 * `attachment: "map"` keeps the camera fixed in the world.
 * `attachment: "vehicle"` stores the same view relative to `parentId`.
 */
export function snapshotViewportClipCamera(session, {
    attachment = "map",
    parentId = null,
    environmentId = null,
} = {}) {
    const data = session?.data;
    const camera = data?.camera;
    if (!camera) throw new Error("The editor viewport camera is not available.");
    const resolvedEnvironmentId = environmentId || environmentIdFrom(data);
    if (!resolvedEnvironmentId) throw new Error("The editor environment is not available.");
    const worldMount = threeCameraPoseToRep103Mount(readWorldCameraPose(camera));
    const projection = projectionFrom(camera);
    if (attachment === "vehicle") {
        if (!parentId) throw new Error("A vehicle viewport camera requires parentId.");
        const vehicles = data.vehicles?.()?.vehicles || [];
        const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === parentId);
        if (!vehicle) throw new Error(`Viewport follow target "${parentId}" is not in the scene.`);
        const vehiclePose = threePoseToRep103({
            position: readVector(vehicle.position),
            rotation: {
                x: Number(vehicle.rotation?.x || 0),
                y: Number(vehicle.rotation?.y || 0),
                z: Number(vehicle.rotation?.z || 0),
                order: vehicle.rotation?.order || "XYZ",
            },
        });
        return {
            kind: "viewport",
            attachment: "vehicle",
            environmentId: resolvedEnvironmentId,
            parentId,
            mountPose: eulerMount(rep103PoseRelativeTo(vehiclePose, worldMount)),
            projection,
        };
    }
    if (attachment !== "map") throw new Error('Viewport attachment must be "map" or "vehicle".');
    return {
        kind: "viewport",
        attachment: "map",
        environmentId: resolvedEnvironmentId,
        mountPose: eulerMount(worldMount),
        projection,
    };
}

export function captureViewportClipCamera(options = {}) {
    return snapshotViewportClipCamera(getRunSessionController(), options);
}
