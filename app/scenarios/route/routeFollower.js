/**
 * Built-in bicycle Pure Pursuit command for scenario route-follower.
 * Operates on a follow polyline (typically filleted); plant steering is positive right.
 */

import {
    buildArcLengthPolyline,
    distanceXZ,
    finiteNumber,
    normalizeAngle,
    pointFrom,
    projectPointToPolyline,
} from "./geometry.js";
import {
    FOLLOW_PATH_DEFAULT_KINEMATICS,
    pointAtDistance,
} from "./followPath.js";

const EPSILON = 1e-9;
const LOOKAHEAD_GAIN = 0.6;
const LOOKAHEAD_MIN_M = 4;
const LOOKAHEAD_MAX_M = 12;
const CURVATURE_PREVIEW_MIN_M = 12;
const CURVATURE_SPEED_GAIN = 1.2;
const MIN_TURN_SPEED_MPS = 0.35;
const STOP_DISTANCE_M = 0.15;
/** Allow a little backward jitter, but never snap to an earlier overlapping visit. */
const PROGRESS_SLACK_M = 0.75;

export function resolveFollowerKinematics(candidates = []) {
    for (const source of candidates) {
        if (!source || typeof source !== "object") continue;
        const wheelbase = finiteNumber(source.wheelbase, NaN);
        const maxSteeringAngle = finiteNumber(source.maxSteeringAngle, NaN);
        if (wheelbase > EPSILON && maxSteeringAngle > EPSILON) {
            return {
                wheelbase,
                maxSteeringAngle: Math.min(Math.PI * 0.49, maxSteeringAngle),
            };
        }
    }
    return { ...FOLLOW_PATH_DEFAULT_KINEMATICS };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Peak absolute path curvature |dθ/ds| over [fromDistance, fromDistance + horizon].
 */
export function previewPathCurvature(points, fromDistance, horizonMeters) {
    const arc = buildArcLengthPolyline(points);
    if (arc.polyline.length < 2 || arc.totalLength <= EPSILON) return 0;
    const start = Math.max(0, finiteNumber(fromDistance, 0));
    const end = Math.min(arc.totalLength, start + Math.max(EPSILON, finiteNumber(horizonMeters, CURVATURE_PREVIEW_MIN_M)));
    if (end <= start + EPSILON) return 0;

    let peak = 0;
    for (let index = 0; index < arc.polyline.length - 1; index += 1) {
        const segStart = arc.cumulativeDistances[index];
        const segEnd = arc.cumulativeDistances[index + 1];
        if (segEnd < start - EPSILON || segStart > end + EPSILON) continue;
        const a = arc.polyline[index];
        const b = arc.polyline[index + 1];
        const ds = Math.hypot(b.x - a.x, b.z - a.z);
        if (ds <= EPSILON) continue;
        let nextHeading;
        if (index + 2 < arc.polyline.length) {
            const c = arc.polyline[index + 2];
            nextHeading = Math.atan2(c.x - b.x, c.z - b.z);
        } else {
            nextHeading = Math.atan2(b.x - a.x, b.z - a.z);
        }
        const heading = Math.atan2(b.x - a.x, b.z - a.z);
        const dYaw = Math.abs(normalizeAngle(nextHeading - heading));
        // Curvature of the vertex at b, attributed to the outbound segment length.
        const kappa = dYaw / Math.max(ds, EPSILON);
        if (kappa > peak) peak = kappa;
    }
    return peak;
}

/**
 * Pure Pursuit + curvature-limited speed.
 * @returns {{ speedMps: number, steeringRad: number, lookaheadM: number, alpha: number, kappa: number }}
 */
export function routeFollowerCommand({
    position,
    yaw,
    cruiseSpeedMps = 0,
    achievedSpeedMps = null,
    followPolyline = [],
    kinematics = FOLLOW_PATH_DEFAULT_KINEMATICS,
    minDistanceAlong = null,
} = {}) {
    const pose = pointFrom(position);
    const cruise = finiteNumber(cruiseSpeedMps, 0);
    const limits = resolveFollowerKinematics([kinematics, FOLLOW_PATH_DEFAULT_KINEMATICS]);
    const polyline = Array.isArray(followPolyline) ? followPolyline : [];
    const arc = buildArcLengthPolyline(polyline);

    if (!pose || arc.polyline.length === 0) {
        return { speedMps: 0, steeringRad: 0, lookaheadM: LOOKAHEAD_MIN_M, alpha: 0, kappa: 0, distanceAlong: 0 };
    }

    const end = arc.polyline[arc.polyline.length - 1];
    const remainingToEnd = arc.totalLength - Math.max(0, finiteNumber(minDistanceAlong, 0));
    const remaining = Math.min(distanceXZ(pose, end), remainingToEnd);
    if (remaining <= STOP_DISTANCE_M || arc.totalLength <= EPSILON) {
        return { speedMps: 0, steeringRad: 0, lookaheadM: LOOKAHEAD_MIN_M, alpha: 0, kappa: 0, distanceAlong: arc.totalLength };
    }

    const forwardMin = Number.isFinite(minDistanceAlong)
        ? minDistanceAlong - PROGRESS_SLACK_M
        : Number.NEGATIVE_INFINITY;
    const projection = projectPointToPolyline(pose, arc.polyline, {
        minDistanceAlong: forwardMin,
    });
    const along = finiteNumber(projection?.distanceAlong, 0);
    const speedHint = Math.abs(finiteNumber(
        achievedSpeedMps == null ? cruise : achievedSpeedMps,
        cruise,
    ));
    const lookaheadM = clamp(LOOKAHEAD_GAIN * Math.max(speedHint, Math.abs(cruise)), LOOKAHEAD_MIN_M, LOOKAHEAD_MAX_M);
    const target = pointAtDistance(arc.polyline, along + lookaheadM) ?? end;

    const dx = finiteNumber(target.x) - pose.x;
    const dz = finiteNumber(target.z) - pose.z;
    // Plant convention (matches ScenarioRuntime spawn / legacy follower).
    const desiredYaw = -Math.atan2(dz, dx);
    const alpha = normalizeAngle(desiredYaw - finiteNumber(yaw, 0));
    const wheelbase = limits.wheelbase;
    const rawSteer = Math.atan2(2 * wheelbase * Math.sin(alpha), lookaheadM);
    const steeringRad = clamp(rawSteer, -limits.maxSteeringAngle, limits.maxSteeringAngle);

    const horizon = Math.max(lookaheadM, CURVATURE_PREVIEW_MIN_M);
    const kappa = previewPathCurvature(arc.polyline, along, horizon);
    let speedMps = cruise;
    if (Math.abs(cruise) > EPSILON && kappa > EPSILON) {
        const limited = CURVATURE_SPEED_GAIN / kappa;
        const signedFloor = Math.sign(cruise) * Math.min(Math.abs(cruise), MIN_TURN_SPEED_MPS);
        speedMps = Math.sign(cruise) * Math.min(Math.abs(cruise), Math.max(Math.abs(signedFloor), limited));
    }

    return {
        speedMps: finiteNumber(speedMps, 0),
        steeringRad: finiteNumber(steeringRad, 0),
        lookaheadM,
        alpha,
        kappa,
        distanceAlong: along,
    };
}

export {
    LOOKAHEAD_GAIN,
    LOOKAHEAD_MIN_M,
    LOOKAHEAD_MAX_M,
    CURVATURE_SPEED_GAIN,
    STOP_DISTANCE_M,
};
