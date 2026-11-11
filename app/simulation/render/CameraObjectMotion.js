import { compareUtf8 } from "../world/WorldDescription.js";
import { canonicalExactStringify } from "../visual/VisualLayer.js";
import { RigidBodyPoseTracker } from "../world/RigidBodyPoseTracker.js";

export const LIVE_CAMERA_OBJECT_MOTION = "live-rigid-bodies@1";
export const CAMERA_OBJECT_MOTION_POLICIES = Object.freeze(["authored@1", LIVE_CAMERA_OBJECT_MOTION]);

export function assertCameraObjectMotion(policy) {
    if (policy !== undefined && !CAMERA_OBJECT_MOTION_POLICIES.includes(policy)) {
        throw new TypeError("cameraObjectMotion must be authored@1 or live-rigid-bodies@1.");
    }
    return policy;
}

function assertVector(value, rotation = false) {
    const axes = rotation ? ["x", "y", "z", "w"] : ["x", "y", "z"];
    if (!value || axes.some((key) => !Number.isFinite(value[key])) || Object.keys(value).some((key) => !axes.includes(key))) {
        throw new TypeError("Camera object poses require finite position and quaternion rotation.");
    }
    if (rotation && Math.abs(Math.hypot(...axes.map((key) => value[key])) - 1) > 1e-5) {
        throw new TypeError("Camera object rotation must be a unit quaternion.");
    }
    return axes;
}

function vector(value, rotation = false) {
    const axes = assertVector(value, rotation);
    return Object.freeze(Object.fromEntries(axes.map((key) => [key, Object.is(value[key], -0) ? 0 : value[key]])));
}

/** Camera receipt checks scalars; only changed records produce a new frozen snapshot. */
export class CameraObjectPoseTracker {
    constructor(bindings = []) {
        this.ids = new Set(bindings.map((binding) => binding.id));
        this.tracker = new RigidBodyPoseTracker();
        this.poses = Object.freeze([]);
    }

    sync(poses = []) {
        if (!Array.isArray(poses)) throw new TypeError("Camera object poses must be an array.");
        const seen = new Set();
        const staged = [];
        for (const pose of poses) {
            if (!this.ids.has(pose?.id) || seen.has(pose.id)) throw new TypeError(`Unknown or duplicate camera object ID ${pose?.id}.`);
            seen.add(pose.id);
            assertVector(pose.position);
            assertVector(pose.rotation, true);
            const previous = this.tracker.get(pose.id);
            const same = previous && ["x", "y", "z"].every((axis) => previous.position[axis] === pose.position[axis])
                && ["x", "y", "z", "w"].every((axis) => previous.rotation[axis] === pose.rotation[axis]);
            staged.push(same ? previous : { id: pose.id, position: pose.position, rotation: pose.rotation });
        }
        const changed = this.tracker.sync(staged);
        if (changed.size) {
            this.poses = Object.freeze([...this.tracker.records.values()].map((record) => record.pose)
                .sort((a, b) => compareUtf8(a.id, b.id)));
        }
        return changed;
    }
}

/** Bind only resolved world IDs and published visual scopes, never GLTF names. */
export function cameraObjectMotionFields(policy, world, visualLayer = null) {
    assertCameraObjectMotion(policy);
    if (policy === undefined) return {};
    if (policy !== LIVE_CAMERA_OBJECT_MOTION) return { objectMotion: policy };
    const bodies = [...(world?.rigidBodies ?? [])].sort((a, b) => compareUtf8(a.id, b.id));
    if (visualLayer && bodies.length > 0 && visualLayer.instances.some((instance) => !visualLayer.bindings.some((binding) => binding.instanceId === instance.id))) {
        throw new TypeError("Live PBR requires published truth scopes for every appearance instance; unseparable baked/static appearance is unsupported.");
    }
    const objectMotionBindings = bodies.map((body) => {
        const appearanceInstanceIds = visualLayer ? [...new Set(visualLayer.bindings
            .filter((binding) => binding.truthEntityId === body.id)
            .map((binding) => binding.instanceId))].sort(compareUtf8) : [];
        if (visualLayer) {
            if (appearanceInstanceIds.length === 0) {
                throw new TypeError(`Live PBR object ${body.id} requires a separable published appearance binding.`);
            }
            for (const id of appearanceInstanceIds) {
                if (!visualLayer.instances.some((instance) => instance.id === id)
                    || visualLayer.bindings.some((binding) => binding.instanceId === id && binding.truthEntityId !== body.id)) {
                    throw new TypeError(`Live PBR appearance ${id} is shared with another truth object.`);
                }
            }
        }
        return {
            id: body.id,
            spawnPosition: vector(body.position),
            spawnRotation: vector(body.rotation, true),
            appearanceInstanceIds,
        };
    });
    return { objectMotion: policy, objectMotionBindings };
}

