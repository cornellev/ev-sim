import assert from "node:assert/strict";
import test from "node:test";

import { layoutVehiclePlan, planYawDegrees, projectVehiclePlan, wheelPlanCorners } from "../app/vehicles/plan/projectVehiclePlan.js";
import { visualWheelYaws } from "../app/vehicles/plan/turnGeometry.js";

function closeTo(actual, expected, epsilon = 1e-6) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

function manifest(patch = {}) {
    return {
        version: 3,
        id: "plan-car",
        boundingBox: {
            size: { x: 2, y: 1, z: 1 },
            center: { x: 0.2, y: 0.5, z: 0 },
        },
        kinematics: { wheelbase: 1.5, maxSteeringAngle: 0.6 },
        wheels: [
            { id: "front-left", axle: "front", side: "left", position: { x: 1, y: 0.25, z: 0.5 }, radius: 0.3, width: 0.2, steerable: true },
            { id: "front-right", axle: "front", side: "right", position: { x: 1, y: 0.25, z: -0.5 }, radius: 0.3, width: 0.2, steerable: true },
            { id: "rear-left", axle: "rear", side: "left", position: { x: -0.5, y: 0.25, z: 0.5 }, radius: 0.3, width: 0.2, steerable: false },
            { id: "rear-right", axle: "rear", side: "right", position: { x: -0.5, y: 0.25, z: -0.5 }, radius: 0.3, width: 0.2, steerable: false },
            { id: "spare", position: { x: -1.2, y: 0.25, z: 0.1 }, radius: 0.2, width: 0.1, steerable: false },
        ],
        ...patch,
    };
}

test("the plan separates body, axles, unclassified wheels, and both constructions", () => {
    const projection = projectVehiclePlan(manifest(), { steeringAngle: 0.2 });
    closeTo(projection.body.centerX, 0.2);
    closeTo(projection.body.length, 2);
    closeTo(projection.body.width, 1);
    assert.deepEqual(projection.axles.map((axle) => axle.id), ["front", "rear"]);
    assert.equal(projection.axles[0].locked, false);
    assert.deepEqual(projection.unclassified.map((wheel) => wheel.id), ["spare"]);
    assert.equal(projection.wheelbase.complete, false);
    assert.equal(projection.simulator.center.x, 0);
    closeTo(projection.ackermann.center.x, -0.5);
    assert.equal(projection.diagnostics.some((entry) => entry.code === "vehicle.plan.straight"), false);
    assert.equal(projection.diagnostics.some((entry) => entry.code === "vehicle.plan.ackermann-unavailable"), false);
});

test("straight, clamped, locked, and missing-axle diagnostics are named", () => {
    const straight = projectVehiclePlan(manifest(), { steeringAngle: 0 });
    assert.equal(straight.diagnostics.some((entry) => entry.code === "vehicle.plan.straight"), true);
    assert.equal(straight.simulator.center, null);

    const clamped = projectVehiclePlan(manifest(), { steeringAngle: 2 });
    assert.equal(clamped.diagnostics.some((entry) => entry.code === "vehicle.plan.steering-clamped"), true);
    assert.equal(clamped.diagnostics.some((entry) => entry.code === "vehicle.plan.extreme-angle"), false);
    const capped = projectVehiclePlan(manifest({
        kinematics: { wheelbase: 1.5, maxSteeringAngle: 2 },
    }), { steeringAngle: 2 });
    assert.equal(capped.diagnostics.some((entry) => entry.code === "vehicle.plan.extreme-angle"), true);
    assert.equal(capped.diagnostics.some((entry) => entry.code === "vehicle.plan.steering-clamped"), true);

    const locked = manifest();
    locked.wheels[0].visual = { kind: "model-node", nodeIndex: 1 };
    locked.wheels[1].visual = { kind: "model-node", nodeIndex: 2 };
    const lockedPlan = projectVehiclePlan(locked, { steeringAngle: 0.2 });
    assert.equal(lockedPlan.axles[0].locked, true);
    assert.equal(lockedPlan.diagnostics.some((entry) => entry.code === "vehicle.plan.geometry-locked"), true);

    const legacy = projectVehiclePlan({
        version: 2,
        boundingBox: { size: { x: 1, y: 1, z: 1 }, center: { x: 0, y: 0, z: 0 } },
        kinematics: { wheelbase: 1.2, maxSteeringAngle: 0.5 },
        wheels: [{ id: "only", position: { x: 0, y: 0, z: 0 }, radius: 0.2, width: 0.1, steerable: true }],
    }, { steeringAngle: 0.1 });
    assert.equal(legacy.axles.length, 0);
    assert.equal(legacy.diagnostics.some((entry) => entry.code === "vehicle.plan.ackermann-unavailable"), true);
});

