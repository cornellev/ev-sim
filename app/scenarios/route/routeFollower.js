/**
 * Built-in bicycle Pure Pursuit command for scenario route-follower.
 * Operates on a follow polyline (typically filleted); plant steering is positive left.
 */

import {
    buildArcLengthPolyline,
    distanceXZ,
    finiteNumber,
    normalizeAngle,
    pointFrom,
    projectPointToPolyline,
} from "./geometry.js";
import { clamp } from "../../math/linalg.js";
import {
    FOLLOW_DISTANCE_METRIC,
    FOLLOW_PATH_DEFAULT_KINEMATICS,
    pointAtDistance,
} from "./followPath.js";

const EPSILON = 1e-9;
const LOOKAHEAD_GAIN = 0.6;
/** Straight-approach aim distance, also the "near the finish" stop window. */
const LOOKAHEAD_MIN_M = 4;
const LOOKAHEAD_MAX_M = 12;
/** Do not aim closer than this, even when the chord is cutting a bend. */
const LOOKAHEAD_CURVE_FLOOR_M = 0.8;
/** Shrink the aim point when the path leaves its chord by more than this. */
const CHORD_LATERAL_BUDGET_M = 0.35;
/**
 * Upcoming bend used to shorten the aim point. A 4 m chord through a shallow
 * hook can still sit inside the lateral budget, so curvature over this window
 * pulls the aim point in before the car is committed to the chord.
 */
const LOOKAHEAD_CURVATURE_HORIZON_M = 4;
/** Aim distance ≈ this / κ, then clamped to the speed window and the curve floor. */
const LOOKAHEAD_CURVATURE_GAIN = 1.2;
const CURVATURE_PREVIEW_MIN_M = 12;
/** Heading change is measured over this length so one short sample cannot set κ. */
const CURVATURE_BASELINE_M = 1;
const CURVATURE_MIN_SPAN_M = 0.5;
const CURVATURE_SPEED_GAIN = 1.2;
const MIN_TURN_SPEED_MPS = 0.35;
const STOP_DISTANCE_M = 0.15;
/** Allow a little backward jitter, but never snap to an earlier overlapping visit. */
const PROGRESS_SLACK_M = 0.75;
/** Cap how far ahead projection may jump (blocks later overlapping visits). */
const PROGRESS_FORWARD_WINDOW_M = Math.max(LOOKAHEAD_MAX_M * 2, 24);

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

function lineDistanceXZ(point, start, end) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (length <= EPSILON) return distanceXZ(point, start);
    return Math.abs((point.x - start.x) * dz - (point.z - start.z) * dx) / length;
}

/**
 * How far the polyline between two arc positions leaves the chord that joins them.
 * A straight approach stays near zero; a weave or a corner cut grows with lookahead.
 */
function chordDeviation(arc, origin, fromDistance, lookahead) {
    const endDistance = Math.min(arc.totalLength, fromDistance + Math.max(0, finiteNumber(lookahead, 0)));
    if (endDistance <= fromDistance + EPSILON) return 0;
    const start = origin ?? pointAtDistance(arc.polyline, fromDistance, arc);
    const end = pointAtDistance(arc.polyline, endDistance, arc);
    if (!start || !end) return 0;
    let peak = 0;
    for (let index = 0; index < arc.polyline.length; index += 1) {
        const distance = arc.cumulativeDistances[index];
        if (distance <= fromDistance + EPSILON) continue;
        if (distance >= endDistance - EPSILON) break;
        const deviation = lineDistanceXZ(arc.polyline[index], start, end);
        if (deviation > peak) peak = deviation;
    }
    return peak;
}

/**
 * Longest lookahead in [floor, requested] whose path chord stays inside the lateral budget.
 */
function fitChordLookahead(arc, origin, fromDistance, requested, floor) {
    const upper = Math.max(0, finiteNumber(requested, 0));
    const lower = Math.min(Math.max(0, finiteNumber(floor, 0)), upper);
    if (upper <= lower + EPSILON) return upper;
    if (chordDeviation(arc, origin, fromDistance, upper) <= CHORD_LATERAL_BUDGET_M) return upper;
    if (chordDeviation(arc, origin, fromDistance, lower) > CHORD_LATERAL_BUDGET_M) return lower;
    let lo = lower;
    let hi = upper;
    for (let step = 0; step < 12; step += 1) {
        const mid = (lo + hi) / 2;
        if (chordDeviation(arc, origin, fromDistance, mid) <= CHORD_LATERAL_BUDGET_M) lo = mid;
        else hi = mid;
    }
    return lo;
}

function pathHeading(arc, distance) {
    const span = 0.25;
    let from = Math.max(0, Math.min(arc.totalLength, finiteNumber(distance, 0)));
    let to = from + span;
    if (to > arc.totalLength) {
        to = arc.totalLength;
        from = Math.max(0, to - span);
    }
    if (to <= from + EPSILON) return 0;
    const start = pointAtDistance(arc.polyline, from, arc);
    const end = pointAtDistance(arc.polyline, to, arc);
    if (!start || !end) return 0;
    return Math.atan2(end.x - start.x, end.z - start.z);
}

