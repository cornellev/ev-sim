from __future__ import annotations

import shutil
import tempfile
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
from .overrides import normalize_reset_options

_PROTOCOL_FAILURES = (CevSimCompatibilityError, CevSimSupervisorError, CevSimTransportError)


def _finalize_resources(
    batch: CevSimBatch | None,
    client: SupervisorClient | None,
    temporary_output: str | None = None,
) -> None:
    try:
        batch and batch.close(finalize_active_episodes=True)
    except Exception:
        pass
    finally:
        try:
            client and client.close()
        except Exception:
            pass
        finally:
            if temporary_output:
                shutil.rmtree(temporary_output, ignore_errors=True)


def resolve_session_paths(
    *,
    output_dir: str | Path | None,
    target: str | None,
    launch: SupervisorLaunch | None,
    artifact_policy: ArtifactPolicy | None,
) -> tuple[Path | str, str | None, SupervisorLaunch | None, ArtifactPolicy, str | None]:
    """Fill the optional output directory and owned-supervisor defaults."""
    temporary_output = None
    if output_dir is None:
        temporary_output = tempfile.mkdtemp(prefix="cev-sim-output-")
        output_dir = temporary_output
        if artifact_policy is None:
            artifact_policy = ArtifactPolicy(profile="disabled")
    if target is None and launch is None:
        launch = SupervisorLaunch()
    return output_dir, target, launch, artifact_policy or ArtifactPolicy(), temporary_output


class CevSimEnv(gym.Env[dict[str, np.ndarray[Any, Any]], np.ndarray[Any, Any]]):
    """One Gymnasium environment backed by a protocol 1.2–1.5 supervisor batch."""

    metadata = {"render_modes": ["human", "rgb_array"]}

    def __init__(
        self,
        bundle: BundleInput,
        *,
        output_dir: str | Path | None = None,
        target: str | None = None,
        launch: SupervisorLaunch | None = None,
        render_mode: str | None = None,
        episode: EpisodeConfig | None = None,
        resource_limits: ResourceLimits | None = None,
        artifact_policy: ArtifactPolicy | None = None,
        rpc_timeout_s: float = 30.0,
        max_message_bytes: int = 64 * 1024 * 1024,
    ) -> None:
        super().__init__()
        if render_mode not in {None, "human", "rgb_array"}:
            raise CevSimConfigurationError("render_mode must be human, rgb_array, or omitted")
        self.render_mode = render_mode
        self.bundle = bundle
        self._overlay_path: Any = None
        self._last_observation: dict[str, np.ndarray[Any, Any]] | None = None
        self._viewer: Any = None
        self._client: SupervisorClient | None = None
        self._batch: CevSimBatch | None = None
        self._closed = False
        self._temporary_output: str | None = None
        self._finalizer: weakref.finalize | None = None
        output_dir, target, launch, artifact_policy, self._temporary_output = resolve_session_paths(
            output_dir=output_dir,
            target=target,
            launch=launch,
            artifact_policy=artifact_policy,
        )
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
                artifact_policy=artifact_policy,
            )
            self.action_space = self._batch.action_space
            self.observation_space = self._batch.observation_space
            self._finalizer = weakref.finalize(
                self, _finalize_resources, self._batch, self._client, self._temporary_output
            )
        except Exception:
            _finalize_resources(self._batch, self._client, self._temporary_output)
            self._temporary_output = None
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
        overrides = normalize_reset_options(options)
        if seed is not None and (type(seed) is not int or not 0 <= seed <= 0xFFFF_FFFF_FFFF_FFFF):
            raise CevSimConfigurationError("Gymnasium reset seed must be a uint64")
        super().reset(seed=seed)
        reset_seed = self._reset_seed(seed)
        try:
            if self._batch.states[0] in {"ready", "terminal"}:
                self._batch.finalize([0])
            observation, info = self._batch.reset([0], [reset_seed], None if overrides is None else [overrides])[0]
            self._remember(observation)
            return observation, info
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
            observation, reward, terminated, truncated, info = self._batch.step([action])[0]
            self._remember(observation)
            return observation, reward, terminated, truncated, info
        except _PROTOCOL_FAILURES:
            self._close_after_failure()
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        batch, client = self._batch, self._client
        temporary_output = self._temporary_output
        self._batch = None
        self._client = None
        self._temporary_output = None
        try:
            try:
                batch and batch.close(finalize_active_episodes=True)
            finally:
                client and client.close()
        finally:
            if self._viewer is not None:
                closer = getattr(self._viewer, "close", None)
                if closer is not None:
                    closer()
                self._viewer = None
            if temporary_output:
                shutil.rmtree(temporary_output, ignore_errors=True)
            if self._finalizer is not None:
                self._finalizer.detach()
                self._finalizer = None

    def _close_after_failure(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def set_overlay(self, path: Any) -> None:
        """Store a planned path, as an (N, 2) array of (x, z) points, for render()."""
        self._overlay_path = None if path is None else np.asarray(path, dtype=np.float64)

    def render(self) -> np.ndarray[Any, Any] | None:
        if self.render_mode is None:
            raise CevSimConfigurationError("render() requires render_mode human or rgb_array")
        from .render import PlanningRenderer

        if self._viewer is None:
            self._viewer = PlanningRenderer(self.bundle, mode=self.render_mode)
        return self._viewer.draw(self._last_observation, self._overlay_path)

    def _remember(self, observation: dict[str, np.ndarray[Any, Any]]) -> None:
        self._last_observation = observation
        if self.render_mode == "human":
            self.render()

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
