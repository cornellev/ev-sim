import assert from "node:assert/strict";
import test from "node:test";

import { createReplayVehicleGeometry, REPLAY_VEHICLE_SIZE } from "../app/replay/ReplayVehicleGeometry.js";

test("replay vehicle geometry uses simulation +X as its longitudinal axis", () => {
    const geometry = createReplayVehicleGeometry();

    assert.equal(geometry.parameters.width, REPLAY_VEHICLE_SIZE.length);
    assert.equal(geometry.parameters.height, REPLAY_VEHICLE_SIZE.height);
    assert.equal(geometry.parameters.depth, REPLAY_VEHICLE_SIZE.width);
    assert.ok(geometry.parameters.width > geometry.parameters.depth);

    geometry.dispose();
});