test("SVG mapping puts forward up and left left, and clips a large arc without a swept path", () => {
    const projection = projectVehiclePlan(manifest({
        kinematics: { wheelbase: 1.2446, maxSteeringAngle: 0.6 },
    }), { steeringAngle: 0.01 });
    const layout = layoutVehiclePlan(projection, { width: 300, height: 240, padding: 24 });
    const forward = layout.toSvg(1, 0);
    const back = layout.toSvg(-1, 0);
    const left = layout.toSvg(0, 1);
    const right = layout.toSvg(0, -1);
    assert.ok(forward.svgY < back.svgY);
    assert.ok(left.svgX < right.svgX);

    const wheel = layout.records.find((record) => record.id === "wheel-front-left");
    const roundTrip = layout.vehicleFromSvg(wheel.x + wheel.width / 2, wheel.y + wheel.height / 2);
    closeTo(roundTrip.x, 1);
    closeTo(roundTrip.z, 0.5);

    const arc = layout.records.find((record) => record.id === "simulator-turn");
    assert.ok(arc.points.length > 1);
    closeTo(arc.radius, projection.simulator.radius);
    assert.ok(Math.abs(arc.radius) > 50);
    for (const point of arc.points) {
        assert.ok(point.x >= 24 && point.x <= 276);
        assert.ok(point.y >= 24 && point.y <= 216);
    }
    assert.equal(layout.records.some((record) => record.kind === "swept-path"), false);
    const wheelbase = layout.records.find((record) => record.id === "wheelbase");
    assert.match(wheelbase.text, /axle spacing/);
    assert.equal(layout.records.some((record) => record.kind === "ackermann-arc"), true);
});

test("the plan keeps a uniform scale, steers wheels clockwise, and draws a clamped radius", () => {
    const projection = projectVehiclePlan(manifest(), { steeringAngle: 0.2 });
    const layout = layoutVehiclePlan(projection, { width: 300, height: 200, padding: 24 });
    const origin = layout.toSvg(0, 0);
    const forward = layout.toSvg(1, 0);
    const left = layout.toSvg(0, 1);
    closeTo(Math.abs(forward.svgY - origin.svgY), Math.abs(left.svgX - origin.svgX));

    const steered = layout.records.find((record) => record.id === "wheel-front-left");
    const fixed = layout.records.find((record) => record.id === "wheel-rear-left");
    assert.ok(steered.yaw > 0);
    assert.equal(fixed.yaw, 0);
    assert.ok(planYawDegrees(steered.yaw) > 0);
    assert.equal(layout.records.some((record) => record.kind === "radius-line" && record.id === "simulator-radius"), true);
    assert.equal(layout.records.some((record) => record.id === "simulator-center"), true);
    assert.equal(projection.diagnostics.some((entry) => entry.code === "vehicle.plan.origin-offset"), true);

    const wide = projectVehiclePlan(manifest(), { steeringAngle: 0.01 });
    const clipped = layoutVehiclePlan(wide, { width: 300, height: 240, padding: 24, fit: "vehicle" });
    const center = clipped.records.find((record) => record.id === "simulator-center");
    assert.equal(center.clamped, true);
    assert.ok(center.svgX >= 24 && center.svgX <= 276);
    assert.ok(center.svgY >= 24 && center.svgY <= 216);
    const arc = clipped.records.find((record) => record.id === "simulator-turn");
    assert.ok(arc.segments.length >= 1);
    for (const segment of arc.segments) {
        for (let index = 1; index < segment.length; index += 1) {
            const jump = Math.hypot(segment[index].x - segment[index - 1].x, segment[index].y - segment[index - 1].y);
            assert.ok(jump < 80, `arc segment jumped ${jump}`);
        }
    }
    const turned = layoutVehiclePlan(projection, { width: 300, height: 240, padding: 24, fit: "turn" });
    const fitted = layoutVehiclePlan(projection, { width: 300, height: 240, padding: 24, fit: "vehicle" });
    assert.ok(turned.scale <= fitted.scale);
});

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const current = polygon[index];
        const prior = polygon[previous];
        const crosses = (current.z > point.z) !== (prior.z > point.z)
            && point.x < ((prior.x - current.x) * (point.z - current.z)) / (prior.z - current.z) + current.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

function hasVertex(points, target, epsilon = 1e-5) {
    return points.some((point) => Math.hypot(point.x - target.x, point.z - target.z) <= epsilon);
}

