/**
 * DOM-free top view of a vehicle manifest on the vehicle-local XZ plane.
 * +X is forward and +Z is left. The SVG mapping puts forward up and left left.
 */

import { deriveCompleteWheelbase } from "../axle/standardAxle.js";
import { deriveWheelbase } from "../VehicleManifest.js";
import { describeTurnGeometry, plantSteeringLimit, simulatorTurn, visualWheelYaws } from "./turnGeometry.js";

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function freeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
}

function diagnostic(code, message) {
    return { code, message };
}

function wheelRecord(wheel) {
    return {
        id: wheel.id,
        side: wheel.side ?? null,
        x: finite(wheel.position?.x),
        z: finite(wheel.position?.z),
        radius: finite(wheel.radius),
        width: finite(wheel.width),
        steerable: wheel.steerable === true,
        locked: wheel.visual?.kind === "model-node",
    };
}

/** Positive yaw is clockwise on the plan, matching SVG's y-down rotation. */
export function planYawDegrees(yaw) {
    const angle = Number(yaw);
    return Number.isFinite(angle) ? angle * (180 / Math.PI) : 0;
}

export function turnDirection(radius) {
    return Number(radius) < 0 ? "left" : "right";
}

function axleRecord(wheels, id) {
    const members = wheels.filter((wheel) => wheel.axle === id);
    if (members.length === 0) return null;
    const left = members.find((wheel) => wheel.side === "left");
    const right = members.find((wheel) => wheel.side === "right");
    const sample = left ?? members[0];
    return {
        id,
        locked: members.some((wheel) => wheel.visual?.kind === "model-node"),
        x: finite(sample.position?.x),
        y: finite(sample.position?.y),
        halfTrack: left && right ? Math.abs(finite(left.position?.z)) : Math.abs(finite(sample.position?.z)),
        radius: finite(sample.radius),
        width: finite(sample.width),
        wheelIds: members.map((wheel) => wheel.id),
        wheels: members.map(wheelRecord),
    };
}

function differs(left, right) {
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) > 1e-6;
}

/** Plan-rectangle corners. Positive yaw rotates +X toward −Z, matching the plant. */
export function wheelPlanCorners(wheel, yaw) {
    const along = finite(wheel.radius);
    const across = finite(wheel.width) / 2;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    return [
        [along, across],
        [along, -across],
        [-along, -across],
        [-along, across],
    ].map(([forward, left]) => ({
        x: wheel.x + forward * cosine + left * sine,
        z: wheel.z - forward * sine + left * cosine,
    }));
}

function radialReach(wheel, yaw, dirX, dirZ) {
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const along = Math.abs(dirX * cosine - dirZ * sine);
    const across = Math.abs(dirX * sine + dirZ * cosine);
    const halfLength = Math.max(0, finite(wheel.radius));
    const halfWidth = Math.max(0, finite(wheel.width) / 2);
    const lengthReach = along > 1e-12 ? halfLength / along : Infinity;
    const widthReach = across > 1e-12 ? halfWidth / across : Infinity;
    const reach = Math.min(lengthReach, widthReach);
    return Number.isFinite(reach) ? reach : 0;
}

function uniqueAngles(angles) {
    const tau = Math.PI * 2;
    const sorted = angles.map((angle) => {
        let wrapped = angle % tau;
        if (wrapped < 0) wrapped += tau;
        if (wrapped > tau - 1e-10) wrapped = 0;
        return wrapped;
    }).sort((left, right) => left - right);
    const unique = [];
    for (const angle of sorted) {
        if (unique.length === 0 || angle - unique[unique.length - 1] > 1e-8) unique.push(angle);
    }
    if (unique.length > 1 && unique[0] + tau - unique[unique.length - 1] < 1e-8) unique.pop();
    return unique;
}

function commandSamples(limit) {
    const step = Math.PI / 180;
    const count = Math.max(1, Math.ceil((2 * limit) / step));
    const samples = [];
    for (let index = 0; index <= count; index += 1) {
        samples.push(-limit + ((2 * limit) * index) / count);
    }
    samples.push(-limit, 0, limit);
    return samples;
}

