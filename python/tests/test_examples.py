from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from cev_sim import PLANNING_ORACLE_OBSERVATION_PROFILE, CevSimEnv, EpisodeConfig, load_world
from cev_sim.errors import CevSimEnvironmentError

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = (
    "01_pure_pursuit.py",
    "02_astar_track.py",
    "03_rrt_star.py",
    "04_mpc_kinematic.py",
)


@pytest.mark.integration
@pytest.mark.parametrize("script", EXAMPLES)
def test_planner_example_runs_fifty_steps(script: str) -> None:
    env = os.environ.copy()
    source = str(ROOT / "python" / "src")
    env["PYTHONPATH"] = source + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(
        [sys.executable, str(ROOT / "python" / "examples" / script), "--steps", "50", "--seed", "1"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout


@pytest.mark.integration
def test_reset_options_round_trip_through_the_supervisor() -> None:
    bundle = ROOT / "python" / "examples" / "bundles" / "straight.json"
    world = load_world(bundle)
    env = CevSimEnv(
        str(bundle),
        episode=EpisodeConfig(observation_profile=PLANNING_ORACLE_OBSERVATION_PROFILE),
    )
    try:
        _baseline, baseline_info = env.reset(seed=7)
        point = world.route_polyline[min(8, len(world.route_polyline) - 1)]
        moved, moved_info = env.reset(
            seed=7,
            options={"start_pose": (float(point[0]), float(point[1]), float(world.start.yaw))},
        )
        assert moved_info["episode_hash"] != baseline_info["episode_hash"]
        pose = moved["oracle/ego/pose"]
        assert abs(float(pose[0]) - float(point[0])) < 0.5
        assert abs(float(pose[1]) - float(point[1])) < 0.5
        _goal_observation, goal_info = env.reset(
            seed=7,
            options={
                "goal": (float(world.start.x), float(world.start.z)),
                "position_tolerance_m": 4.0,
            },
        )
        assert goal_info["episode_hash"] != baseline_info["episode_hash"]
        _observation, _reward, terminated, truncated, info = env.step(np.zeros(2, dtype=np.float32))
        assert terminated and not truncated
        assert info["termination_reason"] == "success"
        with pytest.raises(CevSimEnvironmentError):
            env.reset(seed=7, options={"start_pose": (1.0e6, 1.0e6, 0.0)})
    finally:
        env.close()
