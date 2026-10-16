import assert from "node:assert/strict";
import test from "node:test";

import { revealSelectedSensor, setSensorDisclosureOpen } from "../app/vehicles/editor/sensorDisclosure.js";

test("selecting a sensor opens its row once", () => {
    const revealed = revealSelectedSensor([], "lidar", null);
    assert.deepEqual(revealed.openSensorIds, ["lidar"]);
    assert.equal(revealed.revealedSensorId, "lidar");
    assert.equal(revealSelectedSensor(revealed.openSensorIds, "lidar", revealed.revealedSensorId).openSensorIds, revealed.openSensorIds);
});

test("collapsing the selected sensor stays collapsed", () => {
    const revealed = revealSelectedSensor([], "lidar", null);
    const collapsed = setSensorDisclosureOpen(revealed.openSensorIds, "lidar", false);
    const again = revealSelectedSensor(collapsed, "lidar", revealed.revealedSensorId);
    assert.deepEqual(collapsed, []);
    assert.deepEqual(again.openSensorIds, []);
    assert.equal(again.revealedSensorId, "lidar");
});

test("a later selection opens that sensor and leaves a collapsed row closed", () => {
    const revealed = revealSelectedSensor([], "lidar", null);
    const collapsed = setSensorDisclosureOpen(revealed.openSensorIds, "lidar", false);
    const withCamera = setSensorDisclosureOpen(collapsed, "camera", true);
    const next = revealSelectedSensor(withCamera, "imu", revealed.revealedSensorId);
    assert.deepEqual(next.openSensorIds, ["camera", "imu"]);
});
