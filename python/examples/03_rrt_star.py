"""Plan with RRT* and track the resulting path."""

from __future__ import annotations

import numpy as np

from examples_path import bootstrap

bootstrap()

from control import pure_pursuit, rrt_star_path, run_controller


def main(argv: list[str] | None = None) -> int:
    def make_controller(env, world, _observation, args):
        path = rrt_star_path(world, np.random.default_rng(args.seed))
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
