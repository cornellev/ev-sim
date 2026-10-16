"""Drive with no goal on a saved environment.

The car starts on the road. Nothing ends the episode except leaving the road,
hitting an obstacle, ``--steps``, or stopping the loop. The built-in ``igvc``
environment and ``big-car`` vehicle work without a saved data directory.
"""

from __future__ import annotations

import argparse

import numpy as np

import cev_sim


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", default="igvc")
    parser.add_argument("--vehicle", default="big-car")
    parser.add_argument("--steps", type=int, default=200)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args(argv)
    if args.steps < 1:
        raise SystemExit("--steps must be at least 1")
    config = cev_sim.configure(
        environment=args.environment,
        vehicle=args.vehicle,
        goal=None,
        max_steps=args.steps,
    )
    with cev_sim.launch(config) as env:
        env.reset(seed=args.seed)
        action = np.array([0.35, 0.0], dtype=np.float32)
        while env.loop():
            env.step(action)
        print(f"stopped at step {env.clock.steps()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
