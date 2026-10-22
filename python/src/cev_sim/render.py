"""Top-down planner view driven by ``planning-oracle`` observations."""

from __future__ import annotations

from typing import Any

import numpy as np

from .bundle import BundleInput
from .errors import CevSimConfigurationError
from .world import PlanningWorld, load_world


class PlanningRenderer:
    """Draw the route, obstacles, actors, goal, and an optional planned path."""

    def __init__(self, bundle: BundleInput, *, mode: str) -> None:
        if mode not in {"human", "rgb_array"}:
            raise CevSimConfigurationError("render mode must be human or rgb_array")
        self.mode = mode
        self.world: PlanningWorld = load_world(bundle)
        self._figure: Any = None
        self._axes: Any = None

    def draw(
        self,
        observation: dict[str, np.ndarray[Any, Any]] | None,
        overlay: np.ndarray[Any, Any] | None = None,
        estimate: np.ndarray[Any, Any] | None = None,
    ) -> np.ndarray[Any, Any] | None:
        pose = _required_pose(observation)
        if self.mode == "human":
            return self._draw_human(pose, observation, overlay, estimate)
        return self._draw_array(pose, observation, overlay, estimate)

    def close(self) -> None:
        if self._figure is None:
            return
        import matplotlib.pyplot as plt

        plt.close(self._figure)
        self._figure = None
        self._axes = None

    def _draw_human(
        self,
        pose: np.ndarray[Any, Any],
        observation: dict[str, np.ndarray[Any, Any]] | None,
        overlay: np.ndarray[Any, Any] | None,
        estimate: np.ndarray[Any, Any] | None,
    ) -> None:
        import matplotlib.pyplot as plt

        if self._figure is None:
            plt.ion()
            self._figure, self._axes = plt.subplots(figsize=(8, 6))
            manager = getattr(self._figure.canvas, "manager", None)
            if manager is not None and hasattr(manager, "set_window_title"):
                manager.set_window_title("cev-sim planner")
        self._axes.clear()
        _paint(self._axes, self.world, pose, observation, overlay, estimate)
        self._figure.canvas.draw_idle()
        plt.pause(0.001)
        return None

    def _draw_array(
        self,
        pose: np.ndarray[Any, Any],
        observation: dict[str, np.ndarray[Any, Any]] | None,
        overlay: np.ndarray[Any, Any] | None,
        estimate: np.ndarray[Any, Any] | None,
    ) -> np.ndarray[Any, Any]:
        from matplotlib.backends.backend_agg import FigureCanvasAgg
        from matplotlib.figure import Figure

        figure = Figure(figsize=(8, 6), dpi=100)
        FigureCanvasAgg(figure)
        axes = figure.add_subplot(111)
        _paint(axes, self.world, pose, observation, overlay, estimate)
        figure.canvas.draw()
        image = np.asarray(figure.canvas.buffer_rgba(), dtype=np.uint8)
        return np.ascontiguousarray(image[:, :, :3])


def _required_pose(observation: dict[str, np.ndarray[Any, Any]] | None) -> np.ndarray[Any, Any]:
    if observation is None or "oracle/ego/pose" not in observation:
        raise CevSimConfigurationError(
            "render() requires the planning-oracle observation profile so it can read oracle/ego/pose"
        )
    pose = np.asarray(observation["oracle/ego/pose"], dtype=np.float64).reshape(3)
    return pose


def _paint(
    axes: Any,
    world: PlanningWorld,
    pose: np.ndarray[Any, Any],
    observation: dict[str, np.ndarray[Any, Any]] | None,
    overlay: np.ndarray[Any, Any] | None,
    estimate: np.ndarray[Any, Any] | None = None,
) -> None:
    route = world.route_polyline
    if len(route):
        axes.plot(route[:, 0], route[:, 1], color="#8d99ae", linewidth=1.5, label="route")
    for obstacle in world.obstacles:
        ring = obstacle.footprint
        if len(ring) < 3:
            continue
        closed = np.vstack((ring, ring[:1]))
        axes.fill(closed[:, 0], closed[:, 1], color="#6d6875", alpha=0.85, linewidth=0)
    if overlay is not None:
        path = np.asarray(overlay, dtype=np.float64)
        if path.ndim == 2 and path.shape[1] >= 2 and len(path):
            axes.plot(path[:, 0], path[:, 1], color="#2a9d8f", linewidth=2, label="plan")
    _actors(axes, observation)
    _goal(axes, observation)
    _vehicle(axes, pose, world.vehicle.length_m, world.vehicle.width_m, color="#e76f51")
    if estimate is not None:
        _vehicle(
            axes,
            estimate,
            world.vehicle.length_m,
            world.vehicle.width_m,
            color="#f97316",
            alpha=0.45,
        )
    axes.set_aspect("equal", adjustable="datalim")
    axes.set_xlabel("x (m)")
    axes.set_ylabel("z (m)")
    axes.grid(True, linewidth=0.4, alpha=0.4)


def _vehicle(
    axes: Any,
    pose: np.ndarray[Any, Any],
    length: float,
    width: float,
    color: str,
    alpha: float = 0.9,
) -> None:
    from matplotlib.patches import Polygon

    yaw = float(pose[2])
    forward = np.array([np.cos(yaw), -np.sin(yaw)])
    right = np.array([np.sin(yaw), np.cos(yaw)])
    center = np.array([float(pose[0]), float(pose[1])])
    corners = []
    for along in (-0.5, 0.5):
        for across in (-0.5, 0.5):
            corners.append(center + along * length * forward + across * width * right)
    order = [corners[0], corners[1], corners[3], corners[2]]
    axes.add_patch(Polygon(order, closed=True, facecolor=color, edgecolor="#1d3557", linewidth=0.8, alpha=alpha))
    nose = center + 0.5 * max(length, 0.5) * forward
    axes.plot([center[0], nose[0]], [center[1], nose[1]], color="#1d3557", linewidth=1)


def _actors(axes: Any, observation: dict[str, np.ndarray[Any, Any]] | None) -> None:
    if observation is None or "oracle/actors/pose" not in observation:
        return
    poses = np.asarray(observation["oracle/actors/pose"], dtype=np.float64).reshape(-1, 3)
    footprints = np.asarray(observation.get("oracle/actors/footprint", np.zeros((len(poses), 2))), dtype=np.float64)
    footprints = footprints.reshape(-1, 2)
    validity = np.asarray(observation.get("oracle/actors/validity", np.ones(len(poses), dtype=bool))).reshape(-1)
    for index, actor_pose in enumerate(poses):
        if index < len(validity) and not bool(validity[index]):
            continue
        if index < len(footprints):
            length, width = float(footprints[index, 0]), float(footprints[index, 1])
        else:
            length, width = 1.0, 0.5
        _vehicle(axes, actor_pose, max(length, 0.2), max(width, 0.2), color="#457b9d")


def _goal(axes: Any, observation: dict[str, np.ndarray[Any, Any]] | None) -> None:
    if observation is None or "oracle/goal" not in observation:
        return
    validity = observation.get("oracle/goal/validity")
    if validity is not None and not bool(np.asarray(validity).reshape(-1)[0]):
        return
    goal = np.asarray(observation["oracle/goal"], dtype=np.float64).reshape(3)
    axes.scatter([goal[0]], [goal[1]], marker="*", s=80, color="#e9c46a", zorder=4, label="goal")
