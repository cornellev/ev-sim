"""Follow the verified route with pure pursuit."""

from __future__ import annotations

from examples_path import bootstrap

bootstrap()

from control import pure_pursuit, run_controller


def main(argv: list[str] | None = None) -> int:
    def make_controller(env, world, _observation, _args):
        del env

        def control(observation):
            return pure_pursuit(
                observation["oracle/ego/pose"],
                world.route_polyline,
                lookahead_m=5.0,
                wheelbase_m=world.vehicle.wheelbase_m,
                max_steering_rad=world.vehicle.max_steering_rad,
            )

        return control

    return run_controller(make_controller, argv)


if __name__ == "__main__":
    raise SystemExit(main())
