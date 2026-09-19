import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
    applyControlsPathRibbonPose,
    createControlsPathRibbonGeometry,
    sampleControlsArcPoints,
    updateControlsPathRibbon,
} from "../app/autonomy/ControlsPathArc.js";

test("updateControlsPathRibbon writes a local +X ribbon at pathY", () => {
    const geometry = createControlsPathRibbonGeometry(4);
    updateControlsPathRibbon(geometry, {}, 0, {
        lookahead: 8,
        segments: 4,
        pathWidth: 0.4,
        pathY: 0.05,
        wheelbase: 1.5,
    });
    const arr = geometry.getAttribute("position").array;
    assert.ok(Math.abs(arr[0]) < 1e-5);
    assert.ok(Math.abs(arr[1] - 0.05) < 1e-5);
    assert.ok(Math.abs(arr[2] - 0.2) < 1e-5);
    assert.ok(Math.abs(arr[3]) < 1e-5);
    assert.ok(Math.abs(arr[4] - 0.05) < 1e-5);
    assert.ok(Math.abs(arr[5] + 0.2) < 1e-5);

    const lastLeft = 4 * 2 * 3;
    assert.ok(Math.abs(arr[lastLeft] - 8) < 1e-5);
    assert.ok(arr[lastLeft] > arr[0]);
});

test("updateControlsPathRibbon treats pathY 0 as a real lift", () => {
    const geometry = createControlsPathRibbonGeometry(2);
    updateControlsPathRibbon(geometry, {}, 0, {
        lookahead: 4,
        segments: 2,
        pathWidth: 0.4,
        pathY: 0,
        wheelbase: 1.5,
    });
    const arr = geometry.getAttribute("position").array;
    assert.equal(arr[1], 0);
    assert.equal(arr[4], 0);
});

test("applyControlsPathRibbonPose lifts and pitches the local ribbon", () => {
    const geometry = createControlsPathRibbonGeometry(4);
    const pathY = 0.05;
    const pitch = 0.2;
    updateControlsPathRibbon(geometry, {}, 0, {
        lookahead: 8,
        segments: 4,
        pathWidth: 0.4,
        pathY,
        wheelbase: 1.5,
    });
    const mesh = new THREE.Mesh(geometry);
    applyControlsPathRibbonPose(mesh, {
        position: { x: 10, y: 6, z: 2 },
        yaw: 0,
        rotation: { x: 0, y: 0, z: pitch, order: "XYZ" },
    });
    mesh.updateMatrixWorld(true);
    const world = new THREE.Vector3(0, pathY, 0).applyMatrix4(mesh.matrixWorld);
    assert.ok(Math.abs(world.y - (6 + pathY * Math.cos(pitch))) < 1e-6);
    assert.ok(Math.abs(world.x - (10 - pathY * Math.sin(pitch))) < 1e-6);
    assert.ok(Math.abs(world.z - 2) < 1e-6);
    assert.ok(Math.abs(world.y - 0.05) > 1);
});

test("sampleControlsArcPoints uses plant-forward -sin(yaw)", () => {
    const points = sampleControlsArcPoints(
        { position: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2 },
        0,
        { lookahead: 4, segments: 4 },
    );
    assert.ok(Math.abs(points[0].x) < 1e-5);
    assert.ok(Math.abs(points[0].z) < 1e-5);
    assert.ok(Math.abs(points.at(-1).x) < 1e-5);
    assert.ok(points.at(-1).z < 0);
    assert.ok(Math.abs(points.at(-1).z + 4) < 1e-5);
});
