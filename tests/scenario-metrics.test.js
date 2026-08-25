import assert from "node:assert/strict";
import test from "node:test";

import {
    ACCELERATION_LIMIT_MPS2,
    CURVATURE_LIMIT_PER_M,
    ScenarioMetricCollector,
    normalizeReferenceKeyframes,
    resolveVehicleFootprint,
    sampleReferenceKeyframe,
} from "../app/scenarios/ScenarioMetrics.js";
import { vehicleGroundFootprint } from "../app/scenarios/route/geometry.js";

function straightRoute(length = 20) {
    const polyline = [{ x: 0, y: 0, z: 0 }, { x: length, y: 0, z: 0 }];
    return {
        id: "ego-route",
        actorId: "ego",
        waypoints: [
            { id: "start", position: polyline[0] },
            { id: "end", position: polyline[1] },
        ],
        polyline,
        sections: [{ index: 0, polyline, length }],
        totalLength: length,
        verification: { polyline, totalLength: length, sections: [{ index: 0, polyline, length }] },
    };
}

function corridorEnvironment({ length = 40, width = 8 } = {}) {
    return {
        environmentId: "metrics-corridor",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0 },
                { id: "b", x: length, y: 0, z: 0 },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", width, bidirectional: true },
            ],
        },
    };
}

function intersectionEnvironment() {
    return {
        environmentId: "metrics-x",
        roads: {
            nodes: [
                { id: "c", x: 0, y: 0, z: 0 },
                { id: "n", x: 0, y: 0, z: -20 },
                { id: "s", x: 0, y: 0, z: 20 },
                { id: "e", x: 20, y: 0, z: 0 },
                { id: "w", x: -20, y: 0, z: 0 },
            ],
            edges: [
                { id: "cn", startNodeId: "c", endNodeId: "n", width: 7, bidirectional: true },
                { id: "cs", startNodeId: "c", endNodeId: "s", width: 7, bidirectional: true },
                { id: "ce", startNodeId: "c", endNodeId: "e", width: 7, bidirectional: true },
                { id: "cw", startNodeId: "c", endNodeId: "w", width: 7, bidirectional: true },
            ],
        },
    };
}

function pose(x, z, yaw = 0) {
    return { position: { x, y: 0, z }, rotation: { x: 0, y: yaw, z: 0 } };
}

test("route progress is max non-negative arc distance from the initial projection", () => {
    const collector = new ScenarioMetricCollector();
    collector.configure({
        route: straightRoute(20),
        environment: corridorEnvironment(),
        footprint: resolveVehicleFootprint(null, { type: "scenario-car" }),
    });

    collector.observe({ timeNs: 0, dt: 0.1, pose: pose(5, 0) });
    collector.observe({ timeNs: 100_000_000, dt: 0.1, pose: pose(12, 0) });
    collector.observe({ timeNs: 200_000_000, dt: 0.1, pose: pose(9, 0) });
    const episode = collector.finalize();
    assert.equal(episode["route-progress"], 7);
    assert.equal(episode["route-progress-ratio"], 7 / 15);
});

test("missing route, road, footprint, or keyframes yield null rather than false success", () => {
    const collector = new ScenarioMetricCollector();
    collector.configure({});
    collector.observe({ timeNs: 0, pose: pose(0, 0) });
    const episode = collector.finalize();
    assert.equal(episode["route-progress"], null);
    assert.equal(episode["route-progress-ratio"], null);
    assert.equal(episode["off-road"], null);
    assert.equal(episode["wrong-way"], null);
    assert.equal(episode["log-divergence"], null);
    assert.equal(episode.failure, null);
});

