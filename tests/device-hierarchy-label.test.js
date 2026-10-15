import assert from "node:assert/strict";
import test from "node:test";

import { deviceHierarchyLabel } from "../app/3d/overlay/deviceHierarchyLabel.js";

test("device hierarchy label falls back to the sensor id", () => {
    assert.equal(deviceHierarchyLabel({ name: "front", telemetryId: "other", id: "ignored" }), "front");
    assert.equal(deviceHierarchyLabel({ name: "  ", telemetryId: "car-imu", id: "imu" }), "car-imu");
    assert.equal(deviceHierarchyLabel({ id: "helios" }), "helios");
    assert.equal(deviceHierarchyLabel({}), "");
});
