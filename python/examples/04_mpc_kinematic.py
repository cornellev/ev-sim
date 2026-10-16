"""Track the goal with a short kinematic-bicycle rollout."""

from __future__ import annotations

import numpy as np

from examples_path import bootstrap

bootstrap()

from control import kinematic_mpc, run_controller


def main(argv: list[str] | None = None) -> int:
    def make_controller(_env, world, _observation, args):
        rng = np.random.default_rng(args.seed)

        def control(observation):
            return kinematic_mpc(
                observation["oracle/ego/pose"],
                observation["oracle/goal"],
                wheelbase_m=world.vehicle.wheelbase_m,
                max_speed_mps=world.vehicle.max_speed_mps,
                max_steering_rad=world.vehicle.max_steering_rad,
                rng=rng,
            )

        return control

    return run_controller(make_controller, argv)


if __name__ == "__main__":
    raise SystemExit(main())
