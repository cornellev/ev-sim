import assert from "node:assert/strict";
import test from "node:test";

import { buildVehicleHierarchy, hierarchyVisibilityKey } from "../app/vehicles/editor/workspace/vehicleHierarchyModel.js";

function manifest(sensors) {
    return {
        model: { asset: "car.glb" },
        wheels: [{ id: "front-left", axle: "front" }],
        sensors,
    };
}

test("a lidar sensor is one hierarchy row and does not share the LiDAR zone id", () => {
    const rows = buildVehicleHierarchy(manifest([
        { id: "lidar", name: "lidar", type: "lidar3d" },
        { id: "helios", name: "helios", type: "vendor.robosense.helios32.lidar" },
    ]));
    const sensors = rows.filter((row) => row.kind === "sensor");
    assert.deepEqual(sensors.map((row) => row.id), ["lidar", "helios"]);
    assert.equal(rows.some((row) => row.kind === "lidar" || row.label === "LiDAR zone"), false);
    assert.equal(rows.some((row) => row.id === "lidar" && row.kind !== "sensor"), false);
    const keys = rows.map((row) => hierarchyVisibilityKey(row.kind, row.id));
    assert.equal(new Set(keys).size, keys.length);
});

test("a sensor id equal to a structural row id keeps a distinct hierarchy key", () => {
    const rows = buildVehicleHierarchy(manifest([
        { id: "body", type: "imu" },
        { id: "front-left", type: "wheel-odometry" },
    ]));
    const keys = rows.map((row) => hierarchyVisibilityKey(row.kind, row.id));
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.includes("body:body"));
    assert.ok(keys.includes("sensor:body"));
    assert.ok(keys.includes("wheel:front-left"));
    assert.ok(keys.includes("sensor:front-left"));
});
