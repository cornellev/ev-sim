from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .errors import CevSimConfigurationError

PROTOCOL_MAJOR = 1
PROTOCOL_MINOR = 1

MEASURED_STATE_PROFILE = "measured-state"
MEASURED_STATE_PROFILE_VERSION = 1
MEASURED_STATE_CONFIG_HASH = "5c81866540bbdf0031f6c700554d65c7becc6fe76b5abaa5e81a20f14aa99e6d"
MEASURED_STATE_SCHEMA_HASH = "f1e342c273110d10b905550cc2f0f42cd5a0a7fc46d9e468edf9602fafd3e128"

ROUTE_SAFETY_PROFILE = "route-safety"
ROUTE_SAFETY_PROFILE_VERSION = 1
ROUTE_SAFETY_CONFIG_HASH = "29dd55136f4207d78b8c3e9d4202f33849f12d9b415c7ed17fff641ee876b1f4"
ROUTE_SAFETY_SCHEMA_HASH = "214ad749f21030998ca0da8b02a123f8e70893c4602929be3f2448e4c7fce9b7"

STATE_SENSOR_KIND = 2
STATE_SENSOR_CAPABILITY = "deterministic-state-sensors"
STATE_SENSOR_VERSION = "1"
STATE_SENSOR_CONFIG_HASH = "dc27525458e0f720321213cd0a1abac8842266ae86f3d82172d8cda518924cf5"

_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


def _validate_sha256(value: str, label: str) -> None:
    if not isinstance(value, str) or _SHA256_PATTERN.fullmatch(value) is None:
        raise CevSimConfigurationError(f"{label} must be a lowercase SHA-256 hex digest")


@dataclass(frozen=True)
class ProfileRef:
    id: str
    version: int
    config_hash: str

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not self.id or type(self.version) is not int or self.version <= 0:
            raise CevSimConfigurationError("ProfileRef requires a non-empty id and positive version")
        _validate_sha256(self.config_hash, "ProfileRef.config_hash")


@dataclass(frozen=True)
class BackendSelection:
    kind: int
    capability_id: str
    version: str
    config_hash: str

    def __post_init__(self) -> None:
        if type(self.kind) is not int or self.kind <= 0:
            raise CevSimConfigurationError("BackendSelection.kind must be a positive integer")
        if (
            not isinstance(self.capability_id, str)
            or not self.capability_id
            or not isinstance(self.version, str)
            or not self.version
        ):
            raise CevSimConfigurationError("BackendSelection requires a capability_id and version")
        _validate_sha256(self.config_hash, "BackendSelection.config_hash")


DEFAULT_OBSERVATION_PROFILE = ProfileRef(
    MEASURED_STATE_PROFILE,
    MEASURED_STATE_PROFILE_VERSION,
    MEASURED_STATE_CONFIG_HASH,
)
DEFAULT_REWARD_PROFILE = ProfileRef(
    ROUTE_SAFETY_PROFILE,
    ROUTE_SAFETY_PROFILE_VERSION,
    ROUTE_SAFETY_CONFIG_HASH,
)
DEFAULT_STATE_SENSOR_BACKEND = BackendSelection(
    STATE_SENSOR_KIND,
    STATE_SENSOR_CAPABILITY,
    STATE_SENSOR_VERSION,
    STATE_SENSOR_CONFIG_HASH,
)


@dataclass(frozen=True)
class EpisodeConfig:
    action_repeat: int = 1
    max_episode_steps: int = 0
    observation_profile: ProfileRef = DEFAULT_OBSERVATION_PROFILE
    reward_profile: ProfileRef = DEFAULT_REWARD_PROFILE
    backend_selections: tuple[BackendSelection, ...] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.observation_profile, ProfileRef) or not isinstance(self.reward_profile, ProfileRef):
            raise CevSimConfigurationError("observation_profile and reward_profile must be ProfileRef values")
        if type(self.action_repeat) is not int or not 1 <= self.action_repeat <= 0xFFFF_FFFF:
            raise CevSimConfigurationError("action_repeat must be within [1, 2^32-1]")
        if type(self.max_episode_steps) is not int or not 0 <= self.max_episode_steps <= 0xFFFF_FFFF_FFFF_FFFF:
            raise CevSimConfigurationError("max_episode_steps must be a uint64")
        if self.backend_selections is not None and not isinstance(self.backend_selections, tuple):
            raise CevSimConfigurationError("backend_selections must be a tuple when supplied")
        if self.backend_selections is not None and not all(
            isinstance(selection, BackendSelection) for selection in self.backend_selections
        ):
            raise CevSimConfigurationError("backend_selections entries must be BackendSelection values")


