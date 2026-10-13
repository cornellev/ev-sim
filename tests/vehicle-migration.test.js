import assert from "node:assert/strict";
import test from "node:test";

import { computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import { planVehicleMigration } from "../app/vehicles/migration/planVehicleMigration.js";
import {
    VEHICLE_MANIFEST_DOWNGRADE,
    assertNoVehicleManifestDowngrade,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";

const shell = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }));

function encodeModel() {
    return { asset: "canon.glb", dependencies: ["wheel.bin", "body.bin"], sha256: "abc" };
}

function bigCarPlan(options = {}) {
    return planVehicleMigration(getBuiltInVehicleManifest("big-car"), {
        publicFiles: { "/shell/shell.gltf": shell },
        encodeModel,
        ...options,
    });
}

test("a model-free vehicle migrates to version 3 without an encoder", () => {
    const plan = planVehicleMigration({ version: 2, id: "box", name: "Box" });
    assert.equal(plan.ok, true);
    assert.equal(plan.proposedManifest.version, 3);
    assert.equal(plan.proposedManifest.model.asset, null);
    assert.deepEqual(plan.proposedManifest.model.dependencies, []);
    assert.deepEqual(plan.proposedManifest.model.hiddenNodeIndices, []);
    assert.equal(plan.assetPlan.operations[0].op, "model-free");
    assert.equal(plan.snapshot.kind, "cev-sim.vehicle-pre-migration");
    assert.equal(plan.proposedManifest.wheels.every((wheel) => wheel.axle === undefined), true);
});

test("version 1 migration keeps the permissive actuator defaults", () => {
    const plan = planVehicleMigration({
        kind: "cev-sim.vehicle",
        version: 1,
        id: "legacy",
        kinematics: { wheelbase: 2, maxSteeringAngle: 0.5 },
        wheels: [],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.proposedManifest.version, 3);
    assert.equal(plan.proposedManifest.kinematics.maxSpeed, 40);
    assert.equal(plan.proposedManifest.kinematics.maxJerk, 1e6);
    assert.equal(plan.proposedManifest.kinematics.wheelbase, 2);
    assert.equal(plan.proposedManifest.kinematics.responseDelayNs, 0);
});

test("local glTF closures encode, and a missing buffer blocks migration", () => {
    const gltf = Buffer.from(JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "car.bin" }],
    }));
    const source = { version: 2, id: "local", model: { asset: "car.gltf" } };
    const ready = planVehicleMigration(source, {
        files: { "car.gltf": gltf, "car.bin": Buffer.from("bytes") },
        encodeModel: () => ({ asset: "sha.glb", dependencies: ["sha.bin"] }),
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.proposedManifest.model.asset, "sha.glb");
    assert.deepEqual(ready.proposedManifest.model.dependencies, ["sha.bin"]);
    assert.equal(ready.assetPlan.operations[0].op, "encode-canonical-glb");
    assert.equal(ready.snapshot.assets["car.bin"].length, 64);

    const missing = planVehicleMigration(source, {
        files: { "car.gltf": gltf },
        encodeModel: () => ({ asset: "sha.glb", dependencies: [] }),
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.proposedManifest, null);
    assert.equal(missing.assetPlan.operations[0].op, "missing-dependency");
    assert.ok(missing.diagnostics.some((entry) => entry.code === "vehicle.model.missing-dependency"));
});

test("an external model URL waits for a selected local package", () => {
    const source = { version: 2, id: "remote", model: { asset: "https://example.com/car.glb" } };
    const blocked = planVehicleMigration(source, { encodeModel });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.proposedManifest, null);
    assert.equal(blocked.assetPlan.operations[0].op, "require-local-package");

    const accepted = planVehicleMigration(source, {
        localPackage: {
            entryPath: "robot.gltf",
            files: { "robot.gltf": shell },
        },
        encodeModel: () => ({ asset: "packed.glb", dependencies: [] }),
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.proposedManifest.model.asset, "packed.glb");
});

