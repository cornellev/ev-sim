const VECTOR_KEYS = ["x", "y", "z"];
const ROTATION_KEYS = [...VECTOR_KEYS, "w"];
const POSE_FIELDS = ["position", "rotation", "spawnPosition", "spawnRotation"];

function keysFor(field) {
    return field.endsWith("Rotation") || field === "rotation" ? ROTATION_KEYS : VECTOR_KEYS;
}

function assertPose(pose) {
    for (const field of POSE_FIELDS) {
        const value = pose[field];
        if (value === undefined && field.startsWith("spawn")) continue;
        for (const key of keysFor(field)) {
            if (!Number.isFinite(value?.[key])) throw new TypeError(`Rigid-body pose ${pose.id}.${field}.${key} must be finite.`);
        }
    }
}

function samePose(previous, next) {
    if (!previous || previous.host !== next.host) return false;
    return POSE_FIELDS.every((field) => keysFor(field).every((key) => previous[field]?.[key] === next[field]?.[key]));
}

function snapshotPose(pose, id) {
    const snapshot = { id, ...(pose.host === undefined ? {} : { host: pose.host }) };
    for (const field of POSE_FIELDS) {
        if (pose[field] !== undefined) snapshot[field] = Object.freeze(Object.fromEntries(keysFor(field).map((key) => [key, pose[field][key]])));
    }
    return Object.freeze(snapshot);
}

export class RigidBodyPoseTracker {
    constructor() {
        this.records = new Map();
        this.version = 0;
    }

    sync(poses = []) {
        if (!Array.isArray(poses)) throw new TypeError("Rigid-body poses must be an array.");
        const incoming = new Map();
        for (const pose of poses) {
            if (pose?.id == null || pose.id === "") continue;
            assertPose(pose);
            incoming.set(String(pose.id), pose);
        }
        const changed = new Set();
        for (const id of this.records.keys()) {
            if (!incoming.has(id)) {
                this.records.delete(id);
                this.version += 1;
                changed.add(id);
            }
        }
        for (const [id, pose] of incoming) {
            if (samePose(this.records.get(id)?.pose, pose)) continue;
            this.records.set(id, Object.freeze({ pose: snapshotPose(pose, id), revision: ++this.version }));
            changed.add(id);
        }
        return changed;
    }

    get(id) {
        return this.records.get(String(id))?.pose ?? null;
    }

    revision(id) {
        return this.records.get(String(id))?.revision ?? 0;
    }

    clear() {
        return this.sync([]);
    }
}
