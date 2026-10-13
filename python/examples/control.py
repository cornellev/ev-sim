"""Small planning controllers shared by the example scripts."""

from __future__ import annotations

import argparse
import heapq
from pathlib import Path
from typing import Any

import numpy as np

from cev_sim.world import OccupancyGrid, PlanningWorld, direction_from_yaw

DEFAULT_BUNDLE = Path(__file__).resolve().parent / "bundles" / "straight.json"


def run_controller(make_controller: Any, argv: list[str] | None = None) -> int:
    """Reset one planning-oracle environment and run the controller for ``--steps``."""
    from cev_sim import PLANNING_ORACLE_OBSERVATION_PROFILE, CevSimEnv, EpisodeConfig
    from cev_sim.world import load_world

    args = parse_args(argv)
    if args.steps < 1:
        raise SystemExit("--steps must be at least 1")
    world = load_world(args.bundle)
    env = CevSimEnv(
        str(args.bundle),
        render_mode="human" if args.render else None,
        episode=EpisodeConfig(
            observation_profile=PLANNING_ORACLE_OBSERVATION_PROFILE,
            max_episode_steps=args.steps,
        ),
    )
    try:
        observation, _info = env.reset(seed=args.seed)
        controller = make_controller(env, world, observation, args)
        for step in range(args.steps):
            observation, _reward, terminated, truncated, _info = env.step(controller(observation))
            if terminated or truncated:
                print(f"stopped at step {step + 1}")
                return 0
        print(f"completed {args.steps} steps")
        return 0
    finally:
        env.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=200)
    parser.add_argument("--bundle", type=Path, default=DEFAULT_BUNDLE)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--render", action="store_true")
    return parser.parse_args(argv)


def action(speed: float, steer: float) -> np.ndarray[Any, Any]:
    return np.array([np.clip(speed, -1.0, 1.0), np.clip(steer, -1.0, 1.0)], dtype=np.float32)


def pure_pursuit(
    pose: np.ndarray[Any, Any],
    path: np.ndarray[Any, Any],
    *,
    lookahead_m: float,
    wheelbase_m: float,
    max_steering_rad: float,
    speed: float = 0.35,
) -> np.ndarray[Any, Any]:
    points = np.asarray(path, dtype=np.float64).reshape(-1, 2)
    if len(points) == 0:
        return action(0.0, 0.0)
    position = np.array([float(pose[0]), float(pose[1])], dtype=np.float64)
    yaw = float(pose[2])
    distances = np.linalg.norm(points - position, axis=1)
    nearest = int(np.argmin(distances))
    target = len(points) - 1
    for index in range(nearest, len(points)):
        if distances[index] >= lookahead_m:
            target = index
            break
    delta = points[target] - position
    forward_x, forward_z = direction_from_yaw(yaw)
    forward = float(delta[0] * forward_x + delta[1] * forward_z)
    lateral = float(delta[0] * np.sin(yaw) + delta[1] * np.cos(yaw))
    distance = max(float(np.hypot(delta[0], delta[1])), 1e-3)
    heading_error = float(np.arctan2(lateral, forward))
    steer = np.arctan(2.0 * wheelbase_m * np.sin(heading_error) / distance) / max(max_steering_rad, 1e-6)
    return action(speed if forward >= -0.25 else -0.15, float(steer))


def astar_path(world: PlanningWorld, *, resolution_m: float = 0.75) -> np.ndarray[Any, Any]:
    inflate = max(world.vehicle.width_m * 0.5, 0.3)
    grid = world.occupancy_grid(resolution_m, inflate_m=inflate)
    start = _nearest_free(grid, *grid.world_to_grid(world.start.x, world.start.z))
    goal = _nearest_free(grid, *grid.world_to_grid(world.goal.x, world.goal.z))
    route = _astar(grid, start, goal)
    if route is None:
        return world.route_polyline
    return np.asarray([grid.grid_to_world(row, col) for row, col in route], dtype=np.float64)


def rrt_star_path(
    world: PlanningWorld,
    rng: np.random.Generator,
    *,
    samples: int = 250,
    step_m: float = 2.0,
) -> np.ndarray[Any, Any]:
    inflate = max(world.vehicle.width_m * 0.5, 0.3)
    grid = world.occupancy_grid(0.75, inflate_m=inflate)
    start = np.array([world.start.x, world.start.z], dtype=np.float64)
    goal = np.array([world.goal.x, world.goal.z], dtype=np.float64)
    if _blocked(grid, start) or _blocked(grid, goal):
        return astar_path(world)
    nodes = [start]
    parents = [-1]
    costs = [0.0]
    bounds = grid_bounds(grid)
    for _ in range(samples):
        sample = goal if rng.random() < 0.1 else rng.uniform([bounds[0], bounds[1]], [bounds[2], bounds[3]])
        nearest = int(np.argmin(np.linalg.norm(np.asarray(nodes) - sample, axis=1)))
        direction = sample - nodes[nearest]
        length = float(np.linalg.norm(direction))
        if length < 1e-6:
            continue
        proposal = nodes[nearest] + direction / length * min(step_m, length)
        if _segment_blocked(grid, nodes[nearest], proposal):
            continue
        neighbors = [
            index
            for index, node in enumerate(nodes)
            if float(np.linalg.norm(node - proposal)) <= step_m * 2.0
            and not _segment_blocked(grid, node, proposal)
        ]
        parent = min(neighbors, key=lambda index: costs[index] + float(np.linalg.norm(nodes[index] - proposal)))
        nodes.append(proposal)
        parents.append(parent)
        costs.append(costs[parent] + float(np.linalg.norm(nodes[parent] - proposal)))
        child = len(nodes) - 1
        for index in neighbors:
            proposed = costs[child] + float(np.linalg.norm(nodes[index] - proposal))
            if proposed + 1e-6 < costs[index]:
                parents[index] = child
                costs[index] = proposed
        if float(np.linalg.norm(proposal - goal)) <= step_m and not _segment_blocked(grid, proposal, goal):
            nodes.append(goal)
            parents.append(child)
            break
    if not np.allclose(nodes[-1], goal):
        return astar_path(world)
    path = []
    index = len(nodes) - 1
    while index >= 0:
        path.append(nodes[index])
        index = parents[index]
    path.reverse()
    return np.asarray(path, dtype=np.float64)