/** Fill only small gaps. A singular Ackermann jump stays unfilled. */
function expandContinuousYaws(samples) {
    const maxGap = 0.5;
    const maxStep = (2 * Math.PI) / 180;
    const expanded = [];
    for (let index = 0; index < samples.length; index += 1) {
        const yaw = samples[index];
        if (index > 0) {
            const previous = samples[index - 1];
            const gap = yaw - previous;
            if (Math.abs(gap) > maxStep && Math.abs(gap) <= maxGap) {
                const pieces = Math.ceil(Math.abs(gap) / maxStep);
                for (let piece = 1; piece < pieces; piece += 1) {
                    expanded.push(previous + (gap * piece) / pieces);
                }
            }
        }
        expanded.push(yaw);
    }
    return expanded;
}

function footprintPolygon(wheel, yaws) {
    const samples = expandContinuousYaws(yaws);
    if (samples.every((yaw) => Math.abs(yaw) < 1e-8)) return [];
    const angles = [];
    for (let index = 0; index < 180; index += 1) angles.push((index / 180) * Math.PI * 2);
    for (const yaw of samples) {
        for (const corner of wheelPlanCorners(wheel, yaw)) {
            angles.push(Math.atan2(corner.z - wheel.z, corner.x - wheel.x));
        }
    }
    return uniqueAngles(angles).map((angle) => {
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        let reach = 0;
        for (const yaw of samples) reach = Math.max(reach, radialReach(wheel, yaw, dirX, dirZ));
        return { x: wheel.x + dirX * reach, z: wheel.z + dirZ * reach };
    });
}

function steeringFootprints(manifest, wheels, limit) {
    const steerable = wheels.filter((wheel) => wheel.steerable);
    if (steerable.length === 0 || !(limit > 0)) return [];
    const byWheel = new Map(steerable.map((wheel) => [wheel.id, []]));
    for (const angle of commandSamples(limit)) {
        for (const entry of visualWheelYaws(manifest, angle)) {
            byWheel.get(entry.wheelId)?.push(entry.yaw);
        }
    }
    return steerable.flatMap((wheel) => {
        const points = footprintPolygon(wheel, byWheel.get(wheel.id) ?? []);
        return points.length >= 3 ? [{ wheelId: wheel.id, points }] : [];
    });
}

function lockRecord(manifest, angle) {
    const simulator = simulatorTurn({
        wheelbase: manifest?.kinematics?.wheelbase,
        steeringAngle: angle,
        maxSteeringAngle: manifest?.kinematics?.maxSteeringAngle,
    });
    return {
        angle: simulator.appliedAngle,
        straight: simulator.straight,
        radius: simulator.radius,
        center: simulator.center,
        yaws: visualWheelYaws(manifest, simulator.appliedAngle),
    };
}

function wrapPi(angle) {
    const tau = Math.PI * 2;
    let value = (angle + Math.PI) % tau;
    if (value < 0) value += tau;
    return value - Math.PI;
}

function rayBox(wheel, yaw, center, bearing) {
    const dirX = Math.cos(bearing);
    const dirZ = Math.sin(bearing);
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const relX = center.x - wheel.x;
    const relZ = center.z - wheel.z;
    const u0 = relX * cosine - relZ * sine;
    const v0 = relX * sine + relZ * cosine;
    const du = dirX * cosine - dirZ * sine;
    const dv = dirX * sine + dirZ * cosine;
    const halfLength = Math.max(0, finite(wheel.radius));
    const halfWidth = Math.max(0, finite(wheel.width) / 2);
    let near = -Infinity;
    let far = Infinity;
    const clip = (origin, delta, min, max) => {
        if (Math.abs(delta) <= 1e-12) return origin >= min && origin <= max;
        let enter = (min - origin) / delta;
        let exit = (max - origin) / delta;
        if (enter > exit) [enter, exit] = [exit, enter];
        near = Math.max(near, enter);
        far = Math.min(far, exit);
        return near <= far;
    };
    if (!clip(u0, du, -halfLength, halfLength) || !clip(v0, dv, -halfWidth, halfWidth)) return null;
    if (far < 0) return null;
    return { near: Math.max(near, 0), far };
}

function pointOnRay(center, bearing, distance) {
    return {
        x: center.x + Math.cos(bearing) * distance,
        z: center.z + Math.sin(bearing) * distance,
    };
}

function dedupeRing(points) {
    const ring = [];
    for (const point of points) {
        const previous = ring[ring.length - 1];
        if (previous && Math.hypot(point.x - previous.x, point.z - previous.z) < 1e-6) continue;
        ring.push(point);
    }
    if (ring.length > 1) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (Math.hypot(first.x - last.x, first.z - last.z) < 1e-6) ring.pop();
    }
    return ring;
}

