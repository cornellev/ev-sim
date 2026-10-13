import { HeadlessEpisodeError } from "./HeadlessErrors.js";
import { canonicalEpisodeOverrides, initialStateWithStartPose } from "../kernel/SimulationHashes.js";

export { initialStateWithStartPose };

export function episodeOverridesFromSpec(spec = {}) {
    return canonicalEpisodeOverrides(spec.overrides);
}

export function vehicleCorners(position, yaw, size) {
    const forward = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const right = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const halfLength = Number(size?.x || 0) / 2;
    const halfWidth = Number(size?.z || 0) / 2;
    return [-1, 1].flatMap((along) => [-1, 1].map((across) => ({
        x: position.x + along * halfLength * forward.x + across * halfWidth * right.x,
        z: position.z + along * halfLength * forward.z + across * halfWidth * right.z,
    })));
}

function ring(points) {
    return (points || []).map((point) => ({ x: Number(point.x) || 0, z: Number(point.z) || 0 }));
}

function pointInRing(point, polygon) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const current = polygon[index];
        const prior = polygon[previous];
        const crosses = (current.z > point.z) !== (prior.z > point.z)
            && point.x < ((prior.x - current.x) * (point.z - current.z)) / ((prior.z - current.z) || Number.EPSILON) + current.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

function pointInTriangle(point, a, b, c) {
    const cross = (left, right) => left.x * right.z - left.z * right.x;
    const area = cross({ x: b.x - a.x, z: b.z - a.z }, { x: c.x - a.x, z: c.z - a.z });
    if (Math.abs(area) <= 1e-12) return false;
    const signs = [
        cross({ x: b.x - a.x, z: b.z - a.z }, { x: point.x - a.x, z: point.z - a.z }),
        cross({ x: c.x - b.x, z: c.z - b.z }, { x: point.x - b.x, z: point.z - b.z }),
        cross({ x: a.x - c.x, z: a.z - c.z }, { x: point.x - c.x, z: point.z - c.z }),
    ];
    return area > 0 ? signs.every((value) => value >= -1e-9) : signs.every((value) => value <= 1e-9);
}

function obstacleRings(description) {
    return (description?.obstacles || []).map((obstacle) => {
        if (Array.isArray(obstacle.footprint) && obstacle.footprint.length >= 3) return ring(obstacle.footprint);
        const min = obstacle.bounds?.min;
        const max = obstacle.bounds?.max;
        if (!min || !max) return null;
        return [
            { x: min.x, z: min.z },
            { x: max.x, z: min.z },
            { x: max.x, z: max.z },
            { x: min.x, z: max.z },
        ];
    }).filter((polygon) => polygon && polygon.length >= 3);
}

function drivableTriangles(description) {
    const triangles = [];
    for (const surface of description?.drivableSurfaces || []) {
        const vertices = ring(surface.vertices || surface.footprint);
        const raw = surface.indices || surface.triangles || [];
        const faces = Array.isArray(raw[0]) ? raw : [];
        if (!faces.length && raw.length >= 3 && Number.isInteger(raw[0])) {
            for (let index = 0; index + 2 < raw.length; index += 3) faces.push([raw[index], raw[index + 1], raw[index + 2]]);
        }
        if (!faces.length && vertices.length >= 3) {
            for (let index = 1; index < vertices.length - 1; index += 1) faces.push([0, index, index + 1]);
        }
        for (const face of faces) {
            const [a, b, c] = face;
            if (vertices[a] && vertices[b] && vertices[c]) triangles.push([vertices[a], vertices[b], vertices[c]]);
        }
    }
    return triangles;
}

function polygonsOverlap(left, right) {
    if (left.some((point) => pointInRing(point, right)) || right.some((point) => pointInRing(point, left))) return true;
    const side = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    const segments = (ringPoints) => ringPoints.map((point, index) => [point, ringPoints[(index + 1) % ringPoints.length]]);
    return segments(left).some(([a, b]) => segments(right).some(([c, d]) => (
        side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
    )));
}

export function assertStartPoseClear(resolvedRun, startPose) {
    const description = resolvedRun?.world?.description;
    const egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
    const vehicle = (resolvedRun?.vehicles || []).find((entry) => entry.actorId === egoId) ?? resolvedRun?.vehicles?.[0];
    const size = vehicle?.manifest?.boundingBox?.size;
    if (!size) {
        throw new HeadlessEpisodeError("BUNDLE_INVALID", "A start pose override requires the ego footprint.");
    }
    const corners = vehicleCorners(startPose, startPose.yaw, size);
    const blocked = obstacleRings(description).some((polygon) => polygonsOverlap(corners, polygon));
    if (blocked) {
        throw new HeadlessEpisodeError("INVALID_REQUEST", "The start pose overlaps an obstacle.");
    }
    const triangles = drivableTriangles(description);
    if (triangles.length === 0) {
        throw new HeadlessEpisodeError("INVALID_REQUEST", "The start pose is outside the drivable surface.");
    }
    const inside = corners.every((corner) => triangles.some(([a, b, c]) => pointInTriangle(corner, a, b, c)));
    if (!inside) {
        throw new HeadlessEpisodeError("INVALID_REQUEST", "The start pose leaves the drivable surface.");
    }
}

export function goalReached(pose, goal) {
    if (!pose || !goal) return false;
    const distance = Math.hypot(pose.x - goal.x, pose.z - goal.z);
    if (distance > goal.positionToleranceM) return false;
    if (goal.yaw == null || !Number.isFinite(goal.yaw)) return true;
    const delta = Math.atan2(Math.sin(pose.yaw - goal.yaw), Math.cos(pose.yaw - goal.yaw));
    return Math.abs(delta) <= goal.yawToleranceRad;
}
