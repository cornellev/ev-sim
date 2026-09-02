/**
 * Runtime-only filleted follow polylines for the built-in route follower.
 * Directed-A* verification polylines stay untouched; fillets are never persisted.
 */

import {
    buildArcLengthPolyline,
    dedupePolyline,
    distanceXZ,
    finiteNumber,
} from "./geometry.js";
import { getRoutePolyline } from "./Route.js";

const EPSILON = 1e-9;
const DEFAULT_WHEELBASE_M = 1.5;
const DEFAULT_MAX_STEERING_RAD = 0.6;
const RADIUS_MARGIN = 1.15;
const MIN_FILLET_RADIUS_M = 0.25;
const DEFAULT_CHORD_M = 0.25;
const COLLINEAR_CROSS_EPS = 1e-8;
/** Cap used only when sizing road fillets — plant maxSteer can be near π/2. */
const FILLET_SIZING_STEER_RAD = DEFAULT_MAX_STEERING_RAD;

export const FOLLOW_PATH_DEFAULT_KINEMATICS = Object.freeze({
    wheelbase: DEFAULT_WHEELBASE_M,
    maxSteeringAngle: DEFAULT_MAX_STEERING_RAD,
});

/**
 * Minimum turning radius for a bicycle model: L / tan(δ_max).
 * δ_max is clamped below π/2 so tan stays finite.
 */
export function minTurningRadius(kinematics = {}) {
    const wheelbase = Math.max(Number.EPSILON, finiteNumber(kinematics.wheelbase, DEFAULT_WHEELBASE_M));
    const maxSteer = Math.min(
        Math.PI * 0.49,
        Math.max(Number.EPSILON, finiteNumber(kinematics.maxSteeringAngle, DEFAULT_MAX_STEERING_RAD)),
    );
    return wheelbase / Math.tan(maxSteer);
}

/**
 * Follow-path fillet radius with a small margin for steer-rate lag.
 * Uses a road-scale steer budget (≤ ~0.6 rad), not the plant emergency max —
 * otherwise big-car (δ≈0.49π) collapses R to centimeters and skips every fillet.
 */
export function followRadiusM(kinematics = {}) {
    const wheelbase = Math.max(Number.EPSILON, finiteNumber(kinematics.wheelbase, DEFAULT_WHEELBASE_M));
    const plantMax = Math.max(
        Number.EPSILON,
        finiteNumber(kinematics.maxSteeringAngle, DEFAULT_MAX_STEERING_RAD),
    );
    const sizingSteer = Math.min(FILLET_SIZING_STEER_RAD, plantMax, Math.PI * 0.49);
    return (wheelbase / Math.tan(sizingSteer)) * RADIUS_MARGIN;
}

function unitXZ(dx, dz) {
    const length = Math.hypot(dx, dz);
    if (length <= EPSILON) return null;
    return { x: dx / length, z: dz / length, length };
}

function sampleArc(center, startAngle, sweep, radius, y, chordM) {
    const absSweep = Math.abs(sweep);
    if (absSweep <= EPSILON || radius <= EPSILON) return [];
    const step = Math.max(1, Math.ceil((radius * absSweep) / Math.max(chordM, EPSILON)));
    const points = [];
    for (let index = 1; index < step; index += 1) {
        const t = index / step;
        const angle = startAngle + sweep * t;
        points.push({
            x: center.x + Math.cos(angle) * radius,
            y,
            z: center.z + Math.sin(angle) * radius,
        });
    }
    return points;
}

/**
 * Replace sharp polyline vertices with circular fillets in the XZ plane.
 * Endpoints are preserved. Collinear vertices and over-constrained short
 * segments fall back to the original vertex.
 */
