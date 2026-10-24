import assert from "node:assert/strict";
import test from "node:test";

import { VehicleDocumentSession } from "../app/vehicles/document/VehicleDocumentSession.js";
import { applyReviewedUrdfPatch } from "../app/vehicles/document/vehicleCommands.js";
import { createBlankVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { acceptUrdfImport, manifestFromUrdfImport, planUrdfImport } from "../app/vehicles/urdf/planUrdfImport.js";
import { carPackage } from "./helpers/urdf-fixtures.js";

function codes(issues) {
    return (issues ?? []).map((entry) => entry.code);
}

test("VEH-06c accepts a symmetric cylinder car and keeps sensors on the existing draft", () => {
    const plan = planUrdfImport(carPackage());
    assert.ok(plan.closure, codes(plan.diagnostics).join(","));
    assert.equal(plan.steering.status, "derived");
    assert.equal(plan.steering.maxSteeringAngle, 0.4);
    assert.equal(plan.wheelReview.front.review.withinTolerance, true);
    assert.equal(plan.wheelReview.rear.review.withinTolerance, true);
    assert.equal(plan.wheelReview.front.review.proposed.x, 0.8);
    assert.equal(plan.wheelReview.front.review.proposed.z, 0.5);
    assert.equal(plan.wheelReview.front.review.proposed.y, 0.25);

    const accepted = acceptUrdfImport(plan, { acceptAdjustments: true });
    assert.equal(accepted.ok, true, codes(accepted.issues).join(","));
    assert.equal(accepted.patch.wheelbase, 1.5);
    assert.equal(accepted.patch.maxSteeringAngle, 0.4);
    assert.equal(accepted.patch.wheels.length, 4);
    assert.equal(accepted.patch.model.scale, 1);

    const blank = createBlankVehicleManifest({ id: "city-car", name: "City car" });
    const session = new VehicleDocumentSession({ manifest: blank });
    const applied = session.execute(applyReviewedUrdfPatch(accepted.patch));
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    const draft = session.draft.snapshot();
    assert.equal(draft.name, "City car");
    assert.equal(draft.sensors[0].id, "roof-lidar");
    assert.equal(draft.kinematics.maxSpeed, blank.kinematics.maxSpeed);
    assert.equal(draft.kinematics.wheelbase, 1.5);
    assert.equal(draft.wheels.find((wheel) => wheel.id === "front-left").position.z, 0.5);

    const created = manifestFromUrdfImport(plan, accepted, { id: "imported-car", name: "Imported" });
    assert.equal(created.version, 3);
    assert.equal(created.name, "Imported");
    assert.equal(created.model.asset, accepted.patch.model.asset);
    assert.equal(created.dynamics.model, "contact-bicycle-v1");
    assert.equal(created.dynamics.mass, 1500);
});

test("VEH-06c keeps a pair inside tolerance and refuses a larger asymmetry", () => {
    const inside = planUrdfImport(carPackage({ rightY: -0.5004 }));
    assert.equal(inside.wheelReview.front.review.withinTolerance, true, codes(inside.diagnostics).join(","));
    const insideAccepted = acceptUrdfImport(inside, { acceptAdjustments: true });
    assert.equal(insideAccepted.ok, true, codes(insideAccepted.issues).join(","));

    const outside = planUrdfImport(carPackage({ rightY: -0.52 }));
    assert.equal(outside.closure == null, false);
    assert.equal(outside.wheelReview.front.review.withinTolerance, false);
    const refused = acceptUrdfImport(outside, { acceptAdjustments: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.patch, null);
});

test("VEH-06c requires an explicit limit when carrier ranges disagree", () => {
    const plan = planUrdfImport(carPackage({
        leftLower: -0.2,
        leftUpper: 0.5,
        rightLower: -0.5,
        rightUpper: 0.5,
    }));
    assert.equal(plan.steering.status, "required");
    assert.ok(plan.closure);
    const blocked = acceptUrdfImport(plan, { acceptAdjustments: true });
    assert.equal(blocked.ok, false);
    assert.ok(codes(blocked.issues).includes("vehicle.urdf.steering-limit-required"));
    const accepted = acceptUrdfImport(plan, { acceptAdjustments: true, maxSteeringAngle: 0.35 });
    assert.equal(accepted.ok, true, codes(accepted.issues).join(","));
    assert.equal(accepted.patch.maxSteeringAngle, 0.35);
});

test("VEH-06c does not change a draft when the steered axle is behind a fixed axle", () => {
    const blank = createBlankVehicleManifest({ id: "rear-steer", name: "Rear steer" });
    const session = new VehicleDocumentSession({ manifest: blank });
    const before = session.draft.snapshot();
    const plan = planUrdfImport(carPackage({ frontX: -0.7, rearX: 0.8 }));
    assert.ok(codes(plan.diagnostics).includes("vehicle.urdf.rear-steering"));
    const accepted = acceptUrdfImport(plan, { acceptAdjustments: true });
    assert.equal(accepted.ok, false);
    assert.deepEqual(session.draft.snapshot().wheels, before.wheels);
    assert.equal(session.draft.snapshot().name, "Rear steer");
});

test("VEH-06c hides an extra axle only when unclassified wheels are generated", () => {
    const plan = planUrdfImport(carPackage({ extraAxle: { x: -1.6 } }));
    assert.ok(plan.closure, codes(plan.diagnostics).join(","));
    assert.equal(plan.wheelReview.unclassified.length, 2);
    const omitted = acceptUrdfImport(plan, { acceptAdjustments: true });
    assert.equal(omitted.ok, true, codes(omitted.issues).join(","));
    assert.equal(omitted.patch.wheels.length, 4);
    assert.deepEqual(omitted.patch.model.hiddenNodeIndices, []);
    const generated = acceptUrdfImport(plan, { acceptAdjustments: true, unclassified: "generated" });
    assert.equal(generated.ok, true, codes(generated.issues).join(","));
    assert.equal(generated.patch.model.hiddenNodeIndices.length, 2);
    assert.equal(generated.patch.wheels.length, 6);
    assert.equal(generated.patch.wheels.filter((wheel) => wheel.visual).length, 4);
    const blank = createBlankVehicleManifest({ id: "extra-axle", name: "Extra axle" });
    const session = new VehicleDocumentSession({ manifest: blank });
    const applied = session.execute(applyReviewedUrdfPatch(generated.patch));
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    assert.deepEqual(session.draft.snapshot().model.hiddenNodeIndices, generated.patch.model.hiddenNodeIndices);
});
