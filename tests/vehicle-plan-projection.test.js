import assert from "node:assert/strict";
import test from "node:test";

import { layoutVehiclePlan, projectVehiclePlan } from "../app/vehicles/plan/projectVehiclePlan.js";

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