export function filletPolyline(points, radius, options = {}) {
    const chordM = Math.max(EPSILON, finiteNumber(options.chordM, DEFAULT_CHORD_M));
    const requestedRadius = Math.max(0, finiteNumber(radius, 0));
    const polyline = dedupePolyline(points);
    if (polyline.length < 3 || requestedRadius <= EPSILON) {
        return polyline.map((point) => ({ ...point }));
    }

    const result = [{ ...polyline[0] }];

    for (let index = 1; index < polyline.length - 1; index += 1) {
        const previous = polyline[index - 1];
        const current = polyline[index];
        const next = polyline[index + 1];
        const inbound = unitXZ(current.x - previous.x, current.z - previous.z);
        const outbound = unitXZ(next.x - current.x, next.z - current.z);
        if (!inbound || !outbound) {
            result.push({ ...current });
            continue;
        }

        // Signed cross in XZ: positive means a left turn in plant coordinates.
        const cross = inbound.x * outbound.z - inbound.z * outbound.x;
        const dot = Math.max(-1, Math.min(1, inbound.x * outbound.x + inbound.z * outbound.z));
        if (Math.abs(cross) <= COLLINEAR_CROSS_EPS) {
            result.push({ ...current });
            continue;
        }

        const turnAngle = Math.acos(dot);
        if (turnAngle <= EPSILON || Math.PI - turnAngle <= EPSILON) {
            result.push({ ...current });
            continue;
        }

        const halfTurn = turnAngle * 0.5;
        const tanHalf = Math.tan(halfTurn);
        if (tanHalf <= EPSILON) {
            result.push({ ...current });
            continue;
        }

        const maxTangent = Math.min(inbound.length, outbound.length) * 0.5;
        let fitRadius = Math.min(requestedRadius, maxTangent / tanHalf);
        if (fitRadius < MIN_FILLET_RADIUS_M) {
            result.push({ ...current });
            continue;
        }

        const tangentLength = fitRadius * tanHalf;
        const entry = {
            x: current.x - inbound.x * tangentLength,
            y: current.y,
            z: current.z - inbound.z * tangentLength,
        };
        const exit = {
            x: current.x + outbound.x * tangentLength,
            y: current.y,
            z: current.z + outbound.z * tangentLength,
        };

        // Center sits R along the inward normal of the inbound tangent.
        const sign = cross > 0 ? 1 : -1;
        const normal = { x: -inbound.z * sign, z: inbound.x * sign };
        const center = {
            x: entry.x + normal.x * fitRadius,
            z: entry.z + normal.z * fitRadius,
        };

        const startAngle = Math.atan2(entry.z - center.z, entry.x - center.x);
        // Sweep magnitude equals the path turn angle; sign matches the cross product.
        const sweep = sign > 0 ? turnAngle : -turnAngle;

        result.push(entry);
        for (const sample of sampleArc(center, startAngle, sweep, fitRadius, current.y, chordM)) {
            result.push(sample);
        }
        result.push(exit);
    }

    result.push({ ...polyline[polyline.length - 1] });
    return dedupePolyline(result);
}

/**
 * Build a filleted follow polyline from a verified (or raw) route.
 * Does not mutate route.verification.
 */
export function followPolylineFromRoute(route, kinematics = FOLLOW_PATH_DEFAULT_KINEMATICS) {
    const source = getRoutePolyline(route);
    if (source.length < 2) return source.map((point) => ({ ...point }));
    return filletPolyline(source, followRadiusM(kinematics));
}

/** Arc-length summary of a follow polyline (for tests and diagnostics). */
export function followPathLength(points) {
    return buildArcLengthPolyline(points).totalLength;
}

/** True when two polylines share the same endpoints within epsilon. */
export function sameEndpoints(left, right, epsilon = 1e-6) {
    const a = dedupePolyline(left);
    const b = dedupePolyline(right);
    if (a.length === 0 || b.length === 0) return a.length === b.length;
    return distanceXZ(a[0], b[0]) <= epsilon && distanceXZ(a.at(-1), b.at(-1)) <= epsilon;
}

export function pointAtDistance(points, distanceMeters) {
    const arc = buildArcLengthPolyline(points);
    if (arc.polyline.length === 0) return null;
    if (arc.polyline.length === 1 || arc.totalLength <= EPSILON) {
        return { ...arc.polyline[0], distance: 0, progress: 1, segment: 0 };
    }
    const target = Math.max(0, Math.min(arc.totalLength, finiteNumber(distanceMeters, 0)));
    let segment = arc.polyline.length - 2;
    for (let index = 0; index < arc.cumulativeDistances.length - 1; index += 1) {
        if (target <= arc.cumulativeDistances[index + 1] + EPSILON) {
            segment = index;
            break;
        }
    }
    const start = arc.polyline[segment];
    const end = arc.polyline[segment + 1];
    const startDistance = arc.cumulativeDistances[segment];
    const segmentLength = arc.cumulativeDistances[segment + 1] - startDistance;
    const t = segmentLength <= EPSILON ? 0 : (target - startDistance) / segmentLength;
    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
        distance: target,
        progress: arc.totalLength <= EPSILON ? 1 : target / arc.totalLength,
        segment,
    };
}
