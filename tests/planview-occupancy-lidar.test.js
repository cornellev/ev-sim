import assert from "node:assert/strict";
import test from "node:test";

import { SENSOR_OCCUPANCY_OCCUPIED } from "../app/simulation/occupancy/constants.js";
import { PlanLidarSampler } from "../app/spatial/planview/occupancy/lidarSample.js";

const RESOLUTION = 0.05;
const CELLS = 200;

function ray(buffer, index, range, semanticId) {
    buffer[index * 4] = range;
    buffer[index * 4 + 2] = semanticId;
}

test("a lidar return lands on the matching window cell", () => {
    const calibration = {
        azimuth: { startDeg: -90, endDeg: 180, stepDeg: 90 },
        elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
    };
    const buffer = new Float32Array(3 * 4);
    ray(buffer, 1, 2, 5);
    const vehicle = {
        telemetryId: "ego",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        devices: [{
            buff: buffer,
            config: {
                calibration,
                pose: {
                    position: { x: 0, y: 0, z: 0.5 },
                    rotation: { x: 0, y: 0, z: 0 },
                },
            },
        }],
    };
    const sampler = new PlanLidarSampler({ resolutionM: RESOLUTION, cells: CELLS });
    const sample = sampler.sample({ vehicles: [vehicle], ego: { x: 0, z: 0 } });
    const col = Math.floor((2 - sample.originX) / RESOLUTION);
    const row = Math.floor((0 - sample.originZ) / RESOLUTION);
    assert.equal(sample.palette, "ternary");
    assert.equal(sample.cells[row * CELLS + col], SENSOR_OCCUPANCY_OCCUPIED);
    const again = sampler.sample({ vehicles: [vehicle], ego: { x: 0, z: 0 } });
    assert.equal(again.changed, false);
    assert.equal(sampler.sample({ vehicles: [], ego: { x: 0, z: 0 } }), null);
});
