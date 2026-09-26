import assert from "node:assert/strict";
import test from "node:test";

import { buildPlanViewFrame } from "../app/spatial/planview/frame.js";
import "../app/spatial/planview/layers/index.js";
import { projectPlanView } from "../app/spatial/planview/project.js";
import { registerPlanLayer, unregisterPlanLayer } from "../app/spatial/planview/registry.js";
import { defaultVisibility, isGroupVisible, toggleGroup, toggleLayer } from "../app/spatial/planview/visibility.js";
import { PLAN_COLORS, SIGNAL_COLORS } from "../app/spatial/planview/primitives.js";

function vehicle(id, position, extra = {}) {
    return {
        telemetryId: id,
        position: { x: position.x, y: 0, z: position.z },
        rotation: { y: extra.yaw ?? 0 },
        velocity: extra.velocity ?? { x: 0, y: 0, z: 0 },
        manifest: { boundingBox: { size: { x: 4, y: 1.4, z: 2 }, center: { x: 0, y: 0.7, z: 0 } } },
        class: extra.class,
        devices: extra.devices ?? [],
    };
}

function frame(overrides = {}) {
    return buildPlanViewFrame({
        vehicles: [
            vehicle("ego", { x: 0, z: 0 }, { velocity: { x: 2, y: 0, z: 0 } }),
            vehicle("npc", { x: 8, z: 3 }),
        ],
        scenario: {
            actors: [{ id: "ego", role: "ego" }, { id: "npc", role: "actor" }],
            routes: [{ actorId: "ego", waypoints: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }] }],
        },
        metrics: { "route-progress": 10, "off-road": 0 },
        ...overrides,
    });
}

test("actor polygons distinguish ego, collision, and off-road", () => {
    const calm = projectPlanView(frame(), defaultVisibility()).filter((primitive) => primitive.layerId === "actors");
    const ego = calm.find((primitive) => primitive.actorId === "ego");
    const npc = calm.find((primitive) => primitive.actorId === "npc");
    assert.equal(ego.kind, "polygon");
    assert.equal(ego.stroke, PLAN_COLORS.ego);
    assert.equal(npc.stroke, PLAN_COLORS.vehicle);
    assert.equal(ego.points.length, 4);

    const contact = projectPlanView(frame({
        contacts: ["ego|npc"],
        metrics: { "off-road": 1, "route-progress": 10 },
    }), defaultVisibility()).filter((primitive) => primitive.layerId === "actors");
    assert.equal(contact.find((primitive) => primitive.actorId === "ego").stroke, PLAN_COLORS.collision);
    assert.equal(contact.find((primitive) => primitive.actorId === "npc").stroke, PLAN_COLORS.collision);

    const offRoad = projectPlanView(frame({ metrics: { "off-road": 1, "route-progress": 0 } }), defaultVisibility());
    assert.equal(offRoad.find((primitive) => primitive.layerId === "actors" && primitive.actorId === "ego").stroke, PLAN_COLORS.offRoad);
});

test("pedestrians are circles and cyclists use a narrower box", () => {
    const projected = projectPlanView(buildPlanViewFrame({
        vehicles: [
            vehicle("walker", { x: 1, z: 1 }, { class: "pedestrian" }),
            vehicle("bike", { x: 2, z: 2 }, { class: "cyclist" }),
        ],
    }), defaultVisibility());
    const walker = projected.find((primitive) => primitive.actorId === "walker");
    const bike = projected.find((primitive) => primitive.actorId === "bike");
    assert.equal(walker.kind, "circle");
    assert.equal(walker.radiusM, 0.35);
    assert.equal(bike.kind, "polygon");
    const width = Math.hypot(bike.points[0].z - bike.points[1].z, bike.points[0].x - bike.points[1].x);
    assert.ok(width < 1.5);
});

test("route progress splits the driven and remaining polyline", () => {
    const routes = projectPlanView(frame(), defaultVisibility()).filter((primitive) => primitive.layerId === "route");
    assert.equal(routes.length, 2);
    assert.equal(routes[0].dash, undefined);
    assert.equal(routes[0].points.at(-1).x, 10);
    assert.equal(routes[1].dash, "6 5");
    assert.equal(routes[1].points[0].x, 10);
    const goal = projectPlanView(frame(), defaultVisibility()).find((primitive) => primitive.layerId === "goal");
    assert.equal(goal.center.x, 20);
});

