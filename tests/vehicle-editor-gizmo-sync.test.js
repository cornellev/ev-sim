import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { applySensorMarkerPose } from "../app/vehicles/editor/sensorMarkerPose.js";

function sensor(pose = {}) {
    return {
        id: "imu",
        pose: {
            position: { x: 0, y: 0, z: 0, ...pose.position },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ", ...pose.rotation },
        },
    };
}

function marker() {
    const object = new THREE.Group();
    object.position.set(5, 1, 2);
    object.rotation.set(0.4, 0.2, 0.1);
    return object;
}

test("a sensor drag keeps the gizmo pose instead of the manifest pose", () => {
    const object = marker();
    applySensorMarkerPose(object, sensor(), true);
    assert.deepEqual(object.position.toArray(), [5, 1, 2]);
    assert.deepEqual(object.rotation.toArray().slice(0, 3), [0.4, 0.2, 0.1]);
});

test("a sensor sync applies the manifest pose when the gizmo is idle", () => {
    const object = marker();
    applySensorMarkerPose(object, sensor({
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0.3, y: 0.2, z: 0.1, order: "ZXY" },
    }), false);
    assert.deepEqual(object.position.toArray(), [1, 2, 3]);
    assert.deepEqual(object.rotation.toArray().slice(0, 3), [0.3, 0.2, 0.1]);
    assert.equal(object.rotation.order, "ZXY");
});
