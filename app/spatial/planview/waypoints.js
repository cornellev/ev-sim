import { localToWorld } from "./transform.js";

export const PLAN_WAYPOINTS_TOPIC = "/planning/waypoints";
export const PLAN_WAYPOINTS_TYPE = "sensor_fusion_msgs/WaypointList";
export const PLAN_WAYPOINTS_DEFINITION = "geometry_msgs/Point32[] points\n";

let points = [];
let revision = 0;

function pointOf(entry) {
    const x = Number(entry?.x);
    const z = Number(entry?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x, z };
}

/** `{x,z}[]` or `{ points: [{x,y,z}] }`. `y` is ignored. Non-finite points are dropped. */
export function normalizePlanWaypoints(list) {
    const source = Array.isArray(list) ? list : list?.points;
    if (!Array.isArray(source)) return [];
    return source.map(pointOf).filter(Boolean);
}

export function setPlanWaypoints(list) {
    points = normalizePlanWaypoints(list);
    revision += 1;
    return points;
}

export function getPlanWaypoints() {
    return points;
}

export function planWaypointRevision() {
    return revision;
}

export function clearPlanWaypoints() {
    if (points.length === 0) return;
    points = [];
    revision += 1;
}

/**
 * Map meters, or ego body meters (`+x` forward, `+z` right).
 * Body mode with no ego returns null.
 */
export function waypointWorldPoint(point, ego, mode) {
    const local = pointOf(point);
    if (!local) return null;
    if (mode !== "body") return local;
    const origin = ego?.position;
    if (!origin || !Number.isFinite(Number(origin.x)) || !Number.isFinite(Number(origin.z))) return null;
    return localToWorld(origin, Number(ego.yaw) || 0, local);
}
