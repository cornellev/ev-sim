import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Spherical, Vector3 } from "three";

import { dot3, length3, sub3 } from "../app/math/linalg.js";
import {
    ORBIT_ALIGN_AXES,
    ORBIT_ALIGN_MS,
    ORBIT_FREE_POLAR_ANGLE,
    alignProgress,
    axisGizmoPixel,
    orbitPoseForAxis,
    pickAxisGizmo,
    projectAxisGizmo,
    quaternionFromLookAt,
    slerpDirection,
} from "../app/vehicles/editor/alignOrbitAxis.js";

const TARGET = { x: 0, y: 0.6, z: 0 };
const DISTANCE = 5;

function pose(axis) {
    return orbitPoseForAxis({ axis, target: TARGET, distance: DISTANCE });
}

function offsetOf(position) {
    return sub3(position, TARGET);
}

function cameraFor(position, up) {
    const camera = new PerspectiveCamera();
    camera.up.set(up.x, up.y, up.z);
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(TARGET.x, TARGET.y, TARGET.z);
    return camera;
}

function quaternionDot(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w;
}

function roundTripSpherical(position) {
    const offset = offsetOf(position);
    const spherical = new Spherical().setFromVector3(new Vector3(offset.x, offset.y, offset.z));
    spherical.makeSafe();
    return new Vector3().setFromSpherical(spherical);
}

test("each axis keeps the orbit distance on its own side of the target", () => {
    assert.equal(ORBIT_ALIGN_AXES.length, 6);
    const front = pose("+x");
    const back = pose("-x");
    const top = pose("+y");
    const bottom = pose("-y");
    const left = pose("+z");
    const right = pose("-z");

    for (const next of [front, back, top, bottom, left, right]) {
        assert.ok(Math.abs(length3(offsetOf(next.position)) - DISTANCE) < 1e-9);
        assert.deepEqual(next.up, { x: 0, y: 1, z: 0 });
    }

    assert.ok(front.position.x > TARGET.x);
    assert.ok(back.position.x < TARGET.x);
    assert.ok(top.position.y > TARGET.y);
    assert.ok(bottom.position.y < TARGET.y);
    assert.ok(left.position.z > TARGET.z);
    assert.ok(right.position.z < TARGET.z);

    assert.equal(front.maxPolarAngle, ORBIT_FREE_POLAR_ANGLE);
    assert.equal(bottom.maxPolarAngle, Math.PI);
    assert.equal(orbitPoseForAxis({ axis: "nope" }), null);
});

test("top and bottom stay a degree off the pole so orbit can keep Y up", () => {
    const top = pose("+y");
    const bottom = pose("-y");
    const topOffset = offsetOf(top.position);
    const bottomOffset = offsetOf(bottom.position);

    assert.ok(topOffset.x < 0);
    assert.ok(Math.abs(topOffset.z) < 1e-9);
    assert.ok(bottomOffset.x > 0);
    assert.ok(Math.abs(bottomOffset.z) < 1e-9);

    const topRoundTrip = roundTripSpherical(top.position);
    const bottomRoundTrip = roundTripSpherical(bottom.position);
    assert.ok(topRoundTrip.x < 0);
    assert.ok(Math.abs(topRoundTrip.z) < 1e-6);
    assert.ok(bottomRoundTrip.x > 0);
    assert.ok(Math.abs(bottomRoundTrip.z) < 1e-6);

    const topCamera = cameraFor(top.position, top.up);
    const bottomCamera = cameraFor(bottom.position, bottom.up);
    const topScreenUp = new Vector3(0, 1, 0).applyQuaternion(topCamera.quaternion);
    const bottomScreenUp = new Vector3(0, 1, 0).applyQuaternion(bottomCamera.quaternion);
    assert.ok(topScreenUp.x > 0.99);
    assert.ok(bottomScreenUp.x > 0.99);
});

test("look-at quaternion matches three.js and the facing axis is nearest", () => {
    const front = pose("+x");
    const camera = cameraFor(front.position, front.up);
    const quaternion = quaternionFromLookAt(front.position, TARGET, front.up);
    assert.ok(Math.abs(quaternionDot(quaternion, camera.quaternion)) > 0.999);

    const projected = projectAxisGizmo({
        x: camera.quaternion.x,
        y: camera.quaternion.y,
        z: camera.quaternion.z,
        w: camera.quaternion.w,
    });
    const positiveX = projected.find((endpoint) => endpoint.id === "+x");
    const negativeX = projected.find((endpoint) => endpoint.id === "-x");
    assert.ok(positiveX.depth > negativeX.depth);
    assert.ok(Math.hypot(positiveX.x, positiveX.y) < 0.05);

    const top = pose("+y");
    const topCamera = cameraFor(top.position, top.up);
    const topProjected = projectAxisGizmo({
        x: topCamera.quaternion.x,
        y: topCamera.quaternion.y,
        z: topCamera.quaternion.z,
        w: topCamera.quaternion.w,
    });
    const topX = topProjected.find((endpoint) => endpoint.id === "+x");
    assert.ok(topX.y > 0.99);
    assert.ok(Math.abs(topX.x) < 0.05);
});

test("an overlapping click chooses the axis closer to the camera", () => {
    const endpoints = [
        { id: "+x", name: "front", x: 0, y: 0, depth: 1 },
        { id: "-x", name: "back", x: 0, y: 0, depth: -1 },
        { id: "+z", name: "left", x: 1, y: 0, depth: 0 },
    ];
    const center = axisGizmoPixel(endpoints[0]);
    assert.equal(pickAxisGizmo(endpoints, center.x, center.y).id, "+x");
    assert.equal(pickAxisGizmo(endpoints, 0, 0), null);
});

test("alignment eases onto the requested direction, including a half turn", () => {
    assert.equal(alignProgress(0), 0);
    assert.equal(alignProgress(ORBIT_ALIGN_MS), 1);
    assert.equal(alignProgress(ORBIT_ALIGN_MS / 2), 0.5);
    assert.ok(alignProgress(ORBIT_ALIGN_MS * 0.25) < 0.25);

    const from = { x: 4, y: 3, z: 4 };
    const onto = offsetOf(pose("+x").position);
    const start = slerpDirection(from, onto, alignProgress(0));
    const end = slerpDirection(from, onto, alignProgress(ORBIT_ALIGN_MS));
    assert.ok(dot3(start, from) / length3(from) > 0.999);
    assert.ok(dot3(end, onto) / (length3(end) * length3(onto)) > 0.999);

    const halfway = slerpDirection({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 0.5);
    assert.ok(Math.abs(halfway.x) < 1e-6);
    assert.ok(halfway.y > 0.99);
    assert.ok(Math.abs(length3(halfway) - 1) < 1e-9);
});