/** Swept plan rectangle about the simulator center. End caps follow the rectangle. */
export function wheelSweepPolygon(wheel, yaw, center, halfAngle) {
    const reach = Math.hypot(finite(wheel.radius), finite(wheel.width) / 2);
    const distance = Math.hypot(wheel.x - center.x, wheel.z - center.z);
    if (!(distance > reach + 1e-6) || !(halfAngle > 0)) return [];
    const corners = wheelPlanCorners(wheel, yaw);
    const anchor = Math.atan2(wheel.z - center.z, wheel.x - center.x);
    const cornerBearings = corners.map((corner) => anchor + wrapPi(Math.atan2(corner.z - center.z, corner.x - center.x) - anchor));
    const spanMin = Math.min(...cornerBearings);
    const spanMax = Math.max(...cornerBearings);
    let half = halfAngle;
    const span = spanMax - spanMin;
    if (span + 2 * half > Math.PI * 2 - 0.05) {
        half = Math.max(0, (Math.PI * 2 - 0.05 - span) / 2);
    }
    const rayBearings = [...cornerBearings];
    const rayStep = Math.PI / 180;
    for (let bearing = spanMin; bearing <= spanMax; bearing += rayStep) rayBearings.push(bearing);
    rayBearings.push(spanMax);
    rayBearings.sort((left, right) => left - right);
    const hits = [];
    for (const bearing of rayBearings) {
        const previous = hits[hits.length - 1];
        if (previous && Math.abs(previous.bearing - bearing) < 1e-8) continue;
        const hit = rayBox(wheel, yaw, center, bearing);
        if (hit) hits.push({ bearing, near: hit.near, far: hit.far });
    }
    if (hits.length === 0) return [];
    const outMin = spanMin - half;
    const outMax = spanMax + half;
    const outStep = Math.max(rayStep, (outMax - outMin) / 96);
    const outer = [];
    const inner = [];
    for (let bearing = outMin; bearing <= outMax + outStep * 0.5; bearing += outStep) {
        const sample = Math.min(bearing, outMax);
        const low = sample - half;
        const high = sample + half;
        let near = Infinity;
        let far = -Infinity;
        let any = false;
        for (const hit of hits) {
            if (hit.bearing < low) continue;
            if (hit.bearing > high) break;
            any = true;
            near = Math.min(near, hit.near);
            far = Math.max(far, hit.far);
        }
        if (!any) continue;
        outer.push(pointOnRay(center, sample, far));
        inner.push(pointOnRay(center, sample, near));
    }
    return dedupeRing([...outer, ...inner.reverse()]);
}

export function projectVehiclePlan(manifest, { steeringAngle = 0 } = {}) {
    const wheels = Array.isArray(manifest?.wheels) ? manifest.wheels : [];
    const described = describeTurnGeometry(manifest, steeringAngle);
    const axles = ["front", "rear"].map((id) => axleRecord(wheels, id)).filter(Boolean);
    const unclassified = wheels.filter((wheel) => wheel.axle === undefined).map(wheelRecord);
    const completeDerived = Number(manifest?.version) === 3 ? deriveCompleteWheelbase(wheels) : null;
    const box = manifest?.boundingBox ?? {};
    const diagnostics = [];
    if (described.simulator.straight) {
        diagnostics.push(diagnostic("vehicle.plan.straight", "Straight travel. The origin has no finite turn center."));
    }
    if (described.simulator.requestedAngle !== described.simulator.appliedAngle) {
        diagnostics.push(diagnostic(
            "vehicle.plan.steering-clamped",
            `Steering is clamped from ${described.simulator.requestedAngle} to ${described.simulator.appliedAngle}.`,
        ));
    }
    if (described.simulator.extreme) {
        diagnostics.push(diagnostic("vehicle.plan.extreme-angle", "Steering is at the plant limit."));
    }
    if (!described.ackermann.available) {
        diagnostics.push(diagnostic(
            "vehicle.plan.ackermann-unavailable",
            "Ideal Ackermann needs a version 3 front and rear axle.",
        ));
    } else if (described.ackermann.singular) {
        diagnostics.push(diagnostic(
            "vehicle.plan.ackermann-singular",
            "The ideal center falls inside the track. Inner and outer angles are not applied.",
        ));
    }
    for (const axle of axles) {
        if (!axle.locked) continue;
        diagnostics.push(diagnostic(
            "vehicle.plan.geometry-locked",
            `The ${axle.id} axle is model-bound. Detach its wheels before editing geometry.`,
        ));
    }
    const rearAxle = axles.find((axle) => axle.id === "rear");
    if (!described.simulator.straight && described.ackermann.available && rearAxle && Math.abs(rearAxle.x) > 1e-4) {
        const distance = Math.abs(rearAxle.x).toFixed(3);
        const place = rearAxle.x > 0 ? "behind" : "ahead of";
        diagnostics.push(diagnostic(
            "vehicle.plan.origin-offset",
            `The simulator turns about the origin, which is ${distance} m ${place} the rear axle.`,
        ));
    }
    const yaws = visualWheelYaws(manifest, described.simulator.appliedAngle);
    const steeringLimit = plantSteeringLimit(manifest?.kinematics?.maxSteeringAngle);
    const planWheels = [...axles.flatMap((axle) => axle.wheels), ...unclassified];
    return freeze({
        body: {
            centerX: finite(box.center?.x),
            centerZ: finite(box.center?.z),
            length: finite(box.size?.x),
            width: finite(box.size?.z),
        },
        axles,
        unclassified,
        wheelbase: {
            stored: manifest?.kinematics?.wheelbase ?? null,
            derived: completeDerived ?? deriveWheelbase(wheels),
            complete: completeDerived != null,
        },
        steeringLimit,
        simulator: described.simulator,
        ackermann: described.ackermann,
        yaws,
        footprints: steeringFootprints(manifest, planWheels, steeringLimit),
        locks: {
            left: lockRecord(manifest, -steeringLimit),
            right: lockRecord(manifest, steeringLimit),
        },
        diagnostics,
    });
}

