import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { worldToScreen } from "../app/3d/editor/map/mapCoords.js";
import {
    MAP_SATELLITE_MIN_ELEVATION,
    mapSatelliteFrustum,
    mapSatelliteNdcToCanvas,
    mapSatelliteScreenRect,
    mapViewportWorldRect,
    paintMapSatelliteCanvas,
} from "../app/3d/editor/map/mapSatelliteFrustum.js";

const viewport = Object.freeze({ centerX: 10, centerZ: -4, zoom: 2 });
const size = Object.freeze({ width: 800, height: 600 });

test("mapViewportWorldRect corners project to the canvas corners", () => {
    const rect = mapViewportWorldRect(viewport, size);
    const topLeft = worldToScreen({ x: rect.minX, z: rect.minZ }, viewport, size);
    const bottomRight = worldToScreen({ x: rect.maxX, z: rect.maxZ }, viewport, size);
    assert.ok(Math.abs(topLeft.x) < 1e-9);
    assert.ok(Math.abs(topLeft.y) < 1e-9);
    assert.ok(Math.abs(bottomRight.x - size.width) < 1e-9);
    assert.ok(Math.abs(bottomRight.y - size.height) < 1e-9);
});

test("mapSatelliteFrustum matches the map XZ extent and nadir axes", () => {
    const frustum = mapSatelliteFrustum(viewport, size);
    assert.equal(frustum.left, -50);
    assert.equal(frustum.right, 50);
    assert.equal(frustum.top, 37.5);
    assert.equal(frustum.bottom, -37.5);
    assert.deepEqual(frustum.position, [10, MAP_SATELLITE_MIN_ELEVATION, -4]);
    assert.deepEqual(frustum.up, [0, 0, -1]);
    assert.deepEqual(frustum.lookAt, [10, 0, -4]);
    assert.equal(frustum.near, 0.1);
    assert.equal(frustum.far, MAP_SATELLITE_MIN_ELEVATION + 1000);

    const raised = mapSatelliteFrustum(viewport, size, { elevation: 120 });
    assert.deepEqual(raised.position, [10, 120, -4]);
    assert.equal(raised.far, 1120);
});

test("mapSatelliteScreenRect is identity when the viewport is unchanged", () => {
    const capture = { viewport, size };
    const placed = mapSatelliteScreenRect(capture, viewport, size);
    assert.ok(Math.abs(placed.x) < 1e-9);
    assert.ok(Math.abs(placed.y) < 1e-9);
    assert.ok(Math.abs(placed.width - size.width) < 1e-9);
    assert.ok(Math.abs(placed.height - size.height) < 1e-9);
});

test("mapSatelliteScreenRect follows pan and zoom of a stale capture", () => {
    const capture = { viewport, size };
    const panned = { ...viewport, centerX: viewport.centerX + 10 };
    const pannedRect = mapSatelliteScreenRect(capture, panned, size);
    const worldTopLeft = mapViewportWorldRect(viewport, size);
    const expected = worldToScreen({ x: worldTopLeft.minX, z: worldTopLeft.minZ }, panned, size);
    assert.ok(Math.abs(pannedRect.x - expected.x) < 1e-9);
    assert.ok(Math.abs(pannedRect.y - expected.y) < 1e-9);
    assert.equal(pannedRect.width, size.width);
    assert.equal(pannedRect.height, size.height);

    const zoomed = { ...viewport, zoom: 4 };
    const zoomedRect = mapSatelliteScreenRect(capture, zoomed, size);
    assert.ok(zoomedRect.width > size.width);
    assert.ok(zoomedRect.height > size.height);
});

test("orthographic nadir camera projects onto the same pixels as worldToScreen", () => {
    const frustum = mapSatelliteFrustum(viewport, size);
    const camera = new THREE.OrthographicCamera(
        frustum.left,
        frustum.right,
        frustum.top,
        frustum.bottom,
        frustum.near,
        frustum.far,
    );
    camera.position.fromArray(frustum.position);
    camera.up.fromArray(frustum.up);
    camera.lookAt(frustum.lookAt[0], frustum.lookAt[1], frustum.lookAt[2]);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    const points = [
        { x: viewport.centerX, z: viewport.centerZ },
        { x: viewport.centerX + 20, z: viewport.centerZ - 12 },
        { x: viewport.centerX - 30, z: viewport.centerZ + 18 },
    ];
    for (const point of points) {
        const ndc = new THREE.Vector3(point.x, 0, point.z).project(camera);
        const canvas = mapSatelliteNdcToCanvas(ndc, size);
        const screen = worldToScreen(point, viewport, size);
        assert.ok(Math.abs(canvas.x - screen.x) < 1e-6, `x ${canvas.x} vs ${screen.x}`);
        assert.ok(Math.abs(canvas.y - screen.y) < 1e-6, `y ${canvas.y} vs ${screen.y}`);
    }
});

test("paintMapSatelliteCanvas draws a stale bitmap into the current screen rect", () => {
    const source = { width: 32, height: 16 };
    const capture = { viewport, size, canvas: source };
    const panned = { ...viewport, centerX: viewport.centerX + 10 };
    const draws = [];
    const display = {
        width: 0,
        height: 0,
        getContext() {
            return {
                setTransform() {},
                clearRect() {},
                drawImage(...args) { draws.push(args); },
            };
        },
    };
    const painted = paintMapSatelliteCanvas(display, capture, panned, size);
    const expected = mapSatelliteScreenRect(capture, panned, size);
    assert.equal(display.width, size.width);
    assert.equal(display.height, size.height);
    assert.equal(draws.length, 1);
    assert.equal(draws[0][0], source);
    assert.equal(draws[0][1], expected.x);
    assert.equal(draws[0][2], expected.y);
    assert.equal(draws[0][3], expected.width);
    assert.equal(draws[0][4], expected.height);
    assert.deepEqual(painted.rect, expected);
});
