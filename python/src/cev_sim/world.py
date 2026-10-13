"""Planning geometry read from a resolved cev-sim run bundle.

The planar frame is `(x, z, yaw)`. `yaw` is the vehicle rotation about Y, so
forward is `(cos(yaw), -sin(yaw))` in `(x, z)`. That matches
`vehicleForwardTangent` in the JavaScript simulator. Route heading
`atan2(dx, dz)` is a different angle; use `yaw_from_direction`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .bundle import BundleInput, load_bundle
from .errors import CevSimConfigurationError


def yaw_from_direction(dx: float, dz: float) -> float:
    """Vehicle yaw whose forward axis follows the travel direction `(dx, dz)`."""
    return float(np.arctan2(-dz, dx))


def direction_from_yaw(yaw: float) -> tuple[float, float]:
    return float(np.cos(yaw)), float(-np.sin(yaw))


@dataclass(frozen=True)
class Pose2D:
    x: float
    z: float
    yaw: float
    speed_mps: float = 0.0


@dataclass(frozen=True)
class Obstacle:
    id: str
    footprint: np.ndarray


@dataclass(frozen=True)
class DrivableSurface:
    id: str
    vertices: np.ndarray
    triangles: np.ndarray


@dataclass(frozen=True)
class VehicleModel:
    actor_id: str
    vehicle_id: str
    length_m: float
    width_m: float
    wheelbase_m: float
    max_speed_mps: float
    max_steering_rad: float


@dataclass(frozen=True)
class OccupancyGrid:
    """`cells` is uint8 with shape `(rows, cols)`. 0 is drivable and free; 1 is blocked."""

    cells: np.ndarray
    origin_x: float
    origin_z: float
    resolution_m: float

    def world_to_grid(self, x: float, z: float) -> tuple[int, int]:
        return world_to_grid(self, x, z)

    def grid_to_world(self, row: int, col: int) -> tuple[float, float]:
        return grid_to_world(self, row, col)


def world_to_grid(grid: OccupancyGrid, x: float, z: float) -> tuple[int, int]:
    column = int(np.floor((float(x) - grid.origin_x) / grid.resolution_m))
    row = int(np.floor((float(z) - grid.origin_z) / grid.resolution_m))
    return row, column


def grid_to_world(grid: OccupancyGrid, row: int, col: int) -> tuple[float, float]:
    return (
        grid.origin_x + (int(col) + 0.5) * grid.resolution_m,
        grid.origin_z + (int(row) + 0.5) * grid.resolution_m,
    )


@dataclass(frozen=True)
class PlanningWorld:
    route_polyline: np.ndarray
    route_distances: np.ndarray
    route_length_m: float
    obstacles: tuple[Obstacle, ...]
    drivable_surfaces: tuple[DrivableSurface, ...]
    vehicle: VehicleModel
    start: Pose2D
    goal: Pose2D

    def occupancy_grid(
        self,
        resolution_m: float,
        inflate_m: float = 0.0,
        bounds: tuple[float, float, float, float] | None = None,
    ) -> OccupancyGrid:
        if isinstance(resolution_m, bool) or not isinstance(resolution_m, (int, float)) or resolution_m <= 0:
            raise CevSimConfigurationError("resolution_m must be positive")
        if isinstance(inflate_m, bool) or not isinstance(inflate_m, (int, float)) or inflate_m < 0:
            raise CevSimConfigurationError("inflate_m must be non-negative")
        min_x, min_z, max_x, max_z = bounds if bounds is not None else self._default_bounds()
        if max_x <= min_x or max_z <= min_z:
            raise CevSimConfigurationError("occupancy bounds must have positive width and height")
        columns = max(1, int(np.ceil((max_x - min_x) / resolution_m)))
        rows = max(1, int(np.ceil((max_z - min_z) / resolution_m)))
        cells = np.ones((rows, columns), dtype=np.uint8)
        triangles = _surface_triangles(self.drivable_surfaces)
        obstacle_rings = tuple(obstacle.footprint for obstacle in self.obstacles)
        for row, col in np.ndindex(rows, columns):
            x = min_x + (col + 0.5) * resolution_m
            z = min_z + (row + 0.5) * resolution_m
            if _point_in_triangles(x, z, triangles) and not _blocked_by_obstacles(x, z, obstacle_rings, inflate_m):
                cells[row, col] = 0
        return OccupancyGrid(cells=cells, origin_x=min_x, origin_z=min_z, resolution_m=float(resolution_m))

    def _default_bounds(self) -> tuple[float, float, float, float]:
        points = [self.route_polyline]
        points.extend(surface.vertices for surface in self.drivable_surfaces if len(surface.vertices))
        points.extend(obstacle.footprint for obstacle in self.obstacles if len(obstacle.footprint))
        stacked = np.vstack(points)
        pad = max(self.vehicle.length_m, self.vehicle.width_m, 1.0)
        return (
            float(np.min(stacked[:, 0]) - pad),
            float(np.min(stacked[:, 1]) - pad),
            float(np.max(stacked[:, 0]) + pad),
            float(np.max(stacked[:, 1]) + pad),
        )


def load_world(bundle: BundleInput) -> PlanningWorld:
    document = load_bundle(bundle).document
    resolved = document["resolved"]
    manifest = document["manifest"]
    scenario = ((resolved.get("scenario") or {}).get("scenario") or {})
    route = _ego_route(scenario, manifest)
    verification = route.get("verification") or {}
    polyline = _points(verification.get("polyline"))
    distances = np.asarray(verification.get("cumulativeDistances") or [], dtype=np.float64)
    if len(polyline) < 2 or len(distances) != len(polyline):
        raise CevSimConfigurationError("The bundle route needs a verified polyline and cumulative distances")
    description = ((resolved.get("world") or {}).get("description") or {})
    obstacles = tuple(
        Obstacle(id=str(entry.get("id") or f"obstacle-{index}"), footprint=_points(entry.get("footprint")))
        for index, entry in enumerate(description.get("obstacles") or [])
        if _points(entry.get("footprint")).size
    )
    surfaces = tuple(_surface(entry, index) for index, entry in enumerate(description.get("drivableSurfaces") or []))
    surfaces = tuple(surface for surface in surfaces if len(surface.vertices) >= 3)
    vehicle = _vehicle(resolved, manifest)
    start = _start_pose(manifest, polyline)
    goal = _goal_pose(scenario, route, polyline)
    return PlanningWorld(
        route_polyline=polyline,
        route_distances=distances,
        route_length_m=float(verification.get("totalLength") or distances[-1]),
        obstacles=obstacles,
        drivable_surfaces=surfaces,
        vehicle=vehicle,
        start=start,
        goal=goal,
    )


def _ego_route(scenario: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    routes = scenario.get("routes") or []
    target = ((manifest.get("controls") or {}).get("targetVehicleId")) or "ego"
    for route in routes:
        if route.get("actorId") in {target, "ego"}:
            return route
    if routes:
        return routes[0]
    raise CevSimConfigurationError("The bundle has no ego route")


def _points(value: Any) -> np.ndarray:
    rows = []
    for point in value or []:
        if isinstance(point, dict):
            rows.append((float(point.get("x", 0.0)), float(point.get("z", 0.0))))
        else:
            rows.append((float(point[0]), float(point[1])))
    if not rows:
        return np.zeros((0, 2), dtype=np.float64)
    return np.asarray(rows, dtype=np.float64)


def _surface(entry: dict[str, Any], index: int) -> DrivableSurface:
    vertices = _points(entry.get("vertices") or entry.get("footprint"))
    raw = entry.get("indices") or entry.get("triangles") or []
    if raw and isinstance(raw[0], (list, tuple)):
        triangles = np.asarray(raw, dtype=np.int64)
    elif len(raw) >= 3:
        triangles = np.asarray(raw, dtype=np.int64).reshape(-1, 3)
    elif len(vertices) >= 3:
        triangles = _fan(len(vertices))
    else:
        triangles = np.zeros((0, 3), dtype=np.int64)
    return DrivableSurface(id=str(entry.get("id") or f"surface-{index}"), vertices=vertices, triangles=triangles)


def _fan(count: int) -> np.ndarray:
    return np.asarray([[0, index, index + 1] for index in range(1, count - 1)], dtype=np.int64)


def _vehicle(resolved: dict[str, Any], manifest: dict[str, Any]) -> VehicleModel:
    initial = ((manifest.get("initialState") or {}).get("vehicles") or [{}])[0]
    actor_id = str(initial.get("id") or "ego")
    entries = resolved.get("vehicles") or []
    selected = next((entry for entry in entries if entry.get("actorId") == actor_id), entries[0] if entries else {})
    vehicle_manifest = selected.get("manifest") or {}
    size = ((vehicle_manifest.get("boundingBox") or {}).get("size") or {})
    kinematics = vehicle_manifest.get("kinematics") or {}
    try:
        return VehicleModel(
            actor_id=actor_id,
            vehicle_id=str(selected.get("vehicleId") or initial.get("type") or ""),
            length_m=float(size["x"]),
            width_m=float(size["z"]),
            wheelbase_m=float(kinematics["wheelbase"]),
            max_speed_mps=float(kinematics["maxSpeed"]),
            max_steering_rad=float(kinematics["maxSteeringAngle"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise CevSimConfigurationError("The bundle is missing ego footprint or kinematics") from error


def _start_pose(manifest: dict[str, Any], polyline: np.ndarray) -> Pose2D:
    vehicles = ((manifest.get("initialState") or {}).get("vehicles") or [])
    vehicle = next(
        (entry for entry in vehicles if entry.get("id") in {"ego", None} or entry.get("role") == "ego"),
        None,
    )
    vehicle = vehicle or (vehicles[0] if vehicles else None)
    if vehicle and isinstance(vehicle.get("pose"), dict):
        position = vehicle["pose"].get("position") or {}
        rotation = vehicle["pose"].get("rotation") or {}
        return Pose2D(
            x=float(position.get("x", polyline[0, 0])),
            z=float(position.get("z", polyline[0, 1])),
            yaw=float(rotation.get("y", yaw_from_direction(*(polyline[1] - polyline[0])))),
            speed_mps=0.0,
        )
    delta = polyline[1] - polyline[0]
    yaw = yaw_from_direction(float(delta[0]), float(delta[1]))
    return Pose2D(x=float(polyline[0, 0]), z=float(polyline[0, 1]), yaw=yaw)


def _goal_pose(scenario: dict[str, Any], route: dict[str, Any], polyline: np.ndarray) -> Pose2D:
    waypoints = route.get("waypoints") or []
    finish = next((waypoint for waypoint in waypoints if waypoint.get("kind") == "finish"), None)
    finish = finish or (waypoints[-1] if waypoints else None)
    if finish and isinstance(finish.get("position"), dict):
        position = finish["position"]
        point = np.array([float(position.get("x", polyline[-1, 0])), float(position.get("z", polyline[-1, 1]))])
    else:
        zones = scenario.get("zones") or []
        if zones and isinstance(zones[-1].get("center"), dict):
            center = zones[-1]["center"]
            point = np.array([float(center.get("x", polyline[-1, 0])), float(center.get("z", polyline[-1, 1]))])
        else:
            point = polyline[-1]
    previous = polyline[-2]
    yaw = yaw_from_direction(float(point[0] - previous[0]), float(point[1] - previous[1]))
    return Pose2D(x=float(point[0]), z=float(point[1]), yaw=yaw)


def _surface_triangles(surfaces: tuple[DrivableSurface, ...]) -> list[np.ndarray]:
    triangles = []
    for surface in surfaces:
        for tri in surface.triangles:
            if np.any(tri < 0) or np.any(tri >= len(surface.vertices)):
                continue
            triangles.append(surface.vertices[tri])
    return triangles


def _point_in_triangles(x: float, z: float, triangles: list[np.ndarray]) -> bool:
    point = np.array([x, z], dtype=np.float64)
    return any(_point_in_triangle(point, triangle) for triangle in triangles)


def _point_in_triangle(point: np.ndarray, triangle: np.ndarray) -> bool:
    a, b, c = triangle
    area = _cross(b - a, c - a)
    if abs(area) <= 1e-12:
        return False
    left = _cross(b - a, point - a)
    right = _cross(c - b, point - b)
    back = _cross(a - c, point - c)
    if area > 0:
        return left >= -1e-9 and right >= -1e-9 and back >= -1e-9
    return left <= 1e-9 and right <= 1e-9 and back <= 1e-9


def _cross(left: np.ndarray, right: np.ndarray) -> float:
    return float(left[0] * right[1] - left[1] * right[0])


def _blocked_by_obstacles(x: float, z: float, footprints: tuple[np.ndarray, ...], inflate_m: float) -> bool:
    point = np.array([x, z], dtype=np.float64)
    return any(_distance_to_polygon(point, footprint) <= inflate_m for footprint in footprints)


def _distance_to_polygon(point: np.ndarray, polygon: np.ndarray) -> float:
    if len(polygon) < 3:
        return float("inf")
    if _point_in_ring(point, polygon):
        return 0.0
    count = len(polygon)
    return min(
        _distance_to_segment(point, polygon[index], polygon[(index + 1) % count])
        for index in range(count)
    )


def _point_in_ring(point: np.ndarray, polygon: np.ndarray) -> bool:
    inside = False
    j = len(polygon) - 1
    for i, current in enumerate(polygon):
        previous = polygon[j]
        span = previous[1] - current[1]
        intersects = ((current[1] > point[1]) != (previous[1] > point[1])) and (
            point[0] < (previous[0] - current[0]) * (point[1] - current[1]) / span + current[0]
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def _distance_to_segment(point: np.ndarray, start: np.ndarray, end: np.ndarray) -> float:
    edge = end - start
    length_sq = float(edge @ edge)
    if length_sq <= 1e-18:
        return float(np.linalg.norm(point - start))
    blend = float(np.clip(((point - start) @ edge) / length_sq, 0.0, 1.0))
    return float(np.linalg.norm(point - (start + blend * edge)))
