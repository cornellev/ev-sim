import assert from "node:assert/strict";
import test from "node:test";

import {
    clamp,
    clamp01,
    cross3,
    distanceXZ,
    dot3a,
    invertRigidMat4,
    mat4FromQuaternionTranslation,
    mat4FromTrs,
    multiplyMat4,
    normalize3,
    quaternionFromRotationMatrix,
    transformPointMat4,
} from "../app/math/linalg.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

test("multiplyMat4 leaves a matrix unchanged when multiplied by identity", () => {
    const pose = mat4FromQuaternionTranslation({ x: 0.1, y: -0.2, z: 0.3, w: 0.9 }, { x: 1, y: 2, z: 3 });
    assert.deepEqual(multiplyMat4(IDENTITY, pose), pose);
    assert.deepEqual(multiplyMat4(pose, IDENTITY), pose);
});

test("invertRigidMat4 round-trips a rigid pose", () => {
    const pose = mat4FromQuaternionTranslation({ x: 0, y: 0, z: 0, w: 1 }, { x: 4, y: -2, z: 0.5 });
    const roundTrip = multiplyMat4(invertRigidMat4(pose), pose);
    for (let index = 0; index < 16; index += 1) {
        assert.ok(Math.abs(roundTrip[index] - IDENTITY[index]) < 1e-12, `index ${index}`);
    }
});

test("mat4FromTrs applies scale on the glTF diagonal", () => {
    const matrix = mat4FromTrs([1, 2, 3], [0, 0, 0, 1], [2, 3, 4]);
    assert.deepEqual(matrix, [
        2, 0, 0, 0,
        0, 3, 0, 0,
        0, 0, 4, 0,
        1, 2, 3, 1,
    ]);
});

test("quaternionFromRotationMatrix keeps a non-negative w", () => {
    const length = Math.hypot(0.2, -0.4, 0.1, -0.8);
    const matrix = mat4FromQuaternionTranslation({
        x: 0.2 / length,
        y: -0.4 / length,
        z: 0.1 / length,
        w: -0.8 / length,
    }, { x: 0, y: 0, z: 0 });
    const quaternion = quaternionFromRotationMatrix(matrix);
    assert.ok(quaternion.w >= 0);
    const restored = mat4FromQuaternionTranslation(quaternion, { x: 0, y: 0, z: 0 });
    for (let index = 0; index < 11; index += 1) {
        assert.ok(Math.abs(restored[index] - matrix[index]) < 1e-9, `index ${index}`);
    }
});

test("transformPointMat4 accepts object and array points", () => {
    const translated = mat4FromQuaternionTranslation({ x: 0, y: 0, z: 0, w: 1 }, { x: 10, y: 0, z: -3 });
    assert.deepEqual(transformPointMat4(translated, { x: 1, y: 2, z: 3 }), { x: 11, y: 2, z: 0 });
    assert.deepEqual(transformPointMat4(translated, [1, 2, 3]), { x: 11, y: 2, z: 0 });
});

test("vec3 helpers cover degenerate normalization and clamp", () => {
    assert.equal(normalize3({ x: 0, y: 0, z: 0 }, 1e-9), null);
    assert.deepEqual(normalize3({ x: 0, y: 0, z: 0 }, 0, { x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
    assert.deepEqual(cross3({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), { x: 0, y: 0, z: 1 });
    assert.equal(dot3a([1, 2, 3], [4, 5, 6]), 32);
    assert.equal(distanceXZ({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
    assert.equal(clamp(5, 0, 1), 1);
    assert.equal(clamp01(-0.2), 0);
    assert.equal(clamp01(0.4), 0.4);
});
