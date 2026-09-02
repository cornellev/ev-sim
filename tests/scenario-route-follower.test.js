import assert from "node:assert/strict";
import test from "node:test";

import {
    buildArcLengthPolyline,
    filletPolyline,
    followPathLength,
    followPolylineFromRoute,
    followRadiusM,
    FOLLOW_PATH_DEFAULT_KINEMATICS,
    minTurningRadius,
    routeFollowerCommand,
    sameEndpoints,
    stableStringify,
    verifyRoute,
} from "../app/scenarios/route/index.js";

function roadEnvironment() {
    return {
        environmentId: "route-follower-test",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 20, z: 0, kind: "intersection" },
                { id: "c", x: 20, z: 20, kind: "endpoint" },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: false, width: 6 },
                { id: "bc", startNodeId: "b", endNodeId: "c", bidirectional: false, width: 6 },
            ],
        },
    };
}

const L_PATH = [
    { x: 0, y: 0, z: 0 },
    { x: 20, y: 0, z: 0 },
    { x: 20, y: 0, z: 20 },
];

test("minTurningRadius and followRadiusM use bicycle kinematics with margin", () => {
    const kinematics = { wheelbase: 1.5, maxSteeringAngle: 0.6 };
    const rMin = minTurningRadius(kinematics);
    assert.ok(Math.abs(rMin - (1.5 / Math.tan(0.6))) < 1e-9);
    assert.ok(Math.abs(followRadiusM(kinematics) - rMin * 1.15) < 1e-9);
});

test("followRadiusM keeps a road-scale radius when plant maxSteer is near pi/2", () => {
    const bigCarLike = { wheelbase: 1.2446, maxSteeringAngle: Math.PI * 0.49 };
    assert.ok(minTurningRadius(bigCarLike) < 0.1, "plant R_min is tiny for huge maxSteer");
    const followR = followRadiusM(bigCarLike);
    assert.ok(followR > 2, `expected road-scale fillet radius, got ${followR}`);
    const L = [
        { x: 0, y: 0, z: 0 },
        { x: 40, y: 0, z: 0 },
        { x: 40, y: 0, z: 40 },
    ];
    const filleted = filletPolyline(L, followR);
    assert.ok(filleted.length > L.length, "big-car-like kinematics must still fillet corners");
});

test("filletPolyline inserts an arc on a 90-degree L, keeps endpoints, and is a no-op for collinear points", () => {
    const radius = followRadiusM(FOLLOW_PATH_DEFAULT_KINEMATICS);
    const filleted = filletPolyline(L_PATH, radius);
    assert.ok(filleted.length > L_PATH.length);
    assert.equal(sameEndpoints(filleted, L_PATH), true);
    assert.ok(followPathLength(filleted) < followPathLength(L_PATH));

    const straight = [
        { x: 0, y: 0, z: 0 },
        { x: 5, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
    ];
    const unchanged = filletPolyline(straight, radius);
    assert.equal(unchanged.length, straight.length);
    assert.deepEqual(
        unchanged.map((point) => ({ x: point.x, z: point.z })),
        straight.map((point) => ({ x: point.x, z: point.z })),
    );

    const again = filletPolyline(L_PATH, radius);
    assert.equal(stableStringify(filleted), stableStringify(again));
});

test("short segments shrink the fillet radius instead of overshooting", () => {
    const short = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 0, z: 1 },
    ];
    const filleted = filletPolyline(short, 5);
    assert.equal(sameEndpoints(filleted, short), true);
    // Either keeps the vertex (radius below floor) or inserts a tiny arc that fits.
    assert.ok(followPathLength(filleted) <= followPathLength(short) + 1e-6);
});

test("followPolylineFromRoute does not mutate directed-A* verification", () => {
    const environment = roadEnvironment();
    const result = verifyRoute(environment, {
        id: "turn-route",
        waypoints: [
            { id: "start", x: 1, z: 0 },
            { id: "finish", x: 20, z: 19 },
        ],
    });
    assert.equal(result.ok, true);
    const before = stableStringify(result.route.verification);
    const follow = followPolylineFromRoute(result.route, FOLLOW_PATH_DEFAULT_KINEMATICS);
    assert.ok(follow.length >= 2);
    assert.equal(stableStringify(result.route.verification), before);
    assert.equal(sameEndpoints(follow, result.route.verification.polyline), true);
});

test("routeFollowerCommand tracks a straight path with near-zero steer at cruise", () => {
    const polyline = [
        { x: 0, y: 0, z: 0 },
        { x: 30, y: 0, z: 0 },
    ];
    const command = routeFollowerCommand({
        position: { x: 2, y: 0, z: 0 },
        yaw: 0,
        cruiseSpeedMps: 4,
        achievedSpeedMps: 4,
        followPolyline: polyline,
        kinematics: FOLLOW_PATH_DEFAULT_KINEMATICS,
    });
    assert.equal(command.speedMps, 4);
    assert.ok(Math.abs(command.steeringRad) < 0.05);
});

