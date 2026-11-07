import assert from "node:assert/strict";
import test from "node:test";

import { VehicleSelection } from "../app/vehicles/document/VehicleSelection.js";
import {
    buildVehicleHierarchy,
    describeModelPart,
    hierarchySelectionMatches,
    hierarchyVisibilityKey,
} from "../app/vehicles/editor/workspace/vehicleHierarchyModel.js";

function manifest(sensors) {
    return {
        model: { asset: "car.glb" },
        wheels: [{ id: "front-left", axle: "front" }],
        sensors,
    };
}

test("a lidar sensor and its LiDAR zone have distinct hierarchy keys", () => {
    const rows = buildVehicleHierarchy(manifest([
        { id: "lidar", name: "lidar", type: "lidar3d" },
        { id: "helios", name: "helios", type: "vendor.robosense.helios32.lidar" },
    ]));
    const sensors = rows.filter((row) => row.kind === "sensor");
    assert.deepEqual(sensors.map((row) => row.id), ["lidar", "helios"]);
    assert.equal(rows.filter((row) => row.kind === "lidar" && row.label === "LiDAR zone").length, 1);
    assert.notEqual(hierarchyVisibilityKey("sensor", "lidar"), hierarchyVisibilityKey("lidar", "lidar"));
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

test("model parts list parent before child and a selection names that part", () => {
    const nodes = [
        { index: 0, name: "door", parentIndex: 2, mesh: 1 },
        { index: 1, name: "chassis", parentIndex: null, mesh: null },
        { index: 2, name: "body", parentIndex: 1, mesh: 0 },
    ];
    const manifest = {
        model: { asset: "car.glb", hiddenNodeIndices: [2] },
        wheels: [{ id: "front-left", axle: "front", visual: { kind: "model-node", nodeIndex: 0 } }],
        sensors: [],
    };
    const rows = buildVehicleHierarchy(manifest, { nodes }).filter((row) => row.kind === "model-node");
    assert.deepEqual(rows.map((row) => row.id), ["node-1", "node-2", "node-0"]);
    assert.deepEqual(rows.map((row) => row.depth), [1, 2, 3]);
    assert.equal(rows[2].path, "chassis / body / door");
    assert.equal(hierarchySelectionMatches(rows[2], { kind: "model", id: null }), false);
    assert.equal(hierarchySelectionMatches(rows[2], { kind: "model-node", id: "node-0" }), true);
    assert.equal(hierarchySelectionMatches(rows[1], { kind: "model-node", id: "node-0" }), false);
    const part = describeModelPart(nodes, manifest, "node-0");
    assert.deepEqual(part, {
        name: "door",
        path: "chassis / body / door",
        nodeIndex: 0,
        mesh: true,
        wheelId: "front-left",
        semanticallyHidden: false,
    });
    assert.equal(describeModelPart(nodes, manifest, "node-2").semanticallyHidden, true);
    assert.equal(describeModelPart(nodes, manifest, "node-2").mesh, true);
    assert.equal(describeModelPart(nodes, manifest, "node-1").mesh, false);
    assert.equal(describeModelPart(nodes, manifest, "node-9"), null);
});

test("a model-node selection survives edits and clears when the model is gone", () => {
    const selection = new VehicleSelection();
    assert.deepEqual(selection.select("model-node", "node-2"), { kind: "model-node", id: "node-2" });
    selection.prune({ model: { asset: "car.glb" }, wheels: [], sensors: [] });
    assert.equal(selection.kind, "model-node");
    selection.prune({ model: {}, wheels: [], sensors: [] });
    assert.equal(selection.snapshot().kind, null);
});
