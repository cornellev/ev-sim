import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { applySensorMarkerPose } from "../app/vehicles/editor/sensorMarkerPose.js";
import {
    appliedSensorMarkerScale,
    fitSensorMarkerScale,
    mountSensorMarker,
    normalizeSensorMarkerScaleMap,
    syncSensorMarkerScale,
} from "../app/vehicles/editor/sensorMarkerScale.js";

const INCH = 0.0254;

function sensor(position) {
    return {
        id: "lidar",
        pose: {
            position,
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        },
    };
}

test("passenger-car body lengths keep the stock marker scale", () => {
    assert.equal(fitSensorMarkerScale(4.5), 1);
    assert.equal(fitSensorMarkerScale(2.7), 1);
    assert.equal(fitSensorMarkerScale(106 * INCH), 1);
    assert.equal(fitSensorMarkerScale(0), 1);
    assert.equal(fitSensorMarkerScale(undefined), 1);
    assert.equal(fitSensorMarkerScale(Number.NaN), 1);
});

test("a short body shrinks the marker down to a 4 cm disc", () => {
    assert.equal(fitSensorMarkerScale(0.4), 0.15);
    assert.equal(fitSensorMarkerScale(0.2), 0.125);
    assert.equal(fitSensorMarkerScale(0.1), 0.125);
    const igvc = fitSensorMarkerScale(38.933 * INCH);
    assert.ok(Math.abs(igvc - ((0.12 * 38.933 * INCH) / 0.32)) < 1e-12);
    assert.ok(igvc < 1);
});

test("the marker root keeps the mount and the visual child keeps the scale", () => {
    const preview = new THREE.Group();
    const frustum = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));
    frustum.scale.z = 1.7;
    preview.add(frustum);
    const root = mountSensorMarker(preview, 0.15);
    applySensorMarkerPose(root, sensor({ x: 1, y: 2, z: 3 }), false);
    syncSensorMarkerScale(root, 0.15);

    assert.deepEqual(root.position.toArray(), [1, 2, 3]);
    assert.deepEqual(root.scale.toArray(), [1, 1, 1]);
    assert.equal(preview.scale.x, 0.15);
    assert.equal(preview.scale.y, 0.15);
    assert.equal(preview.scale.z, 0.15);
    assert.equal(frustum.scale.z, 1.7);
    const pick = root.getObjectByName("sensor-marker-pick");
    assert.ok(pick);
    assert.equal(pick.material.opacity, 0);
    assert.equal(pick.material.depthWrite, false);
    assert.notEqual(pick.visible, false);
});

test("scale 1 has no extra pick sphere, and returning to 1 removes it", () => {
    const full = mountSensorMarker(new THREE.Group(), 1);
    assert.equal(full.getObjectByName("sensor-marker-pick"), undefined);

    const preview = new THREE.Group();
    const root = mountSensorMarker(preview, 0.5);
    assert.ok(root.getObjectByName("sensor-marker-pick"));
    syncSensorMarkerScale(root, 1);
    assert.equal(root.getObjectByName("sensor-marker-pick"), undefined);
    assert.equal(preview.scale.x, 1);
    assert.equal(root.scale.x, 1);
});

test("a marker scale map clamps manual values and drops bad entries", () => {
    const map = normalizeSensorMarkerScaleMap({
        mini: { mode: "manual", scale: 9 },
        tiny: { mode: "manual", scale: 0.01 },
        broken: { mode: "manual", scale: "large" },
        weird: { mode: "nope", scale: 0.2 },
        junk: "fit",
        truck: { mode: "fit" },
        other: { mode: "manual", scale: 0.4 },
    });
    assert.deepEqual(map.mini, { mode: "manual", scale: 2 });
    assert.deepEqual(map.tiny, { mode: "manual", scale: 0.05 });
    assert.equal(map.broken, undefined);
    assert.equal(map.weird, undefined);
    assert.equal(map.junk, undefined);
    assert.deepEqual(map.truck, { mode: "fit" });
    assert.deepEqual(map.other, { mode: "manual", scale: 0.4 });
    assert.deepEqual(normalizeSensorMarkerScaleMap(null), {});
    assert.deepEqual(normalizeSensorMarkerScaleMap(["mini"]), {});
});

test("a manual scale overrides the fit, and other vehicles stay on the fit", () => {
    const map = normalizeSensorMarkerScaleMap({
        mini: { mode: "manual", scale: 0.8 },
        truck: { mode: "fit" },
    });
    assert.equal(appliedSensorMarkerScale(map.mini, 0.4), 0.8);
    assert.equal(appliedSensorMarkerScale(map.truck, 0.4), 0.15);
    assert.equal(appliedSensorMarkerScale(undefined, 0.4), 0.15);
    assert.equal(appliedSensorMarkerScale({ mode: "manual", scale: 4 }, 4.5), 2);
});
