"""Protocol 1.5 start-pose and goal overrides."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

from .errors import CevSimConfigurationError
from .headless.v1 import headless_pb2 as pb

_OPTION_KEYS = {"start_pose", "goal", "position_tolerance_m", "yaw_tolerance_rad"}


def normalize_reset_options(options: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Validate Gymnasium reset options. ``None`` and ``{}`` mean no override."""
    if options is None:
        return None
    if not isinstance(options, Mapping):
        raise CevSimConfigurationError("reset options must be a mapping")
    unknown = set(options) - _OPTION_KEYS
    if unknown:
        names = ", ".join(sorted(unknown))
        raise CevSimConfigurationError(
            f"Reset options accept start_pose, goal, position_tolerance_m, and yaw_tolerance_rad; got {names}"
        )
    if not options:
        return None
    start = _numbers(options.get("start_pose"), "start_pose", (3, 4), "x, z, yaw, and an optional speed")
    goal = _numbers(options.get("goal"), "goal", (2, 3), "x, z, and an optional yaw")
    if start is None and goal is None:
        raise CevSimConfigurationError("reset options require start_pose or goal")
    normalized: dict[str, Any] = {}
    if start is not None:
        normalized["start_pose"] = start
    if goal is not None:
        normalized["goal"] = goal
        normalized["position_tolerance_m"] = _positive(
            options.get("position_tolerance_m", 1.0), "position_tolerance_m"
        )
        normalized["yaw_tolerance_rad"] = _positive(
            options.get("yaw_tolerance_rad", math.pi), "yaw_tolerance_rad"
        )
    return normalized


def episode_overrides_message(options: Mapping[str, Any] | None) -> pb.EpisodeOverrides | None:
    normalized = normalize_reset_options(options)
    if normalized is None:
        return None
    message = pb.EpisodeOverrides()
    start = normalized.get("start_pose")
    if start is not None:
        message.start_pose.x = start[0]
        message.start_pose.z = start[1]
        message.start_pose.yaw = start[2]
        if len(start) == 4:
            message.start_pose.speed_mps = start[3]
    goal = normalized.get("goal")
    if goal is not None:
        message.goal.x = goal[0]
        message.goal.z = goal[1]
        if len(goal) == 3:
            message.goal.yaw = goal[2]
        message.goal.position_tolerance_m = normalized["position_tolerance_m"]
        message.goal.yaw_tolerance_rad = normalized["yaw_tolerance_rad"]
    return message


def _numbers(value: Any, label: str, lengths: tuple[int, ...], description: str) -> tuple[float, ...] | None:
    if value is None:
        return None
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise CevSimConfigurationError(f"{label} must be a sequence of {description}")
    if len(value) not in lengths:
        raise CevSimConfigurationError(f"{label} must contain {description}")
    numbers = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            raise CevSimConfigurationError(f"{label} values must be finite numbers")
        numbers.append(float(item))
    return tuple(numbers)


def _positive(value: Any, label: str) -> float:
    number = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    if number is None or not math.isfinite(number) or number <= 0:
        raise CevSimConfigurationError(f"{label} must be a positive finite number")
    return number