function pointInside(point, view) {
    return point.x >= view.padding
        && point.y >= view.padding
        && point.x <= view.width - view.padding
        && point.y <= view.height - view.padding;
}

function outcode(x, y, view) {
    const xMin = view.padding;
    const yMin = view.padding;
    const xMax = view.width - view.padding;
    const yMax = view.height - view.padding;
    let code = 0;
    if (x < xMin) code |= 1;
    else if (x > xMax) code |= 2;
    if (y < yMin) code |= 4;
    else if (y > yMax) code |= 8;
    return code;
}

/** Cohen–Sutherland clip. Returns null when the segment misses the padded view. */
function clipSegment(x1, y1, x2, y2, view) {
    let c1 = outcode(x1, y1, view);
    let c2 = outcode(x2, y2, view);
    const xMin = view.padding;
    const yMin = view.padding;
    const xMax = view.width - view.padding;
    const yMax = view.height - view.padding;
    for (let step = 0; step < 8; step += 1) {
        if (!(c1 | c2)) return { x1, y1, x2, y2 };
        if (c1 & c2) return null;
        const code = c1 || c2;
        let x = x1;
        let y = y1;
        if (code & 8) {
            x = x1 + ((x2 - x1) * (yMax - y1)) / (y2 - y1);
            y = yMax;
        } else if (code & 4) {
            x = x1 + ((x2 - x1) * (yMin - y1)) / (y2 - y1);
            y = yMin;
        } else if (code & 2) {
            y = y1 + ((y2 - y1) * (xMax - x1)) / (x2 - x1);
            x = xMax;
        } else {
            y = y1 + ((y2 - y1) * (xMin - x1)) / (x2 - x1);
            x = xMin;
        }
        if (code === c1) {
            x1 = x;
            y1 = y;
            c1 = outcode(x1, y1, view);
        } else {
            x2 = x;
            y2 = y;
            c2 = outcode(x2, y2, view);
        }
    }
    return { x1, y1, x2, y2 };
}

function arcHalfAngle(origin, anchor, view) {
    const svgRadius = Math.hypot(anchor.svgX - origin.svgX, anchor.svgY - origin.svgY);
    if (!(svgRadius > 1e-6)) return 0;
    const mid = Math.atan2(anchor.svgY - origin.svgY, anchor.svgX - origin.svgX);
    const at = (offset) => ({
        x: origin.svgX + Math.cos(mid + offset) * svgRadius,
        y: origin.svgY + Math.sin(mid + offset) * svgRadius,
    });
    let half = Math.PI;
    while (half > 0.01 && (!pointInside(at(-half), view) || !pointInside(at(half), view))) {
        half *= 0.5;
    }
    return half;
}

function lerpPoint(start, end, t) {
    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
    };
}

