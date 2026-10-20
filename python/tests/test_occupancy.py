from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
import pytest

from cev_sim import (
    PLANNING_OCCUPANCY_OBSERVATION_PROFILE,
    CevSimConfigurationError,
    CevSimEnv,
    EpisodeConfig,
)
from cev_sim.world import OccupancyGrid, inflate_occupancy

ROOT = Path(__file__).resolve().parents[2]


def test_inflation_blocks_a_disk_around_an_obstacle() -> None:
    cells = np.zeros((7, 7), dtype=np.uint8)
    cells[3, 3] = 1
    grid = OccupancyGrid(cells=cells, origin_x=0.0, origin_z=0.0, resolution_m=0.5)
    inflated = inflate_occupancy(grid, 0.5)
    assert inflated.cells[3, 3] == 1
    assert inflated.cells[3, 4] == 1
    assert inflated.cells[3, 6] == 0
    assert inflate_occupancy(grid, 0).cells is grid.cells


def _free_path(grid: OccupancyGrid, start: tuple[int, int], goal: tuple[int, int]) -> bool:
    rows, cols = grid.cells.shape
    pending = deque([start])
    seen = {start}
    while pending:
        row, col = pending.popleft()
        if (row, col) == goal:
            return True
        for next_row, next_col in ((row + 1, col), (row - 1, col), (row, col + 1), (row, col - 1)):
            if not (0 <= next_row < rows and 0 <= next_col < cols):
                continue
            if (next_row, next_col) in seen or grid.cells[next_row, next_col] != 0:
                continue
            seen.add((next_row, next_col))
            pending.append((next_row, next_col))
    return False


@pytest.mark.integration
def test_live_occupancy_grid_is_plannable_after_reset() -> None:
    bundle = ROOT / "python" / "examples" / "bundles" / "straight.json"
    env = CevSimEnv(
        str(bundle),
        episode=EpisodeConfig(observation_profile=PLANNING_OCCUPANCY_OBSERVATION_PROFILE),
    )
    try:
        env.reset(seed=1)
        grid = env.occupancy()
        pose = env.pose()
        start = grid.world_to_grid(float(pose[0]), float(pose[1]))
        assert grid.cells[start] == 0
        assert grid.resolution_m == pytest.approx(0.05)
        assert grid.cells.shape == (1000, 1000)
        forward_x = float(np.cos(pose[2]))
        forward_z = float(-np.sin(pose[2]))
        goal = grid.world_to_grid(float(pose[0]) + forward_x * 4.0, float(pose[1]) + forward_z * 4.0)
        assert _free_path(grid, start, goal)
        with pytest.raises(CevSimConfigurationError, match="oracle/sensor-occupancy"):
            env.sensor_occupancy()
    finally:
        env.close()
