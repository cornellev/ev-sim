"""Start a simulator session from a saved environment and vehicle.

``configure`` builds a temporary run bundle. ``launch`` starts one worker.
A session with ``goal=None`` is a free drive: the simulator still has a
verified route, because headless episodes require one, but that route does
not end the episode.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
import weakref
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .bundles import create_bundle
from .config import (
    DEFAULT_OBSERVATION_PROFILE,
    PLANNING_ORACLE_OBSERVATION_PROFILE,
    ArtifactPolicy,
    EpisodeConfig,
)
from .errors import CevSimConfigurationError, CevSimLaunchError
from .process import _checkout_root, resolve_supervisor_command
from .world import PlanningWorld, load_world, yaw_from_direction

_VIEWS = {
    "planning": PLANNING_ORACLE_OBSERVATION_PROFILE,
    "measured": DEFAULT_OBSERVATION_PROFILE,
}


@dataclass(frozen=True)
class CatalogEntry:
    """One saved or built-in environment or vehicle."""

    id: str
    name: str
    built_in: bool


class _Catalog:
    def __init__(self, key: str) -> None:
        self._key = key

    def list(self, data_dir: str | Path | None = None) -> tuple[CatalogEntry, ...]:
        """Return environments or vehicles visible to ``configure``."""
        payload = _read_catalog(resolve_data_dir(data_dir))
        entries = payload.get(self._key)
        if not isinstance(entries, list):
            raise CevSimLaunchError(f"cev-sim catalog did not return {self._key}")
        return tuple(_catalog_entry(item) for item in entries)


environments = _Catalog("environments")
vehicles = _Catalog("vehicles")


@dataclass(frozen=True)
class RunConfig:
    """A prepared session. Keep it alive while the launched environment is open."""

    environment: str
    vehicle: str | None
    bundle_path: Path
    world: PlanningWorld
    episode: EpisodeConfig
    reset_options: dict[str, Any] | None
    artifact_policy: ArtifactPolicy
    output_dir: str | None
    workspace: Path

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "_finalizer",
            weakref.finalize(self, shutil.rmtree, str(self.workspace), True),
        )

    def save(self, path: str | Path) -> Path:
        """Copy the generated run bundle to ``path``."""
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.bundle_path, destination)
        return destination

    def close(self) -> None:
        """Delete the temporary bundle directory."""
        finalizer = getattr(self, "_finalizer", None)
        if finalizer is not None and finalizer.alive:
            finalizer()


def configure(
    environment: str,
    vehicle: str | None = None,
    start: tuple[float, ...] | list[float] | None = None,
    goal: tuple[float, ...] | list[float] | None = None,
    goal_tolerance_m: float = 1.0,
    max_steps: int = 0,
    view: str = "planning",
    logging: str | Path | bool = False,
    data_dir: str | Path | None = None,
) -> RunConfig:
    """Build a free-drive bundle for ``environment`` and an optional ``vehicle``.

    ``goal=None`` does not add a finish line. Pass ``goal=(x, z)`` to stop
    when the car gets that close. ``start=(x, z)`` faces the car along the
    nearest route segment. ``logging=False`` discards artifacts.
    ``logging="runs/name"`` keeps an evaluation log there.
    """
    environment_id = _identifier(environment, "environment")
    vehicle_id = None if vehicle is None else _identifier(vehicle, "vehicle")
    if view not in _VIEWS:
        raise CevSimConfigurationError('view must be "planning" or "measured"')
    if type(max_steps) is not int or max_steps < 0:
        raise CevSimConfigurationError("max_steps must be a non-negative integer")
    if isinstance(goal_tolerance_m, bool) or not isinstance(goal_tolerance_m, (int, float)):
        raise CevSimConfigurationError("goal_tolerance_m must be a positive finite number")
    if not math.isfinite(float(goal_tolerance_m)) or float(goal_tolerance_m) <= 0:
        raise CevSimConfigurationError("goal_tolerance_m must be a positive finite number")
    parsed_start = _numbers(start, "start", (2, 3, 4), "x, z, an optional yaw, and an optional speed")
    parsed_goal = _numbers(goal, "goal", (2, 3), "x, z, and an optional yaw")
    output_dir, artifact_policy = _logging(logging)
    resolved_data = resolve_data_dir(data_dir)
    workspace = Path(tempfile.mkdtemp(prefix="cev-sim-session-"))
    bundle_path = workspace / "session.json"
    try:
        create_bundle(
            bundle_path,
            environment=environment_id,
            vehicle=vehicle_id,
            data_dir=resolved_data,
            finish="none",
        )
        world = load_world(bundle_path)
    except Exception:
        shutil.rmtree(workspace, ignore_errors=True)
        raise
    reset_options = _reset_options(world, parsed_start, parsed_goal, float(goal_tolerance_m))
    return RunConfig(
        environment=environment_id,
        vehicle=vehicle_id,
        bundle_path=bundle_path,
        world=world,
        episode=EpisodeConfig(max_episode_steps=max_steps, observation_profile=_VIEWS[view]),
        reset_options=reset_options,
        artifact_policy=artifact_policy,
        output_dir=output_dir,
        workspace=workspace,
    )


def launch(config: RunConfig, **env_kwargs: Any) -> Any:
    """Start one worker for a configured session."""
    if not isinstance(config, RunConfig):
        raise CevSimConfigurationError("launch requires a RunConfig from configure()")
    from .env import CevSimEnv

    options: dict[str, Any] = {
        "output_dir": config.output_dir,
        "episode": config.episode,
        "artifact_policy": config.artifact_policy,
        "default_reset_options": config.reset_options,
    }
    options.update(env_kwargs)
    session = CevSimEnv(str(config.bundle_path), **options)
    session.run_config = config
    return session


def resolve_data_dir(data_dir: str | Path | None = None) -> Path | None:
    """Choose the saved-data directory, or ``None`` when only built-ins exist."""
    if data_dir is not None:
        return Path(data_dir)
    from_env = os.environ.get("CEV_SIM_DATA_DIR")
    if from_env:
        return Path(from_env)
    checkout = _checkout_root()
    if checkout is not None:
        bundled = checkout / "server" / "data"
        if bundled.is_dir():
            return bundled
    return None


def yaw_along_route(world: PlanningWorld, x: float, z: float) -> float:
    """Vehicle yaw of the route segment nearest to ``(x, z)``."""
    points = np.asarray(world.route_polyline, dtype=np.float64).reshape(-1, 2)
    if len(points) < 2:
        raise CevSimConfigurationError("The route needs at least two points to infer heading")
    origin = np.array([x, z], dtype=np.float64)
    best_index = 0
    best_distance = float("inf")
    for index in range(len(points) - 1):
        distance = _segment_distance(origin, points[index], points[index + 1])
        if distance < best_distance:
            best_distance = distance
            best_index = index
    delta = points[best_index + 1] - points[best_index]
    return yaw_from_direction(float(delta[0]), float(delta[1]))


def _reset_options(
    world: PlanningWorld,
    start: tuple[float, ...] | None,
    goal: tuple[float, ...] | None,
    goal_tolerance_m: float,
) -> dict[str, Any] | None:
    options: dict[str, Any] = {}
    if start is not None:
        if len(start) == 2:
            yaw = yaw_along_route(world, start[0], start[1])
            options["start_pose"] = (start[0], start[1], yaw)
        else:
            options["start_pose"] = start
    if goal is not None:
        options["goal"] = goal
        options["position_tolerance_m"] = goal_tolerance_m
    return options or None


def _logging(logging: str | Path | bool) -> tuple[str | None, ArtifactPolicy]:
    if logging is False:
        return None, ArtifactPolicy(profile="disabled")
    if isinstance(logging, (str, Path)) and str(logging):
        return str(logging), ArtifactPolicy(profile="evaluation")
    raise CevSimConfigurationError('logging must be False or a directory path such as "runs/first"')


def _read_catalog(data_dir: Path | None) -> dict[str, Any]:
    command = [*resolve_supervisor_command(None), "catalog"]
    if data_dir is not None:
        command.extend(["--data-dir", str(data_dir)])
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise CevSimLaunchError(f"cev-sim catalog failed ({result.returncode}): {detail}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise CevSimLaunchError(f"cev-sim catalog did not return JSON: {result.stdout!r}") from error
    if not isinstance(payload, dict) or payload.get("kind") != "cev-sim.headless.catalog":
        raise CevSimLaunchError(f"cev-sim catalog returned an unexpected result: {payload!r}")
    return payload


def _catalog_entry(value: Any) -> CatalogEntry:
    if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not value["id"]:
        raise CevSimLaunchError(f"cev-sim catalog entry is invalid: {value!r}")
    name = value.get("name")
    return CatalogEntry(
        id=value["id"],
        name=name if isinstance(name, str) and name else value["id"],
        built_in=value.get("builtIn") is True,
    )


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CevSimConfigurationError(f"{label} must be a non-empty id")
    return value.strip()


def _numbers(
    value: Any,
    label: str,
    lengths: tuple[int, ...],
    description: str,
) -> tuple[float, ...] | None:
    if value is None:
        return None
    if isinstance(value, (str, bytes)) or not isinstance(value, (tuple, list)):
        raise CevSimConfigurationError(f"{label} must be a sequence of {description}")
    if len(value) not in lengths:
        raise CevSimConfigurationError(f"{label} must contain {description}")
    numbers = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            raise CevSimConfigurationError(f"{label} values must be finite numbers")
        numbers.append(float(item))
    return tuple(numbers)


def _segment_distance(point: np.ndarray[Any, Any], start: np.ndarray[Any, Any], end: np.ndarray[Any, Any]) -> float:
    delta = end - start
    length_sq = float(np.dot(delta, delta))
    if length_sq <= 1e-12:
        return float(np.linalg.norm(point - start))
    blend = float(np.clip(np.dot(point - start, delta) / length_sq, 0.0, 1.0))
    return float(np.linalg.norm(point - (start + delta * blend)))
