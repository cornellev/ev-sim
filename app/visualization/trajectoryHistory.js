import { TRAIL_HISTORY_MODES } from "../spatial/spatialLogModel.js";
import { planActorId } from "../spatial/planview/selection.js";

export const TRAJECTORY_RETENTION_NS = 120_000_000_000;
export const TRAJECTORY_SAMPLE_LIMIT = 10_000;

export function trajectoryTimeNs(value = 0) {
    if (typeof value === "string" && /^\d+$/.test(value)) value = BigInt(value);
    if ((typeof value === "bigint" && value >= 0n) || (Number.isSafeInteger(value) && value >= 0)) return value;
    throw new TypeError("Trajectory time must be nonnegative integer nanoseconds.");
}

export function historyWindowNs(historyMode = "10s") {
    const mode = TRAIL_HISTORY_MODES.find((entry) => entry.id === historyMode);
    if (!mode) throw new TypeError("Unknown trajectory history window.");
    return mode.windowUs == null ? null : mode.windowUs * 1000;
}

function cutoffAt(timeNs, windowNs) {
    return typeof timeNs === "bigint" ? timeNs - BigInt(windowNs) : timeNs - windowNs;
}

export function clipTrail(samples, timeNs, historyMode = "10s") {
    const windowNs = historyWindowNs(historyMode);
    const source = Array.isArray(samples) ? samples : [];
    if (windowNs == null) return source.slice();
    const cutoff = cutoffAt(trajectoryTimeNs(timeNs), windowNs);
    let start = 0;
    while (start < source.length && source[start].timeNs < cutoff) start += 1;
    return source.slice(start);
}

export function pruneTrajectoryHistory(trails, timeNs) {
    const cutoff = cutoffAt(trajectoryTimeNs(timeNs), TRAJECTORY_RETENTION_NS);
    let changed = false;
    for (const samples of trails.values()) {
        let count = 0;
        while (count < samples.length && samples[count].timeNs < cutoff) count += 1;
        count = Math.max(count, samples.length - TRAJECTORY_SAMPLE_LIMIT);
        if (count > 0) { samples.splice(0, count); changed = true; }
    }
    return changed;
}

/** Anchors retain the last sampled pose after its history expires, avoiding stationary re-appends. */
export function appendPlanTrails(trails, vehicles, timeNs, anchors = null) {
    if (!trails) return false;
    timeNs = trajectoryTimeNs(timeNs);
    let changed = false;
    const seen = new Set();
    vehicles.forEach((vehicle, index) => {
        const id = planActorId(vehicle, index);
        seen.add(id);
        const position = vehicle.position ?? {};
        const sample = { x: position.x ?? 0, y: position.y ?? 0, z: position.z ?? 0, timeNs };
        const samples = trails.get(id) ?? [];
        const last = anchors?.get(id) ?? samples.at(-1);
        if (!last || Math.hypot(last.x - sample.x, (last.y ?? 0) - sample.y, last.z - sample.z) > 0.05) {
            samples.push(sample);
            anchors?.set(id, sample);
            changed = true;
        }
        trails.set(id, samples);
    });
    for (const id of trails.keys()) {
        if (seen.has(id)) continue;
        trails.delete(id);
        anchors?.delete(id);
        changed = true;
    }
    return pruneTrajectoryHistory(trails, timeNs) || changed;
}
