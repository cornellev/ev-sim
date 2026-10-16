import assert from "node:assert/strict";
import test from "node:test";

import { VehicleDocumentSession } from "../app/vehicles/document/VehicleDocumentSession.js";
import { adoptStandardAxles, classifyWheel, copyWheelFromPartner } from "../app/vehicles/document/vehicleCommands.js";
import {
    createBlankVehicleManifest,
    createDefaultVehicleManifest,
    normalizeVehicleManifest,
    validateVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";

function unclassifiedVersion3() {
    const source = createDefaultVehicleManifest({ id: "box", name: "Box" });
    return normalizeVehicleManifest({ ...source, version: 3 }, { version: 3 });
}

test("a blank vehicle publishes classified standard axles", () => {
    const blank = createBlankVehicleManifest();
    assert.equal(blank.version, 3);
    assert.equal(blank.wheels.find((wheel) => wheel.id === "front-left").axle, "front");
    assert.equal(blank.wheels.find((wheel) => wheel.id === "front-left").side, "left");
    assert.equal(blank.wheels.find((wheel) => wheel.id === "rear-right").steerable, false);
    assert.equal(validateVehicleManifest(blank).ok, true, JSON.stringify(validateVehicleManifest(blank).issues));
});

test("grouping named wheels is one undo and classifying completes a pair", () => {
    const session = new VehicleDocumentSession({ manifest: unclassifiedVersion3() });
    const grouped = session.execute(adoptStandardAxles());
    assert.equal(grouped.ok, true, JSON.stringify(grouped.issues));
    const draft = session.draft.snapshot();
    assert.equal(draft.wheels.find((wheel) => wheel.id === "front-left").side, "left");
    assert.equal(draft.wheels.find((wheel) => wheel.id === "rear-right").axle, "rear");
    assert.equal(draft.kinematics.wheelbase, 1.5);
    assert.equal(session.history.length, 1);
    session.undo();
    assert.equal(session.draft.snapshot().wheels.every((wheel) => wheel.axle === undefined), true);

    const left = session.execute(classifyWheel({ wheelId: "front-left", axle: "front", side: "left" }));
    assert.equal(left.ok, true, JSON.stringify(left.issues));
    assert.equal(session.draft.snapshot().wheels.find((wheel) => wheel.id === "front-right").axle, undefined);
    const right = session.execute(classifyWheel({ wheelId: "front-right", axle: "front", side: "right" }));
    assert.equal(right.ok, true, JSON.stringify(right.issues));
    assert.equal(session.draft.snapshot().wheels.find((wheel) => wheel.id === "front-right").axle, "front");
    const cleared = session.execute(classifyWheel({ wheelId: "front-left" }));
    assert.equal(cleared.ok, true, JSON.stringify(cleared.issues));
    assert.equal(session.draft.snapshot().wheels.every((wheel) => wheel.axle !== "front"), true);
});

test("classification keeps a placed pose, then partner actions copy one wheel", () => {
    const source = unclassifiedVersion3();
    const placed = (id) => source.wheels.find((wheel) => wheel.id === id);
    placed("front-right").position = { x: 1.2, y: 0.3, z: -0.7 };
    placed("front-right").radius = 0.31;
    placed("front-right").width = 0.18;
    placed("front-left").position = { x: 0.2, y: 0.1, z: 0.22 };
    placed("front-left").radius = 0.22;
    placed("front-left").width = 0.11;
    placed("rear-right").position = { x: -0.4, y: 0.28, z: -0.15 };
    const session = new VehicleDocumentSession({ manifest: source });
    const at = (id, manifest = session.draft.snapshot()) => manifest.wheels.find((wheel) => wheel.id === id);
    const openedRight = { ...at("front-right").position };
    const openedLeft = { ...at("front-left").position };
    const openedRear = { ...at("rear-right").position };

    const right = session.execute(classifyWheel({ wheelId: "front-right", axle: "front", side: "right" }));
    assert.equal(right.ok, true, JSON.stringify(right.issues));
    assert.deepEqual(at("front-right").position, openedRight);
    assert.equal(at("front-right").radius, 0.31);
    const early = session.execute(copyWheelFromPartner({ wheelId: "front-right", mode: "mirror" }));
    assert.equal(early.ok, false);
    assert.deepEqual(at("front-right").position, openedRight);
    const left = session.execute(classifyWheel({ wheelId: "front-left", axle: "front", side: "left" }));
    assert.equal(left.ok, true, JSON.stringify(left.issues));
    assert.deepEqual(at("front-right").position, openedRight);
    assert.deepEqual(at("front-left").position, openedLeft);

    const missing = session.execute(copyWheelFromPartner({ wheelId: "rear-right", mode: "align" }));
    assert.equal(missing.ok, false);
    assert.deepEqual(at("rear-right").position, openedRear);

    const mirrored = session.execute(copyWheelFromPartner({ wheelId: "front-left", mode: "mirror" }));
    assert.equal(mirrored.ok, true, JSON.stringify(mirrored.issues));
    assert.deepEqual(at("front-right").position, openedRight);
    assert.equal(at("front-left").position.x, openedRight.x);
    assert.equal(at("front-left").position.y, openedRight.y);
    assert.equal(at("front-left").position.z, 0.7);
    assert.equal(at("front-left").radius, 0.31);
    assert.equal(at("front-left").width, 0.18);
    assert.equal(at("front-right").radius, 0.31);

    const rear = session.execute(classifyWheel({ wheelId: "rear-right", axle: "rear", side: "right" }));
    assert.equal(rear.ok, true, JSON.stringify(rear.issues));
    assert.deepEqual(at("rear-right").position, openedRear);
    const aligned = session.execute(copyWheelFromPartner({ wheelId: "rear-right", mode: "align" }));
    assert.equal(aligned.ok, true, JSON.stringify(aligned.issues));
    assert.equal(at("rear-right").position.z, openedRight.z);
    assert.equal(at("rear-right").position.x, openedRear.x);
    assert.equal(at("rear-right").position.y, openedRear.y);
    assert.deepEqual(at("front-right").position, openedRight);

    session.undo();
    assert.deepEqual(at("rear-right").position, openedRear);
    assert.equal(session.history.length, 4);
});

test("a model-bound wheel refuses a partner copy", () => {
    const source = createBlankVehicleManifest();
    source.wheels.find((entry) => entry.id === "front-left").visual = { kind: "model-node", nodeIndex: 0 };
    const session = new VehicleDocumentSession({ manifest: source });
    const before = JSON.stringify(session.draft.snapshot());
    const copied = session.execute(copyWheelFromPartner({ wheelId: "front-left", mode: "mirror" }));
    assert.equal(copied.ok, false);
    assert.equal(copied.issues[0].code, "vehicle.axle.geometry-locked");
    assert.equal(JSON.stringify(session.draft.snapshot()), before);
});