test("off-road uses the yaw-oriented full footprint, including intersection disks", () => {
    const footprint = { size: { x: 4, y: 1.5, z: 2 }, center: { x: 0, y: 0.75, z: 0 }, wheelbase: 2.5 };
    const cornersOnRoad = vehicleGroundFootprint(pose(10, 0, 0), footprint.size, footprint.center);
    assert.equal(cornersOnRoad.length, 4);

    const collector = new ScenarioMetricCollector();
    collector.configure({
        route: straightRoute(40),
        environment: corridorEnvironment({ length: 40, width: 3 }),
        footprint,
    });
    collector.observe({ timeNs: 0, dt: 0.1, pose: pose(10, 0, 0) });
    assert.equal(collector.current()["off-road"], 0);

    // Rotate 90° so length spans Z and corners leave the 3 m corridor (half-width 1.5).
    collector.observe({ timeNs: 100_000_000, dt: 0.1, pose: pose(10, 0, Math.PI / 2) });
    assert.equal(collector.current()["off-road"], 1);
    assert.equal(collector.finalize()["off-road"], 1);

    const crossing = new ScenarioMetricCollector();
    crossing.configure({
        route: {
            ...straightRoute(20),
            polyline: [{ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }],
            totalLength: 20,
            sections: [{ index: 0, polyline: [{ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], length: 20 }],
        },
        environment: intersectionEnvironment(),
        footprint,
    });
    crossing.observe({ timeNs: 0, pose: pose(0, 0, 0) });
    assert.equal(crossing.current()["off-road"], 0);
});

test("wrong-way compares realized motion to the directed route tangent and ignores near-zero speed", () => {
    const collector = new ScenarioMetricCollector();
    collector.configure({
        route: straightRoute(30),
        environment: corridorEnvironment(),
        footprint: resolveVehicleFootprint(null, { type: "big-car" }),
    });
    collector.observe({ timeNs: 0, dt: 0.1, pose: pose(0, 0, 0), velocity: { x: 0 } });
    assert.equal(collector.current()["wrong-way"], 0);

    collector.observe({ timeNs: 100_000_000, dt: 0.1, pose: pose(2, 0, 0) });
    assert.equal(collector.current()["wrong-way"], 0);

    collector.observe({ timeNs: 200_000_000, dt: 0.1, pose: pose(1, 0, Math.PI) });
    assert.equal(collector.current()["wrong-way"], 1);
    assert.equal(collector.finalize()["wrong-way"], 1);
});

test("kinematic thresholds mark infeasibility and report peak absolute accel/jerk", () => {
    const collector = new ScenarioMetricCollector();
    collector.configure({
        route: straightRoute(50),
        environment: corridorEnvironment({ length: 50 }),
        footprint: { size: { x: 4, y: 1.5, z: 2 }, center: { x: 0, y: 0.75, z: 0 }, wheelbase: 2.5 },
    });
    const dt = 0.1;
    // Speeds 0 → 0.5 → 2.0 produce accel 5 then 15 (> 10.4).
    collector.observe({ timeNs: 0, dt, pose: pose(0, 0), velocity: { x: 0 }, steeringAngle: 0 });
    collector.observe({ timeNs: 100_000_000, dt, pose: pose(0.05, 0), velocity: { x: 0.5 }, steeringAngle: 0 });
    collector.observe({ timeNs: 200_000_000, dt, pose: pose(0.25, 0), velocity: { x: 2.0 }, steeringAngle: 0 });
    assert.equal(collector.current()["kinematic-infeasibility"], 1);
    assert.ok(collector.current().acceleration > ACCELERATION_LIMIT_MPS2);

    const turning = new ScenarioMetricCollector();
    turning.configure({
        route: straightRoute(50),
        environment: corridorEnvironment({ length: 50 }),
        footprint: { size: { x: 4, y: 1.5, z: 2 }, center: { x: 0, y: 0.75, z: 0 }, wheelbase: 2.5 },
    });
    // tan(delta)/L > 0.3 ⇒ delta > atan(0.75) ≈ 0.6435
    turning.observe({
        timeNs: 0,
        dt: 0.1,
        pose: pose(0, 0),
        velocity: { x: 1 },
        steeringAngle: 0.7,
    });
    turning.observe({
        timeNs: 100_000_000,
        dt: 0.1,
        pose: pose(0.1, 0),
        velocity: { x: 1 },
        steeringAngle: 0.7,
    });
    assert.equal(turning.current()["kinematic-infeasibility"], 1);
    assert.ok(Math.tan(0.7) / 2.5 > CURVATURE_LIMIT_PER_M);

    const jerkCollector = new ScenarioMetricCollector();
    jerkCollector.configure({
        footprint: { size: { x: 4, y: 1.5, z: 2 }, center: { x: 0, y: 0.75, z: 0 }, wheelbase: 2.5 },
    });
    jerkCollector.observe({ timeNs: 0, dt: 0.1, pose: pose(0, 0), velocity: { x: 0 } });
    jerkCollector.observe({ timeNs: 100_000_000, dt: 0.1, pose: pose(0.05, 0), velocity: { x: 0.5 } });
    jerkCollector.observe({ timeNs: 200_000_000, dt: 0.1, pose: pose(0.15, 0), velocity: { x: 1.0 } });
    jerkCollector.observe({ timeNs: 300_000_000, dt: 0.1, pose: pose(0.35, 0), velocity: { x: 2.0 } });
    assert.ok(jerkCollector.finalize().jerk > 0);
});

test("log-divergence averages L2 XZ distance against interpolated keyframes and is null without coverage", () => {
    assert.deepEqual(normalizeReferenceKeyframes([
        { t: 0, x: 0, y: 0 },
        { t: 1, x: 10, y: 0 },
    ]), [
        { t: 0, x: 0, z: 0, yaw: 0 },
        { t: 1, x: 10, z: 0, yaw: 0 },
    ]);
    const mid = sampleReferenceKeyframe([
        { t: 0, x: 0, z: 0, yaw: 0 },
        { t: 1, x: 10, z: 0, yaw: 0 },
    ], 0.5);
    assert.equal(mid.x, 5);

    const collector = new ScenarioMetricCollector();
    collector.configure({
        keyframes: [
            { t: 0, x: 0, y: 0 },
            { t: 1, x: 10, y: 0 },
        ],
    });
    collector.observe({ timeNs: 0, pose: pose(0, 0) });
    collector.observe({ timeNs: 500_000_000, pose: pose(6, 0) });
    assert.equal(collector.finalize()["log-divergence"], 0.5);

    const missing = new ScenarioMetricCollector();
    missing.configure({ keyframes: [] });
    missing.observe({ timeNs: 0, pose: pose(0, 0) });
    assert.equal(missing.finalize()["log-divergence"], null);

    const outside = new ScenarioMetricCollector();
    outside.configure({
        keyframes: [
            { t: 1, x: 0, y: 0 },
            { t: 2, x: 10, y: 0 },
        ],
    });
    outside.observe({ timeNs: 0, pose: pose(0, 0) });
    assert.equal(outside.current()["log-divergence"], null);
});

test("failure is egoCollision OR offRoad without altering unrelated episode fields, and reset clears state", () => {
    const collector = new ScenarioMetricCollector();
    collector.configure({
        route: straightRoute(40),
        environment: corridorEnvironment(),
        footprint: { size: { x: 4, y: 1.5, z: 2 }, center: { x: 0, y: 0.75, z: 0 }, wheelbase: 2.5 },
    });
    collector.observe({ timeNs: 0, pose: pose(10, 0) });
    assert.equal(collector.finalize().failure, 0);

    collector.reset();
    collector.configure({
        route: straightRoute(40),
        environment: corridorEnvironment(),
        footprint: { size: { x: 4, y: 1.5, z: 2 }, center: { x: 0, y: 0.75, z: 0 }, wheelbase: 2.5 },
    });
    collector.observe({ timeNs: 0, pose: pose(10, 20) });
    assert.equal(collector.finalize().failure, 1);

    collector.reset();
    collector.configure({
        route: straightRoute(40),
        environment: corridorEnvironment(),
        footprint: { size: { x: 4, y: 1.5, z: 2 }, center: { x: 0, y: 0.75, z: 0 }, wheelbase: 2.5 },
    });
    collector.observe({ timeNs: 0, pose: pose(10, 0), egoCollision: true });
    assert.equal(collector.finalize().failure, 1);

    collector.reset();
    assert.equal(collector.finalize()["route-progress"], null);
});

test("resolveVehicleFootprint uses built-in vehicle types deterministically", () => {
    const big = resolveVehicleFootprint(null, { type: "big-car" });
    assert.ok(big.size.x > 2);
    assert.ok(big.wheelbase > 1);
    const igvc = resolveVehicleFootprint(null, { type: "igvc-car" });
    assert.ok(igvc.size.x < big.size.x);
    const live = resolveVehicleFootprint({ collisionDimensions: { x: 3, y: 1, z: 1.5 } });
    assert.equal(live.size.x, 3);
    assert.equal(live.size.z, 1.5);
});
