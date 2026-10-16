from __future__ import annotations

from pathlib import Path

import numpy as np

from cev_sim.world import direction_from_yaw, grid_to_world, load_world, world_to_grid, yaw_from_direction

FIXTURE = Path(__file__).parent / "fixtures" / "planning-world-bundle.json"


def test_world_reads_route_vehicle_and_goal() -> None:
    world = load_world(FIXTURE)
    assert world.route_length_m == 10
    assert world.vehicle.wheelbase_m == 1.2
    assert world.vehicle.max_speed_mps == 10
    assert world.start.x == 1
    assert world.start.yaw == 0
    assert direction_from_yaw(0) == (1.0, -0.0) or np.allclose(direction_from_yaw(0), (1.0, 0.0))
    assert world.goal.x == 10
    assert len(world.obstacles) == 1


def test_yaw_matches_vehicle_forward() -> None:
    yaw = yaw_from_direction(0.0, -1.0)
    forward = direction_from_yaw(yaw)
    assert np.allclose(forward, (0.0, -1.0))


def test_occupancy_marks_obstacle_and_off_road() -> None:
    world = load_world(FIXTURE)
    grid = world.occupancy_grid(0.5, bounds=(0.0, -2.0, 12.0, 2.0))
    free_row, free_col = world_to_grid(grid, 1.25, 0.25)
    blocked_row, blocked_col = world_to_grid(grid, 4.25, 0.25)
    off_row, off_col = world_to_grid(grid, 1.25, 3.0)
    assert grid.cells[free_row, free_col] == 0
    assert grid.cells[blocked_row, blocked_col] == 1
    assert off_row < 0 or off_row >= grid.cells.shape[0] or off_col < 0 or off_col >= grid.cells.shape[1]
    x, z = grid_to_world(grid, free_row, free_col)
    assert np.allclose((x, z), (1.25, 0.25))


def test_inflation_blocks_cells_beside_an_obstacle() -> None:
    world = load_world(FIXTURE)
    tight = world.occupancy_grid(0.5, inflate_m=0.0, bounds=(0.0, -2.0, 12.0, 2.0))
    wide = world.occupancy_grid(0.5, inflate_m=1.0, bounds=(0.0, -2.0, 12.0, 2.0))
    row, col = world_to_grid(tight, 3.25, 0.25)
    assert tight.cells[row, col] == 0
    assert wide.cells[row, col] == 1
