from __future__ import annotations

import math

import pytest

from cev_sim.errors import CevSimConfigurationError
from cev_sim.overrides import episode_overrides_message, normalize_reset_options


def test_goal_yaw_zero_is_distinct_from_an_unset_heading() -> None:
    unset = episode_overrides_message({"goal": (1.0, 2.0)})
    assert unset is not None
    assert unset.goal.HasField("yaw") is False
    assert unset.goal.position_tolerance_m == pytest.approx(1.0)
    assert unset.goal.yaw_tolerance_rad == pytest.approx(math.pi)

    facing = episode_overrides_message({"goal": (1.0, 2.0, 0.0), "position_tolerance_m": 2.5})
    assert facing is not None
    assert facing.goal.HasField("yaw") is True
    assert facing.goal.yaw == 0.0
    assert facing.goal.position_tolerance_m == pytest.approx(2.5)


def test_start_pose_keeps_optional_speed() -> None:
    message = episode_overrides_message({"start_pose": (3.0, -1.0, 0.5, 2.0)})
    assert message is not None
    assert message.HasField("start_pose") is True
    assert message.HasField("goal") is False
    assert message.start_pose.speed_mps == pytest.approx(2.0)
    assert normalize_reset_options(None) is None
    assert normalize_reset_options({}) is None


def test_unknown_reset_options_are_rejected() -> None:
    with pytest.raises(CevSimConfigurationError, match="seed"):
        normalize_reset_options({"seed": 1})
