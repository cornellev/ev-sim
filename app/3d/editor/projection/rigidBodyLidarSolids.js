import { RigidBodyPoseTracker } from "../../../simulation/world/RigidBodyPoseTracker.js";
import { rigidBodyPoseMoved } from "../../../simulation/world/RigidBodyRecords.js";

const states = new WeakMap();

function stateFor(data) {
    let state = states.get(data);
    if (!state) {
        state = {
            tracker: new RigidBodyPoseTracker(),
            pending: new Set(),
            applied: new Set(),
            objects: null,
            geometryRevision: -1,
            poses: Object.freeze([]),
        };
        states.set(data, state);
    }
    return state;
}

export function setRigidBodyLidarPoses(data, poses = []) {
    const state = stateFor(data);
    const changed = state.tracker.sync(poses);
    for (const id of changed) state.pending.add(id);
    if (changed.size) state.poses = Object.freeze([...state.tracker.records.values()].map((record) => record.pose));
    return state.poses;
}

export function flushRigidBodyLidarSolids(data) {
    const state = states.get(data);
    const objects = data?.objects?.();
    if (!state || typeof objects?.applyRigidBodyGeometry !== "function") return 0;
    if (state.objects !== objects || state.geometryRevision !== objects.geometryRevision) {
        for (const id of state.tracker.records.keys()) state.pending.add(id);
        for (const id of state.applied) state.pending.add(id);
        state.objects = objects;
        state.geometryRevision = objects.geometryRevision;
    }
    let writes = 0;
    for (const id of state.pending) {
        const pose = state.tracker.get(id);
        if (pose && rigidBodyPoseMoved(pose)) {
            writes += objects.applyRigidBodyGeometry(id, pose);
            state.applied.add(id);
        } else if (state.applied.delete(id)) {
            writes += objects.applyRigidBodyGeometry(id, null);
        }
    }
    state.pending.clear();
    return writes;
}

export function syncRigidBodyLidarSolids(data, poses = null) {
    setRigidBodyLidarPoses(data, poses ?? []);
    return flushRigidBodyLidarSolids(data);
}
