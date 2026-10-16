import assert from "node:assert/strict";
import test from "node:test";

import { VehicleEditorController } from "../app/vehicles/editor/VehicleEditorController.js";
import { VehicleDocumentSession } from "../app/vehicles/document/VehicleDocumentSession.js";
import { editManifestFields } from "../app/vehicles/document/vehicleCommands.js";
import {
    applyLinkedWheelMotion,
    resolveMotionLink,
} from "../app/vehicles/document/wheelLink.js";
import { cloneJson } from "../app/util/cloneJson.js";
import { normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";

function wheel(id, position, extras = {}) {
    return {
        id,
        position,
        radius: 0.25,
        width: 0.15,
        steerable: false,
        ...extras,
    };
}

function standardWheels() {
    return [
        wheel("front-left", { x: 0.75, y: 0.25, z: 0.55 }, { axle: "front", side: "left", steerable: true }),
        wheel("front-right", { x: 0.75, y: 0.25, z: -0.55 }, { axle: "front", side: "right", steerable: true }),
        wheel("rear-left", { x: -0.75, y: 0.25, z: 0.55 }, { axle: "rear", side: "left" }),
        wheel("rear-right", { x: -0.75, y: 0.25, z: -0.55 }, { axle: "rear", side: "right" }),
    ];
}

function manifest(wheels = standardWheels(), patch = {}) {
    return normalizeVehicleManifest({
        version: 3,
        id: "link-car",
        name: "Link",
        wheels,
        kinematics: { wheelbase: 1.5, maxSpeed: 15 },
        ...patch,
    });
}

function withSpares() {
    return manifest([
        ...standardWheels(),
        wheel("spare-a", { x: 0.25, y: 0.5, z: 0.25 }),
        wheel("spare-b", { x: 1, y: 0.25, z: -0.5 }),
    ]);
}

function at(document, id) {
    return document.wheels.find((entry) => entry.id === id);
}

test("together keeps the offset and mirror flips only the lateral delta", () => {
    const source = withSpares();
    const driven = { x: 0.5, y: 0.25, z: 0.75 };
    const together = applyLinkedWheelMotion(source, {
        drivenId: "spare-a",
        position: driven,
        link: { ids: ["spare-a", "spare-b"], mode: "together" },
    });
    assert.equal(together.ok, true);
    assert.deepEqual(at(together.manifest, "spare-a").position, driven);
    assert.deepEqual(at(together.manifest, "spare-b").position, { x: 1.25, y: 0, z: 0 });
    assert.equal(at(together.manifest, "spare-a").radius, 0.25);
    assert.equal(at(together.manifest, "spare-b").width, 0.15);
    assert.equal(at(source, "spare-b").position.z, -0.5);

    const mirrored = applyLinkedWheelMotion(source, {
        drivenId: "spare-a",
        position: driven,
        link: { ids: ["spare-a", "spare-b"], mode: "mirror" },
    });
    assert.equal(mirrored.ok, true);
    assert.deepEqual(at(mirrored.manifest, "spare-b").position, { x: 1.25, y: 0, z: -1 });
    assert.notEqual(at(mirrored.manifest, "spare-b").position.z, -driven.z);
});

test("a standard pair translates in mirror and updates the derived wheelbase", () => {
    const source = manifest();
    assert.deepEqual(
        resolveMotionLink(source.wheels, "front-left", null),
        { ids: ["front-left", "front-right"], mode: "mirror" },
    );
    const moved = applyLinkedWheelMotion(source, {
        drivenId: "front-left",
        position: { x: 1.2, y: 0.35, z: 0.7 },
        link: { ids: ["front-left", "front-right"], mode: "mirror" },
    });
    assert.equal(moved.ok, true);
    assert.deepEqual(at(moved.manifest, "front-left").position, { x: 1.2, y: 0.35, z: 0.7 });
    assert.deepEqual(at(moved.manifest, "front-right").position, { x: 1.2, y: 0.35, z: -0.7 });
    assert.equal(at(moved.manifest, "rear-left").position.x, -0.75);
    assert.equal(moved.manifest.kinematics.wheelbase, 1.95);
    assert.equal(moved.manifest.wheelLink, undefined);
});

test("together on a standard pair, a bound wheel, and a third-wheel link leave the capture unchanged", () => {
    const source = manifest();
    const frozen = JSON.stringify(source);
    const together = applyLinkedWheelMotion(source, {
        drivenId: "front-left",
        position: { x: 1.2, y: 0.25, z: 0.55 },
        link: { ids: ["front-left", "front-right"], mode: "together" },
    });
    assert.equal(together.ok, false);
    assert.equal(together.manifest, null);
    assert.equal(together.issues[0].code, "vehicle.wheel.link-mode");
    assert.equal(JSON.stringify(source), frozen);

    const bound = cloneJson(source);
    bound.wheels[0].visual = { kind: "model-node", nodeIndex: 4 };
    bound.wheels[1].visual = { kind: "model-node", nodeIndex: 5 };
    const boundFrozen = JSON.stringify(bound);
    const locked = applyLinkedWheelMotion(bound, {
        drivenId: "front-left",
        position: { x: 1.2, y: 0.25, z: 0.55 },
        link: { ids: ["front-left", "front-right"], mode: "mirror" },
    });
    assert.equal(locked.ok, false);
    assert.equal(locked.issues[0].code, "vehicle.wheel.link-bound");
    assert.equal(JSON.stringify(bound), boundFrozen);
    assert.equal(resolveMotionLink(bound.wheels, "front-left", null), null);

    const extras = withSpares();
    const extrasFrozen = JSON.stringify(extras);
    const third = applyLinkedWheelMotion(extras, {
        drivenId: "front-left",
        position: { x: 1.2, y: 0.25, z: 0.55 },
        link: { ids: ["front-left", "spare-a"], mode: "mirror" },
    });
    assert.equal(third.ok, false);
    assert.equal(third.issues[0].code, "vehicle.wheel.link-standard");
    assert.equal(JSON.stringify(extras), extrasFrozen);

    const session = new VehicleDocumentSession({ manifest: source });
    assert.equal(session.beginGesture({
        kind: "wheel-link",
        label: "Move wheels",
        drivenId: "front-left",
        link: { ids: ["front-left", "front-right"], mode: "together" },
    }).ok, true);
    const preview = session.previewGesture({
        drivenId: "front-left",
        position: { x: 1.2, y: 0.25, z: 0.55 },
    });
    assert.equal(preview.ok, false);
    assert.equal(session.draft.snapshot().wheels[0].position.x, 0.75);
    assert.equal(session.commitGesture().empty, true);
    assert.equal(session.history.length, 0);
});

test("the session link stays out of the manifest and history, and one gesture undoes both wheels", () => {
    const session = new VehicleDocumentSession({ manifest: withSpares() });
    assert.equal(session.wheelLink, null);
    const link = { ids: ["spare-a", "spare-b"], mode: "together" };
    assert.deepEqual(session.setWheelLink(link).link, link);
    assert.equal(session.setWheelLink({ ids: ["front-left", "spare-a"], mode: "mirror" }).ok, false);
    assert.deepEqual(session.wheelLink, link);
    assert.equal(session.beginGesture({
        kind: "wheel-link",
        label: "Move wheels",
        drivenId: "spare-a",
        link: session.wheelLink,
    }).ok, true);
    assert.equal(session.previewGesture({
        drivenId: "spare-a",
        position: { x: 0.5, y: 0.25, z: 0.75 },
    }).ok, true);
    assert.equal(session.history.length, 0);
    assert.equal(session.commitGesture().ok, true);
    assert.equal(session.history.length, 1);
    assert.equal(session.history[0].before.wheelLink, undefined);
    assert.equal(session.history[0].after.wheelLink, undefined);
    assert.equal(session.draft.snapshot().wheelLink, undefined);
    assert.deepEqual(at(session.draft.snapshot(), "spare-b").position, { x: 1.25, y: 0, z: 0 });
    assert.deepEqual(session.wheelLinkSnapshot(), link);
    assert.equal(session.undo().ok, true);
    assert.deepEqual(at(session.draft.snapshot(), "spare-a").position, { x: 0.25, y: 0.5, z: 0.25 });
    assert.deepEqual(at(session.draft.snapshot(), "spare-b").position, { x: 1, y: 0.25, z: -0.5 });
    assert.deepEqual(session.wheelLinkSnapshot(), link);

    const removed = cloneJson(session.draft.snapshot());
    removed.wheels = removed.wheels.filter((entry) => entry.id !== "spare-b");
    assert.equal(session.execute(editManifestFields(removed)).ok, true);
    assert.equal(session.wheelLink, null);

    session.setWheelLink({ ids: ["spare-a", "spare-a"], mode: "mirror" });
    session.discard();
    assert.equal(session.wheelLink, null);
});

test("the editor controller mirrors a standard axle from the gizmo path and drops the link on open", () => {
    const controller = new VehicleEditorController();
    controller.open(manifest());
    assert.equal(controller.beginWheel("front-left").ok, true);
    assert.equal(controller.previewWheel("front-left", { x: 1.2, y: 0.25, z: 0.7 }).ok, true);
    const committed = controller.commitWheel();
    assert.equal(committed.ok, true);
    assert.deepEqual(at(committed.manifest, "front-right").position, { x: 1.2, y: 0.25, z: -0.7 });
    assert.equal(committed.manifest.kinematics.wheelbase, 1.95);
    assert.equal(controller.session.history.length, 1);
    assert.equal(controller.undo().ok, true);
    assert.equal(at(controller.snapshot.manifest, "front-left").position.x, 0.75);
    assert.equal(controller.snapshot.manifest.kinematics.wheelbase, 1.5);

    controller.open(withSpares());
    assert.equal(controller.setWheelLink({ ids: ["spare-a", "spare-b"], mode: "mirror" }).ok, true);
    assert.deepEqual(controller.snapshot.wheelLink, { ids: ["spare-a", "spare-b"], mode: "mirror" });
    assert.equal(controller.snapshot.manifest.wheelLink, undefined);
    assert.equal(controller.setWheelLink({ ids: ["front-left", "front-right"], mode: "together" }).ok, false);
    assert.deepEqual(controller.snapshot.wheelLink, { ids: ["spare-a", "spare-b"], mode: "mirror" });
    controller.discard();
    assert.equal(controller.snapshot.wheelLink, null);
    controller.setWheelLink({ ids: ["spare-a", "spare-b"], mode: "together" });
    controller.open(manifest());
    assert.equal(controller.snapshot.wheelLink, null);
});
