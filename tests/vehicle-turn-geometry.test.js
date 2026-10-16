import assert from "node:assert/strict";
import test from "node:test";

import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import {
    clampPlantSteering,
    describeTurnGeometry,
    idealAckermann,
    simulatorTurn,
    visualWheelYaws,
} from "../app/vehicles/plan/turnGeometry.js";

const CAP = Math.PI * 0.49;

function closeTo(actual, expected, epsilon = 1e-9) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

function wheels({ frontX, rearX, halfTrack = 0.55 }) {
    return [
        { id: "front-left", axle: "front", side: "left", position: { x: frontX, y: 0.25, z: halfTrack }, radius: 0.25, width: 0.15, steerable: true },
        { id: "front-right", axle: "front", side: "right", position: { x: frontX, y: 0.25, z: -halfTrack }, radius: 0.25, width: 0.15, steerable: true },
        { id: "rear-left", axle: "rear", side: "left", position: { x: rearX, y: 0.25, z: halfTrack }, radius: 0.25, width: 0.15, steerable: false },
        { id: "rear-right", axle: "rear", side: "right", position: { x: rearX, y: 0.25, z: -halfTrack }, radius: 0.25, width: 0.15, steerable: false },
    ];
}

function manifest({ wheelbase = 1.5, maxSteeringAngle = 0.6, frontX = 1.3, rearX = -0.2, halfTrack = 0.55, version = 3 } = {}) {
    return {
        version,
        id: "turn-car",
        kinematics: { wheelbase, maxSteeringAngle },
        wheels: wheels({ frontX, rearX, halfTrack }),
    };
}

test("an offset rear axle keeps the simulator center on the origin", () => {
    const described = describeTurnGeometry(manifest(), 0.2);
    const radius = 1.5 / Math.tan(0.2);
    closeTo(described.simulator.radius, radius);
    closeTo(described.simulator.center.x, 0);
    closeTo(described.simulator.center.z, -radius);
    closeTo(described.ackermann.radius, radius);
    closeTo(described.ackermann.center.x, -0.2);
    closeTo(described.ackermann.center.z, -radius);
    assert.equal(described.ackermann.innerSide, "right");
    assert.equal(described.ackermann.outerSide, "left");
    assert.ok(described.ackermann.rightAngle > described.ackermann.leftAngle);
    assert.ok(described.ackermann.leftAngle > 0);

    const mirrored = describeTurnGeometry(manifest(), -0.2);
    closeTo(mirrored.simulator.center.z, -described.simulator.center.z);
    closeTo(mirrored.ackermann.center.z, -described.ackermann.center.z);
    closeTo(mirrored.ackermann.leftAngle, -described.ackermann.rightAngle);
    closeTo(mirrored.ackermann.rightAngle, -described.ackermann.leftAngle);
    assert.equal(mirrored.ackermann.innerSide, "left");
    assert.equal(mirrored.ackermann.outerSide, "right");
});

test("a stored wheelbase that disagrees with the axle spacing uses two radii", () => {
    const described = describeTurnGeometry(manifest({
        wheelbase: 1.2446,
        frontX: 0.75,
        rearX: -0.75,
    }), 0.3);
    closeTo(described.simulator.radius, 1.2446 / Math.tan(0.3));
    closeTo(described.ackermann.radius, 1.5 / Math.tan(0.3));
    assert.notEqual(described.simulator.radius, described.ackermann.radius);
    closeTo(described.simulator.center.x, 0);
    closeTo(described.ackermann.center.x, -0.75);
});