test("routeFollowerCommand steers opposite directions for left vs right lookahead", () => {
    // Plant positive steer yaws toward -Z (right when facing +X).
    const towardPlusZ = routeFollowerCommand({
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        cruiseSpeedMps: 3,
        followPolyline: [
            { x: 0, y: 0, z: 0 },
            { x: 10, y: 0, z: 10 },
        ],
        kinematics: FOLLOW_PATH_DEFAULT_KINEMATICS,
    });
    const towardMinusZ = routeFollowerCommand({
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        cruiseSpeedMps: 3,
        followPolyline: [
            { x: 0, y: 0, z: 0 },
            { x: 10, y: 0, z: -10 },
        ],
        kinematics: FOLLOW_PATH_DEFAULT_KINEMATICS,
    });
    assert.ok(towardPlusZ.steeringRad < 0, `expected left (-Z) steer for +Z path, got ${towardPlusZ.steeringRad}`);
    assert.ok(towardMinusZ.steeringRad > 0, `expected right (+steer) for -Z path, got ${towardMinusZ.steeringRad}`);
});

test("filleted L-path triggers early steer and curvature-limited speed before the vertex", () => {
    const kinematics = FOLLOW_PATH_DEFAULT_KINEMATICS;
    const follow = filletPolyline(L_PATH, followRadiusM(kinematics));
    const arc = buildArcLengthPolyline(follow);
    // Stand on the approach a few meters before the fillet entry.
    const approach = { x: 16, y: 0, z: 0 };
    const command = routeFollowerCommand({
        position: approach,
        yaw: 0,
        cruiseSpeedMps: 6,
        achievedSpeedMps: 6,
        followPolyline: follow,
        kinematics,
    });
    // L-path turns toward +Z → plant-negative (left) steer.
    assert.ok(command.steeringRad < -0.05, `expected early left steer, got ${command.steeringRad}`);
    assert.ok(command.kappa > 0, "expected upcoming curvature on filleted corner");
    assert.ok(command.speedMps < 6, `expected curvature-limited speed, got ${command.speedMps}`);
    assert.ok(command.speedMps > 0);
    assert.ok(arc.totalLength < 40);
});

test("city-grid style first corner gets early steer with big-car kinematics", () => {
    const kinematics = { wheelbase: 1.2446, maxSteeringAngle: Math.PI * 0.49 };
    const path = [
        { x: 0, y: 0, z: 0 },
        { x: 40, y: 0, z: 0 },
        { x: 40, y: 0, z: 40 },
    ];
    const follow = filletPolyline(path, followRadiusM(kinematics));
    const command = routeFollowerCommand({
        position: { x: 36, y: 0, z: 0 },
        yaw: 0,
        cruiseSpeedMps: 2,
        achievedSpeedMps: 2,
        followPolyline: follow,
        kinematics,
    });
    assert.ok(follow.length > path.length);
    assert.ok(command.steeringRad < -0.05, `expected early left steer before (40,0), got ${command.steeringRad}`);
    assert.ok(command.speedMps <= 2);
});

test("overlapping out-and-back visits keep forward progress instead of looping the first pass", () => {
    const kinematics = FOLLOW_PATH_DEFAULT_KINEMATICS;
    // Same centerline as the loop-de-loop log: north on x=40 is visited twice.
    const path = [
        { x: 0, y: 0, z: 0 },
        { x: 40, y: 0, z: 0 },
        { x: 40, y: 0, z: 40 },
        { x: 80, y: 0, z: 40 },
        { x: 80, y: 0, z: 0 },
        { x: 40, y: 0, z: 0 },
        { x: 40, y: 0, z: 80 },
        { x: 80, y: 0, z: 80 },
    ];
    const follow = filletPolyline(path, followRadiusM(kinematics));
    const secondVisitAlong = 200;
    const firstPass = routeFollowerCommand({
        position: { x: 40, y: 0, z: 5 },
        yaw: -Math.PI / 2,
        cruiseSpeedMps: 2,
        achievedSpeedMps: 2,
        followPolyline: follow,
        kinematics,
        minDistanceAlong: 40,
    });
    const secondPass = routeFollowerCommand({
        position: { x: 40, y: 0, z: 5 },
        yaw: -Math.PI / 2,
        cruiseSpeedMps: 2,
        achievedSpeedMps: 2,
        followPolyline: follow,
        kinematics,
        minDistanceAlong: secondVisitAlong,
    });
    assert.ok(firstPass.distanceAlong < 80, `first pass should stay on the early visit, got ${firstPass.distanceAlong}`);
    assert.ok(secondPass.distanceAlong > 180, `second pass must not snap back (got ${secondPass.distanceAlong})`);
    assert.ok(secondPass.distanceAlong > firstPass.distanceAlong + 50);
});
