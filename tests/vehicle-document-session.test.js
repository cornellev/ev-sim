import assert from "node:assert/strict";
import test from "node:test";

import { publishVehicleDraft } from "../app/vehicles/document/publishVehicleDraft.js";
import { VehicleDocumentSession } from "../app/vehicles/document/VehicleDocumentSession.js";
import {
    applyMigration,
    applyModelReplacement,
    applyPlacementChange,
    applyReviewedUrdfPatch,
    assignModelWheels,
    detachWheel,
    editAxle,
    editKinematics,
    reattachWheel,
    setStagedResources,
    suppressSourceWheels,
} from "../app/vehicles/document/vehicleCommands.js";
import { measurePlacedVehicleModel } from "../app/vehicles/model/measurePlacedVehicle.js";
import { buildBoxGlb, symmetricWheelParts } from "./helpers/vehicle-wheel-glb.js";
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

test("publishing a draft acknowledges the captured generation and keeps the stage after a conflict", async () => {
    const session = new VehicleDocumentSession({ manifest: standardVehicle(), revision: 4, definitionHash: "old" });
    const stage = { stageId: "stage-1", members: [{ name: "car.glb", sha256: "ab", size: 3, mediaType: "model/gltf-binary" }] };
    assert.equal(session.execute(setStagedResources(stage)).ok, true);
    const client = {
        async readVehicleStageMember() {
            return { sha256: "ab", size: 3, mediaType: "model/gltf-binary" };
        },
        async saveVehicleManifest() {
            session.execute(editKinematics({ patch: { maxSpeed: 9 } }));
            return { revision: 5, definitionHash: "saved" };
        },
    };
    const saved = await publishVehicleDraft(session, client, { operationId: "a".repeat(64) });
    assert.equal(saved.ok, true);
    assert.equal(saved.dirty, true);
    assert.equal(session.baseline.revision, 5);
    assert.equal(session.baseline.manifest.kinematics.maxSpeed, 15);
    assert.equal(session.draft.snapshot().kinematics.maxSpeed, 9);

    const conflicted = new VehicleDocumentSession({ manifest: standardVehicle(), revision: 4, definitionHash: "old" });
    conflicted.execute(setStagedResources(stage));
    await assert.rejects(() => publishVehicleDraft(conflicted, {
        async readVehicleStageMember() {
            return { sha256: "ff", size: 3, mediaType: "model/gltf-binary" };
        },
        async saveVehicleManifest() {
            throw new Error("should not save");
        },
    }, { operationId: "b".repeat(64) }), /does not match the server digest/);
    assert.equal(conflicted.dirty, false);
    assert.equal(conflicted.stagedResources.stageId, "stage-1");
    assert.equal(conflicted.saveCapture, null);
});

function withZone(manifest) {
    manifest.lidarZone = {
        params: { voxelSize: 0.2 },
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        triangles: [[0, 1, 2]],
    };
    return manifest;
}

function wheelMeasurement(manifest, parts = symmetricWheelParts()) {
    const glbBytes = buildBoxGlb(parts);
    return {
        glbBytes,
        measurement: measurePlacedVehicleModel({
            glbBytes,
            model: manifest.model,
            boundingBox: manifest.boundingBox,
        }),
    };
}

test("assigning a measured pair is one undo item and requires acceptance", () => {
    const manifest = withZone(standardVehicle());
    const { measurement } = wheelMeasurement(manifest);
    const session = new VehicleDocumentSession({ manifest });
    const blocked = session.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        measurement,
        acceptAdjustments: false,
    }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.review.withinTolerance, true);
    assert.equal(session.history.length, 0);
    assert.equal(session.draft.snapshot().lidarZone.vertices.length, 3);

    const applied = session.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        measurement,
        acceptAdjustments: true,
    }));
    assert.equal(applied.ok, true);
    assert.equal(session.history.length, 1);
    const draft = session.draft.snapshot();
    assert.equal(draft.wheels[0].visual.nodeIndex, 0);
    assert.equal(draft.wheels[1].visual.nodeIndex, 1);
    assert.equal(draft.lidarZone.vertices.length, 0);
    assert.equal(session.undo().ok, true);
    assert.equal(session.draft.snapshot().wheels[0].visual, undefined);
    assert.equal(session.draft.snapshot().lidarZone.vertices.length, 3);
});