test("full-lock footprints and tightest-turn paths stay on the simulator center", () => {
    const preview = projectVehiclePlan(manifest(), { steeringAngle: 0.2 });
    const straight = projectVehiclePlan(manifest(), { steeringAngle: 0 });
    assert.deepEqual(preview.footprints, straight.footprints);
    assert.deepEqual(preview.locks, straight.locks);
    assert.equal(preview.footprints.some((entry) => entry.wheelId === "rear-left"), false);
    assert.equal(straight.locks.right.center.x, 0);
    assert.ok(straight.locks.right.center.z < 0);
    assert.ok(straight.locks.left.center.z > 0);

    const front = preview.footprints.find((entry) => entry.wheelId === "front-left");
    const wheel = { x: 1, z: 0.5, radius: 0.3, width: 0.2 };
    const reach = Math.hypot(wheel.radius, wheel.width / 2);
    const yaws = [0, ...[-preview.steeringLimit, preview.steeringLimit].map((angle) => (
        visualWheelYaws(manifest(), angle).find((entry) => entry.wheelId === "front-left").yaw
    ))];
    for (const yaw of yaws) {
        for (const corner of wheelPlanCorners(wheel, yaw)) {
            assert.ok(hasVertex(front.points, corner), `missing corner at yaw ${yaw}`);
        }
    }
    assert.equal(pointInPolygon({ x: wheel.x, z: wheel.z }, front.points), true);
    assert.equal(pointInPolygon({ x: wheel.x + reach + 0.05, z: wheel.z }, front.points), false);
    for (const point of front.points) {
        assert.ok(Math.hypot(point.x - wheel.x, point.z - wheel.z) <= reach + 1e-6);
    }

    const layout = layoutVehiclePlan(preview, { width: 300, height: 240, padding: 24, fit: "vehicle" });
    const same = layoutVehiclePlan(straight, { width: 300, height: 240, padding: 24, fit: "vehicle" });
    const paths = layout.records.filter((record) => record.kind === "wheel-path" && record.wheelId === "front-left");
    assert.deepEqual(paths.map((record) => record.direction).sort(), ["left", "right"]);
    assert.equal(layout.records.some((record) => record.kind === "wheel-path" && record.wheelId === "rear-left"), false);
    assert.equal(layout.records.some((record) => record.kind === "swept-path"), false);
    assert.deepEqual(
        paths.map((record) => record.vehiclePoints),
        same.records.filter((record) => record.kind === "wheel-path" && record.wheelId === "front-left").map((record) => record.vehiclePoints),
    );
    for (const path of paths) {
        assert.equal(pointInPolygon({ x: wheel.x, z: wheel.z }, path.vehiclePoints), true);
        const centerDistance = Math.hypot(wheel.x - path.center.x, wheel.z - path.center.z);
        for (const point of path.vehiclePoints) {
            const distance = Math.hypot(point.x - path.center.x, point.z - path.center.z);
            assert.ok(distance <= centerDistance + reach + 1e-3);
            assert.ok(distance >= centerDistance - reach - 1e-3);
        }
        for (const point of path.points) {
            assert.ok(point.x >= 24 && point.x <= 276);
            assert.ok(point.y >= 24 && point.y <= 216);
        }
    }

    const turn = layoutVehiclePlan(straight, { width: 300, height: 240, padding: 24, fit: "turn" });
    const fitted = layoutVehiclePlan(straight, { width: 300, height: 240, padding: 24, fit: "vehicle" });
    assert.ok(turn.scale < fitted.scale);
    const placed = turn.toSvg(straight.locks.right.center.x, straight.locks.right.center.z);
    assert.ok(placed.svgX >= -1 && placed.svgX <= 301);
    assert.ok(placed.svgY >= -1 && placed.svgY <= 241);
    const outside = fitted.toSvg(straight.locks.right.center.x, straight.locks.right.center.z);
    assert.ok(outside.svgX < 0 || outside.svgX > 300 || outside.svgY < 0 || outside.svgY > 240);

    const loose = projectVehiclePlan({
        version: 2,
        boundingBox: { size: { x: 1, y: 1, z: 1 }, center: { x: 0, y: 0, z: 0 } },
        kinematics: { wheelbase: 1.2, maxSteeringAngle: 0.5 },
        wheels: [{ id: "only", position: { x: 0.4, y: 0, z: 0.2 }, radius: 0.2, width: 0.1, steerable: true }],
    }, { steeringAngle: 0.1 });
    assert.equal(loose.footprints.length, 1);
    const looseLayout = layoutVehiclePlan(loose, { width: 300, height: 240, padding: 24 });
    assert.equal(looseLayout.records.filter((record) => record.kind === "wheel-path").length, 2);
});
