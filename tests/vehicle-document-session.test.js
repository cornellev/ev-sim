import assert from "node:assert/strict";
import test from "node:test";

import { VehicleDocumentSession } from "../app/vehicles/document/VehicleDocumentSession.js";
import {
    applyMigration,
    applyModelReplacement,
    applyReviewedUrdfPatch,
    detachWheel,
    editAxle,
    editKinematics,
    reattachWheel,
    setStagedResources,
} from "../app/vehicles/document/vehicleCommands.js";
import { planVehicleMigration } from "../app/vehicles/migration/planVehicleMigration.js";
import { createDefaultVehicleManifest, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";

function standardVehicle(patch = {}) {
    return normalizeVehicleManifest({
        version: 3,
        id: "axle-car",
        name: "Axle Car",
        model: { asset: "car.glb", dependencies: [], hiddenNodeIndices: [] },
        wheels: [
            { id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: true, axle: "front", side: "left" },
            { id: "front-right", position: { x: 0.75, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: true, axle: "front", side: "right" },
            { id: "rear-left", position: { x: -0.75, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: false, axle: "rear", side: "left" },
            { id: "rear-right", position: { x: -0.75, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: false, axle: "rear", side: "right" },
        ],
        kinematics: { wheelbase: 1.5, maxSpeed: 15 },
        sensors: [{ id: "roof-lidar", type: "lidar3d", pose: { position: { x: 0, y: 1, z: 0 }, rotation: {} }, config: {} }],
        ...patch,
    });
}

test("an axle gesture is one undo item and cancel writes no history", () => {
    const session = new VehicleDocumentSession({ manifest: standardVehicle(), revision: 1, definitionHash: "a" });
    assert.equal(session.beginGesture({ kind: "axle", axle: "front", label: "Front axle" }).ok, true);
    assert.equal(session.previewGesture({ x: 1 }).ok, true);
    assert.equal(session.previewGesture({ x: 1.2 }).ok, true);
    assert.equal(session.history.length, 0);
    assert.equal(session.commitGesture().ok, true);
    assert.equal(session.history.length, 1);
    assert.equal(session.draft.snapshot().wheels[0].position.x, 1.2);
    assert.equal(session.draft.snapshot().wheels[1].position.x, 1.2);
    assert.equal(session.draft.snapshot().kinematics.wheelbase, 1.95);
    assert.equal(session.undo().ok, true);
    assert.equal(session.draft.snapshot().wheels[0].position.x, 0.75);
    assert.equal(session.draft.snapshot().kinematics.wheelbase, 1.5);

    const again = new VehicleDocumentSession({ manifest: standardVehicle() });
    again.beginGesture({ kind: "axle", axle: "front" });
    again.previewGesture({ x: 1.1 });
    assert.equal(again.cancelGesture().ok, true);
    assert.equal(again.history.length, 0);
    assert.equal(again.draft.snapshot().wheels[0].position.x, 0.75);
    assert.equal(again.dirty, false);
});

test("model-bound axle geometry stays locked until the wheel is detached", () => {
    const manifest = standardVehicle();
    manifest.wheels[0].visual = { kind: "model-node", nodeIndex: 4 };
    manifest.wheels[1].visual = { kind: "model-node", nodeIndex: 5 };
    const session = new VehicleDocumentSession({ manifest });
    const locked = session.execute(editAxle({ axle: "front", patch: { x: 1 } }));
    assert.equal(locked.ok, false);
    assert.equal(locked.issues[0].code, "vehicle.axle.geometry-locked");
    assert.equal(session.history.length, 0);

    assert.equal(session.execute(detachWheel({ wheelId: "front-left" })).ok, true);
    assert.equal(session.execute(detachWheel({ wheelId: "front-right" })).ok, true);
    assert.deepEqual(session.draft.snapshot().model.hiddenNodeIndices, [4, 5]);
    assert.equal(session.draft.snapshot().wheels[0].visual, undefined);
    assert.equal(session.execute(editAxle({ axle: "front", patch: { x: 1 } })).ok, true);
    assert.equal(session.undo().ok, true);
    assert.equal(session.draft.snapshot().wheels[0].position.x, 0.75);

    assert.equal(session.execute(reattachWheel({ wheelId: "front-left", nodeIndex: 4 })).ok, true);
    assert.equal(session.undo().ok, true);
    assert.equal(session.draft.snapshot().wheels[0].visual, undefined);
    assert.deepEqual(session.draft.snapshot().model.hiddenNodeIndices, [4, 5]);
    session.redo();
    assert.equal(session.draft.snapshot().wheels[0].visual.nodeIndex, 4);
    assert.deepEqual(session.draft.snapshot().model.hiddenNodeIndices, [5]);
});

test("migration apply is one draft change and a blocked plan does nothing", () => {
    const session = new VehicleDocumentSession({
        manifest: createDefaultVehicleManifest({ id: "box" }),
        revision: 3,
        definitionHash: "before",
    });
    const blocked = planVehicleMigration({
        version: 2,
        id: "box",
        model: { asset: "https://example.com/car.glb" },
    });
    assert.equal(session.execute(applyMigration(blocked)).ok, false);
    assert.equal(session.draft.snapshot().version, 2);
    assert.equal(session.history.length, 0);

    const plan = planVehicleMigration(createDefaultVehicleManifest({ id: "box" }));
    assert.equal(session.execute(applyMigration(plan)).ok, true);
    assert.equal(session.draft.snapshot().version, 3);
    assert.equal(session.history.length, 1);
    assert.equal(session.dirty, true);
    assert.equal(session.undo().ok, true);
    assert.equal(session.draft.snapshot().version, 2);
});

test("an edit during save stays dirty and a failed save keeps the draft and stage", () => {
    const session = new VehicleDocumentSession({ manifest: standardVehicle(), revision: 1, definitionHash: "old" });
    const stage = { stageId: "stage-1", operationId: "op-1", members: [{ name: "car.glb", sha256: "ab", size: 3, mediaType: "model/gltf-binary" }] };
    assert.equal(session.execute(setStagedResources(stage)).ok, true);
    const capture = session.beginSave();
    assert.equal(session.execute(editKinematics({ patch: { maxSpeed: 12 } })).ok, true);
    const acknowledged = session.acknowledgeSave({ generation: capture.generation, revision: 2, definitionHash: "saved" });
    assert.equal(acknowledged.ok, true);
    assert.equal(acknowledged.dirty, true);
    assert.equal(session.baseline.revision, 2);
    assert.equal(session.baseline.definitionHash, "saved");
    assert.equal(session.baseline.manifest.kinematics.maxSpeed, 15);
    assert.equal(session.draft.snapshot().kinematics.maxSpeed, 12);
    assert.equal(session.stagedResources.stageId, "stage-1");

    const direct = new VehicleDocumentSession({ manifest: standardVehicle(), revision: 1, definitionHash: "old" });
    direct.execute(setStagedResources(stage));
    const saved = direct.beginSave();
    direct.failSave();
    assert.equal(direct.draft.snapshot().kinematics.maxSpeed, 15);
    assert.equal(direct.stagedResources.stageId, "stage-1");
    assert.equal(direct.acknowledgeSave({ generation: saved.generation, revision: 2, definitionHash: "nope" }).ok, false);

    const clean = new VehicleDocumentSession({ manifest: standardVehicle(), revision: 4, definitionHash: "same" });
    const cleanCapture = clean.beginSave();
    const done = clean.acknowledgeSave({ generation: cleanCapture.generation, revision: 4, definitionHash: "same" });
    assert.equal(done.dirty, false);
    assert.equal(clean.dirty, false);
});

test("raw JSON and a reviewed URDF patch share the command boundary", () => {
    const session = new VehicleDocumentSession({ manifest: standardVehicle(), revision: 1, definitionHash: "a" });
    const invalid = session.replaceFromText("{");
    assert.equal(invalid.ok, false);
    assert.equal(session.history.length, 0);

    const replacement = standardVehicle();
    replacement.name = "Renamed";
    assert.equal(session.replaceFromText(JSON.stringify(replacement)).ok, true);
    assert.equal(session.draft.snapshot().name, "Renamed");
    assert.equal(session.history.length, 1);

    const applied = session.execute(applyReviewedUrdfPatch({
        model: { asset: "body.glb", dependencies: [] },
        wheels: [
            { id: "front-left", position: { x: 1, y: 0.2, z: 0.4 }, radius: 0.2, width: 0.1, steerable: true },
            { id: "rear-left", position: { x: -1, y: 0.2, z: 0.4 }, radius: 0.2, width: 0.1, steerable: false },
        ],
        wheelbase: 2,
        maxSteeringAngle: 0.4,
    }));
    assert.equal(applied.ok, true);
    const draft = session.draft.snapshot();
    assert.equal(draft.model.asset, "body.glb");
    assert.equal(draft.model.hiddenNodeIndices.length, 0);
    assert.equal(draft.kinematics.wheelbase, 2);
    assert.equal(draft.kinematics.maxSteeringAngle, 0.4);
    assert.equal(draft.kinematics.maxSpeed, 15);
    assert.equal(draft.sensors[0].id, "roof-lidar");
    assert.equal(draft.name, "Renamed");
    assert.equal(draft.wheels.every((wheel) => wheel.visual === undefined), true);
});

test("model replacement clears bindings and keeps actuators and sensors", () => {
    const manifest = standardVehicle();
    manifest.wheels[0].visual = { kind: "model-node", nodeIndex: 2 };
    manifest.model.hiddenNodeIndices = [1];
    const session = new VehicleDocumentSession({ manifest });
    assert.equal(session.execute(applyModelReplacement({
        model: { asset: "next.glb", dependencies: ["next.bin"] },
    })).ok, true);
    const draft = session.draft.snapshot();
    assert.equal(draft.model.asset, "next.glb");
    assert.deepEqual(draft.model.dependencies, ["next.bin"]);
    assert.deepEqual(draft.model.hiddenNodeIndices, []);
    assert.equal(draft.wheels[0].visual, undefined);
    assert.equal(draft.kinematics.maxSpeed, 15);
    assert.equal(draft.sensors[0].id, "roof-lidar");
});

test("a direct wheelbase edit is rejected once both standard axles exist", () => {
    const session = new VehicleDocumentSession({ manifest: standardVehicle() });
    const rejected = session.execute(editKinematics({ patch: { wheelbase: 2 } }));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.issues[0].code, "vehicle.axle.wheelbase-mismatch");
    assert.equal(session.draft.snapshot().kinematics.wheelbase, 1.5);
    assert.equal(session.execute(editKinematics({ patch: { maxSpeed: 9 } })).ok, true);
    assert.equal(session.draft.snapshot().kinematics.maxSpeed, 9);
});