test("suppressing source wheels hides them and adds unclassified cylinders", () => {
    const manifest = withZone(standardVehicle());
    const parts = symmetricWheelParts();
    parts[1] = { ...parts[1], center: { x: 0.875, y: 0.25, z: -0.5 } };
    const { measurement } = wheelMeasurement(manifest, parts);
    const session = new VehicleDocumentSession({ manifest });
    const blocked = session.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        measurement,
        acceptAdjustments: true,
    }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.issues.some((entry) => entry.code === "vehicle.axle.asymmetric"), true);

    const replaced = session.execute(suppressSourceWheels({ nodeIndices: [0, 1], measurement }));
    assert.equal(replaced.ok, true);
    assert.equal(session.history.length, 1);
    const draft = session.draft.snapshot();
    assert.deepEqual(draft.model.hiddenNodeIndices, [0, 1]);
    assert.equal(draft.wheels.some((wheel) => wheel.id === "generated-0" && wheel.axle === undefined && wheel.visual === undefined), true);
    assert.equal(draft.wheels.some((wheel) => wheel.id === "generated-1" && wheel.side === undefined), true);
    assert.equal(draft.lidarZone.vertices.length, 0);
    assert.equal(session.undo().ok, true);
    assert.deepEqual(session.draft.snapshot().model.hiddenNodeIndices, []);
});

