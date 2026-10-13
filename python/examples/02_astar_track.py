"""Plan a grid path with A* and track it."""

from __future__ import annotations

from examples_path import bootstrap

bootstrap()

from control import astar_path, pure_pursuit, run_controller


def main(argv: list[str] | None = None) -> int:
    def make_controller(env, world, _observation, _args):
        path = astar_path(world)
        env.set_overlay(path)

        def control(observation):
            return pure_pursuit(
                observation["oracle/ego/pose"],
                path,
                lookahead_m=3.0,
                wheelbase_m=world.vehicle.wheelbase_m,
                max_steering_rad=world.vehicle.max_steering_rad,
            )

        return control

    return run_controller(make_controller, argv)


if __name__ == "__main__":
    raise SystemExit(main())
