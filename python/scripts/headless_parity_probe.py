from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
from typing import Any

import numpy as np

from cev_sim.client import SupervisorClient
from cev_sim.config import (
    MEASURED_PERCEPTION_OBSERVATION_PROFILE,
    ArtifactPolicy,
    EpisodeConfig,
    ResourceLimits,
)


def observation_projection(observation: dict[str, np.ndarray[Any, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "dtype": str(value.dtype),
            "shape": list(value.shape),
            "data": base64.b64encode(value.tobytes(order="C")).decode("ascii"),
        }
        for name, value in sorted(observation.items(), key=lambda entry: entry[0].encode("utf-8"))
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--actions", required=True)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--perception", action="store_true")
    arguments = parser.parse_args()
    actions = json.loads(Path(arguments.actions).read_text(encoding="utf-8"))
    client = SupervisorClient(target=arguments.target)
    batch = client.create_batch(
        arguments.bundle,
        count=1,
        output_directory=arguments.output,
        episode=EpisodeConfig(
            action_repeat=1,
            observation_profile=(
                MEASURED_PERCEPTION_OBSERVATION_PROFILE if arguments.perception else EpisodeConfig().observation_profile
            ),
        ),
        resource_limits=ResourceLimits(),
        artifact_policy=ArtifactPolicy(profile="disabled"),
    )
    try:
        observation, reset_info = batch.reset([0], [arguments.seed])[0]
        reset_observation = observation_projection(observation)
        transitions = []
        for action in actions:
            observation, reward, terminated, truncated, info = batch.step(
                [np.asarray(action, dtype=np.float32)]
            )[0]
            transitions.append(
                {
                    "observation": observation_projection(observation),
                    "reward": reward,
                    "terminated": terminated,
                    "truncated": truncated,
                    "info": info,
                }
            )
            if terminated or truncated:
                break
        finalized = batch.finalize([0])[0]
        print(
            json.dumps(
                {
                    "source": "python",
                    "reset": {
                        "observation": reset_observation,
                        "info": reset_info,
                    },
                    "transitions": transitions,
                    "final": finalized,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    finally:
        batch.close(finalize_active_episodes=False)
        client.close()


if __name__ == "__main__":
    main()