def kinematic_mpc(
    pose: np.ndarray[Any, Any],
    goal: np.ndarray[Any, Any],
    *,
    wheelbase_m: float,
    max_speed_mps: float,
    max_steering_rad: float,
    rng: np.random.Generator,
) -> np.ndarray[Any, Any]:
    best_cost = float("inf")
    best = action(0.2, 0.0)
    speeds = np.linspace(0.15, 0.7, 4)
    steers = np.linspace(-0.8, 0.8, 9)
    for speed in speeds:
        for steer in steers:
            cost = _rollout_cost(
                pose, goal, float(speed), float(steer),
                wheelbase_m=wheelbase_m, max_speed_mps=max_speed_mps, max_steering_rad=max_steering_rad,
            )
            if cost < best_cost:
                best_cost = cost
                best = action(float(speed), float(steer))
    jitter = rng.normal(0.0, 0.02)
    return action(float(best[0]), float(best[1]) + float(jitter))


def grid_bounds(grid: OccupancyGrid) -> tuple[float, float, float, float]:
    return (
        grid.origin_x,
        grid.origin_z,
        grid.origin_x + grid.cells.shape[1] * grid.resolution_m,
        grid.origin_z + grid.cells.shape[0] * grid.resolution_m,
    )


def _rollout_cost(
    pose: np.ndarray[Any, Any],
    goal: np.ndarray[Any, Any],
    speed: float,
    steer: float,
    *,
    wheelbase_m: float,
    max_speed_mps: float,
    max_steering_rad: float,
) -> float:
    x, z, yaw = (float(pose[0]), float(pose[1]), float(pose[2]))
    velocity = speed * max_speed_mps
    delta = steer * max_steering_rad
    dt = 0.1
    for _ in range(12):
        x += velocity * np.cos(yaw) * dt
        z += velocity * -np.sin(yaw) * dt
        yaw += (velocity / max(wheelbase_m, 1e-3)) * np.tan(delta) * dt
    return float(np.hypot(x - goal[0], z - goal[1]) + 0.15 * abs(steer))


def _nearest_free(grid: OccupancyGrid, row: int, col: int) -> tuple[int, int]:
    rows, cols = grid.cells.shape
    row = int(np.clip(row, 0, rows - 1))
    col = int(np.clip(col, 0, cols - 1))
    if grid.cells[row, col] == 0:
        return row, col
    seen = {(row, col)}
    queue = [(row, col)]
    while queue:
        current_row, current_col = queue.pop(0)
        for d_row, d_col in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            next_row, next_col = current_row + d_row, current_col + d_col
            if not (0 <= next_row < rows and 0 <= next_col < cols) or (next_row, next_col) in seen:
                continue
            if grid.cells[next_row, next_col] == 0:
                return next_row, next_col
            seen.add((next_row, next_col))
            queue.append((next_row, next_col))
    return row, col


def _astar(grid: OccupancyGrid, start: tuple[int, int], goal: tuple[int, int]) -> list[tuple[int, int]] | None:
    def heuristic(node: tuple[int, int]) -> float:
        return float(np.hypot(node[0] - goal[0], node[1] - goal[1]))

    open_set = [(heuristic(start), 0.0, start)]
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    best = {start: 0.0}
    while open_set:
        _, cost, node = heapq.heappop(open_set)
        if node == goal:
            path = [node]
            while node in came_from:
                node = came_from[node]
                path.append(node)
            path.reverse()
            return path
        if cost > best.get(node, float("inf")) + 1e-9:
            continue
        for d_row, d_col in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            nxt = (node[0] + d_row, node[1] + d_col)
            if not (0 <= nxt[0] < grid.cells.shape[0] and 0 <= nxt[1] < grid.cells.shape[1]):
                continue
            if grid.cells[nxt] != 0:
                continue
            step = float(np.hypot(d_row, d_col))
            proposed = cost + step
            if proposed + 1e-9 < best.get(nxt, float("inf")):
                best[nxt] = proposed
                came_from[nxt] = node
                heapq.heappush(open_set, (proposed + heuristic(nxt), proposed, nxt))
    return None


def _blocked(grid: OccupancyGrid, point: np.ndarray[Any, Any]) -> bool:
    row, col = grid.world_to_grid(float(point[0]), float(point[1]))
    if not (0 <= row < grid.cells.shape[0] and 0 <= col < grid.cells.shape[1]):
        return True
    return bool(grid.cells[row, col])


def _segment_blocked(grid: OccupancyGrid, start: np.ndarray[Any, Any], end: np.ndarray[Any, Any]) -> bool:
    distance = float(np.linalg.norm(end - start))
    count = max(2, int(np.ceil(distance / max(grid.resolution_m * 0.5, 1e-3))))
    for blend in np.linspace(0.0, 1.0, count):
        if _blocked(grid, start + (end - start) * blend):
            return True
    return False
