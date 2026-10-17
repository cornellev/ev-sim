from __future__ import annotations

from pathlib import Path

import numpy as np

from cev_sim.bundles import create_bundle
from cev_sim.world import load_world, world_to_grid

CORRIDOR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "planning-corridor"


def test_configure_path_loads_a_saved_corridor(tmp_path: Path) -> None:
    output = tmp_path / "corridor.json"
    create_bundle(
        output,
        environment="corridor",
        vehicle="corridor-car",
        data_dir=CORRIDOR,
        finish="none",
    )
    world = load_world(output)
    cone = next(obstacle for obstacle in world.obstacles if obstacle.id.startswith("cone/"))
    box = next(obstacle for obstacle in world.obstacles if obstacle.id == "primitive:crate")
    assert world.start.x > float(np.max(cone.footprint[:, 0]))
    grid = world.occupancy_grid(0.1, bounds=(-1.0, -5.0, 32.0, 5.0))
    cone_x, cone_z = cone.footprint.mean(axis=0)
    box_x, box_z = box.footprint.mean(axis=0)
    cone_row, cone_col = world_to_grid(grid, float(cone_x), float(cone_z))
    box_row, box_col = world_to_grid(grid, float(box_x), float(box_z))
    free_row, free_col = world_to_grid(grid, 24.25, 0.25)
    start_row, start_col = world_to_grid(grid, world.start.x, world.start.z)
    assert grid.cells[cone_row, cone_col] == 1
    assert grid.cells[box_row, box_col] == 1
    assert grid.cells[free_row, free_col] == 0
    assert grid.cells[start_row, start_col] == 0
