import assert from "node:assert/strict";
import test from "node:test";

import { catalogHash, catalogSchemas } from "../app/autonomy/AutonomyContractCatalog.js";
import { registerMsgDefinition } from "../app/client/TopicCodec.js";
import { buildPlanViewFrame } from "../app/spatial/planview/frame.js";
import "../app/spatial/planview/layers/index.js";
import { PLAN_COLORS } from "../app/spatial/planview/primitives.js";
import { projectPlanView } from "../app/spatial/planview/project.js";
import { defaultVisibility } from "../app/spatial/planview/visibility.js";
import {
    PLAN_WAYPOINTS_DEFINITION,
    PLAN_WAYPOINTS_TYPE,
    getPlanWaypoints,
    setPlanWaypoints,
} from "../app/spatial/planview/waypoints.js";

function vehicle(position, yaw = 0) {
    return {
        telemetryId: "ego",
        position: { x: position.x, y: 0, z: position.z },
        rotation: { y: yaw },
        velocity: { x: 0, y: 0, z: 0 },
    };
}

function waypointsOf(frame) {
    return projectPlanView(frame, defaultVisibility()).filter((primitive) => primitive.layerId === "waypoints");
}

function projected(waypoints, { yaw = 0, position = { x: 0, z: 0 }, mode = "global", vehicles } = {}) {
    return waypointsOf(buildPlanViewFrame({
        vehicles: vehicles ?? [vehicle(position, yaw)],
        scenario: { actors: [{ id: "ego", role: "ego" }] },
        waypoints,
        waypointFrame: mode,
    }));
}

test("global waypoints draw an orange polyline at map coordinates", () => {
    const drawn = projected([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const line = drawn.find((primitive) => primitive.kind === "polyline");
    assert.equal(line.stroke, PLAN_COLORS.waypoints);
    assert.deepEqual(line.points, [{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    assert.equal(drawn.filter((primitive) => primitive.kind === "circle").length, 2);
});

test("one waypoint is a marker and an empty list draws nothing", () => {
    const one = projected([{ x: 3, z: 4 }]);
    assert.equal(one.length, 1);
    assert.equal(one[0].kind, "circle");
    assert.deepEqual(one[0].center, { x: 3, z: 4 });
    assert.equal(projected([]).length, 0);
});

test("body mode places the list on the ego heading", () => {
    const list = [{ x: 1, z: 0 }];
    const ahead = projected(list, { position: { x: 10, z: 5 }, yaw: 0, mode: "body" });
    assert.deepEqual(ahead[0].center, { x: 11, z: 5 });
    const turned = projected(list, { yaw: Math.PI / 2, mode: "body" });
    const center = turned[0].center;
    assert.ok(Math.abs(center.x) < 1e-9);
    assert.ok(Math.abs(center.z + 1) < 1e-9);
    assert.equal(projected(list, { mode: "body", vehicles: [] }).length, 0);
});

test("the same list is map coordinates in global mode and ego-relative in body mode", () => {
    const list = [{ x: 1, z: 2 }, { x: 4, z: 2 }];
    const options = { position: { x: 10, z: 5 }, yaw: 0 };
    const global = projected(list, { ...options, mode: "global" }).find((primitive) => primitive.kind === "polyline");
    const body = projected(list, { ...options, mode: "body" }).find((primitive) => primitive.kind === "polyline");
    assert.deepEqual(global.points, list);
    assert.deepEqual(body.points, [{ x: 11, z: 7 }, { x: 14, z: 7 }]);
});

test("client payload keeps x and z and drops non-finite points", () => {
    setPlanWaypoints({ points: [{ x: 1, y: 9, z: 2 }, { x: Number.NaN, z: 0 }, { x: 3, z: 4 }] });
    assert.deepEqual(getPlanWaypoints(), [{ x: 1, z: 2 }, { x: 3, z: 4 }]);
    setPlanWaypoints([]);
    assert.deepEqual(getPlanWaypoints(), []);
});

test("registering the waypoint message leaves the catalog hash unchanged", () => {
    assert.equal(catalogSchemas()[PLAN_WAYPOINTS_TYPE], undefined);
    const before = catalogHash();
    registerMsgDefinition(PLAN_WAYPOINTS_TYPE, PLAN_WAYPOINTS_DEFINITION);
    assert.equal(catalogHash(), before);
});