test("suppressing an ancestor of a bound wheel does not change the draft", () => {
    const manifest = standardVehicle();
    manifest.wheels[1].visual = { kind: "model-node", nodeIndex: 1 };
    const session = new VehicleDocumentSession({ manifest });
    const measurement = {
        nodes: [{ nodeIndex: 1, center: { x: 0.75, y: 0.25, z: -0.5 }, radius: 0.25, width: 0.25, size: { x: 0.5, y: 0.5, z: 0.25 }, radialDelta: 0 }],
        nodeTable: { count: 2, parents: [-1, 0] },
    };
    const blocked = session.execute(suppressSourceWheels({ nodeIndices: [0], measurement }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.issues[0].code, "vehicle.wheel.ancestor-overlap");
    assert.equal(session.history.length, 0);
    assert.equal(session.draft.snapshot().wheels[1].visual.nodeIndex, 1);
});

test("placement that breaks a bound pair is rejected and a smaller shift requires acceptance", () => {
    const manifest = withZone(standardVehicle());
    const { glbBytes, measurement } = wheelMeasurement(manifest);
    const session = new VehicleDocumentSession({ manifest });
    assert.equal(session.execute(assignModelWheels({
        axle: "front",
        leftNodeIndex: 0,
        rightNodeIndex: 1,
        measurement,
        acceptAdjustments: true,
    })).ok, true);
    const assigned = session.draft.snapshot();
    const asymmetric = structuredClone(measurement);
    asymmetric.nodes[1] = {
        ...asymmetric.nodes[1],
        center: { ...asymmetric.nodes[1].center, x: asymmetric.nodes[1].center.x + 0.05 },
    };
    const rejected = session.execute(applyPlacementChange({
        model: { offset: { x: 0.05, y: 0, z: 0 } },
        measurement: asymmetric,
    }));
    assert.equal(rejected.ok, false);
    assert.equal(session.draft.snapshot().model.offset.x, assigned.model.offset.x);
    assert.equal(session.draft.snapshot().wheels[0].visual.nodeIndex, 0);

    const nudged = session.execute(applyPlacementChange({
        model: { offset: { x: 0.0005, y: 0, z: 0 } },
        glbBytes,
    }));
    assert.equal(nudged.ok, false);
    assert.equal(nudged.review.needsAcceptance, true);
    assert.ok(nudged.review.axles[0].movement > 0.0004 && nudged.review.axles[0].movement < 0.0006);
    assert.equal(session.draft.snapshot().model.offset.x, assigned.model.offset.x);

    const accepted = session.execute(applyPlacementChange({
        model: { offset: { x: 0.0005, y: 0, z: 0 } },
        glbBytes,
        acceptAdjustments: true,
    }));
    assert.equal(accepted.ok, true);
    assert.equal(session.draft.snapshot().model.offset.x, 0.0005);
    assert.notEqual(session.draft.snapshot().wheels[0].position.x, assigned.wheels[0].position.x);
    assert.equal(session.draft.snapshot().lidarZone.vertices.length, 0);
});

test("detach and reattach clear the baked zone and undo restores both", () => {
    const manifest = withZone(standardVehicle());
    manifest.wheels[0].visual = { kind: "model-node", nodeIndex: 4 };
    const session = new VehicleDocumentSession({ manifest });
    assert.equal(session.execute(detachWheel({ wheelId: "front-left" })).ok, true);
    assert.deepEqual(session.draft.snapshot().model.hiddenNodeIndices, [4]);
    assert.equal(session.draft.snapshot().wheels[0].visual, undefined);
    assert.equal(session.draft.snapshot().lidarZone.vertices.length, 0);
    assert.equal(session.undo().ok, true);
    assert.equal(session.draft.snapshot().wheels[0].visual.nodeIndex, 4);
    assert.equal(session.draft.snapshot().lidarZone.vertices.length, 3);
    assert.equal(session.execute(detachWheel({ wheelId: "front-left" })).ok, true);
    assert.equal(session.execute(reattachWheel({ wheelId: "front-left", nodeIndex: 4 })).ok, true);
    assert.equal(session.draft.snapshot().wheels[0].visual.nodeIndex, 4);
    assert.deepEqual(session.draft.snapshot().model.hiddenNodeIndices, []);
    assert.equal(session.undo().ok, true);
    assert.equal(session.draft.snapshot().wheels[0].visual, undefined);
    assert.equal(session.redo().ok, true);
    assert.equal(session.draft.snapshot().wheels[0].visual.nodeIndex, 4);
});

test("undo restores the staged resources captured with that edit", () => {
    const session = new VehicleDocumentSession({ manifest: standardVehicle() });
    const stage = { stageId: "stage-1", members: [{ name: "car.glb", sha256: "ab", size: 4 }] };
    assert.equal(session.execute({
        label: "Replace model",
        run(context) {
            context.setStagedResources(stage);
            context.setManifest({ ...context.manifest, name: "Staged" });
            return { ok: true };
        },
    }).ok, true);
    assert.equal(session.stagedResources.stageId, "stage-1");
    assert.equal(session.undo().ok, true);
    assert.equal(session.stagedResources, null);
    assert.equal(session.draft.snapshot().name, "Axle Car");
    assert.equal(session.redo().ok, true);
    assert.equal(session.stagedResources.stageId, "stage-1");
    assert.equal(session.draft.snapshot().name, "Staged");
});

test("coalesced edits are one history entry and still move the save generation", () => {
    const session = new VehicleDocumentSession({ manifest: standardVehicle() });
    const rename = (name, now) => session.executeCoalesced({
        label: "Name",
        run(context) {
            context.setManifest({ ...context.manifest, name });
            return { ok: true };
        },
    }, { key: "name", now });
    assert.equal(rename("One", 1000).ok, true);
    assert.equal(rename("Two", 1200).ok, true);
    assert.equal(session.history.length, 1);
    assert.equal(session.draft.snapshot().name, "Two");
    assert.equal(session.draft.generation, 2);
    assert.equal(session.undo().ok, true);
    assert.equal(session.draft.snapshot().name, "Axle Car");
    assert.equal(rename("Later", 3000).ok, true);
    assert.equal(session.history.length, 1);
});
