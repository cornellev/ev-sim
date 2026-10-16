import assert from "node:assert/strict";
import test from "node:test";

import {
    CoverageMeasurement,
    buildCoverageOccluder,
    coveragePointPositions,
    disposeCoverageOccluder,
    measureSensorCoverage,
    shellUv,
} from "../app/vehicles/editor/coverage/measureSensorCoverage.js";

function ray(overrides) {
    return {
        sensorId: "roof",
        sensorType: "lidar3d",
        family: "uniform-grid",
        index: 0,
        origin: { x: 0, y: 1, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        minRangeM: 1e-4,
        maxRangeM: 20,
        ...overrides,
    };
}

test("a downward ray reports the ground radius and the nearest sample", () => {
    const slope = 1 / Math.SQRT2;
    const report = measureSensorCoverage([
        ray({ direction: { x: slope, y: -slope, z: 0 } }),
    ], null, { groundY: 0, shellRadiusM: 5 });
    assert.ok(Math.abs(report.groundBlindRadiusM - 1) < 1e-3);
    assert.ok(Math.abs(report.nearestSampleM - Math.SQRT1_2) < 1e-3);
    assert.equal(report.clearCount, 1);
    assert.equal(report.blockedCount, 0);
    assert.equal(report.occluderSource, "none");
});

test("a triangle in front of a ray blocks it and leaves the ground unseen", () => {
    const occluder = buildCoverageOccluder(
        [[0, 0.5, -2], [3, 0.5, -2], [1.25, 0.5, 2]],
        [[0, 1, 2]],
    );
    try {
        const length = Math.hypot(2.5, 1, 0);
        const report = measureSensorCoverage([
            ray({ direction: { x: 2.5 / length, y: -1 / length, z: 0 } }),
        ], occluder, { groundY: 0, occluderSource: "model" });
        assert.equal(report.blockedCount, 1);
        assert.equal(report.clearCount, 0);
        assert.equal(report.groundBlindRadiusM, null);
        assert.equal(report.nearestSampleM, null);
    } finally {
        disposeCoverageOccluder(occluder);
    }
});

test("forward and rear rays leave a horizon gap and keep both sensors", () => {
    const report = measureSensorCoverage([
        ray({
            sensorId: "front",
            origin: { x: 0, y: 0, z: 0 },
            direction: { x: 1, y: 0, z: 0 },
        }),
        ray({
            sensorId: "rear",
            sensorType: "test.range-image-fixture.synthetic-3x4",
            family: "range-image",
            origin: { x: 0, y: 0, z: 0 },
            direction: { x: -1, y: 0, z: 0 },
            minRangeM: 0.1,
        }),
    ], null, { groundY: 0, shellRadiusM: 5 });
    assert.deepEqual(report.sensors.map((sensor) => sensor.id), ["front", "rear"]);
    assert.ok(report.horizonGap);
    assert.ok(report.horizonGap.spanDeg > 90);
    assert.equal(report.groundBlindRadiusM, null);
});

test("open ground beyond the body is the unseen ground radius minus the footprint", () => {
    const length = Math.hypot(2.5, 1, 0);
    const report = measureSensorCoverage([
        ray({ direction: { x: 2.5 / length, y: -1 / length, z: 0 } }),
    ], null, { groundY: 0, bodyFootprintRadiusM: 1 });
    assert.ok(Math.abs(report.groundBlindRadiusM - 2.5) < 1e-3);
    assert.ok(Math.abs(report.groundGapM - 1.5) < 1e-3);
});

test("a +X ray paints the shell texel predicted by the equirectangular uv", () => {
    const report = measureSensorCoverage([
        ray({
            origin: { x: 0, y: 0, z: 0 },
            direction: { x: 1, y: 0, z: 0 },
        }),
    ], null, { shellRadiusM: 5 });
    const uv = shellUv(5, 0, 0);
    const x = Math.min(report.shell.width - 1, Math.floor(uv.u * report.shell.width));
    const y = Math.min(report.shell.height - 1, Math.floor(uv.v * report.shell.height));
    const alpha = report.shell.rgba[(y * report.shell.width + x) * 4 + 3];
    assert.ok(alpha > 0);
    assert.equal(report.shell.rgba[(y * report.shell.width + x + 1) * 4 + 3] ?? 0, 0);
});

test("rays that share a shell texel each keep a point", () => {
    const pass = new CoverageMeasurement([
        ray({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }),
        ray({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0.999, y: 0.001, z: 0 } }),
        ray({ direction: { x: 1 / Math.SQRT2, y: -1 / Math.SQRT2, z: 0 } }),
    ], null, { shellRadiusM: 5, groundY: 0 });
    pass.step(3);
    const points = coveragePointPositions(pass.samples, { shellRadiusM: 5, groundY: 0 });
    assert.equal(points.shell.length / 3, 3);
    assert.equal(points.ground.length / 3, 1);
    assert.equal(coveragePointPositions([{ clear: false }], { shellRadiusM: 5, groundY: 0 }).shell.length, 0);
});
