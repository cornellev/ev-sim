import assert from "node:assert/strict";
import test from "node:test";

import { PlanOccupancySampler } from "../app/spatial/planview/occupancy/oracleSample.js";

const RESOLUTION = 0.05;
const CELLS = 40;

function corridorWorld() {
    return {
        bounds: { min: { x: -1, y: 0, z: -2 }, max: { x: 6, y: 1, z: 2 } },
        drivableSurfaces: [{
            id: "road",
            footprint: [
                { x: 0, z: -1 },
                { x: 4, z: -1 },
                { x: 4, z: 1 },
                { x: 0, z: 1 },
            ],
        }],
        obstacles: [{
            id: "box",
            footprint: [
                { x: 1.8, z: -0.2 },
                { x: 2.2, z: -0.2 },
                { x: 2.2, z: 0.2 },
                { x: 1.8, z: 0.2 },
            ],
        }],
    };
}

function cellAt(sample, x, z) {
    const col = Math.floor((x - sample.originX) / sample.resolutionM);
    const row = Math.floor((z - sample.originZ) / sample.resolutionM);
    return sample.cells[row * sample.width + col];
}

function run(vehicles, obstacles = []) {
    return {
        description: corridorWorld(),
        ego: { x: 2, z: 0 },
        vehicles,
        resolvedRun: {
            manifest: { controls: { targetVehicleId: "ego" } },
            vehicles: [
                { actorId: "ego", manifest: { boundingBox: { size: { x: 1.2, y: 1, z: 1.2 }, center: { x: 0, y: 0, z: 0 } } } },
                { actorId: "npc", manifest: { boundingBox: { size: { x: 0.4, y: 1, z: 0.4 }, center: { x: 0, y: 0, z: 0 } } } },
            ],
        },
        obstacles,
    };
}

test("the oracle window leaves the road and the ego clear, then stamps another actor", () => {
    const sampler = new PlanOccupancySampler({ resolutionM: RESOLUTION, cells: CELLS });
    const description = corridorWorld();
    const ego = { telemetryId: "ego", position: { x: 2, z: 0 }, rotation: { y: 0 } };
    const open = sampler.sample({ ...run([ego]), description });
    assert.equal(open.changed, true);
    assert.equal(open.palette, "cost");
    assert.equal(cellAt(open, 1.2, 0), 0);
    assert.equal(cellAt(open, 2, 0), 1);
    const again = sampler.sample({ ...run([ego]), description });
    assert.equal(again.changed, false);
    const blocked = sampler.sample({
        ...run([
            ego,
            { telemetryId: "npc", position: { x: 1.2, z: 0 }, rotation: { y: 0 } },
        ]),
        description,
    });
    assert.equal(blocked.changed, true);
    assert.equal(cellAt(blocked, 1.2, 0), 1);
});