export function assertCameraObjectMotionFields(scene, { world, visualLayer } = {}) {
    assertCameraObjectMotion(scene.objectMotion);
    if (scene.objectMotion !== LIVE_CAMERA_OBJECT_MOTION) {
        if (scene.objectMotionBindings !== undefined) throw new TypeError("Only live camera scenes may bind object motion.");
        return scene;
    }
    const bindings = scene.objectMotionBindings;
    if (!Array.isArray(bindings)) throw new TypeError("Live camera scene requires object motion bindings.");
    let previous = null;
    const appearances = new Set();
    const primitives = scene.staticPrimitives ?? scene.analyticTruth?.description?.staticPrimitives ?? [];
    for (const binding of bindings) {
        if (typeof binding.id !== "string" || !binding.id || (previous !== null && compareUtf8(previous, binding.id) >= 0)
            || Object.keys(binding).some((key) => !["id", "spawnPosition", "spawnRotation", "appearanceInstanceIds"].includes(key))) {
            throw new TypeError("Camera object IDs must be unique and sorted.");
        }
        previous = binding.id;
        vector(binding.spawnPosition);
        vector(binding.spawnRotation, true);
        if (!primitives.some((primitive) => primitive.sourceId === binding.id)) {
            throw new TypeError(`Camera object ${binding.id} has no analytic truth geometry.`);
        }
        if (!Array.isArray(binding.appearanceInstanceIds)) throw new TypeError("Camera appearance scopes must be an array.");
        let previousScope = null;
        for (const id of binding.appearanceInstanceIds) {
            if (typeof id !== "string" || !id || appearances.has(id) || (previousScope !== null && compareUtf8(previousScope, id) >= 0)) {
                throw new TypeError("Camera appearance scopes must be unique and sorted.");
            }
            previousScope = id;
            appearances.add(id);
        }
        if (scene.provider?.id === "pbr-mesh" && binding.appearanceInstanceIds.length === 0) {
            throw new TypeError(`Live PBR object ${binding.id} has no separable appearance.`);
        }
    }
    if (world) {
        const expected = cameraObjectMotionFields(scene.objectMotion, world, visualLayer);
        if (canonicalExactStringify(expected.objectMotionBindings) !== canonicalExactStringify(bindings)) {
            throw new TypeError("Camera object motion bindings do not match the trusted world and appearance.");
        }
    }
    return scene;
}

/** Capture poses contain no caller-supplied spawn frame. Missing records restore spawn. */
export function snapshotCameraObjectPoses(poses = [], bindings = []) {
    if (!Array.isArray(poses)) throw new TypeError("Camera object poses must be an array.");
    const byId = new Map(bindings.map((binding) => [binding.id, binding]));
    const seen = new Set();
    const result = poses.map((pose) => {
        if (!byId.has(pose?.id) || seen.has(pose.id)) throw new TypeError(`Unknown or duplicate camera object ID ${pose?.id}.`);
        seen.add(pose.id);
        return Object.freeze({ id: pose.id, position: vector(pose.position), rotation: vector(pose.rotation, true) });
    });
    return Object.freeze(result.sort((a, b) => compareUtf8(a.id, b.id)));
}

export function cameraObjectPosesWithSpawn(poses, bindings) {
    const snapshots = snapshotCameraObjectPoses(poses, bindings);
    const byId = new Map(snapshots.map((pose) => [pose.id, pose]));
    return bindings.map((binding) => ({
        ...(byId.get(binding.id) ?? { id: binding.id, position: binding.spawnPosition, rotation: binding.spawnRotation }),
        spawnPosition: binding.spawnPosition,
        spawnRotation: binding.spawnRotation,
    }));
}
