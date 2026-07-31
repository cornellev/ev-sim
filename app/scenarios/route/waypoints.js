import { pointFrom } from "./geometry.js";
import { deterministicHash } from "./hash.js";

function uniqueId(candidate, index, seen) {
    const base = String(candidate || `waypoint-${index + 1}`).trim() || `waypoint-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (seen.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
    }
    seen.add(id);
    return id;
}

export function normalizeWaypoint(value, index, count, seenIds = new Set()) {
    const point = pointFrom(value, { x: 0, y: 0, z: 0 });
    const kind = index === 0 ? "start" : index === count - 1 ? "finish" : "intermediate";
    const normalized = {
        ...(value && typeof value === "object" ? value : {}),
        id: uniqueId(value?.id, index, seenIds),
        kind,
        order: index,
        number: index,
        x: point.x,
        y: point.y,
        z: point.z,
        position: { ...point },
    };
    if (kind === "start") normalized.label = value?.label || "Start";
    if (kind === "finish") normalized.label = value?.label || "Finish";
    return normalized;
}

/** Keep endpoint roles fixed and renumber all intermediate waypoints. */
export function normalizeWaypoints(values = []) {
    const list = Array.isArray(values) ? values : values?.waypoints ?? [];
    const seenIds = new Set();
    return list.map((value, index) => normalizeWaypoint(value, index, list.length, seenIds));
}

export const renumberWaypoints = normalizeWaypoints;

function waypointIndex(waypoints, waypointOrIndex) {
    if (Number.isInteger(waypointOrIndex)) return waypointOrIndex;
    return waypoints.findIndex((waypoint) => waypoint.id === waypointOrIndex);
}

export function reorderWaypoint(values, waypointOrIndex, targetNumber) {
    const waypoints = normalizeWaypoints(values);
    if (waypoints.length <= 2) return waypoints;
    const fromIndex = waypointIndex(waypoints, waypointOrIndex);
    if (fromIndex <= 0 || fromIndex >= waypoints.length - 1) return waypoints;
    const toIndex = Math.max(1, Math.min(waypoints.length - 2, Math.trunc(Number(targetNumber) || 1)));
    if (fromIndex === toIndex) return waypoints;
    const result = [...waypoints];
    const [moved] = result.splice(fromIndex, 1);
    result.splice(toIndex, 0, moved);
    return normalizeWaypoints(result);
}

export const updateWaypointNumber = reorderWaypoint;

export function removeWaypoint(values, waypointOrIndex, options = {}) {
    const waypoints = normalizeWaypoints(values);
    const index = waypointIndex(waypoints, waypointOrIndex);
    if (index < 0) return waypoints;
    const endpoint = index === 0 || index === waypoints.length - 1;
    if (endpoint && options.allowEndpoints !== true) return waypoints;
    return normalizeWaypoints(waypoints.filter((_, candidateIndex) => candidateIndex !== index));
}

export const removeWaypointById = removeWaypoint;

export function hashWaypoints(values) {
    return deterministicHash(normalizeWaypoints(values).map((waypoint) => ({
        ...pointFrom(waypoint, { x: waypoint.x, y: waypoint.y, z: waypoint.z }),
        id: waypoint.id,
        kind: waypoint.kind,
        order: waypoint.order,
    })));
}
