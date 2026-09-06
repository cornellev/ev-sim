from __future__ import annotations

import base64
import os
import signal
import time
from pathlib import Path
from typing import Any

import numpy as np
import psutil
import pytest
from gymnasium.utils.env_checker import check_env as gymnasium_check_env
from stable_baselines3 import PPO
from stable_baselines3.common.env_checker import check_env as sb3_check_env

from cev_sim import (
    ArtifactPolicy,
    CevSimConfigurationError,
    CevSimEnv,
    CevSimEnvironmentError,
    CevSimLaunchError,
    CevSimTransportError,
    EpisodeConfig,
    SupervisorLaunch,
)
from cev_sim.process import OwnedSupervisor
from cev_sim.sb3 import CevSimVecEnv

pytestmark = pytest.mark.integration


def launch(repository_root: Path) -> SupervisorLaunch:
    return SupervisorLaunch(executable=repository_root / "bin" / "cev-sim.js")


def assert_observation_bytes(observation: dict[str, np.ndarray[Any, Any]], expected: list[dict[str, Any]]) -> None:
    assert list(observation) == [entry["name"] for entry in expected]
    for entry in expected:
        assert observation[entry["name"]].tobytes(order="C") == base64.b64decode(entry["data"])


def process_tree(process: psutil.Process) -> list[psutil.Process]:
    return [process, *process.children(recursive=True)]


def wait_for_exit(processes: list[psutil.Process]) -> None:
    _, alive = psutil.wait_procs(processes, timeout=10)
    assert not [process for process in alive if process.is_running() and process.status() != psutil.STATUS_ZOMBIE]