test("canonical encoding is required before a version 2 model can migrate", () => {
    const plan = planVehicleMigration({
        version: 2,
        id: "binary",
        model: { asset: "car.glb" },
    }, {
        files: { "car.glb": Buffer.from("glTF") },
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.proposedManifest, null);
    assert.equal(plan.assetPlan.operations[0].op, "encode-canonical-glb");
    assert.equal(plan.assetPlan.operations[0].outputs, null);
    assert.ok(plan.diagnostics.some((entry) => entry.code === "vehicle.migration.encoder-unavailable"));
});

test("BigCar standardization acknowledges the 1.2446 m to 1.5 m wheelbase change", () => {
    const before = getBuiltInVehicleManifest("big-car");
    const unclassified = bigCarPlan();
    assert.equal(unclassified.ok, true);
    assert.equal(unclassified.proposedManifest.kinematics.wheelbase, 1.2446);
    assert.equal(unclassified.proposedManifest.wheels.every((wheel) => wheel.axle === undefined), true);
    assert.deepEqual(getBuiltInVehicleManifest("big-car"), before);

    const blocked = bigCarPlan({ standardizeLayout: true });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.proposedManifest, null);
    assert.equal(blocked.acknowledgements[0].code, "wheelbase-change");
    assert.equal(blocked.acknowledgements[0].before, 1.2446);
    assert.equal(blocked.acknowledgements[0].after, 1.5);
    assert.equal(blocked.acknowledgements[0].motion.yawRateScale, 1.2446 / 1.5);
    assert.equal(blocked.acknowledgements[0].motion.turnRadiusScale, 1.5 / 1.2446);
    assert.ok(blocked.changes.some((change) => change.path === "kinematics.wheelbase" && change.after === 1.5));

    const accepted = bigCarPlan({ standardizeLayout: true, acknowledgeWheelbase: true });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.proposedManifest.kinematics.wheelbase, 1.5);
    assert.deepEqual(
        accepted.proposedManifest.wheels.map((wheel) => [wheel.id, wheel.axle, wheel.side, wheel.steerable]),
        [
            ["front-left", "front", "left", true],
            ["front-right", "front", "right", true],
            ["rear-left", "rear", "left", false],
            ["rear-right", "rear", "right", false],
        ],
    );
    assert.deepEqual(accepted.proposedManifest.model.dependencies, ["body.bin", "wheel.bin"]);
    assert.equal(getBuiltInVehicleManifest("big-car").version, 2);
    assert.equal(
        computeResolvedRunHash(getBuiltInVehicleManifest("big-car")),
        "4c39469acfa250f98dfee99560ea646619aa65230415b39c6c31b46368f161af",
    );
});

test("a pair outside tolerance blocks standardization", () => {
    const plan = planVehicleMigration({
        version: 2,
        id: "skew",
        wheels: [
            { id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "front-right", position: { x: 0.9, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: true },
        ],
    }, { standardizeLayout: true });
    assert.equal(plan.ok, false);
    assert.equal(plan.proposedManifest, null);
    assert.ok(plan.diagnostics.some((entry) => entry.code === "vehicle.axle.asymmetric"));
});

test("an already version 3 vehicle plans an identity migration", () => {
    const source = normalizeVehicleManifest({
        version: 3,
        id: "keep",
        model: { asset: "car.glb", dependencies: ["b.png", "a.png"], hiddenNodeIndices: [3, 1] },
        kinematics: { wheelbase: 2 },
    });
    const plan = planVehicleMigration(source);
    assert.equal(plan.ok, true);
    assert.equal(plan.proposedManifest.model.asset, "car.glb");
    assert.deepEqual(plan.proposedManifest.model.dependencies, ["a.png", "b.png"]);
    assert.deepEqual(plan.proposedManifest.model.hiddenNodeIndices, [1, 3]);
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.assetPlan.operations.length, 0);
});

test("a legacy writer is rejected before it can discard version 3 fields", () => {
    assert.throws(
        () => assertNoVehicleManifestDowngrade({ version: 3 }, { version: 2 }),
        (error) => error.code === VEHICLE_MANIFEST_DOWNGRADE,
    );
    assert.doesNotThrow(() => assertNoVehicleManifestDowngrade({ version: 3 }, { version: 3 }));
    assert.doesNotThrow(() => assertNoVehicleManifestDowngrade({ version: 2 }, { version: 2 }));
});
