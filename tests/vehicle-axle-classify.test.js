import assert from "node:assert/strict";
import test from "node:test";

import { VehicleDocumentSession } from "../app/vehicles/document/VehicleDocumentSession.js";
import { adoptStandardAxles, classifyWheel } from "../app/vehicles/document/vehicleCommands.js";
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
