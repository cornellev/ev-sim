import assert from "node:assert/strict";
import test from "node:test";

import { RigidBodyPoseTracker } from "../app/simulation/world/RigidBodyPoseTracker.js";

function pose(id = "crate", x = 0) {
    return {
        id,
        position: { x, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        spawnPosition: { x: 0, y: 0, z: 0 },
        spawnRotation: { x: 0, y: 0, z: 0, w: 1 },
    };
}

test("rigid-body motion tracks scalar changes, removals, and immutable snapshots", () => {
    const tracker = new RigidBodyPoseTracker();
    const input = pose();
    assert.deepEqual([...tracker.sync([input])], ["crate"]);
    const snapshot = tracker.get("crate");
    const revision = tracker.revision("crate");
    assert.deepEqual([...tracker.sync([pose()])], []);
    assert.equal(tracker.get("crate"), snapshot);
    input.position.x = 3;
    assert.equal(snapshot.position.x, 0);
    assert.deepEqual([...tracker.sync([input, pose("other")])], ["crate", "other"]);
    assert.ok(tracker.revision("crate") > revision);
    assert.deepEqual([...tracker.sync([pose("other")])], ["crate"]);
    assert.equal(tracker.get("crate"), null);
    assert.deepEqual([...tracker.clear()], ["other"]);
});

test("rigid-body motion validates a snapshot before changing any entry", () => {
    const tracker = new RigidBodyPoseTracker();
    tracker.sync([pose()]);
    const revision = tracker.version;
    assert.throws(() => tracker.sync([pose("other"), pose("bad", NaN)]), /must be finite/);
    assert.equal(tracker.version, revision);
    assert.equal(tracker.get("crate").position.x, 0);
    assert.equal(tracker.get("other"), null);
    assert.throws(() => tracker.sync({}), /must be an array/);
});

test("rigid-body motion detects rotations, spawn changes, and duplicate-id replacement", () => {
    const tracker = new RigidBodyPoseTracker();
    tracker.sync([pose()]);
    const turned = pose();
    turned.rotation = { x: 0, y: 1, z: 0, w: 0 };
    assert.deepEqual([...tracker.sync([turned])], ["crate"]);
    const spawned = structuredClone(turned);
    spawned.spawnPosition.x = 2;
    assert.deepEqual([...tracker.sync([spawned])], ["crate"]);
    tracker.sync([pose("crate", 1), pose("crate", 2)]);
    assert.equal(tracker.get("crate").position.x, 2);
});
