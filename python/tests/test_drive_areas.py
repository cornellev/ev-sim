"""Area-only planning worlds keep an empty route and no goal."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

from cev_sim.env import CevSimEnv
from cev_sim.errors import CevSimConfigurationError
from cev_sim.quickstart import _reset_options
from cev_sim.render import _paint
from cev_sim.world import load_world

FIXTURE = Path(__file__).parent / "fixtures" / "planning-world-bundle.json"


def _area_bundle() -> dict:
    document = json.loads(FIXTURE.read_text())
    document["resolved"]["scenario"]["scenario"]["freeDrive"] = True
    document["resolved"]["scenario"]["scenario"]["routes"] = []
    for manifest in (document["manifest"], document["resolved"]["manifest"]):
        pose = manifest["initialState"]["vehicles"][0]["pose"]
        pose["position"] = {"x": 12.0, "y": 1.0, "z": 3.0}
        pose["rotation"]["y"] = 0.25
    surface = {
        "id": "drive-area:lot",
        "kind": "area-polygon",
        "footprint": [
            {"x": 0.0, "z": -8.0},
            {"x": 30.0, "z": -8.0},
            {"x": 30.0, "z": 8.0},
            {"x": 0.0, "z": 8.0},
        ],
        "triangles": [[0, 1, 2], [0, 2, 3]],
        "minY": 1.0,
        "maxY": 1.0,
    }
    description = document["resolved"]["world"]["description"]
    description["roads"] = {"nodes": [], "edges": []}
    description["drivableSurfaces"] = [surface]
    description["obstacles"] = []
    return document


def test_area_only_world_has_no_route_or_goal() -> None:
    world = load_world(_area_bundle())
    assert world.route_length_m == 0
    assert len(world.route_polyline) == 0
    assert world.goal is None
    assert world.start.x == 12
    assert world.start.z == 3
    assert world.start.yaw == pytest.approx(0.25)
    grid = world.occupancy_grid(1.0)
    assert int(grid.cells.min()) == 0
    options = _reset_options(world, (4.0, 1.0), None, 1.0)
    assert options["start_pose"] == (4.0, 1.0, world.start.yaw)
    axes = MagicMock()
    _paint(
        axes,
        world,
        np.array([12.0, 3.0, 0.25]),
        {"oracle/goal": np.array([0.0, 0.0, 0.0]), "oracle/goal/validity": np.array([0])},
        None,
    )
    axes.scatter.assert_not_called()


def test_routed_bundle_still_rejects_a_broken_route() -> None:
    document = json.loads(FIXTURE.read_text())
    document["resolved"]["scenario"]["scenario"]["freeDrive"] = True
    document["resolved"]["scenario"]["scenario"]["routes"][0]["verification"]["polyline"] = [{"x": 0.0, "z": 0.0}]
    with pytest.raises(CevSimConfigurationError, match="verified polyline"):
        load_world(document)
    routed = load_world(json.loads(FIXTURE.read_text()))
    assert routed.goal is not None
    assert routed.route_length_m == 10


def test_env_goal_is_none_when_the_oracle_goal_is_invalid() -> None:
    env = CevSimEnv.__new__(CevSimEnv)
    env._closed = False
    env._batch = object()
    env._last_observation = {
        "oracle/goal": np.array([1.0, 2.0, 0.0]),
        "oracle/goal/validity": np.array([0]),
    }
    assert env.goal() is None
    env._last_observation["oracle/goal/validity"] = np.array([1])
    assert np.allclose(env.goal(), [1.0, 2.0, 0.0])


def test_copy_does_not_change_the_fixture() -> None:
    original = json.loads(FIXTURE.read_text())
    _area_bundle()
    assert json.loads(FIXTURE.read_text()) == original
    assert copy.deepcopy(original)["resolved"]["scenario"]["scenario"]["routes"]