/** Clip a closed polygon to the padded view. The clip window is convex. */
function clipPolygon(points, view) {
    const xMin = view.padding;
    const yMin = view.padding;
    const xMax = view.width - view.padding;
    const yMax = view.height - view.padding;
    const edges = [
        { inside: (point) => point.x >= xMin, cross: (start, end) => lerpPoint(start, end, (xMin - start.x) / (end.x - start.x)) },
        { inside: (point) => point.x <= xMax, cross: (start, end) => lerpPoint(start, end, (xMax - start.x) / (end.x - start.x)) },
        { inside: (point) => point.y >= yMin, cross: (start, end) => lerpPoint(start, end, (yMin - start.y) / (end.y - start.y)) },
        { inside: (point) => point.y <= yMax, cross: (start, end) => lerpPoint(start, end, (yMax - start.y) / (end.y - start.y)) },
    ];
    let output = points;
    for (const edge of edges) {
        if (output.length === 0) return [];
        const input = output;
        output = [];
        for (let index = 0; index < input.length; index += 1) {
            const current = input[index];
            const previous = input[(index + input.length - 1) % input.length];
            const currentInside = edge.inside(current);
            const previousInside = edge.inside(previous);
            if (currentInside) {
                if (!previousInside) output.push(edge.cross(previous, current));
                output.push(current);
            } else if (previousInside) {
                output.push(edge.cross(previous, current));
            }
        }
    }
    return output;
}

function toSvgPoint(point, toSvg) {
    const svg = toSvg(point.x, point.z);
    return { x: svg.svgX, y: svg.svgY };
}

function appendSteeringOverlays(records, projection, toSvg, view) {
    const wheels = [
        ...projection.axles.flatMap((axle) => axle.wheels),
        ...projection.unclassified,
    ];
    for (const direction of ["left", "right"]) {
        const lock = projection.locks?.[direction];
        if (!lock?.center) continue;
        for (const wheel of wheels) {
            if (!wheel.steerable) continue;
            const yaw = lock.yaws.find((entry) => entry.wheelId === wheel.id)?.yaw ?? 0;
            const half = arcHalfAngle(toSvg(lock.center.x, lock.center.z), toSvg(wheel.x, wheel.z), view);
            const vehiclePoints = wheelSweepPolygon(wheel, yaw, lock.center, half);
            if (vehiclePoints.length < 3) continue;
            const points = clipPolygon(vehiclePoints.map((point) => toSvgPoint(point, toSvg)), view);
            if (points.length < 3) continue;
            records.push({
                kind: "wheel-path",
                id: `wheel-path-${wheel.id}-${direction}`,
                wheelId: wheel.id,
                direction,
                center: lock.center,
                vehiclePoints,
                points,
            });
        }
    }
    for (const footprint of projection.footprints ?? []) {
        const points = footprint.points.map((point) => toSvgPoint(point, toSvg));
        if (points.length < 3) continue;
        records.push({
            kind: "steering-footprint",
            id: `steering-footprint-${footprint.wheelId}`,
            wheelId: footprint.wheelId,
            points,
        });
    }
}

function edgePoint(svgX, svgY, view) {
    if (pointInside({ x: svgX, y: svgY }, view)) return { svgX, svgY, clamped: false };
    const clipped = clipSegment(view.width / 2, view.height / 2, svgX, svgY, view);
    if (!clipped) return { svgX: view.width / 2, svgY: view.height / 2, clamped: true };
    return { svgX: clipped.x2, svgY: clipped.y2, clamped: true };
}

function clippedArc(center, radius, through, toSvg, view) {
    const origin = toSvg(center.x, center.z);
    const anchor = toSvg(through.x, through.z);
    const svgRadius = Math.hypot(anchor.svgX - origin.svgX, anchor.svgY - origin.svgY);
    const mid = Math.atan2(anchor.svgY - origin.svgY, anchor.svgX - origin.svgX);
    const at = (offset) => ({
        x: origin.svgX + Math.cos(mid + offset) * svgRadius,
        y: origin.svgY + Math.sin(mid + offset) * svgRadius,
    });
    let half = Math.PI;
    while (half > 0.01 && (!pointInside(at(-half), view) || !pointInside(at(half), view))) {
        half *= 0.5;
    }
    const samples = [];
    const steps = 48;
    for (let index = 0; index <= steps; index += 1) {
        const point = at(-half + (2 * half * index) / steps);
        samples.push({ ...point, inside: pointInside(point, view) });
    }
    const segments = [];
    let run = [];
    const flush = () => {
        if (run.length > 1) segments.push(run);
        run = [];
    };
    for (const sample of samples) {
        if (sample.inside) run.push({ x: sample.x, y: sample.y });
        else flush();
    }
    flush();
    const points = segments.flat();
    const marker = pointInside(origin, view) ? origin : null;
    return { points, segments, center: origin, marker, radius };
}

