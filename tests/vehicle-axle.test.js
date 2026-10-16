import assert from "node:assert/strict";
import test from "node:test";

import {
    deriveCompleteWheelbase,
    pairTolerance,
    proposeStandardPair,
    validateStandardAxles,
    validateVehicleAssetClosure,
    validateWheelBindings,
} from "../app/vehicles/axle/standardAxle.js";
import { normalizeVehicleManifest, validateVehicleManifest } from "../app/vehicles/VehicleManifest.js";

function wheel(id, axle, side, position, extras = {}) {
    return {
        id,
        axle,
        side,
        position,
        radius: 0.25,
        width: 0.15,
        steerable: axle === "front",
        ...extras,
    };
}

function layout(wheels, wheelbase = 1.5) {
    return normalizeVehicleManifest({
        version: 3,
        id: "axle-car",
        model: { asset: "car.glb" },
        wheels,
        kinematics: { wheelbase },
        sensors: [],
    });
}

const symmetric = () => layout([
    wheel("front-left", "front", "left", { x: 0.75, y: 0.25, z: 0.55 }),
    wheel("front-right", "front", "right", { x: 0.75, y: 0.25, z: -0.55 }),
    wheel("rear-left", "rear", "left", { x: -0.75, y: 0.25, z: 0.55 }),
    wheel("rear-right", "rear", "right", { x: -0.75, y: 0.25, z: -0.55 }),
]);

test("exact symmetry proposes zero adjustment and the derived wheelbase", () => {
    const manifest = symmetric();
    const proposal = proposeStandardPair(manifest.wheels[0], manifest.wheels[1], { axle: "front" });
    assert.equal(proposal.withinTolerance, true);
    assert.equal(proposal.maxAdjustment, 0);
    assert.equal(proposal.proposed.x, 0.75);
    assert.equal(proposal.proposed.z, 0.55);
    assert.equal(deriveCompleteWheelbase(manifest.wheels), 1.5);
    assert.equal(validateVehicleManifest(manifest).ok, true);
});

test("micrometer noise is inside pair tolerance and a larger gap is not", () => {
    const noisy = layout([
        wheel("front-left", "front", "left", { x: 0.75 + 1e-6, y: 0.25, z: 0.55 }),
        wheel("front-right", "front", "right", { x: 0.75, y: 0.25, z: -0.55 }),
    ], 1.5);
    const noise = proposeStandardPair(noisy.wheels[0], noisy.wheels[1], { axle: "front" });
    assert.equal(noise.withinTolerance, true);
    assert.ok(noise.maxAdjustment < pairTolerance(noisy.wheels[0].position.x, noisy.wheels[1].position.x));

    const gap = 0.002;
    const skewed = layout([
        wheel("front-left", "front", "left", { x: 0.75, y: 0.25, z: 0.55 }),
        wheel("front-right", "front", "right", { x: 0.75 + gap, y: 0.25, z: -0.55 }),
    ], 1.5);
    const proposal = proposeStandardPair(skewed.wheels[0], skewed.wheels[1], { axle: "front" });
    assert.equal(proposal.withinTolerance, false);
    assert.ok(proposal.maxAdjustment == null);
    assert.ok(Math.abs(gap) > pairTolerance(0.75, 0.75 + gap));
    assert.equal(validateVehicleManifest(skewed).ok, false);
    assert.ok(validateVehicleManifest(skewed).issues.some((entry) => entry.code === "vehicle.axle.asymmetric"));
});

test("normalization does not average an asymmetric pair or rewrite a mismatched wheelbase", () => {
    const manifest = layout([
        wheel("front-left", "front", "left", { x: 0.75, y: 0.25, z: 0.55 }),
        wheel("front-right", "front", "right", { x: 0.75, y: 0.25, z: -0.2 }),
    ], 2);
    assert.equal(manifest.wheels[0].position.z, 0.55);
    assert.equal(manifest.wheels[1].position.z, -0.2);
    assert.equal(manifest.kinematics.wheelbase, 2);
    const issues = validateStandardAxles(manifest);
    assert.ok(issues.some((entry) => entry.code === "vehicle.axle.asymmetric"));
    assert.equal(issues.some((entry) => entry.code === "vehicle.axle.wheelbase-mismatch"), false);
});

test("a complete layout must use the derived wheelbase and the axle steer rule", () => {
    const mismatched = symmetric();
    mismatched.kinematics.wheelbase = 2;
    const issues = validateStandardAxles(mismatched);
    assert.ok(issues.some((entry) => entry.code === "vehicle.axle.wheelbase-mismatch"));

    const fixedFront = layout([
        wheel("front-left", "front", "left", { x: 0.75, y: 0.25, z: 0.55 }, { steerable: false }),
        wheel("front-right", "front", "right", { x: 0.75, y: 0.25, z: -0.55 }, { steerable: false }),
    ]);
    assert.ok(validateStandardAxles(fixedFront).some((entry) => entry.code === "vehicle.axle.steer-mismatch"));
});

test("a partial layout keeps its authored wheelbase", () => {
    const frontOnly = layout([
        wheel("front-left", "front", "left", { x: 1, y: 0.25, z: 0.5 }),
        wheel("front-right", "front", "right", { x: 1, y: 0.25, z: -0.5 }),
        { id: "spare", position: { x: 0, y: 0.25, z: 0 }, radius: 0.2, width: 0.1, steerable: false },
    ], 2.2);
    assert.equal(deriveCompleteWheelbase(frontOnly.wheels), null);
    assert.equal(validateVehicleManifest(frontOnly).ok, true);
    assert.equal(frontOnly.kinematics.wheelbase, 2.2);
});

test("bindings reject duplicates, ancestor overlap, and an unverified node table", () => {
    const nodeTable = { count: 5, parents: [-1, 0, 1, 0, 3] };
    const bound = (leftIndex, rightIndex, hidden = []) => layout([
        wheel("front-left", "front", "left", { x: 0.75, y: 0.25, z: 0.55 }, { visual: { kind: "model-node", nodeIndex: leftIndex } }),
        wheel("front-right", "front", "right", { x: 0.75, y: 0.25, z: -0.55 }, { visual: { kind: "model-node", nodeIndex: rightIndex } }),
    ], 1.5);
    const siblings = bound(1, 3);
    siblings.model.hiddenNodeIndices = [];
    assert.equal(validateWheelBindings(siblings, nodeTable).length, 0);

    const nested = bound(1, 2);
    assert.ok(validateWheelBindings(nested, nodeTable).some((entry) => entry.code === "vehicle.wheel.ancestor-overlap"));

    const duplicate = bound(3, 3);
    assert.ok(validateWheelBindings(duplicate, nodeTable).some((entry) => entry.code === "vehicle.wheel.duplicate-binding"));

    const hiddenRoot = bound(2, 3);
    hiddenRoot.model.hiddenNodeIndices = [0];
    assert.ok(validateWheelBindings(hiddenRoot, nodeTable).some((entry) => entry.code === "vehicle.wheel.ancestor-overlap"));

    assert.ok(validateWheelBindings(siblings).some((entry) => entry.code === "vehicle.model.nodes-unverified"));
    const closure = validateVehicleAssetClosure(siblings, { files: {}, nodeTable });
    assert.equal(closure.some((entry) => entry.code === "vehicle.model.missing-dependency"), false);
    siblings.model.dependencies = ["missing.png"];
    assert.ok(validateVehicleAssetClosure(siblings, { files: {}, nodeTable }).some((entry) => entry.code === "vehicle.model.missing-dependency"));
});
