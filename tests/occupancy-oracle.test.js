import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { OracleOccupancyGrid, snapWindowOrigin } from "../app/simulation/occupancy/OracleOccupancyGrid.js";

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
    assert.ok(col >= 0 && row >= 0 && col < CELLS && row < CELLS, `cell ${x},${z} is inside the window`);
    return sample.cells[row * CELLS + col];
}

test("a snapped window matches the Python cell rule and leaves the ego unstamped", () => {
    const description = corridorWorld();
    const grid = new OracleOccupancyGrid(description, { resolutionM: RESOLUTION, cells: CELLS });
    const sample = grid.sample({ x: 2, z: 0, actors: [] });
    const snapped = snapWindowOrigin(2, 0, RESOLUTION, CELLS);
    assert.equal(sample.originX, snapped.originX);
    assert.equal(sample.originZ, snapped.originZ);
    const python = spawnSync("python3", ["-c", `
import json, sys
import numpy as np
from cev_sim.world import DrivableSurface, Obstacle, OccupancyGrid, PlanningWorld, Pose2D, VehicleModel
payload = json.load(sys.stdin)
points = lambda rows: np.asarray(rows, dtype=np.float64)
world = PlanningWorld(
    route_polyline=np.zeros((2, 2)),
    route_distances=np.zeros(2),
    route_length_m=0,
    obstacles=(Obstacle("box", points(payload["obstacle"])),),
    drivable_surfaces=(DrivableSurface("road", points(payload["footprint"]), np.asarray([[0, 1, 2], [0, 2, 3]])),),
    vehicle=VehicleModel("ego", "car", 1, 1, 1, 1, 1),
    start=Pose2D(0, 0, 0),
    goal=Pose2D(0, 0, 0),
)
grid = world.occupancy_grid(${RESOLUTION}, inflate_m=0, bounds=(payload["bounds"]))
sys.stdout.write(grid.cells.tobytes().hex())
`], {
        input: JSON.stringify({
            footprint: description.drivableSurfaces[0].footprint.map((point) => [point.x, point.z]),
            obstacle: description.obstacles[0].footprint.map((point) => [point.x, point.z]),
            bounds: [sample.originX, sample.originZ, sample.originX + CELLS * RESOLUTION, sample.originZ + CELLS * RESOLUTION],
        }),
        encoding: "utf8",
        env: { ...process.env, PYTHONPATH: "python/src" },
    });
    assert.equal(python.status, 0, python.stderr || python.stdout);
    const expected = Buffer.from(python.stdout.trim(), "hex");
    assert.equal(expected.length, CELLS * CELLS);
    assert.deepEqual(Buffer.from(sample.cells), expected);
    assert.equal(cellAt(sample, 2, 0), 1, "the static box blocks its own cells");
    assert.equal(cellAt(sample, 1.2, 0), 0, "open pavement stays clear");
});

test("an actor center offset blocks the shifted box and the ego is not an obstacle", () => {
    const grid = new OracleOccupancyGrid(corridorWorld(), { resolutionM: RESOLUTION, cells: CELLS });
    const sample = grid.sample({
        x: 1.5,
        z: 0,
        actors: [{
            id: "other",
            x: 0.5,
            z: 0,
            yaw: 0,
            length: 0.4,
            width: 0.4,
            centerX: 1,
            centerZ: 0,
        }],
    });
    assert.equal(cellAt(sample, 1.5, 0), 1, "the rotated center, not the actor origin, is blocked");
    assert.equal(cellAt(sample, 0.5, 0), 0, "the unshifted origin stays clear");
    const egoOnly = grid.sample({ x: 2, z: 0, actors: [] });
    assert.equal(cellAt(egoOnly, 2.6, 0), 0);
});

test("reset overlay obstacles are blocked and cells past the map stay blocked", () => {
    const description = corridorWorld();
    const grid = new OracleOccupancyGrid(description, { resolutionM: RESOLUTION, cells: CELLS });
    const open = grid.sample({ x: 3.2, z: 0 });
    assert.equal(cellAt(open, 3.2, 0), 0);
    grid.setOverlay([{
        id: "episode:barrel",
        footprint: [
            { x: 3.05, z: -0.15 },
            { x: 3.35, z: -0.15 },
            { x: 3.35, z: 0.15 },
            { x: 3.05, z: 0.15 },
        ],
    }]);
    const blocked = grid.sample({ x: 3.2, z: 0 });
    assert.equal(cellAt(blocked, 3.2, 0), 1);
    const outside = grid.sample({ x: 20, z: 20 });
    assert.equal(outside.cells[Math.floor(outside.cells.length / 2)], 1);
    assert.ok(outside.cells.every((value) => value === 1));
});
