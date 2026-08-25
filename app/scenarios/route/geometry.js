const EPSILON = 1e-9;

export function finiteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function pointFrom(value, fallback = null) {
    if (!value || typeof value !== "object") return fallback;
    const source = value.position && typeof value.position === "object"
        ? value.position
        : value;
    const x = Number(source.x ?? source.longitude ?? source.lon);
    const z = Number(source.z ?? source.latitude ?? source.lat);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return fallback;
    return {
        x,
        y: finiteNumber(source.y ?? source.altitude, 0),
        z,
    };
}

export function clamp01(value) {
    return Math.max(0, Math.min(1, finiteNumber(value, 0)));
}

export function distanceXZ(left, right) {
    return Math.hypot(right.x - left.x, right.z - left.z);
}

export function distance3d(left, right) {
    return Math.hypot(
        right.x - left.x,
        finiteNumber(right.y, 0) - finiteNumber(left.y, 0),
        right.z - left.z,
    );
}

export function projectPointToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = finiteNumber(end.y, 0) - finiteNumber(start.y, 0);
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared <= EPSILON
        ? 0
        : clamp01(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared);
    const projected = {
        x: start.x + dx * t,
        y: finiteNumber(start.y, 0) + dy * t,
        z: start.z + dz * t,
    };
    return {
        point: projected,
        t,
        distance: distanceXZ(point, projected),
    };
}

export function dedupePolyline(points, epsilon = 1e-7) {
    const result = [];
    for (const value of points ?? []) {
        const point = pointFrom(value);
        if (!point) continue;
        const previous = result[result.length - 1];
        if (!previous || distance3d(previous, point) > epsilon) {
            result.push(point);
        }
    }
    return result;
}

export function buildArcLengthPolyline(points) {
    const polyline = dedupePolyline(points);
    const cumulativeDistances = [];
    let totalLength = 0;

    polyline.forEach((point, index) => {
        if (index > 0) totalLength += distance3d(polyline[index - 1], point);
        cumulativeDistances.push(totalLength);
    });

    return { polyline, cumulativeDistances, totalLength };
}

export function sampleArcLengthPolyline(points, percent) {
    const arc = buildArcLengthPolyline(points);
    const progress = clamp01(percent);
    if (arc.polyline.length === 0) return null;
    if (arc.polyline.length === 1 || arc.totalLength <= EPSILON) {
        return {
            ...arc.polyline[0],
            heading: 0,
            distance: 0,
            progress,
            segment: 0,
        };
    }

    const targetDistance = progress * arc.totalLength;
    let segment = arc.polyline.length - 2;
    for (let index = 0; index < arc.cumulativeDistances.length - 1; index += 1) {
        if (targetDistance <= arc.cumulativeDistances[index + 1] + EPSILON) {
            segment = index;
            break;
        }
    }

    const start = arc.polyline[segment];
    const end = arc.polyline[segment + 1];
    const startDistance = arc.cumulativeDistances[segment];
    const segmentLength = arc.cumulativeDistances[segment + 1] - startDistance;
    const t = segmentLength <= EPSILON ? 0 : (targetDistance - startDistance) / segmentLength;

    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
        heading: Math.atan2(end.x - start.x, end.z - start.z),
        distance: targetDistance,
        progress,
        segment,
    };
}

export function projectPointToPolyline(value, points) {
    const point = pointFrom(value);
    const arc = buildArcLengthPolyline(points);
    if (!point || arc.polyline.length === 0) return null;
    if (arc.polyline.length === 1) {
        return {
            point: arc.polyline[0],
            distance: distanceXZ(point, arc.polyline[0]),
            distanceAlong: 0,
            progress: 1,
            segment: 0,
            t: 0,
            heading: 0,
            tangent: { x: 1, z: 0 },
        };
    }

    let best = null;
    for (let index = 0; index < arc.polyline.length - 1; index += 1) {
        const projection = projectPointToSegment(point, arc.polyline[index], arc.polyline[index + 1]);
        const segmentLength = arc.cumulativeDistances[index + 1] - arc.cumulativeDistances[index];
        const distanceAlong = arc.cumulativeDistances[index] + projection.t * segmentLength;
        const start = arc.polyline[index];
        const end = arc.polyline[index + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        const tangent = length <= EPSILON
            ? { x: 1, z: 0 }
            : { x: dx / length, z: dz / length };
        const candidate = {
            ...projection,
            distanceAlong,
            progress: arc.totalLength <= EPSILON ? 1 : distanceAlong / arc.totalLength,
            segment: index,
            heading: Math.atan2(dx, dz),
            tangent,
        };
        if (!best
            || candidate.distance < best.distance - EPSILON
            || (Math.abs(candidate.distance - best.distance) <= EPSILON && candidate.distanceAlong < best.distanceAlong)) {
            best = candidate;
        }
    }
    return best;
}

/** Normalize an angle into (-π, π]. */
export function normalizeAngle(value) {
    let result = finiteNumber(value);
    while (result > Math.PI) result -= Math.PI * 2;
    while (result <= -Math.PI) result += Math.PI * 2;
    return result;
}

/**
 * Heading of a vehicle whose local +X is forward and whose yaw is `rotation.y`
 * (matching ManifestVehicle / BigCar). Equals Math.atan2(forward.x, forward.z).
 */
export function vehicleForwardHeading(rotationY) {
    const tangent = vehicleForwardTangent(rotationY);
    return Math.atan2(tangent.x, tangent.z);
}

/**
 * World-space unit forward for a yaw-only vehicle pose (local +X).
 * Matches `new THREE.Vector3(1,0,0).applyEuler(rotation)` on the XZ plane.
 */
export function vehicleForwardTangent(rotationY) {
    const yaw = finiteNumber(rotationY);
    return {
        x: Math.cos(yaw),
        z: -Math.sin(yaw),
    };
}

/** Unit tangent for heading measured as Math.atan2(dx, dz). */
export function headingTangent(heading) {
    const angle = finiteNumber(heading);
    return {
        x: Math.sin(angle),
        z: Math.cos(angle),
    };
}

/**
 * Oriented ground rectangle for a vehicle pose.
 * Size.x is length (local +X), size.z is width (local +Z).
 */
export function vehicleGroundFootprint(pose = {}, size = {}, center = {}) {
    const position = pointFrom(pose?.position ?? pose);
    if (!position) return null;
    const length = Math.max(Number.EPSILON, finiteNumber(size.x, 0));
    const width = Math.max(Number.EPSILON, finiteNumber(size.z, 0));
    if (!(length > 0) || !(width > 0)) return null;
    const yaw = finiteNumber(pose?.rotation?.y ?? pose?.yaw ?? pose?.rotationY, 0);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const cx = finiteNumber(center.x, 0);
    const cz = finiteNumber(center.z, 0);
    const halfL = length / 2;
    const halfW = width / 2;
    const local = [
        { x: cx + halfL, z: cz + halfW },
        { x: cx + halfL, z: cz - halfW },
        { x: cx - halfL, z: cz - halfW },
        { x: cx - halfL, z: cz + halfW },
    ];
    return local.map((corner) => ({
        x: position.x + corner.x * cos + corner.z * sin,
        y: position.y,
        z: position.z - corner.x * sin + corner.z * cos,
    }));
}