function radiusLine(id, construction, center, target, toSvg, view, label) {
    const start = toSvg(center.x, center.z);
    const end = toSvg(target.x, target.z);
    const clipped = clipSegment(start.svgX, start.svgY, end.svgX, end.svgY, view);
    if (!clipped) return null;
    const dx = clipped.x2 - clipped.x1;
    const dy = clipped.y2 - clipped.y1;
    const length = Math.hypot(dx, dy);
    const offset = length > 1 ? 11 / length : 0;
    return {
        kind: "radius-line",
        id,
        construction,
        x1: clipped.x1,
        y1: clipped.y1,
        x2: clipped.x2,
        y2: clipped.y2,
        label: length >= 28 ? label : null,
        labelX: (clipped.x1 + clipped.x2) / 2 - dy * offset,
        labelY: (clipped.y1 + clipped.y2) / 2 + dx * offset,
    };
}

function turnCenterRecord(id, construction, center, radius, toSvg, view) {
    const point = toSvg(center.x, center.z);
    const placed = edgePoint(point.svgX, point.svgY, view);
    const dx = point.svgX - view.width / 2;
    const dy = point.svgY - view.height / 2;
    const length = Math.hypot(dx, dy) || 1;
    const direction = turnDirection(radius);
    return {
        kind: "turn-center",
        id,
        construction,
        svgX: placed.svgX,
        svgY: placed.svgY,
        clamped: placed.clamped,
        nx: dx / length,
        ny: dy / length,
        radius,
        direction,
        label: `R ${Math.abs(radius).toFixed(2)} m ${direction}`,
    };
}