@dataclass(frozen=True)
class ArtifactPolicy:
    profile: Literal["evaluation", "training", "disabled"] = "training"
    full_sflog_sample_rate: float = 0.0
    full_sflog_on_failure: bool = True

    def __post_init__(self) -> None:
        if self.profile not in {"evaluation", "training", "disabled"}:
            raise CevSimConfigurationError("ArtifactPolicy.profile must be evaluation, training, or disabled")
        if not isinstance(self.full_sflog_on_failure, bool):
            raise CevSimConfigurationError("full_sflog_on_failure must be a boolean")
        if (
            isinstance(self.full_sflog_sample_rate, bool)
            or not isinstance(self.full_sflog_sample_rate, (int, float))
            or not math.isfinite(self.full_sflog_sample_rate)
            or not 0.0 <= self.full_sflog_sample_rate <= 1.0
        ):
            raise CevSimConfigurationError("full_sflog_sample_rate must be within [0, 1]")


@dataclass(frozen=True)
class ResourceLimits:
    max_rss_bytes_per_environment: int = 0
    max_heap_bytes_per_environment: int = 0
    max_actors_per_environment: int = 0
    max_sensors_per_environment: int = 0
    max_observation_bytes: int = 0
    max_queue_bytes: int = 0
    max_artifact_bytes: int = 0
    step_wall_timeout_ms: int = 0
    episode_wall_timeout_ms: int = 0
    restart_budget: int = 0

    def __post_init__(self) -> None:
        uint32 = {"max_actors_per_environment", "max_sensors_per_environment", "restart_budget"}
        for name, value in vars(self).items():
            maximum = 0xFFFF_FFFF if name in uint32 else 0xFFFF_FFFF_FFFF_FFFF
            if type(value) is not int or not 0 <= value <= maximum:
                raise CevSimConfigurationError(f"{name} must fit its non-negative Protobuf integer field")


@dataclass(frozen=True)
class SupervisorLaunch:
    executable: str | Path = "cev-sim"
    config_path: str | Path | None = None
    preset: Literal["safety", "permissive"] | None = "safety"
    extra_args: tuple[str, ...] = ()
    startup_timeout_s: float = 10.0
    shutdown_grace_s: float = 7.0
    kill_grace_s: float = 5.0

    def __post_init__(self) -> None:
        if not str(self.executable):
            raise CevSimConfigurationError("SupervisorLaunch.executable is required")
        if self.preset not in {"safety", "permissive", None}:
            raise CevSimConfigurationError("SupervisorLaunch.preset must be safety, permissive, or None")
        timeouts = (self.startup_timeout_s, self.shutdown_grace_s, self.kill_grace_s)
        if any(
            isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
            for value in timeouts
        ):
            raise CevSimConfigurationError("Supervisor launch timeouts must be finite numbers")
        if self.startup_timeout_s <= 0 or self.shutdown_grace_s < 0 or self.kill_grace_s < 0:
            raise CevSimConfigurationError("Supervisor launch timeouts must be non-negative")
        forbidden = {"--socket", "--tcp", "--config", "--preset"}
        if not isinstance(self.extra_args, tuple) or any(
            not isinstance(argument, str) or not argument for argument in self.extra_args
        ):
            raise CevSimConfigurationError("SupervisorLaunch.extra_args must contain non-empty strings")
        if any(argument.split("=", 1)[0] in forbidden for argument in self.extra_args):
            raise CevSimConfigurationError(
                "Transport, config, and preset options have dedicated SupervisorLaunch fields"
            )
