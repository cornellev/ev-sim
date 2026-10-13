import assert from "node:assert/strict";
import test from "node:test";

import { createAxleGesture } from "../app/vehicles/editor/axleGesture.js";
import { normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";

function manifest(patch = {}) {
    return normalizeVehicleManifest({
        version: 3,
        id: "gesture-car",
        name: "Gesture",
        wheels: [
            { id: "front-left", axle: "front", side: "left", position: { x: 0.75, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "front-right", axle: "front", side: "right", position: { x: 0.75, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "rear-left", axle: "rear", side: "left", position: { x: -0.75, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: false },
            { id: "rear-right", axle: "rear", side: "right", position: { x: -0.75, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: false },
        ],
        kinematics: { wheelbase: 1.5, maxSpeed: 15 },
        ...patch,
    });
}

test("an axle preview updates both wheels and commit reports one change", () => {
    const gesture = createAxleGesture(manifest(), { axle: "front" });
    const preview = gesture.preview({ x: 1.2 });
    assert.equal(preview.ok, true);
    assert.equal(preview.changed, true);
    assert.equal(preview.manifest.wheels[0].position.x, 1.2);
    assert.equal(preview.manifest.wheels[1].position.x, 1.2);
    assert.equal(preview.manifest.kinematics.wheelbase, 1.95);
    assert.equal(gesture.capture().wheels[0].position.x, 0.75);
    const committed = gesture.commit();
    assert.equal(committed.changed, true);
    assert.equal(committed.manifest.kinematics.wheelbase, 1.95);
});

test("a failed preview restores the capture and commit writes nothing", () => {
    const locked = manifest();
    locked.wheels[0].visual = { kind: "model-node", nodeIndex: 4 };
    locked.wheels[1].visual = { kind: "model-node", nodeIndex: 5 };
    const gesture = createAxleGesture(locked, { axle: "front" });
    const preview = gesture.preview({ x: 1 });
    assert.equal(preview.ok, false);
    assert.equal(preview.changed, false);
    assert.equal(preview.issues[0].code, "vehicle.axle.geometry-locked");
    assert.equal(preview.manifest.wheels[0].position.x, 0.75);
    assert.equal(gesture.commit().changed, false);

    const collapsed = createAxleGesture(manifest(), { axle: "front" });
    const rejected = collapsed.preview({ x: -0.75 });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.issues[0].code, "vehicle.axle.wheelbase-mismatch");
    assert.equal(rejected.manifest.wheels[0].position.x, 0.75);
    assert.equal(collapsed.commit().changed, false);
});

test("an unchanged preview does not count as a commit", () => {
    const source = manifest();
    const gesture = createAxleGesture(source, { axle: "front" });
    const preview = gesture.preview({ x: source.wheels[0].position.x });
    assert.equal(preview.ok, true);
    assert.equal(preview.changed, false);
    assert.equal(gesture.commit().changed, false);
});
