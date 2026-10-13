/**
 * DOM-free top view of a vehicle manifest on the vehicle-local XZ plane.
 * +X is forward and +Z is left. The SVG mapping puts forward up and left left.
 */

import { deriveCompleteWheelbase } from "../axle/standardAxle.js";
import { deriveWheelbase } from "../VehicleManifest.js";
import { describeTurnGeometry, plantSteeringLimit } from "./turnGeometry.js";

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
    };
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
        steeringLimit: plantSteeringLimit(manifest?.kinematics?.maxSteeringAngle),
        simulator: described.simulator,
        ackermann: described.ackermann,
        diagnostics,
    });
}

function pointInside(point, view) {
    return point.x >= view.padding
        && point.y >= view.padding
        && point.x <= view.width - view.padding
        && point.y <= view.height - view.padding;
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
    const points = [];
    const steps = 32;
    for (let index = 0; index <= steps; index += 1) {
        const point = at(-half + (2 * half * index) / steps);
        if (pointInside(point, view)) points.push(point);
    }
    const marker = pointInside(origin, view) ? origin : null;
    return { points, center: origin, marker, radius };
}

export function layoutVehiclePlan(projection, { width = 360, height = 280, padding = 36 } = {}) {
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
        const track = toSvg(axle.x, axle.halfTrack);
        records.push({
            kind: "track-handle",
            id: `track-${axle.id}`,
            axle: axle.id,
            locked: axle.locked,
            svgX: track.svgX,
            svgY: track.svgY,
            value: axle.halfTrack,
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
    if (projection.simulator.straight || projection.simulator.center == null) {
        records.push({
            kind: "label",
            id: "simulator-label",
            construction: "simulator",
            text: "Straight",
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
            marker: arc.marker,
        });
        records.push({
            kind: "label",
            id: "simulator-label",
            construction: "simulator",
            text: "Simulator turn",
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
            marker: arc.marker,
        });
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
