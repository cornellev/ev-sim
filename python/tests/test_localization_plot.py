from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from cev_sim.env import LocalizationView
from cev_sim.errors import CevSimConfigurationError

STRAIGHT = Path(__file__).resolve().parents[2] / "python" / "examples" / "bundles" / "straight.json"


class _HumanEnv:
    render_mode = "human"
    _viewer = object()
    _last_observation = {"oracle/ego/pose": np.zeros(3)}

    def __init__(self) -> None:
        self.drawn: list[list[float] | None] = []
        self.localization = LocalizationView(self)

    def render(self) -> None:
        pose = self.localization.pose if self.localization.clone.enabled else None
        self.drawn.append(None if pose is None else pose.tolist())


def test_update_stores_a_pose_and_the_clone_switch_hides_it() -> None:
    env = _HumanEnv()
    env.localization.update((4.0, -1.0, 0.5))
    assert env.drawn == [[4.0, -1.0, 0.5]]

    env.localization.clone.enabled = False
    assert env.drawn[-1] is None
    env.localization.clear()
    assert env.localization.pose is None
    assert env.localization.clone.enabled is False

    env.localization.clone.enabled = True
    assert env.drawn[-1] is None
    with pytest.raises(CevSimConfigurationError):
        env.localization.update((1.0, 2.0))
    with pytest.raises(CevSimConfigurationError):
        env.localization.update((1.0, 2.0, float("nan")))
    with pytest.raises(CevSimConfigurationError):
        env.localization.clone.enabled = 1


def test_estimate_footprint_changes_the_planner_image() -> None:
    pytest.importorskip("matplotlib")
    from cev_sim.render import PlanningRenderer

    observation = {"oracle/ego/pose": np.array([0.0, 0.0, 0.0])}
    renderer = PlanningRenderer(STRAIGHT, mode="rgb_array")
    plain = renderer.draw(observation)
    shifted = renderer.draw(observation, estimate=np.array([8.0, 3.0, 0.4]))
    assert plain is not None and shifted is not None
    assert plain.shape == shifted.shape
    assert not np.array_equal(plain, shifted)
    assert np.array_equal(renderer.draw(observation), plain)
