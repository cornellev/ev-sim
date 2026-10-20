import assert from "node:assert/strict";
import test from "node:test";
import { Quaternion, Vector3 } from "three";

import {
    SENSOR_OCCUPANCY_FREE,
    SENSOR_OCCUPANCY_OCCUPIED,
} from "../app/simulation/occupancy/constants.js";
import { reduceRangeImage } from "../app/simulation/occupancy/SensorOccupancyGrid.js";

const RESOLUTION = 0.05;
const ROAD = 4;
const BARREL = 5;
const SIGN = 2;

function valueAt(cells, x, z) {
    const col = Math.floor(x / RESOLUTION);
    const row = Math.floor(z / RESOLUTION);
    return cells.find((cell) => cell.col === col && cell.row === row)?.value ?? 0;
}

function ray(buffer, index, range, semanticId) {
    buffer[index * 4] = range;
    buffer[index * 4 + 2] = semanticId;
}

test("road is free, a barrel is occupied, and a high hit is ignored", () => {
    const calibration = {
        azimuth: { startDeg: -90, endDeg: 180, stepDeg: 90 },
        elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
    };
    const buffer = new Float32Array(3 * 4);
    ray(buffer, 1, 2, BARREL);
    ray(buffer, 2, 3, ROAD);
    const cells = reduceRangeImage({
        buffer,
        calibration,
        origin: { x: 0, y: 0.5, z: 0 },
        groundY: 0,
        minHeightM: 0.05,
        maxHeightM: 1.5,
        roadSemanticId: ROAD,
        resolutionM: RESOLUTION,
    });
    assert.equal(valueAt(cells, 2, 0), SENSOR_OCCUPANCY_OCCUPIED);
    assert.equal(valueAt(cells, 1, 0), SENSOR_OCCUPANCY_FREE);
    assert.equal(valueAt(cells, 2.5, 0), 0, "cells beyond the barrel stay unknown");
    assert.equal(valueAt(cells, 0, 2), SENSOR_OCCUPANCY_FREE);
    assert.equal(valueAt(cells, 0, 3.2), 0, "past the farthest road hit stays unknown");
    assert.equal(valueAt(cells, 0, -1), 0, "a miss stays unknown");

    const high = new Float32Array(3 * 4);
    ray(high, 1, 2, SIGN);
    const ignored = reduceRangeImage({
        buffer: high,
        calibration: {
            azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            elevation: { startDeg: 60, endDeg: 61, stepDeg: 1 },
        },
        origin: { x: 0, y: 0.5, z: 0 },
        groundY: 0,
        minHeightM: 0.05,
        maxHeightM: 1.5,
        roadSemanticId: ROAD,
        resolutionM: RESOLUTION,
    });
    assert.equal(ignored.length, 0);
});

test("a scanLayout azimuth offset occupies the world direction, not the buffer column", () => {
    const calibration = {
        scanLayout: {
            azimuthsDeg: [0],
            channels: [
                { elevationDeg: 0, azimuthOffsetDeg: 0 },
                { elevationDeg: 0, azimuthOffsetDeg: 90 },
            ],
            minRangeM: 0.1,
            maxRangeM: 20,
        },
    };
    const buffer = new Float32Array(2 * 4);
    ray(buffer, 0, 2, BARREL);
    ray(buffer, 1, 2, BARREL);
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const cells = reduceRangeImage({
        buffer,
        calibration,
        origin: { x: 0, y: 0.5, z: 0 },
        quaternion: { x: yaw.x, y: yaw.y, z: yaw.z, w: yaw.w },
        groundY: 0,
        minHeightM: 0.05,
        maxHeightM: 1.5,
        roadSemanticId: ROAD,
        resolutionM: RESOLUTION,
    });
    assert.equal(valueAt(cells, 0, -2), SENSOR_OCCUPANCY_OCCUPIED, "unoffset +X becomes world -Z after a +90 yaw");
    assert.equal(valueAt(cells, 2, 0), SENSOR_OCCUPANCY_OCCUPIED, "the +90 channel becomes world +X");
    assert.notEqual(valueAt(cells, 0, 2), SENSOR_OCCUPANCY_OCCUPIED);
});
