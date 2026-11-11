import { transformRigidBodyPoint } from "../world/RigidBodyRecords.js";
import { transformPointMat4 } from "../../math/linalg.js";
import { CameraObjectPoseTracker } from "./CameraObjectMotion.js";
import { projectWorldPoint, distortPixelStrict } from "../../3d/environment/visual/VisualCapturePipeline.js";

function pointsOf(primitive) {
    if (primitive.vertices) return primitive.vertices;
    const points = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        points.push({
            x: primitive.center.x + x * primitive.size.x / 2,
            y: primitive.center.y + y * primitive.size.y / 2,
            z: primitive.center.z + z * primitive.size.z / 2,
        });
    }
    return points;
}

const SCENE_BOUNDS = new WeakMap();

function sourceBounds(source, transform = null) {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const points of source.primitives) for (const point of points) {
        const world = transform ? transform(point) : point;
        min.x = Math.min(min.x, world.x);
        min.y = Math.min(min.y, world.y);
        min.z = Math.min(min.z, world.z);
        max.x = Math.max(max.x, world.x);
        max.y = Math.max(max.y, world.y);
        max.z = Math.max(max.z, world.z);
    }
    return { min, max };
}

function sceneBounds(description) {
    const existing = SCENE_BOUNDS.get(description);
    if (existing) return existing;
    const geometry = description.analyticTruth?.description ?? description;
    const bindings = new Map((description.objectMotionBindings ?? []).map((binding) => [binding.id, binding]));
    const statics = new Map();
    const actors = new Map();
    const add = (sources, primitive) => {
        if (primitive.semanticId === 0) return;
        const source = sources.get(primitive.sourceId) ?? {
            record: {
                sourceId: primitive.sourceId,
                instanceId: primitive.instanceId,
                semanticId: primitive.semanticId,
                semanticClass: primitive.tags?.[0] ?? "unknown",
                visible: true,
            },
            primitives: [],
            poseRevision: 0,
            binding: bindings.get(primitive.sourceId),
        };
        source.primitives.push(pointsOf(primitive));
        sources.set(primitive.sourceId, source);
    };
    for (const primitive of geometry.staticPrimitives) add(statics, primitive);
    for (const source of statics.values()) source.bounds = sourceBounds(source);
    for (const actor of geometry.actors ?? []) {
        const sources = new Map();
        for (const primitive of actor.primitives) add(sources, primitive);
        actors.set(actor.actorId, { sources, matrix: null });
    }
    const cache = { statics, actors, poses: new CameraObjectPoseTracker(description.objectMotionBindings ?? []) };
    SCENE_BOUNDS.set(description, cache);
    return cache;
}

/** Warm bounds change only with their source pose; pixel projection still uses the issued camera sample. */
export function cameraSceneDetections(description, captureInput, actorMatrices = new Map()) {
    const cache = sceneBounds(description);
    cache.poses.sync(captureInput.objectPoses ?? []);
    const sources = [];
    for (const [id, source] of cache.statics) {
        const revision = cache.poses.tracker.revision(id);
        if (source.poseRevision !== revision) {
            const pose = cache.poses.tracker.get(id);
            const boundPose = pose ? { ...pose, spawnPosition: source.binding.spawnPosition, spawnRotation: source.binding.spawnRotation } : null;
            source.bounds = sourceBounds(source, boundPose ? (point) => transformRigidBodyPoint(point, boundPose) : null);
            source.poseRevision = revision;
        }
        sources.push(source);
    }
    for (const [id, actor] of cache.actors) {
        const matrix = actorMatrices.get(id);
        if (!matrix) continue;
        if (!actor.matrix || matrix.some((value, index) => value !== actor.matrix[index])) {
            for (const source of actor.sources.values()) source.bounds = sourceBounds(source, (point) => transformPointMat4(matrix, point));
            actor.matrix = Array.from(matrix);
        }
        for (const source of actor.sources.values()) sources.push(source);
    }
    const detections = [];
    for (const source of sources) {
        const { min, max } = source.bounds;
        let left = Infinity;
        let right = -Infinity;
        let top = Infinity;
        let bottom = -Infinity;
        for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
            const projected = projectWorldPoint({ x, y, z }, captureInput.calibration, captureInput.pose, { requireInside: false });
            if (!projected.valid) continue;
            const pixel = distortPixelStrict(projected.pixel, captureInput.calibration);
            left = Math.min(left, pixel.x);
            right = Math.max(right, pixel.x);
            top = Math.min(top, pixel.y);
            bottom = Math.max(bottom, pixel.y);
        }
        left = Math.max(0, left);
        right = Math.min(captureInput.calibration.image.width, right);
        top = Math.max(0, top);
        bottom = Math.min(captureInput.calibration.image.height, bottom);
        if (right <= left || bottom <= top) continue;
        const repMin = { x: min.x, y: -max.z, z: min.y };
        const repMax = { x: max.x, y: -min.z, z: max.y };
        const center = Object.fromEntries(["x", "y", "z"].map((axis) => [axis, (repMin[axis] + repMax[axis]) / 2]));
        const size = Object.fromEntries(["x", "y", "z"].map((axis) => [axis, repMax[axis] - repMin[axis]]));
        detections.push({
            ...source.record,
            position: center,
            worldBounds: { min: repMin, max: repMax, center, size },
            imageBounds: { center: { x: (left + right) / 2, y: (top + bottom) / 2 }, size: { x: right - left, y: bottom - top } },
        });
    }
    return detections;
}
