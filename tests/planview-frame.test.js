import assert from "node:assert/strict";
import test from "node:test";

import { sampleAckermannCenterline } from "../app/autonomy/ControlsPathArc.js";
import {
    appendPlanTrails,
    buildPlanViewFrame,
    clipTrail,
    planViewSourcesFromData,
} from "../app/spatial/planview/frame.js";

function vehicle(id, position, extra = {}) {
    return {
        telemetryId: id,
        position: { x: position.x, y: 0, z: position.z },
        rotation: { y: extra.yaw ?? 0 },
        velocity: extra.velocity ?? { x: 0, y: 0, z: 0 },
        manifest: {
            boundingBox: {
                size: { x: 4, y: 1.5, z: 2 },
                center: { x: 0.2, y: 0.75, z: 0 },
            },
        },
        devices: extra.devices ?? [],
        ...extra.fields,
    };
}

const straightRoad = {
    roads: {
        geometryVersion: 1,
        nodes: [
            { id: "a", x: 0, y: 0, z: 0 },
            { id: "b", x: 40, y: 0, z: 0 },
        ],
        edges: [{ id: "e", startNodeId: "a", endNodeId: "b", width: 8 }],
    },
};

test("buildPlanViewFrame copies pose, role, box, and ego task state", () => {
    const frame = buildPlanViewFrame({
        timeNs: 1_000_000_000,
        vehicles: [
            vehicle("ego", { x: 10, z: 1 }, { velocity: { x: 3, y: 0, z: 0 } }),
            vehicle("npc", { x: 4, z: -2 }, { yaw: 0.4, fields: { class: "cyclist" } }),
        ],
        scenario: {
            actors: [
                { id: "ego", role: "ego" },
                { id: "npc", role: "actor" },
            ],
            routes: [{
                actorId: "ego",
                waypoints: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 30, z: 0 }],
            }],
        },
        metrics: { "off-road": 1, "route-progress": 10 },
        contacts: ["ego|npc"],
        environment: straightRoad,
        selectedActorId: "npc",
    });

    assert.equal(frame.vehicles.length, 2);
    const ego = frame.vehicles[0];
    assert.equal(ego.role, "ego");
    assert.equal(ego.offRoad, true);
    assert.equal(ego.colliding, true);
    assert.equal(ego.speed, 3);
    assert.equal(ego.box.center.x, 0.2);
    assert.equal(ego.routeProgress, 10);
    assert.deepEqual(ego.route, [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 30, z: 0 }]);
    const npc = frame.vehicles[1];
    assert.equal(npc.class, "cyclist");
    assert.equal(npc.offRoad, false);
    assert.equal(npc.colliding, true);
    assert.equal(npc.routeProgress, null);
    assert.equal(frame.selectedActorId, "npc");
    assert.ok(frame.lane.points.length >= 2);
    assert.ok(frame.lane.points.every((point) => point.x >= -0.01 && point.x <= 35.01));
});

test("buildPlanViewFrame reads camera and lidar wedges and skips disabled devices", () => {
    const frame = buildPlanViewFrame({
        vehicles: [vehicle("ego", { x: 0, z: 0 }, {
            devices: [
                {
                    telemetryId: "cam",
                    enabled: true,
                    cameraSettings: { fov: 75, width: 320, height: 180, far: 30 },
                    getPosition: () => ({ x: 1, y: 0, z: 2 }),
                    getRotation: () => ({ y: 0.5 }),
                },
                {
                    telemetryId: "lidar",
                    enabled: true,
                    settings: { range: 20, theta: { range: [0, 360] } },
                    getPosition: () => ({ x: 0, y: 0, z: 0 }),
                    getRotation: () => ({ y: 0 }),
                },
                {
                    telemetryId: "off",
                    enabled: false,
                    settings: { range: 10, theta: { range: [0, 90] } },
                    getPosition: () => ({ x: 0, y: 0, z: 0 }),
                    getRotation: () => ({ y: 0 }),
                },
            ],
        })],
    });

    assert.deepEqual(frame.sensors.map((sensor) => sensor.id), ["cam", "lidar"]);
    assert.equal(frame.sensors[0].kind, "camera");
    assert.ok(frame.sensors[0].endDeg > 0);
    assert.equal(frame.sensors[0].range, 30);
    assert.equal(frame.sensors[0].position.x, 1);
    assert.equal(frame.sensors[1].kind, "lidar");
    assert.equal(frame.sensors[1].endDeg, 360);
});

test("clipTrail and appendPlanTrails keep the requested window", () => {
    const trails = new Map();
    const ego = vehicle("ego", { x: 0, z: 0 });
    appendPlanTrails(trails, [ego], 0);
    ego.position = { x: 5, z: 0 };
    appendPlanTrails(trails, [ego], 11_000_000_000);
    const clipped = clipTrail(trails.get("ego"), 11_000_000_000, "10s");
    assert.equal(clipped.length, 1);
    assert.equal(clipped[0].x, 5);
    const full = clipTrail(trails.get("ego"), 11_000_000_000, "full");
    assert.equal(full.length, 2);
});

test("planViewSourcesFromData reads the live simulation accessors", () => {
    const sources = planViewSourcesFromData({
        vehicles: () => ({ vehicles: [vehicle("ego", { x: 1, z: 2 })] }),
        simulation: () => ({
            timeNs: 42,
            scenarioRuntime: {
                scenario: { actors: [{ id: "ego", role: "ego" }], routes: [] },
                getSnapshot: () => ({ metrics: { "off-road": 0 } }),
            },
            kernel: { lastContacts: { active: [] } },
            candidateOutputRuntime: { lastPerception: { detections3d: [] }, lastLocalization: {} },
            controlRuntime: null,
        }),
    }, { historyMode: "30s" });
    const frame = buildPlanViewFrame(sources);
    assert.equal(frame.timeNs, 42);
    assert.equal(frame.historyMode, "30s");
    assert.equal(frame.vehicles[0].id, "ego");
    assert.equal(frame.signals.length, 0);
});

test("sampleAckermannCenterline stays straight at zero steer and turns right for positive steer", () => {
    const straight = sampleAckermannCenterline(0, { wheelbase: 2, lookahead: 8, segments: 4 });
    assert.equal(straight[0].x, 0);
    assert.ok(straight.at(-1).x > straight[0].x);
    assert.ok(Math.abs(straight.at(-1).z) < 1e-9);
    const right = sampleAckermannCenterline(0.3, { wheelbase: 2, lookahead: 8, segments: 8 });
    assert.ok(right.at(-1).z < -0.1);
});