/**
 * Peak |dθ/ds| over [fromDistance, fromDistance + horizon], measured on a ~1 m baseline.
 */
export function previewPathCurvature(points, fromDistance, horizonMeters, arc = null) {
    const resolved = arc ?? buildArcLengthPolyline(points, FOLLOW_DISTANCE_METRIC);
    if (resolved.polyline.length < 2 || resolved.totalLength <= EPSILON) return 0;
    const start = Math.max(0, finiteNumber(fromDistance, 0));
    const end = Math.min(resolved.totalLength, start + Math.max(EPSILON, finiteNumber(horizonMeters, CURVATURE_PREVIEW_MIN_M)));
    const span = end - start;
    if (span < CURVATURE_MIN_SPAN_M) return 0;

    const window = Math.min(CURVATURE_BASELINE_M, span);
    const step = Math.max(window * 0.5, EPSILON);
    let peak = 0;
    for (let distance = start; distance <= end - window + EPSILON; distance += step) {
        const dYaw = Math.abs(normalizeAngle(pathHeading(resolved, distance + window) - pathHeading(resolved, distance)));
        const kappa = dYaw / window;
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
    const arc = buildArcLengthPolyline(polyline, FOLLOW_DISTANCE_METRIC);

    if (!pose || arc.polyline.length === 0) {
        return { speedMps: 0, steeringRad: 0, lookaheadM: LOOKAHEAD_MIN_M, alpha: 0, kappa: 0, distanceAlong: 0 };
    }

    const end = arc.polyline[arc.polyline.length - 1];
    if (arc.totalLength <= EPSILON) {
        return { speedMps: 0, steeringRad: 0, lookaheadM: LOOKAHEAD_MIN_M, alpha: 0, kappa: 0, distanceAlong: arc.totalLength };
    }

    const forwardMin = Number.isFinite(minDistanceAlong)
        ? minDistanceAlong - PROGRESS_SLACK_M
        : Number.NEGATIVE_INFINITY;
    const forwardMax = Number.isFinite(minDistanceAlong)
        ? minDistanceAlong + PROGRESS_FORWARD_WINDOW_M
        : Number.POSITIVE_INFINITY;
    const projection = projectPointToPolyline(pose, arc.polyline, {
        minDistanceAlong: forwardMin,
        maxDistanceAlong: forwardMax,
        distanceMetric: FOLLOW_DISTANCE_METRIC,
        arc,
    });
    const along = finiteNumber(projection?.distanceAlong, 0);
    const remainingAlong = arc.totalLength - along;
    // Stop from arc remaining (and proximity to the path end point), never
    // Euclidean-to-end alone — that false-stops when the finish overlaps an earlier visit.
    if (remainingAlong <= STOP_DISTANCE_M
        || (remainingAlong <= LOOKAHEAD_MIN_M && distanceXZ(pose, end) <= STOP_DISTANCE_M)) {
        return { speedMps: 0, steeringRad: 0, lookaheadM: LOOKAHEAD_MIN_M, alpha: 0, kappa: 0, distanceAlong: arc.totalLength };
    }

    const speedHint = Math.abs(finiteNumber(
        achievedSpeedMps == null ? cruise : achievedSpeedMps,
        cruise,
    ));
    const speedLookahead = clamp(LOOKAHEAD_GAIN * Math.max(speedHint, Math.abs(cruise)), LOOKAHEAD_MIN_M, LOOKAHEAD_MAX_M);
    const curveFloor = Math.min(speedLookahead, Math.max(LOOKAHEAD_CURVE_FLOOR_M, limits.wheelbase));
    const upcomingKappa = previewPathCurvature(arc.polyline, along, LOOKAHEAD_CURVATURE_HORIZON_M, arc);
    const curvatureLookahead = upcomingKappa > EPSILON
        ? LOOKAHEAD_CURVATURE_GAIN / upcomingKappa
        : speedLookahead;
    const requestedLookahead = Math.min(speedLookahead, Math.max(curveFloor, curvatureLookahead));
    const pathPoint = pointAtDistance(arc.polyline, along, arc) ?? pose;
    const lookaheadM = fitChordLookahead(arc, pathPoint, along, requestedLookahead, curveFloor);
    const target = pointAtDistance(arc.polyline, along + lookaheadM, arc) ?? end;

    const dx = finiteNumber(target.x) - pose.x;
    const dz = finiteNumber(target.z) - pose.z;
    // Plant convention (matches ScenarioRuntime spawn / legacy follower).
    const desiredYaw = -Math.atan2(dz, dx);
    const alpha = normalizeAngle(desiredYaw - finiteNumber(yaw, 0));
    const wheelbase = limits.wheelbase;
    const rawSteer = Math.atan2(2 * wheelbase * Math.sin(alpha), lookaheadM);
    const steeringRad = clamp(rawSteer, -limits.maxSteeringAngle, limits.maxSteeringAngle);

    const horizon = Math.max(lookaheadM, CURVATURE_PREVIEW_MIN_M);
    const kappa = previewPathCurvature(arc.polyline, along, horizon, arc);
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
