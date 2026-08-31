from __future__ import annotations

import weakref
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np

from .bundle import BundleInput
from .client import CevSimBatch, SupervisorClient
from .config import ArtifactPolicy, EpisodeConfig, ResourceLimits, SupervisorLaunch
from .errors import (
    CevSimCompatibilityError,
    CevSimConfigurationError,
    CevSimSupervisorError,
    CevSimTransportError,
)

_PROTOCOL_FAILURES = (CevSimCompatibilityError, CevSimSupervisorError, CevSimTransportError)


def _finalize_resources(batch: CevSimBatch | None, client: SupervisorClient | None) -> None:
    try:
        batch and batch.close(finalize_active_episodes=True)
    except Exception:
        pass
    finally:
        try:
            client and client.close()
        except Exception:
            pass


class CevSimEnv(gym.Env[dict[str, np.ndarray[Any, Any]], np.ndarray[Any, Any]]):
    """One Gymnasium environment backed by a protocol 1.2 supervisor batch."""

    metadata = {"render_modes": []}
    render_mode = None

    def __init__(
        self,
        bundle: BundleInput,
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
        super().__init__()
        self._client: SupervisorClient | None = None
        self._batch: CevSimBatch | None = None
        self._closed = False
        self._finalizer: weakref.finalize | None = None
        try:
            self._client = SupervisorClient(
                target=target,
                launch=launch,
                rpc_timeout_s=rpc_timeout_s,
                max_message_bytes=max_message_bytes,
            )
            self._batch = self._client.create_batch(
                bundle,
                count=1,
                output_directory=output_dir,
                episode=episode or EpisodeConfig(),
                resource_limits=resource_limits or ResourceLimits(),
                artifact_policy=artifact_policy or ArtifactPolicy(),
            )
            self.action_space = self._batch.action_space
            self.observation_space = self._batch.observation_space
            self._finalizer = weakref.finalize(self, _finalize_resources, self._batch, self._client)
        except Exception:
            _finalize_resources(self._batch, self._client)
            raise

    @property
    def batch_id(self) -> str:
        if self._batch is None:
            raise CevSimConfigurationError("Environment is closed")
        return self._batch.batch_id

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[dict[str, np.ndarray[Any, Any]], dict[str, Any]]:
        if self._closed or self._batch is None:
            raise CevSimConfigurationError("Environment is closed")
        if options:
            raise CevSimConfigurationError("CevSimEnv does not support reset options in PR 8")
        if seed is not None and (type(seed) is not int or not 0 <= seed <= 0xFFFF_FFFF_FFFF_FFFF):
            raise CevSimConfigurationError("Gymnasium reset seed must be a uint64")
        super().reset(seed=seed)
        reset_seed = self._reset_seed(seed)
        try:
            if self._batch.states[0] in {"ready", "terminal"}:
                self._batch.finalize([0])
            return self._batch.reset([0], [reset_seed])[0]
        except _PROTOCOL_FAILURES:
            self._close_after_failure()
            raise

    def step(
        self,
        action: np.ndarray[Any, Any],
    ) -> tuple[dict[str, np.ndarray[Any, Any]], float, bool, bool, dict[str, Any]]:
        if self._closed or self._batch is None:
            raise CevSimConfigurationError("Environment is closed")
        if self._batch.states[0] != "ready":
            raise CevSimConfigurationError("reset() must be called before step(), and again after an episode ends")
        try:
            return self._batch.step([action])[0]
        except _PROTOCOL_FAILURES:
            self._close_after_failure()
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
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

    def _close_after_failure(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _reset_seed(self, seed: int | None) -> int:
        if seed is not None:
            if type(seed) is not int or not 0 <= seed <= 0xFFFF_FFFF_FFFF_FFFF:
                raise CevSimConfigurationError("Gymnasium reset seed must be a uint64")
            return seed
        return int(self.np_random.integers(0, 1 << 64, dtype=np.uint64))

    def __enter__(self) -> CevSimEnv:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
