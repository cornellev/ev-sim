import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { applyModelPlacement } from "../app/3d/vehicles/ModelPlacement.js";

test("applyModelPlacement aligns AABB center to boundingBox.center then adds offset", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
    // Origin at a corner-ish offset so the geometric center is not at (0,0,0).
    mesh.geometry.translate(1, 0.5, 0);

    const alignment = applyModelPlacement(mesh, {
        scale: 1,
        rotation: { x: 0, y: 0, z: 0 },
        offset: { x: 0.1, y: 0, z: -0.2 },
    }, { center: { x: 0, y: 0.7, z: 0 } });

    mesh.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    assert.ok(Math.abs(center.x - 0.1) < 1e-6, `expected center.x ≈ 0.1, got ${center.x}`);
    assert.ok(Math.abs(center.y - 0.7) < 1e-6, `expected center.y ≈ 0.7, got ${center.y}`);
    assert.ok(Math.abs(center.z - (-0.2)) < 1e-6, `expected center.z ≈ -0.2, got ${center.z}`);
    assert.ok(Math.abs(alignment.x - (-1)) < 1e-6);
    assert.ok(Math.abs(alignment.y - 0.2) < 1e-6);
    assert.ok(Math.abs(alignment.z) < 1e-6);
});

test("applyModelPlacement uses parent-local AABB when the model is already parented", () => {
    const parent = new THREE.Group();
    parent.position.set(12, 0, -4);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
    mesh.geometry.translate(1, 0.5, 0);
    parent.add(mesh);
    parent.updateMatrixWorld(true);

    applyModelPlacement(mesh, {
        scale: 1,
        rotation: { x: 0, y: 0, z: 0 },
        offset: { x: 0, y: 0, z: 0 },
    }, { center: { x: 0, y: 0.7, z: 0 } });

    parent.updateMatrixWorld(true);
    const worldCenter = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const expected = parent.localToWorld(new THREE.Vector3(0, 0.7, 0));
    assert.ok(Math.abs(worldCenter.x - expected.x) < 1e-5, `x ${worldCenter.x} vs ${expected.x}`);
    assert.ok(Math.abs(worldCenter.y - expected.y) < 1e-5, `y ${worldCenter.y} vs ${expected.y}`);
    assert.ok(Math.abs(worldCenter.z - expected.z) < 1e-5, `z ${worldCenter.z} vs ${expected.z}`);
});
