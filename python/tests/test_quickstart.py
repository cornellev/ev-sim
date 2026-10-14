from __future__ import annotations

import math
import shutil
from pathlib import Path

import numpy as np
import pytest

from cev_sim import configure, environments, launch, vehicles
from cev_sim.env import merge_reset_options
from cev_sim.errors import CevSimConfigurationError
from cev_sim.quickstart import yaw_along_route
from cev_sim.world import load_world, yaw_from_direction

ROOT = Path(__file__).resolve().parents[2]
STRAIGHT = ROOT / "python" / "examples" / "bundles" / "straight.json"


def _install_bundle(monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, object]]) -> None:
    def fake(output: Path, **kwargs: object) -> dict[str, str]:
        captured.append(kwargs)
        shutil.copyfile(STRAIGHT, output)
        return {"kind": "cev-sim.headless.planning-bundle"}

    monkeypatch.setattr("cev_sim.quickstart.create_bundle", fake)


def test_configure_rejects_bad_arguments(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("create_bundle should not run")

    monkeypatch.setattr("cev_sim.quickstart.create_bundle", fail)
    with pytest.raises(CevSimConfigurationError):
        configure(environment="")
    with pytest.raises(CevSimConfigurationError):
        configure(environment="igvc", view="camera")
    with pytest.raises(CevSimConfigurationError):
        configure(environment="igvc", logging=True)
    with pytest.raises(CevSimConfigurationError):
        configure(environment="igvc", start=(1.0,))
    with pytest.raises(CevSimConfigurationError):
        configure(environment="igvc", goal=(1.0, 2.0, 3.0, 4.0))
    with pytest.raises(CevSimConfigurationError):
        configure(environment="igvc", max_steps=-1)
    with pytest.raises(CevSimConfigurationError):
        configure(environment="igvc", goal=(1.0, 2.0), goal_tolerance_m=0)


def test_yaw_follows_the_nearest_route_segment() -> None:
    world = load_world(STRAIGHT)
    start = world.route_polyline[0]
    finish = world.route_polyline[1]
    yaw = yaw_along_route(world, float(start[0] + finish[0]) / 2, float(start[1] + finish[1]) / 2)
    assert yaw == pytest.approx(yaw_from_direction(float(finish[0] - start[0]), float(finish[1] - start[1])))


def test_reset_options_let_a_call_override_one_field() -> None:
    merged = merge_reset_options(
        {"start_pose": (0.0, 1.0, 0.2), "goal": (4.0, 5.0), "position_tolerance_m": 1.0},
        {"start_pose": (2.0, 3.0, 0.4)},
    )
    assert merged == {
        "start_pose": (2.0, 3.0, 0.4),
        "goal": (4.0, 5.0),
        "position_tolerance_m": 1.0,
    }
    assert merge_reset_options(None, None) is None


def test_configure_builds_a_free_drive_bundle_and_logging_policy(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: list[dict[str, object]] = []
    _install_bundle(monkeypatch, captured)
    quiet = configure(environment="igvc", vehicle="big-car", data_dir=tmp_path, logging=False)
    try:
        assert quiet.artifact_policy.profile == "disabled"
        assert quiet.output_dir is None
        assert quiet.reset_options is None
        assert quiet.episode.observation_profile.id == "planning-oracle"
        assert captured[0]["finish"] == "none"
        assert captured[0]["environment"] == "igvc"
        assert captured[0]["vehicle"] == "big-car"
    finally:
        quiet.close()

    captured.clear()
    log_dir = tmp_path / "runs" / "first"
    pointed = configure(
        environment="igvc",
        data_dir=tmp_path,
        logging=log_dir,
        start=(float(quiet.world.start.x), float(quiet.world.start.z)),
        goal=(float(quiet.world.goal.x), float(quiet.world.goal.z)),
        goal_tolerance_m=2.5,
        view="measured",
        max_steps=40,
    )
    try:
        assert pointed.artifact_policy.profile == "evaluation"
        assert pointed.output_dir == str(log_dir)
        assert pointed.episode.observation_profile.id == "measured-state"
        assert pointed.episode.max_episode_steps == 40
        start = pointed.reset_options["start_pose"]
        assert start[0] == pytest.approx(quiet.world.start.x)
        assert start[1] == pytest.approx(quiet.world.start.z)
        assert len(start) == 3
        assert math.isfinite(start[2])
        assert pointed.reset_options["goal"][0] == pytest.approx(quiet.world.goal.x)
        assert pointed.reset_options["goal"][1] == pytest.approx(quiet.world.goal.z)
        assert pointed.reset_options["position_tolerance_m"] == 2.5
    finally:
        pointed.close()


def test_catalog_entries_keep_id_name_and_built_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "cev_sim.quickstart._read_catalog",
        lambda _data_dir: {
            "kind": "cev-sim.headless.catalog",
            "environments": [{"id": "igvc", "name": "IGVC", "builtIn": True}],
            "vehicles": [{"id": "merceves", "name": "MerCEVes", "builtIn": False}],
        },
    )
    assert environments.list()[0].id == "igvc"
    assert environments.list()[0].built_in is True
    assert vehicles.list()[0].name == "MerCEVes"
    assert vehicles.list()[0].built_in is False


@pytest.mark.integration
def test_free_drive_can_pass_the_route_end_without_success(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    config = configure(environment="igvc", vehicle="big-car", goal=None, data_dir=data_dir)
    try:
        world = config.world
        start = np.array([world.start.x, world.start.z])
        goal = np.array([world.goal.x, world.goal.z])
        direction = goal - start
        direction /= np.linalg.norm(direction)
        # Six meters before the route end is outside the old 8 m finish zone
        # and still on the verified edge, so crossing inward would have been SUCCESS.
        approach = goal - direction * 6.0
        with launch(config) as env:
            observation, _info = env.reset(seed=1, options={
                "start_pose": (float(approach[0]), float(approach[1]), float(world.goal.yaw)),
            })
            arrived = False
            distance = float("inf")
            reason = ""
            for _step in range(120):
                observation, _reward, terminated, truncated, info = env.step(np.array([0.4, 0.0], dtype=np.float32))
                pose = observation["oracle/ego/pose"]
                distance = float(np.hypot(pose[0] - world.goal.x, pose[1] - world.goal.z))
                reason = f"{info['termination_reason']} {info['truncation_reason']} at {distance:.2f} m"
                if terminated or truncated:
                    raise AssertionError(f"free drive stopped early: {reason}")
                if distance < 4.0:
                    arrived = True
                    break
            assert arrived, f"did not reach the route end: {reason}"
            assert info["termination_reason"] == "none"
    finally:
        config.close()


@pytest.mark.integration
def test_configured_goal_ends_the_episode(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    preview = configure(environment="igvc", vehicle="big-car", data_dir=data_dir)
    try:
        goal = (float(preview.world.start.x), float(preview.world.start.z))
    finally:
        preview.close()
    config = configure(
        environment="igvc",
        vehicle="big-car",
        data_dir=data_dir,
        goal=goal,
        goal_tolerance_m=4.0,
    )
    try:
        with launch(config) as env:
            env.reset(seed=1)
            _observation, _reward, terminated, truncated, info = env.step(np.zeros(2, dtype=np.float32))
            assert terminated and not truncated
            assert info["termination_reason"] == "success"
    finally:
        config.close()