export function layoutVehiclePlan(projection, { width = 360, height = 280, padding = 36, fit = "vehicle" } = {}) {
    const points = [
        { x: projection.body.centerX - projection.body.length / 2, z: projection.body.centerZ - projection.body.width / 2 },
        { x: projection.body.centerX + projection.body.length / 2, z: projection.body.centerZ + projection.body.width / 2 },
        { x: 0, z: 0 },
    ];
    const pushWheel = (wheel) => {
        points.push(
            { x: wheel.x - wheel.radius, z: wheel.z - wheel.width / 2 },
            { x: wheel.x + wheel.radius, z: wheel.z + wheel.width / 2 },
        );
    };
    for (const axle of projection.axles) axle.wheels.forEach(pushWheel);
    projection.unclassified.forEach(pushWheel);
    for (const footprint of projection.footprints ?? []) {
        for (const point of footprint.points) points.push(point);
    }
    let vehicleMinX = Infinity;
    let vehicleMaxX = -Infinity;
    let vehicleMinZ = Infinity;
    let vehicleMaxZ = -Infinity;
    for (const point of points) {
        vehicleMinX = Math.min(vehicleMinX, point.x);
        vehicleMaxX = Math.max(vehicleMaxX, point.x);
        vehicleMinZ = Math.min(vehicleMinZ, point.z);
        vehicleMaxZ = Math.max(vehicleMaxZ, point.z);
    }
    if (fit === "turn") {
        const span = Math.max(vehicleMaxX - vehicleMinX, vehicleMaxZ - vehicleMinZ, 0.5);
        const cap = span * 3;
        const midX = (vehicleMinX + vehicleMaxX) / 2;
        const midZ = (vehicleMinZ + vehicleMaxZ) / 2;
        const centers = [];
        if (projection.simulator.center) centers.push(projection.simulator.center);
        if (projection.ackermann.center && !projection.simulator.straight) centers.push(projection.ackermann.center);
        if (projection.locks?.left?.center) centers.push(projection.locks.left.center);
        if (projection.locks?.right?.center) centers.push(projection.locks.right.center);
        for (const center of centers) {
            let x = center.x;
            let z = center.z;
            const dx = x - midX;
            const dz = z - midZ;
            const distance = Math.hypot(dx, dz);
            if (distance > cap) {
                x = midX + (dx / distance) * cap;
                z = midZ + (dz / distance) * cap;
            }
            points.push({ x, z });
        }
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    }
    if (!Number.isFinite(minX)) {
        minX = -1;
        maxX = 1;
        minZ = -1;
        maxZ = 1;
    }
    const spanX = Math.max(maxX - minX, 0.5);
    const spanZ = Math.max(maxZ - minZ, 0.5);
    const scale = Math.min(
        Math.max(1, width - padding * 2) / spanZ,
        Math.max(1, height - padding * 2) / spanX,
    );
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const originX = width / 2 + centerZ * scale;
    const originY = height / 2 + centerX * scale;
    const toSvg = (x, z) => ({
        svgX: originX - z * scale,
        svgY: originY - x * scale,
    });
    const vehicleFromSvg = (svgX, svgY) => ({
        x: (originY - svgY) / scale,
        z: (originX - svgX) / scale,
    });
    const view = { width, height, padding };
    const records = [];
    const yawOf = new Map((projection.yaws ?? []).map((entry) => [entry.wheelId, entry.yaw]));
    const origin = toSvg(0, 0);
    records.push({
        kind: "centerline",
        id: "centerline",
        x1: origin.svgX,
        y1: padding,
        x2: origin.svgX,
        y2: height - padding,
    });
    records.push({
        kind: "origin",
        id: "origin",
        svgX: origin.svgX,
        svgY: origin.svgY,
    });
    const nose = toSvg(projection.body.centerX + projection.body.length / 2, projection.body.centerZ);
    records.push({
        kind: "forward",
        id: "forward",
        svgX: nose.svgX,
        svgY: Math.max(padding + 10, nose.svgY),
    });
    const leftMark = toSvg(projection.body.centerX, projection.body.centerZ + projection.body.width / 2);
    const rightMark = toSvg(projection.body.centerX, projection.body.centerZ - projection.body.width / 2);
    records.push({ kind: "side-label", id: "side-left", text: "L", svgX: leftMark.svgX + 8, svgY: leftMark.svgY });
    records.push({ kind: "side-label", id: "side-right", text: "R", svgX: rightMark.svgX - 8, svgY: rightMark.svgY });
    const bodyLeft = toSvg(0, projection.body.centerZ + projection.body.width / 2).svgX;
    const bodyTop = toSvg(projection.body.centerX + projection.body.length / 2, 0).svgY;
    records.push({
        kind: "body",
        id: "body",
        x: bodyLeft,
        y: bodyTop,
        width: projection.body.width * scale,
        height: projection.body.length * scale,
    });
    const pushWheelRecord = (wheel, axleId) => {
        const top = toSvg(wheel.x + wheel.radius, wheel.z + wheel.width / 2);
        records.push({
            kind: "wheel",
            id: `wheel-${wheel.id}`,
            axleId,
            x: top.svgX,
            y: top.svgY,
            width: wheel.width * scale,
            height: wheel.radius * 2 * scale,
            yaw: yawOf.get(wheel.id) ?? 0,
            steerable: wheel.steerable === true,
            locked: wheel.locked === true,
        });
    };
    for (const axle of projection.axles) {
        axle.wheels.forEach((wheel) => pushWheelRecord(wheel, axle.id));
        const axlePoint = toSvg(axle.x, 0);
        records.push({
            kind: "axle-handle",
            id: `axle-${axle.id}`,
            axle: axle.id,
            locked: axle.locked,
            svgX: axlePoint.svgX,
            svgY: axlePoint.svgY,
            value: axle.x,
        });
        const outer = toSvg(axle.x, axle.halfTrack + axle.width / 2);
        records.push({
            kind: "track-handle",
            id: `track-${axle.id}`,
            axle: axle.id,
            locked: axle.locked,
            svgX: outer.svgX - 14,
            svgY: outer.svgY,
            value: axle.halfTrack,
        });
        const trackLeft = toSvg(axle.x, axle.halfTrack);
        const trackRight = toSvg(axle.x, -axle.halfTrack);
        records.push({
            kind: "dimension-line",
            id: `track-line-${axle.id}`,
            x1: trackLeft.svgX,
            y1: trackLeft.svgY,
            x2: trackRight.svgX,
            y2: trackRight.svgY,
            text: `${(axle.halfTrack * 2).toFixed(2)} m`,
        });
        records.push({
            kind: "dimension",
            id: `track-${axle.id}`,
            meters: axle.halfTrack * 2,
            text: `${axle.id} track ${(axle.halfTrack * 2).toFixed(3)} m`,
        });
        records.push({
            kind: "dimension",
            id: `tire-${axle.id}`,
            text: `${axle.id} tire diameter ${(axle.radius * 2).toFixed(3)} m, width ${axle.width.toFixed(3)} m`,
        });
    }
    projection.unclassified.forEach((wheel) => pushWheelRecord(wheel, null));
    const front = projection.axles.find((axle) => axle.id === "front");
    const rear = projection.axles.find((axle) => axle.id === "rear");
    const spacing = front && rear ? Math.abs(front.x - rear.x) : null;
    const stored = projection.wheelbase.stored;
    const wheelbaseText = spacing != null && differs(stored, spacing)
        ? `Wheelbase ${Number(stored).toFixed(3)} m (axle spacing ${spacing.toFixed(3)} m)`
        : `Wheelbase ${Number(stored).toFixed(3)} m`;
    records.push({
        kind: "dimension",
        id: "wheelbase",
        stored,
        spacing,
        text: wheelbaseText,
    });
    if (front && rear) {
        const side = toSvg(0, projection.body.centerZ - projection.body.width / 2 - 0.05);
        const from = toSvg(rear.x, 0);
        const to = toSvg(front.x, 0);
        const lineX = Math.min(width - padding, side.svgX + 18);
        records.push({
            kind: "dimension-line",
            id: "wheelbase-line",
            x1: lineX,
            y1: from.svgY,
            x2: lineX,
            y2: to.svgY,
            text: `${Math.abs(front.x - rear.x).toFixed(2)} m`,
        });
    }
    appendSteeringOverlays(records, projection, toSvg, view);
    const simulatorLabel = projection.simulator.straight || projection.simulator.radius == null
        ? "Straight"
        : `Simulator turn, R = ${Math.abs(projection.simulator.radius).toFixed(2)} m ${turnDirection(projection.simulator.radius)}`;
    if (projection.simulator.straight || projection.simulator.center == null) {
        records.push({
            kind: "label",
            id: "simulator-label",
            construction: "simulator",
            text: simulatorLabel,
            radius: null,
        });
    } else {
        const arc = clippedArc(
            projection.simulator.center,
            projection.simulator.radius,
            { x: 0, z: 0 },
            toSvg,
            view,
        );
        records.push({
            kind: "simulator-arc",
            id: "simulator-turn",
            construction: "simulator",
            label: "Simulator turn",
            radius: projection.simulator.radius,
            points: arc.points,
            segments: arc.segments,
            marker: arc.marker,
        });
        records.push(turnCenterRecord(
            "simulator-center",
            "simulator",
            projection.simulator.center,
            projection.simulator.radius,
            toSvg,
            view,
        ));
        const line = radiusLine(
            "simulator-radius",
            "simulator",
            projection.simulator.center,
            { x: 0, z: 0 },
            toSvg,
            view,
            `R ${Math.abs(projection.simulator.radius).toFixed(2)} m`,
        );
        if (line) records.push(line);
        records.push({
            kind: "label",
            id: "simulator-label",
            construction: "simulator",
            text: simulatorLabel,
            radius: projection.simulator.radius,
        });
    }
    if (projection.ackermann.available && projection.ackermann.center && !projection.simulator.straight) {
        const through = { x: projection.ackermann.rearAxleX, z: 0 };
        const arc = clippedArc(
            projection.ackermann.center,
            projection.ackermann.radius,
            through,
            toSvg,
            view,
        );
        records.push({
            kind: "ackermann-arc",
            id: "ackermann-turn",
            construction: "ackermann",
            label: "Ideal Ackermann, rear axle. Illustration, not the predicted path.",
            radius: projection.ackermann.radius,
            points: arc.points,
            segments: arc.segments,
            marker: arc.marker,
        });
        records.push(turnCenterRecord(
            "ackermann-center",
            "ackermann",
            projection.ackermann.center,
            projection.ackermann.radius,
            toSvg,
            view,
        ));
        const wheels = projection.axles.flatMap((axle) => axle.wheels);
        for (const wheel of wheels) {
            const line = radiusLine(
                `ackermann-radius-${wheel.id}`,
                "ackermann",
                projection.ackermann.center,
                { x: wheel.x, z: wheel.z },
                toSvg,
                view,
                null,
            );
            if (line) records.push(line);
        }
    }
    if (projection.ackermann.available) {
        records.push({
            kind: "label",
            id: "ackermann-label",
            construction: "ackermann",
            text: "Ideal Ackermann, rear axle. Illustration, not the predicted path.",
            radius: projection.ackermann.radius,
        });
    }
    return {
        width,
        height,
        padding,
        scale,
        originX,
        originY,
        toSvg,
        vehicleFromSvg,
        records,
    };
}
