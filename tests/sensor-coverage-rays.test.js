import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Euler, Vector3 } from "three";

import { cameraScanAngles } from "../app/3d/devices/cameraScanAngles.js";
import { enumerateCoverageRays, sphericalDirection } from "../app/vehicles/editor/coverage/enumerateCoverageRays.js";

const plugin = JSON.parse(readFileSync(new URL("./fixtures/plugins/test.range-image-fixture/plugin.json", import.meta.url), "utf8"));
const pluginType = plugin.sensorTypes[0];
const pluginLayout = pluginType.defaults.scanLayout;

function definitionsForPlugin() {
    return {
        get(type) {
            if (type !== pluginType.type) return null;
            return {
                pluginSensor: {
                    descriptor: { defaults: { scanLayout: pluginLayout } },
                },
            };
        },
    };
}

function pose(rotation = {}) {
    return {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ", ...rotation },
    };
}

test("a single lidar step at the origin matches the spherical direction", () => {
    const { rays, skipped } = enumerateCoverageRays({
        sensors: [{
            id: "roof",
            type: "lidar3d",
            pose: pose(),
            config: {
                range: 20,
                thetaStep: 10,
                thetaRange: [0, 10],
                phiStep: 10,
                phiRange: [0, 10],
            },
        }],
    });
    assert.equal(skipped.length, 0);
    assert.equal(rays.length, 1);
    const expected = sphericalDirection(0, 0);
    assert.ok(Math.abs(rays[0].direction.x - expected.x) < 1e-9);
    assert.ok(Math.abs(rays[0].direction.y - expected.y) < 1e-9);
    assert.ok(Math.abs(rays[0].direction.z - expected.z) < 1e-9);
    assert.equal(rays[0].family, "uniform-grid");
    assert.equal(rays[0].minRangeM, 1e-4);
    assert.equal(rays[0].maxRangeM, 20);
    assert.equal(rays[0].index, 0);
});

test("a yawed lidar pose rotates the ray with the editor euler", () => {
    const { rays } = enumerateCoverageRays({
        sensors: [{
            id: "roof",
            type: "lidar3d",
            pose: pose({ y: Math.PI / 2 }),
            config: {
                range: 12,
                thetaStep: 10,
                thetaRange: [0, 10],
                phiStep: 10,
                phiRange: [0, 10],
            },
        }],
    });
    const expected = new Vector3(1, 0, 0).applyEuler(new Euler(0, Math.PI / 2, 0, "XYZ"));
    assert.ok(Math.abs(rays[0].direction.x - expected.x) < 1e-9);
    assert.ok(Math.abs(rays[0].direction.y - expected.y) < 1e-9);
    assert.ok(Math.abs(rays[0].direction.z - expected.z) < 1e-9);
});

test("a camera without angle limits uses cameraScanAngles", () => {
    const config = { range: 15, thetaStep: 30, phiStep: 30, fov: 75, width: 320, height: 180 };
    const angles = cameraScanAngles(config);
    const { rays } = enumerateCoverageRays({
        sensors: [{ id: "front-cam", type: "camera", pose: pose(), config }],
    });
    assert.ok(rays.length > 1);
    const azimuths = rays.map((ray) => Math.atan2(ray.direction.z, ray.direction.x));
    const elevations = rays.map((ray) => Math.asin(Math.min(1, Math.max(-1, ray.direction.y))));
    assert.ok(Math.abs(Math.min(...azimuths) - angles.thetaRange[0] * Math.PI / 180) < 1e-6);
    assert.ok(Math.abs(Math.max(...azimuths) - (angles.thetaRange[0] + Math.floor((angles.thetaRange[1] - angles.thetaRange[0]) / 30) * 30) * Math.PI / 180) < 1e-6);
    assert.ok(Math.abs(Math.min(...elevations) - angles.phiRange[0] * Math.PI / 180) < 1e-6);
    assert.ok(rays.every((ray) => ray.maxRangeM === 15 && ray.family === "uniform-grid"));
});

test("plugin range-image sensors use the declared scan layout, including descriptor defaults", () => {
    const explicit = {
        ...pluginLayout,
        channels: [{ id: 1, elevationDeg: 0, azimuthOffsetDeg: 0 }],
        azimuthsDeg: [0],
    };
    const { rays, skipped } = enumerateCoverageRays({
        sensors: [
            {
                id: "default-plugin",
                type: pluginType.type,
                pose: pose(),
                config: {},
            },
            {
                id: "override-plugin",
                type: pluginType.type,
                pose: pose({ y: 0 }),
                config: { scanLayout: explicit },
            },
        ],
    }, definitionsForPlugin());
    assert.equal(skipped.length, 0);
    const defaults = rays.filter((ray) => ray.sensorId === "default-plugin");
    const overrides = rays.filter((ray) => ray.sensorId === "override-plugin");
    assert.equal(defaults.length, pluginLayout.channels.length * pluginLayout.azimuthsDeg.length);
    assert.equal(overrides.length, 1);
    assert.equal(defaults[0].family, "range-image");
    assert.equal(defaults[0].minRangeM, pluginLayout.minRangeM);
    assert.equal(defaults[0].maxRangeM, pluginLayout.maxRangeM);
    const first = pluginLayout.channels[0];
    const expected = sphericalDirection(
        (pluginLayout.azimuthsDeg[0] + first.azimuthOffsetDeg) * Math.PI / 180,
        first.elevationDeg * Math.PI / 180,
    );
    assert.ok(Math.abs(defaults[0].direction.x - expected.x) < 1e-9);
    assert.ok(Math.abs(defaults[0].direction.y - expected.y) < 1e-9);
    assert.ok(Math.abs(defaults[0].direction.z - expected.z) < 1e-9);
});

test("non-ranging and unknown sensors are skipped and a bad plugin layout does not throw", () => {
    const { rays, skipped } = enumerateCoverageRays({
        sensors: [
            { id: "imu-1", type: "imu", pose: pose(), config: {} },
            { id: "mystery", type: "not-a-sensor", pose: pose(), config: {} },
            {
                id: "broken",
                type: pluginType.type,
                pose: pose(),
                config: { scanLayout: { kind: "nope" } },
            },
        ],
    }, definitionsForPlugin());
    assert.equal(rays.length, 0);
    assert.deepEqual(skipped.map((entry) => entry.reason), ["not-ranging", "unknown-type", "invalid-layout"]);
});