def test_single_env_matches_direct_runner_and_cli_and_reseeds(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    env = CevSimEnv(
        headless_fixture["bundlePath"],
        output_dir=tmp_path / "python",
        launch=launch(repository_root),
        artifact_policy=ArtifactPolicy(profile="disabled"),
    )
    assert env._client is not None and env._client._owned is not None and env._client._owned.process is not None
    processes = process_tree(psutil.Process(env._client._owned.process.pid))
    first, first_info = env.reset(seed=123)
    assert first_info["episode_hash"] == headless_fixture["episodeHash"]
    assert_observation_bytes(first, headless_fixture["resetObservation"])
    stepped, _, terminated, truncated, step_info = env.step(np.zeros(2, dtype=np.float32))
    assert not terminated and not truncated
    assert step_info["trajectory_hash"] == headless_fixture["trajectoryHash"]
    assert step_info["trajectory_hash"] == headless_fixture["cliTrajectoryHash"]
    assert_observation_bytes(stepped, headless_fixture["stepObservation"])

    repeated, repeated_info = env.reset(seed=123)
    assert repeated_info["episode_hash"] == first_info["episode_hash"]
    for key in first:
        np.testing.assert_array_equal(repeated[key], first[key])
    _, changed_info = env.reset(seed=124)
    assert changed_info["episode_hash"] != first_info["episode_hash"]
    env.close()
    wait_for_exit(processes)


def test_gymnasium_and_sb3_environment_checkers_pass(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    with CevSimEnv(
        headless_fixture["bundlePath"],
        output_dir=tmp_path / "checker",
        launch=launch(repository_root),
        episode=EpisodeConfig(max_episode_steps=2),
        artifact_policy=ArtifactPolicy(profile="disabled"),
    ) as env:
        gymnasium_check_env(env, skip_render_check=True)
        sb3_check_env(env, warn=True, skip_render_check=True)


def test_single_env_returns_real_termination_transition(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    with CevSimEnv(
        headless_fixture["bundlePath"],
        output_dir=tmp_path / "termination",
        launch=launch(repository_root),
        artifact_policy=ArtifactPolicy(profile="disabled"),
    ) as env:
        env.reset(seed=12)
        _, _, terminated, truncated, _ = env.step(np.zeros(2, dtype=np.float32))
        assert not terminated and not truncated
        terminal_observation, _, terminated, truncated, info = env.step(np.zeros(2, dtype=np.float32))
        assert terminated and not truncated
        assert info["termination_reason"] == "success"
        assert env.observation_space.contains(terminal_observation)


def test_lidar_bundle_auto_selects_cpu_backend_without_changing_observations(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    with CevSimEnv(
        headless_fixture["lidarBundlePath"],
        output_dir=tmp_path / "lidar",
        launch=launch(repository_root),
        artifact_policy=ArtifactPolicy(profile="disabled"),
    ) as env:
        observation, _ = env.reset(seed=123)
        assert_observation_bytes(observation, headless_fixture["resetObservation"])
        stepped, _, terminated, truncated, _ = env.step(np.zeros(2, dtype=np.float32))
        assert not terminated and not truncated
        assert env.observation_space.contains(stepped)


def test_external_supervisor_is_not_terminated_by_environment_close(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    owner = OwnedSupervisor(launch(repository_root))
    target = owner.start()
    assert owner.process is not None
    try:
        env = CevSimEnv(
            headless_fixture["bundlePath"],
            output_dir=tmp_path / "external",
            target=target,
            artifact_policy=ArtifactPolicy(profile="disabled"),
        )
        env.reset(seed=1)
        env.close()
        assert owner.process.poll() is None
    finally:
        owner.close()


def test_missing_supervisor_executable_reports_a_launch_error(
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    with pytest.raises(CevSimLaunchError, match="not found on PATH"):
        CevSimEnv(
            headless_fixture["bundlePath"],
            output_dir=tmp_path / "missing",
            launch=SupervisorLaunch(executable="cev-sim-does-not-exist"),
        )


def test_supervisor_startup_timeout_is_bounded(tmp_path: Path) -> None:
    executable = tmp_path / "silent-supervisor"
    executable.write_text("#!/bin/sh\nsleep 30\n")
    executable.chmod(0o755)
    owner = OwnedSupervisor(
        SupervisorLaunch(
            executable=executable,
            startup_timeout_s=0.05,
            shutdown_grace_s=0.1,
            kill_grace_s=0.1,
        )
    )
    with pytest.raises(CevSimLaunchError, match="listener record"):
        owner.start()
    assert owner.process is None


def test_sb3_vec_env_autoresets_and_preserves_terminal_observations(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    with CevSimVecEnv(
        headless_fixture["bundlePath"],
        2,
        output_dir=tmp_path / "vector",
        launch=launch(repository_root),
        episode=EpisodeConfig(max_episode_steps=1),
        artifact_policy=ArtifactPolicy(profile="disabled"),
    ) as env:
        assert env.seed(100) == [100, 101]
        observations = env.reset()
        assert observations["task/value"].shape == (2, 7)
        next_observations, rewards, dones, infos = env.step(np.zeros((2, 2), dtype=np.float32))
        assert rewards.shape == (2,)
        assert dones.tolist() == [True, True]
        assert next_observations["task/value"].shape == (2, 7)
        for info in infos:
            assert info["TimeLimit.truncated"] is True
            assert info["truncation_reason"] == "max_episode_steps"
            assert "terminal_observation" in info
            assert "terminal_finalization" in info
            assert "cev_sim.final_result" in info
        env.step_async(np.zeros((2, 2), dtype=np.float32))
        with pytest.raises(CevSimConfigurationError, match="pending"):
            env.step_async(np.zeros((2, 2), dtype=np.float32))
        env.step_wait()


def test_partial_vector_step_failure_closes_owned_process_tree(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = CevSimVecEnv(
        headless_fixture["bundlePath"],
        2,
        output_dir=tmp_path / "partial",
        launch=launch(repository_root),
        artifact_policy=ArtifactPolicy(profile="disabled"),
    )
    assert env._client is not None and env._client._owned is not None and env._client._owned.process is not None
    processes = process_tree(psutil.Process(env._client._owned.process.pid))
    env.seed(20)
    env.reset()
    assert env._batch is not None
    encode = env._batch.action_codec.encode
    calls = 0

    def encode_one_invalid_action(value: Any) -> Any:
        nonlocal calls
        result = encode(value)
        # Calls 0 and 1 are step_async validation; corrupt the first tensor
        # encoded for the actual StepBatch request.
        if calls == 2:
            result.entries[0].name = "wrong"
        calls += 1
        return result

    monkeypatch.setattr(env._batch.action_codec, "encode", encode_one_invalid_action)
    with pytest.raises(CevSimEnvironmentError):
        env.step(np.zeros((2, 2), dtype=np.float32))
    assert env._closed is True
    wait_for_exit(processes)


def test_transport_failure_closes_owned_process_tree(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    env = CevSimEnv(
        headless_fixture["bundlePath"],
        output_dir=tmp_path / "transport",
        launch=launch(repository_root),
        artifact_policy=ArtifactPolicy(profile="disabled"),
        rpc_timeout_s=2,
    )
    assert env._client is not None and env._client._owned is not None and env._client._owned.process is not None
    owned_process = env._client._owned.process
    processes = process_tree(psutil.Process(owned_process.pid))
    env.reset(seed=2)
    os.kill(owned_process.pid, signal.SIGKILL)
    with pytest.raises(CevSimTransportError):
        env.step(np.zeros(2, dtype=np.float32))
    assert env._closed is True
    wait_for_exit(processes)


def test_eight_environment_ppo_smoke(
    repository_root: Path,
    headless_fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    with CevSimVecEnv(
        headless_fixture["bundlePath"],
        8,
        output_dir=tmp_path / "ppo",
        launch=launch(repository_root),
        episode=EpisodeConfig(max_episode_steps=1),
        artifact_policy=ArtifactPolicy(profile="disabled"),
    ) as env:
        model = PPO(
            "MultiInputPolicy",
            env,
            n_steps=2,
            batch_size=16,
            n_epochs=1,
            learning_rate=1e-3,
            seed=7,
            device="cpu",
            verbose=0,
        )
        model.learn(total_timesteps=32)
        assert model.num_timesteps >= 32


def test_owned_supervisor_cleanup_is_idempotent(repository_root: Path) -> None:
    owner = OwnedSupervisor(launch(repository_root))
    owner.start()
    assert owner.process is not None
    processes = process_tree(psutil.Process(owner.process.pid))
    owner.close()
    owner.close()
    wait_for_exit(processes)
    time.sleep(0.01)


@pytest.mark.parametrize("version", [10, 11])
def test_bundle_episode_hash_matches_frozen_javascript_vector(
    repository_root: Path, tmp_path: Path, version: int,
) -> None:
    import json

    root = repository_root / "tests/fixtures/visual-layer"
    vector = (json.loads((root / "legacy-bundles.v1.json").read_text())["state"] if version == 10
              else json.loads((root / "world-bound-state.v2.json").read_text()))
    filename = "legacy-state.v10.json" if version == 10 else "world-bound-state.v11.json"
    with CevSimEnv(root / filename, output_dir=tmp_path / "legacy",
                   launch=launch(repository_root), artifact_policy=ArtifactPolicy(profile="disabled")) as env:
        _, info = env.reset(seed=42)
        assert info["episode_hash"] == vector["headlessEpisodeHash"]
        _, repeated = env.reset(seed=42)
        assert repeated["episode_hash"] == info["episode_hash"]