test("straight travel, the authoring clamp, and the plant cap are explicit", () => {
    const straight = simulatorTurn({ wheelbase: 1.5, steeringAngle: 0, maxSteeringAngle: 0.6 });
    assert.equal(straight.straight, true);
    assert.equal(straight.radius, null);
    assert.equal(straight.center, null);
    assert.equal(straight.extreme, false);

    const pastMax = simulatorTurn({ wheelbase: 1.5, steeringAngle: 1, maxSteeringAngle: 0.4 });
    assert.equal(pastMax.appliedAngle, 0.4);
    assert.notEqual(pastMax.requestedAngle, pastMax.appliedAngle);
    assert.equal(pastMax.extreme, false);

    const pastCap = simulatorTurn({ wheelbase: 1.5, steeringAngle: 2, maxSteeringAngle: 2 });
    closeTo(pastCap.appliedAngle, CAP);
    assert.equal(pastCap.extreme, true);
    assert.equal(clampPlantSteering(1, undefined), 0.6);
});

test("a turn center inside the track has no finite inner angle", () => {
    const singular = idealAckermann({
        rearAxleX: -0.75,
        frontAxleX: 0.75,
        halfTrack: 0.55,
        steeringAngle: 1.4,
        maxSteeringAngle: 1.4,
    });
    assert.equal(singular.singular, true);
    assert.equal(singular.leftAngle, null);
    assert.equal(singular.rightAngle, null);
    const yaws = visualWheelYaws(manifest({
        maxSteeringAngle: 1.4,
        frontX: 0.75,
        rearX: -0.75,
    }), 1.4);
    const front = yaws.filter((entry) => entry.wheelId.startsWith("front"));
    assert.equal(front.length, 2);
    closeTo(front[0].yaw, 1.4);
    closeTo(front[1].yaw, 1.4);
    assert.equal(yaws.find((entry) => entry.wheelId === "rear-left").yaw, 0);
});

test("version 3 ideal yaw is presentation and the plant still turns about the origin", () => {
    const source = manifest();
    const yaws = visualWheelYaws(source, 0.2);
    const left = yaws.find((entry) => entry.wheelId === "front-left").yaw;
    const right = yaws.find((entry) => entry.wheelId === "front-right").yaw;
    assert.ok(right > left);
    assert.ok(left > 0);

    const legacy = visualWheelYaws({
        version: 2,
        kinematics: { wheelbase: 1.5, maxSteeringAngle: 0.6 },
        wheels: [
            { id: "a", position: { x: 1, y: 0.2, z: 0.4 }, radius: 0.2, width: 0.1, steerable: true },
            { id: "b", position: { x: 1, y: 0.2, z: -0.4 }, radius: 0.2, width: 0.1, steerable: true },
        ],
    }, 0.2);
    closeTo(legacy[0].yaw, 0.2);
    closeTo(legacy[1].yaw, 0.2);

    const entry = {
        id: "turn-car",
        type: "turn-car",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        linearVelocity: { x: 2, y: 0, z: 0 },
        steeringAngle: 0.2,
    };
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, null, {
        manifest: source,
        motionModel: "bicycle",
    }));
    const shifted = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, null, {
        manifest: manifest({ rearX: 0.4, frontX: 1.9 }),
        motionModel: "bicycle",
    }));
    plant.update(0.05);
    shifted.update(0.05);
    const turn = simulatorTurn({
        wheelbase: plant.kinematics.wheelbase,
        steeringAngle: 0.2,
        maxSteeringAngle: plant.kinematics.maxSteeringAngle,
    });
    closeTo(plant.rotation.y, (2 / turn.wheelbase) * Math.tan(turn.appliedAngle) * 0.05);
    closeTo(plant.position.x, shifted.position.x);
    closeTo(plant.position.z, shifted.position.z);
    closeTo(plant.rotation.y, shifted.rotation.y);
    const shiftedGeometry = describeTurnGeometry(manifest({ rearX: 0.4, frontX: 1.9 }), 0.2);
    closeTo(shiftedGeometry.simulator.center.x, 0);
    closeTo(shiftedGeometry.ackermann.center.x, 0.4);
    assert.notEqual(shiftedGeometry.ackermann.center.x, shiftedGeometry.simulator.center.x);
});
