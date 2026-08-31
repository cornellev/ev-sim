from __future__ import annotations

import copy
import weakref
from pathlib import Path
from typing import Any

import numpy as np
from gymnasium import Wrapper
from stable_baselines3.common.vec_env import VecEnv
from stable_baselines3.common.vec_env.base_vec_env import VecEnvIndices, VecEnvObs, VecEnvStepReturn

from .bundle import BundleInput
from .client import CevSimBatch, SupervisorClient
from .config import ArtifactPolicy, EpisodeConfig, ResourceLimits, SupervisorLaunch
from .env import _finalize_resources
from .errors import CevSimConfigurationError
from .tensors import batch_observations


def _copy_observation(observation: dict[str, np.ndarray[Any, Any]]) -> dict[str, np.ndarray[Any, Any]]:
    return {key: value.copy() for key, value in observation.items()}


class CevSimVecEnv(VecEnv):
    """Stable-Baselines3 VecEnv backed by one process-isolated supervisor batch."""

    render_mode = None
    metadata = {"render_modes": []}

    def __init__(
        self,
        bundle: BundleInput,
        num_envs: int,
        *,
        output_dir: str | Path,
        target: str | None = None,
        launch: SupervisorLaunch | None = None,
        episode: EpisodeConfig | None = None,
        resource_limits: ResourceLimits | None = None,
        artifact_policy: ArtifactPolicy | None = None,
        rpc_timeout_s: float = 30.0,
        max_message_bytes: int = 64 * 1024 * 1024,
    ) -> None:
        self._client: SupervisorClient | None = None
        self._batch: CevSimBatch | None = None
        self._closed = False
        self._broken = False
        self._pending_actions: np.ndarray[Any, Any] | None = None
        self._finalizer: weakref.finalize | None = None
        self._rngs = [np.random.default_rng() for _ in range(num_envs)]
        self.episode_config = episode or EpisodeConfig()
        try:
            self._client = SupervisorClient(
                target=target,
                launch=launch,
                rpc_timeout_s=rpc_timeout_s,
                max_message_bytes=max_message_bytes,
            )
            self._batch = self._client.create_batch(
                bundle,
                count=num_envs,
                output_directory=output_dir,
                episode=self.episode_config,
                resource_limits=resource_limits or ResourceLimits(),
                artifact_policy=artifact_policy or ArtifactPolicy(),
            )
            super().__init__(num_envs, self._batch.observation_space, self._batch.action_space)
            self._finalizer = weakref.finalize(self, _finalize_resources, self._batch, self._client)
        except Exception:
            _finalize_resources(self._batch, self._client)
            raise

    @property
    def batch_id(self) -> str:
        if self._batch is None:
            raise CevSimConfigurationError("Vector environment is closed")
        return self._batch.batch_id

    def reset(self) -> VecEnvObs:
        batch = self._require_usable()
        if any(self._options):
            raise CevSimConfigurationError("CevSimVecEnv does not support reset options in PR 8")
        seeds = []
        for index, pending in enumerate(self._seeds):
            if pending is None:
                seeds.append(self._next_seed(index))
            else:
                self._validate_seed(pending)
                self._rngs[index] = np.random.default_rng(pending)
                seeds.append(pending)
        try:
            active = [index for index, state in enumerate(batch.states) if state in {"ready", "terminal"}]
            if active:
                batch.finalize(active)
            resets = batch.reset(list(range(self.num_envs)), seeds)
        except Exception:
            self._broken = True
            try:
                self.close()
            except Exception:
                pass
            raise
        self.reset_infos = [info for _, info in resets]
        self._reset_seeds()
        self._reset_options()
        self._pending_actions = None
        return batch_observations([observation for observation, _ in resets])

    def step_async(self, actions: np.ndarray[Any, Any]) -> None:
        batch = self._require_usable()
        if self._pending_actions is not None:
            raise CevSimConfigurationError("step_async() already has a pending action batch")
        array = np.asarray(actions)
        expected = (self.num_envs, *self.action_space.shape)
        if array.shape != expected:
            raise CevSimConfigurationError(f"Vector action shape must be {expected}, received {array.shape}")
        for index in range(self.num_envs):
            batch.action_codec.encode(array[index])
        self._pending_actions = array.astype(self.action_space.dtype, copy=True)

    def step_wait(self) -> VecEnvStepReturn:
        batch = self._require_usable()
        if self._pending_actions is None:
            raise CevSimConfigurationError("step_async() must be called before step_wait()")
        actions = self._pending_actions
        self._pending_actions = None
        try:
            transitions = batch.step([actions[index] for index in range(self.num_envs)])
            observations = [transition[0] for transition in transitions]
            rewards = np.asarray([transition[1] for transition in transitions], dtype=np.float32)
            terminated = np.asarray([transition[2] for transition in transitions], dtype=np.bool_)
            truncated = np.asarray([transition[3] for transition in transitions], dtype=np.bool_)
            dones = terminated | truncated
            infos = [transition[4] for transition in transitions]
            done_indexes = np.flatnonzero(dones).tolist()
            if done_indexes:
                for index in done_indexes:
                    infos[index]["TimeLimit.truncated"] = bool(truncated[index] and not terminated[index])
                    infos[index]["terminal_observation"] = _copy_observation(observations[index])
                finalizations = batch.finalize(done_indexes)
                for finalization in finalizations:
                    info = infos[finalization["environment_index"]]
                    info["terminal_finalization"] = copy.deepcopy(finalization["result"])
                    info["cev_sim.final_result"] = finalization
                reset_seeds = [self._next_seed(index) for index in done_indexes]
                resets = batch.reset(done_indexes, reset_seeds)
                for index, (observation, info) in zip(done_indexes, resets, strict=True):
                    observations[index] = observation
                    self.reset_infos[index] = info
            return batch_observations(observations), rewards, dones, copy.deepcopy(infos)
        except Exception:
            self._broken = True
            try:
                self.close()
            except Exception:
                pass
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._pending_actions = None
        batch, client = self._batch, self._client
        self._batch = None
        self._client = None
        try:
            try:
                batch and batch.close(finalize_active_episodes=True)
            finally:
                client and client.close()
        finally:
            if self._finalizer is not None:
                self._finalizer.detach()
                self._finalizer = None

    def get_attr(self, attr_name: str, indices: VecEnvIndices = None) -> list[Any]:
        selected = self._get_indices(indices)
        attributes = {
            "action_space": self.action_space,
            "batch_id": self.batch_id,
            "episode_config": self.episode_config,
            "metadata": self.metadata,
            "observation_space": self.observation_space,
            "render_mode": self.render_mode,
            "spec": None,
        }
        if attr_name not in attributes:
            raise AttributeError(f"CevSimVecEnv has no per-environment attribute {attr_name!r}")
        return [attributes[attr_name] for _ in selected]

    def set_attr(self, attr_name: str, value: Any, indices: VecEnvIndices = None) -> None:
        del value, indices
        raise AttributeError(f"CevSimVecEnv attribute {attr_name!r} is immutable")

    def env_method(
        self,
        method_name: str,
        *method_args: Any,
        indices: VecEnvIndices = None,
        **method_kwargs: Any,
    ) -> list[Any]:
        del method_args, method_kwargs
        if method_name != "render":
            raise AttributeError(f"CevSimVecEnv has no per-environment method {method_name!r}")
        return [None for _ in self._get_indices(indices)]

    def env_is_wrapped(self, wrapper_class: type[Wrapper], indices: VecEnvIndices = None) -> list[bool]:
        del wrapper_class
        return [False for _ in self._get_indices(indices)]

    def _require_usable(self) -> CevSimBatch:
        if self._closed or self._batch is None:
            raise CevSimConfigurationError("Vector environment is closed")
        if self._broken:
            raise CevSimConfigurationError("Vector environment failed during a partial batch; close and recreate it")
        return self._batch

    def _next_seed(self, index: int) -> int:
        return int(self._rngs[index].integers(0, 1 << 64, dtype=np.uint64))

    @staticmethod
    def _validate_seed(seed: int) -> None:
        if type(seed) is not int or not 0 <= seed <= 0xFFFF_FFFF_FFFF_FFFF:
            raise CevSimConfigurationError("Stable-Baselines3 seeds must be uint64 values")

    def __enter__(self) -> CevSimVecEnv:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


__all__ = ["CevSimVecEnv"]