test("labels follow ego and the selected actor, and speed uses the velocity vector", () => {
    const projected = projectPlanView(frame({ selectedActorId: "npc" }), defaultVisibility());
    const labels = projected.filter((primitive) => primitive.layerId === "labels");
    assert.deepEqual(labels.map((primitive) => primitive.actorId), ["ego", "npc"]);
    const speed = projected.find((primitive) => primitive.layerId === "speed");
    assert.equal(speed.points[1].x, 2);
});

test("perception stays hidden until the layer is enabled", () => {
    const withDetections = frame({
        perception: {
            detections3d: [{ center: { x: 3, z: 1 }, size: { x: 2, z: 1 }, yaw: 0 }],
            oracle: { detections3d: [{ center: { x: 4, z: 1 }, size: { x: 2, z: 1 }, yaw: 0 }] },
        },
    });
    const hidden = projectPlanView(withDetections, defaultVisibility());
    assert.equal(hidden.some((primitive) => primitive.layerId === "perception"), false);
    const shown = projectPlanView(withDetections, { ...defaultVisibility(), perception: true });
    const boxes = shown.filter((primitive) => primitive.layerId === "perception");
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0].stroke, PLAN_COLORS.oracle);
    assert.equal(boxes[1].stroke, PLAN_COLORS.candidate);
});

test("control arcs and localization use the autonomy snapshot", () => {
    const projected = projectPlanView(frame({
        controlsById: {
            ego: { applied: { steeringRad: 0.2 }, achieved: { steeringRad: 0.1 }, wheelbase: 2.5 },
        },
        localization: { estimate: { position: { x: 1, z: 0.5 } } },
    }), defaultVisibility());
    const arcs = projected.filter((primitive) => primitive.layerId === "controls");
    assert.equal(arcs.length, 2);
    assert.ok(arcs[0].points.at(-1).z > 0.05);
    const estimate = projected.find((primitive) => primitive.layerId === "localization" && primitive.kind === "circle");
    assert.equal(estimate.center.x, 1);
});

test("the sensors group toggles wedges, and an injected signal draws a disc", () => {
    const built = frame({
        vehicles: [vehicle("ego", { x: 0, z: 0 }, {
            devices: [{
                telemetryId: "lidar",
                enabled: true,
                settings: { range: 12, theta: { range: [-45, 45] } },
                getPosition: () => ({ x: 0, y: 0, z: 0 }),
                getRotation: () => ({ y: 0 }),
            }],
        })],
        signals: [{ id: "light-1", position: { x: 6, z: 1 }, state: "red" }],
    });
    const visibility = defaultVisibility();
    assert.equal(isGroupVisible(visibility, "sensors"), true);
    const shown = projectPlanView(built, visibility);
    assert.equal(shown.some((primitive) => primitive.layerId === "sensors"), true);
    const hidden = projectPlanView(built, toggleGroup(visibility, "sensors"));
    assert.equal(hidden.some((primitive) => primitive.layerId === "sensors"), false);
    const signal = shown.find((primitive) => primitive.layerId === "signals");
    assert.equal(signal.kind, "circle");
    assert.equal(signal.fill, SIGNAL_COLORS.red);
    assert.equal(signal.center.x, 6);
});

test("a registered layer is projected with the frame and can be removed", () => {
    registerPlanLayer({
        id: "custom-marker",
        label: "Custom marker",
        group: "task",
        defaultVisible: true,
        project(current) {
            return current.vehicles.map((actor) => ({
                kind: "circle",
                center: { x: actor.position.x, z: actor.position.z },
                radiusPx: 4,
                fill: "#f8fafc",
            }));
        },
    });
    try {
        const projected = projectPlanView(frame(), { ...defaultVisibility(), "custom-marker": true });
        assert.equal(projected.filter((primitive) => primitive.layerId === "custom-marker").length, 2);
        const without = projectPlanView(frame(), toggleLayer({ ...defaultVisibility(), "custom-marker": true }, "custom-marker"));
        assert.equal(without.some((primitive) => primitive.layerId === "custom-marker"), false);
    } finally {
        unregisterPlanLayer("custom-marker");
    }
});
