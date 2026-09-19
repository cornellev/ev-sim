import { vehicleForwardTangent } from "../scenarios/route/geometry.js";

export const DEFAULT_HEADING_WEDGE_LENGTH = 1.4;

function distancePointToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lenSq = dx * dx + dz * dz;
    if (lenSq <= Number.EPSILON) {
        const ox = point.x - start.x;
        const oz = point.z - start.z;
        return Math.hypot(ox, oz);
    }
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lenSq));
    const px = start.x + t * dx;
    const pz = start.z + t * dz;
    return Math.hypot(point.x - px, point.z - pz);
}

function toPoint(sample) {
    const position = sample.position || sample.value?.position || {};
    return {
        x: Number(position.x) || 0,
        z: Number(position.z) || 0,
        timeUs: Number(sample.timeUs) || 0,
        cycle: Number(sample.cycle) || 0,
        position: {
            x: Number(position.x) || 0,
            y: Number(position.y) || 0,
            z: Number(position.z) || 0,
        },
        rotation: sample.rotation || sample.value?.rotation || { x: 0, y: 0, z: 0, order: "XYZ" },
    };
}

function douglasPeucker(samples, epsilon) {
    if (samples.length <= 2) return samples;
    const start = toPoint(samples[0]);
    const end = toPoint(samples.at(-1));
    let maxDistance = 0;
    let index = 0;
    for (let i = 1; i < samples.length - 1; i += 1) {
        const point = toPoint(samples[i]);
        const distance = distancePointToSegment(point, start, end);
        if (distance > maxDistance) {
            maxDistance = distance;
            index = i;
        }
    }
    if (maxDistance <= epsilon) return [samples[0], samples.at(-1)];
    const left = douglasPeucker(samples.slice(0, index + 1), epsilon);
    const right = douglasPeucker(samples.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
}

/**
 * Geometry-preserving trajectory simplification for map overlays.
 * Retains original timestamps from kept samples; never uses scalar min/max downsampling.
 */
export function simplifyTrajectory(samples, maxPoints = 2000) {
    const limit = Math.max(2, Math.floor(Number(maxPoints) || 2));
    if (!Array.isArray(samples) || samples.length <= limit) {
        return (samples || []).map((sample) => toPoint(sample));
    }

    let epsilon = 0.01;
    let simplified = samples;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        simplified = douglasPeucker(samples, epsilon);
        if (simplified.length <= limit) break;
        epsilon *= 1.8;
    }

    if (simplified.length <= limit) {
        return simplified.map((sample) => toPoint(sample));
    }

    const normalized = simplified.map((sample) => toPoint(sample));
    const stride = Math.ceil(normalized.length / (limit - 1));
    const result = normalized.filter((_sample, index) => index % stride === 0).slice(0, limit - 1);
    const last = normalized.at(-1);
    if (result.at(-1)?.timeUs !== last?.timeUs) result.push(last);
    return result.slice(0, limit);
}

export function poseSampleFromValue(timeUs, cycle, value) {
    if (!value?.position) return null;
    return {
        timeUs,
        cycle,
        position: {
            x: Number(value.position.x) || 0,
            y: Number(value.position.y) || 0,
            z: Number(value.position.z) || 0,
        },
        rotation: {
            x: Number(value.rotation?.x) || 0,
            y: Number(value.rotation?.y) || 0,
            z: Number(value.rotation?.z) || 0,
            order: value.rotation?.order || "XYZ",
        },
    };
}

export function headingFromPose(pose) {
    const yaw = Number(pose?.rotation?.y) || 0;
    return yaw;
}

export function worldPointFromPose(pose) {
    return {
        x: Number(pose?.position?.x) || 0,
        z: Number(pose?.position?.z) || 0,
    };
}

/** Offset a map XZ point along plant-forward yaw (local +X, z = -sin(yaw)). */
export function offsetByVehicleYaw(origin, yaw, length) {
    const tangent = vehicleForwardTangent(yaw);
    return {
        x: (Number(origin?.x) || 0) + tangent.x * length,
        z: (Number(origin?.z) || 0) + tangent.z * length,
    };
}

/**
 * Cursor wedge vertices in world XZ, matching bicycle-plant forward.
 * Tip is along yaw; wings are ±2.4 rad from that heading.
 */
export function headingWedgeWorldPoints(origin, heading, length = DEFAULT_HEADING_WEDGE_LENGTH) {
    return {
        tip: offsetByVehicleYaw(origin, heading, length),
        left: offsetByVehicleYaw(origin, heading + 2.4, length * 0.55),
        right: offsetByVehicleYaw(origin, heading - 2.4, length * 0.55),
    };
}

export function headingWedgeWorldPath(origin, heading, length = DEFAULT_HEADING_WEDGE_LENGTH) {
    const { tip, left, right } = headingWedgeWorldPoints(origin, heading, length);
    return `${tip.x},${tip.z} ${left.x},${left.z} ${right.x},${right.z}`;
}
