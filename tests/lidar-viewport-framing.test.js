import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import {
    horizontalFovDegrees,
    LIDAR_VIEWPORT_DISPLAY_RANGE_M,
    LIDAR_VIEWPORT_MAX_PIXELS,
    lidarViewportDisplayRange,
    lidarViewportFraming,
    lidarViewportResolution,
} from "../app/3d/perception/lidarViewportFraming.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";

const shaderSource = readFileSync(new URL("../app/3d/shaders/Lidar3dShader.js", import.meta.url), "utf8");
const lidarSource = readFileSync(new URL("../app/3d/devices/LiDAR3d.js", import.meta.url), "utf8");
const bakeSource = readFileSync(new URL("../app/3d/environment/visualization/BakeView.js", import.meta.url), "utf8");

test("a 75 degree 16:9 camera frames the LiDAR viewport like a stereo camera", () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1000);
    camera.position.set(3, 4, 5);
    camera.lookAt(10, 4, 5);
    camera.updateMatrixWorld(true);

    const framing = lidarViewportFraming(camera);
    const horizontal = horizontalFovDegrees(75, 16 / 9);

    assert.ok(framing.origin.distanceTo(camera.position) < 1e-6);
    assert.ok(Math.abs((framing.thetaRange[1] - framing.thetaRange[0]) - horizontal) < 1e-6);
    assert.deepEqual(framing.phiRange, [-37.5, 37.5]);
    assert.equal(framing.range, 1000);
    assert.deepEqual([framing.width, framing.height], [640, 360]);
    assert.ok(framing.width * framing.height <= LIDAR_VIEWPORT_MAX_PIXELS);

    const worldQuaternion = camera.getWorldQuaternion(new THREE.Quaternion());
    const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(worldQuaternion).normalize();
    const lidarForward = new THREE.Vector3(1, 0, 0).applyMatrix3(framing.sensorRotation).normalize();
    assert.ok(lidarForward.distanceTo(cameraForward) < 1e-5);
});

test("an unrotated camera maps LiDAR forward onto camera forward", () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 80);
    camera.updateMatrixWorld(true);
    const framing = lidarViewportFraming(camera);
    const lidarForward = new THREE.Vector3(1, 0, 0).applyMatrix3(framing.sensorRotation);
    assert.ok(lidarForward.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-5);
    assert.equal(lidarViewportDisplayRange(framing.range), 80);
    assert.equal(lidarViewportDisplayRange(10_000), LIDAR_VIEWPORT_DISPLAY_RANGE_M);
});

test("hit buffers keep the camera aspect inside the pixel budget", () => {
    for (const aspect of [16 / 9, 4 / 3, 1, 21 / 9, 0.4]) {
        const { width, height } = lidarViewportResolution(aspect);
        assert.ok(width >= 2 && height >= 2);
        assert.ok(width * height <= LIDAR_VIEWPORT_MAX_PIXELS);
        assert.ok(Math.abs(width / height - aspect) < 0.05);
    }
});

test("pinhole LiDAR rays stay off unless the viewport asks for them", () => {
    const branch = shaderSource.indexOf("if (u_pinhole == 1)");
    const spherical = shaderSource.indexOf("cos(phi) * cos(theta)");
    assert.match(shaderSource, /uniform int u_pinhole;/);
    assert.ok(branch > 0);
    assert.ok(spherical > branch);
    assert.match(shaderSource.slice(branch, spherical), /\} else \{/);
    assert.match(lidarSource, /u_pinhole:\s*\{\s*value:\s*0\s*\}/);
    assert.match(bakeSource, /u_pinhole:\s*\{\s*value:\s*0\s*\}/);
});

test("enabling the LiDAR viewport does not advance simulation time", () => {
    const engine = new SimulationEngine({});
    engine.lidarViewport._ensureShader = () => {};
    const steps = engine.steps;
    const time = engine.time;
    engine.setLidarViewportEnabled(true);
    assert.equal(engine.lidarViewport.enabled, true);
    assert.equal(engine.render(), false);
    assert.equal(engine.steps, steps);
    assert.equal(engine.time, time);
    engine.setLidarViewportEnabled(false);
    assert.equal(engine.lidarViewport.enabled, false);
    assert.equal(engine.steps, steps);
    engine.dispose();
});
