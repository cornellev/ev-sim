from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import grpc

from .bundle import BundleInput, LoadedBundle, load_bundle
from .config import (
    CPU_LIDAR_KIND,
    DEFAULT_CPU_LIDAR_BACKEND,
    DEFAULT_GPU_SENSOR_BACKEND,
    DEFAULT_STATE_SENSOR_BACKEND,
    GPU_SENSOR_KIND,
    MEASURED_PERCEPTION_PROFILE,
    MEASURED_PERCEPTION_PROFILE_VERSION,
    MEASURED_PERCEPTION_SCHEMA_HASH,
    MEASURED_STATE_PROFILE,
    MEASURED_STATE_PROFILE_VERSION,
    MEASURED_STATE_SCHEMA_HASH,
    MIN_PROTOCOL_MINOR,
    PROTOCOL_MAJOR,
    PROTOCOL_MINOR,
    ROUTE_SAFETY_PROFILE,
    ROUTE_SAFETY_PROFILE_VERSION,
    ROUTE_SAFETY_SCHEMA_HASH,
    STATE_SENSOR_CAPABILITY,
    STATE_SENSOR_KIND,
    STATE_SENSOR_VERSION,
    ArtifactPolicy,
    BackendSelection,
    EpisodeConfig,
    ProfileRef,
    ResourceLimits,
    SupervisorLaunch,
)
from .errors import (
    CevSimCompatibilityError,
    CevSimConfigurationError,
    CevSimEnvironmentError,
    CevSimSupervisorError,
    CevSimTransportError,
)
from .headless.v1 import headless_pb2 as pb
from .headless.v1 import headless_pb2_grpc as pb_grpc
from .process import OwnedSupervisor
from .tensors import TensorMapCodec

_ARTIFACT_PROFILES = {"evaluation": 1, "training": 2, "disabled": 3}
_REQUIRES_RESET_CODES = {
    pb.ERROR_CODE_RESOURCE_LIMIT,
    pb.ERROR_CODE_STEP_TIMEOUT,
    pb.ERROR_CODE_WORKER_CRASHED,
}
_COMPATIBILITY_CODES = {
    pb.ERROR_CODE_PROTOCOL_MISMATCH,
    pb.ERROR_CODE_INCOMPATIBLE_SPACE,
    pb.ERROR_CODE_UNSUPPORTED_CAPABILITY,
}


def _decode_json(value: bytes, label: str) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise CevSimCompatibilityError(f"Supervisor returned invalid {label}: {error}") from error


def _error_from_status(status: pb.ErrorStatus, *, environment_index: int | None = None) -> CevSimSupervisorError:
    error_type = CevSimSupervisorError if environment_index is None else CevSimEnvironmentError
    return error_type(
        status.code,
        status.message or "unspecified supervisor failure",
        retryable=status.retryable,
        details=_decode_json(status.canonical_detail_json, "ErrorStatus.canonical_detail_json"),
        environment_index=environment_index,
    )


def _raise_status(status: pb.ErrorStatus, *, environment_index: int | None = None) -> None:
    if status.code != pb.ERROR_CODE_OK:
        if environment_index is None and status.code in _COMPATIBILITY_CODES:
            raise CevSimCompatibilityError(status.message or f"Supervisor compatibility error {status.code}")
        raise _error_from_status(status, environment_index=environment_index)


def _enum_name(wrapper: Any, value: int, prefix: str) -> str:
    try:
        name = wrapper.Name(value)
    except ValueError:
        return f"unknown_{value}"
    return name.removeprefix(prefix).lower()


def _profile_message(profile: ProfileRef) -> pb.ProfileRef:
    return pb.ProfileRef(id=profile.id, version=profile.version, config_hash=profile.config_hash)


def _backend_message(backend: BackendSelection) -> pb.BackendSelection:
    return pb.BackendSelection(
        kind=backend.kind,
        capability_id=backend.capability_id,
        version=backend.version,
        config_hash=backend.config_hash,
    )


def _resource_message(limits: ResourceLimits) -> pb.ResourceLimits:
    return pb.ResourceLimits(**vars(limits))


def _artifact_message(policy: ArtifactPolicy, output_directory: Path) -> pb.ArtifactPolicy:
    return pb.ArtifactPolicy(
        profile=_ARTIFACT_PROFILES[policy.profile],
        output_uri=str(output_directory),
        full_sflog_sample_rate=policy.full_sflog_sample_rate,
        full_sflog_on_failure=policy.full_sflog_on_failure,
    )


def _resolved_backends(bundle: LoadedBundle, configuration: EpisodeConfig) -> tuple[BackendSelection, ...]:
    if configuration.backend_selections is not None:
        backends = list(configuration.backend_selections)
    else:
        resolved = bundle.document.get("resolved")
        if not isinstance(resolved, Mapping):
            raise CevSimConfigurationError("Run bundle resolved value must be an object")
        entries = resolved.get("backendSelections", [])
        if not isinstance(entries, list):
            raise CevSimConfigurationError("Run bundle resolved.backendSelections must be an array")
        backends = []
        for entry in entries:
            if not isinstance(entry, Mapping):
                raise CevSimConfigurationError("Run bundle backend selections must be objects")
            try:
                backends.append(
                    BackendSelection(
                        kind=int(entry.get("kind", 0)),
                        capability_id=str(entry.get("capabilityId", entry.get("capability_id", ""))),
                        version=str(entry.get("version", "")),
                        config_hash=str(entry.get("configHash", entry.get("config_hash", ""))),
                    )
                )
            except (TypeError, ValueError) as error:
                raise CevSimConfigurationError(f"Invalid run-bundle backend selection: {error}") from error
        if not any(entry.kind == STATE_SENSOR_KIND for entry in backends):
            backends.append(DEFAULT_STATE_SENSOR_BACKEND)
        manifest = resolved.get("manifest")
        sensor_rig = manifest.get("sensorRig", {}) if isinstance(manifest, Mapping) else {}
        sensors = sensor_rig.get("sensors", []) if isinstance(sensor_rig, Mapping) else []
        requests_lidar = isinstance(sensors, list) and any(
            isinstance(sensor, Mapping) and sensor.get("enabled", True) is not False and sensor.get("type") == "lidar3d"
            for sensor in sensors
        )
        if requests_lidar and not any(entry.kind == CPU_LIDAR_KIND for entry in backends):
            backends.append(DEFAULT_CPU_LIDAR_BACKEND)
        requests_camera = isinstance(sensors, list) and any(
            isinstance(sensor, Mapping) and sensor.get("enabled", True) is not False and sensor.get("type") == "camera"
            for sensor in sensors
        )
        if requests_camera and not any(entry.kind == GPU_SENSOR_KIND for entry in backends):
            backends.append(DEFAULT_GPU_SENSOR_BACKEND)
    backends.sort(key=lambda entry: (entry.kind, entry.capability_id.encode("utf-8")))
    return tuple(backends)


class SupervisorClient:
    """Synchronous protocol 1.2/1.3 connection with optional process ownership."""

    def __init__(
        self,
        *,
        target: str | None = None,
        launch: SupervisorLaunch | None = None,
        rpc_timeout_s: float = 30.0,
        max_message_bytes: int = 64 * 1024 * 1024,
    ) -> None:
        if (target is None) == (launch is None):
            raise CevSimConfigurationError("Exactly one of target or launch must be supplied")
        if (
            isinstance(rpc_timeout_s, bool)
            or not isinstance(rpc_timeout_s, (int, float))
            or not math.isfinite(rpc_timeout_s)
            or rpc_timeout_s <= 0
            or type(max_message_bytes) is not int
            or max_message_bytes <= 0
        ):
            raise CevSimConfigurationError("RPC timeout and message limit must be positive")
        self.rpc_timeout_s = float(rpc_timeout_s)
        self._owned = OwnedSupervisor(launch) if launch is not None else None
        self.target = ""
        self.channel: grpc.Channel | None = None
        self.stub: pb_grpc.HeadlessSimulationServiceStub | None = None
        self.capabilities: pb.GetCapabilitiesResponse | None = None
        self.closed = False
        self.shared_memory_transport = False
        try:
            self.target = self._owned.start() if self._owned is not None else self._validate_target(target)
            self.channel = grpc.insecure_channel(
                self.target,
                options=(
                    ("grpc.max_receive_message_length", max_message_bytes),
                    ("grpc.max_send_message_length", max_message_bytes),
                ),
            )
            self.stub = pb_grpc.HeadlessSimulationServiceStub(self.channel)
            try:
                grpc.channel_ready_future(self.channel).result(timeout=self.rpc_timeout_s)
            except grpc.FutureTimeoutError as error:
                raise CevSimTransportError(
                    f"Supervisor at {self.target!r} did not become ready within {self.rpc_timeout_s:g} seconds"
                ) from error
            self.capabilities = self.call(
                self.stub.GetCapabilities,
                pb.GetCapabilitiesRequest(
                    client_protocol=pb.ProtocolVersion(major=PROTOCOL_MAJOR, minor=MIN_PROTOCOL_MINOR)
                ),
            )
            _raise_status(self.capabilities.error)
            self._validate_capabilities(self.capabilities)
            self.protocol_minor = min(PROTOCOL_MINOR, self.capabilities.protocol.minor)
            self.shared_memory_transport = self.target.startswith("unix:") and (
                "grpc+unix+shared-memory-v1" in self.capabilities.transports
            )
        except Exception:
            self.close()
            raise

    @staticmethod
    def _validate_target(target: str | None) -> str:
        if not target or ":" not in target or target.startswith(("http://", "https://")):
            raise CevSimConfigurationError("target must be a gRPC Unix target or host:port")
        return target

    def call(self, method: Any, request: Any) -> Any:
        try:
            return method(request, timeout=self.rpc_timeout_s)
        except grpc.RpcError as error:
            code = error.code().name if error.code() is not None else "UNKNOWN"
            raise CevSimTransportError(f"gRPC {code}: {error.details() or error}") from error

    def create_batch(
        self,
        bundle_input: BundleInput,
        *,
        count: int,
        output_directory: str | Path,
        episode: EpisodeConfig,
        resource_limits: ResourceLimits,
        artifact_policy: ArtifactPolicy,
    ) -> CevSimBatch:
        bundle = load_bundle(bundle_input)
        if bundle.identity_profile and (self.protocol_minor < bundle.required_protocol_minor
                                       or bundle.identity_profile not in self.capabilities.identity_profiles):
            raise CevSimCompatibilityError("world-bound@2 requires supervisor protocol 1.3 and identity capability")
        if type(count) is not int or not 1 <= count <= 0xFFFF_FFFF:
            raise CevSimConfigurationError("Environment count must be a positive uint32")
        try:
            output = Path(output_directory).expanduser().resolve()
        except TypeError as error:
            raise CevSimConfigurationError(f"output_dir must be a filesystem path: {error}") from error
        backends = _resolved_backends(bundle, episode)
        self._validate_episode_capabilities(episode, backends)
        initial_specs = [self._episode_message(bundle, episode, backends, index, index) for index in range(count)]
        assert self.stub is not None
        response = self.call(
            self.stub.CreateBatch,
            pb.CreateBatchRequest(
                client_protocol=pb.ProtocolVersion(major=PROTOCOL_MAJOR, minor=self.protocol_minor),
                run_bundles=[
                    pb.RunBundle(
                        bundle_id=bundle.bundle_id,
                        resolved_hash=bundle.resolved_hash,
                        canonical_json=bundle.canonical_json,
                        simulation_semantic_hash=bundle.simulation_semantic_hash,
                    )
                ],
                episodes=initial_specs,
                resource_limits=_resource_message(resource_limits),
                artifact_policy=_artifact_message(artifact_policy, output),
            ),
        )
        _raise_status(response.error)
        if not response.HasField("batch") or not response.batch.batch_id:
            raise CevSimCompatibilityError("CreateBatch succeeded without a batch descriptor")
        expected_indexes = list(range(count))
        actual_indexes = [entry.environment_index for entry in response.batch.environments]
        if actual_indexes != expected_indexes:
            raise CevSimCompatibilityError(
                f"CreateBatch returned environment indexes {actual_indexes!r}, expected {expected_indexes!r}"
            )
        try:
            return CevSimBatch(
                client=self,
                bundle=bundle,
                configuration=episode,
                backends=backends,
                descriptor=response.batch,
            )
        except Exception:
            try:
                self.call(
                    self.stub.CloseBatch,
                    pb.CloseBatchRequest(batch_id=response.batch.batch_id, finalize_active_episodes=False),
                )
            except Exception:
                pass
            raise

    def _validate_capabilities(self, capabilities: pb.GetCapabilitiesResponse) -> None:
        protocol = capabilities.protocol
        if protocol.major != PROTOCOL_MAJOR or protocol.minor < MIN_PROTOCOL_MINOR:
            raise CevSimCompatibilityError(
                f"Supervisor protocol {protocol.major}.{protocol.minor} does not satisfy "
                f"{PROTOCOL_MAJOR}.{MIN_PROTOCOL_MINOR}"
            )
        if capabilities.runtime_name != "cev-sim":
            raise CevSimCompatibilityError(f"Unexpected supervisor runtime {capabilities.runtime_name!r}")
        if not capabilities.runtime_version:
            raise CevSimCompatibilityError("Supervisor did not advertise a runtime version")
        expected_transport = "unix" if self.target.startswith("unix:") else "tcp-insecure"
        if expected_transport not in capabilities.transports:
            raise CevSimCompatibilityError(f"Supervisor does not advertise the active {expected_transport} transport")
        profile_sets = (
            (
                MEASURED_STATE_PROFILE,
                MEASURED_STATE_PROFILE_VERSION,
                MEASURED_STATE_SCHEMA_HASH,
                capabilities.observation_profiles,
            ),
            (
                MEASURED_PERCEPTION_PROFILE,
                MEASURED_PERCEPTION_PROFILE_VERSION,
                MEASURED_PERCEPTION_SCHEMA_HASH,
                capabilities.observation_profiles,
            ),
            (
                ROUTE_SAFETY_PROFILE,
                ROUTE_SAFETY_PROFILE_VERSION,
                ROUTE_SAFETY_SCHEMA_HASH,
                capabilities.reward_profiles,
            ),
        )
        for profile_id, version, schema_hash, available in profile_sets:
            profile = next((entry for entry in available if entry.id == profile_id and entry.version == version), None)
            if profile is None or profile.config_schema_hash != schema_hash:
                raise CevSimCompatibilityError(f"Supervisor does not expose compatible profile {profile_id}@{version}")
        state_backend = next(
            (
                entry
                for entry in capabilities.backends
                if entry.kind == STATE_SENSOR_KIND
                and entry.id == STATE_SENSOR_CAPABILITY
                and entry.version == STATE_SENSOR_VERSION
            ),
            None,
        )
        if state_backend is None or not state_backend.available:
            reason = state_backend.unavailable_reason if state_backend else "not advertised"
            raise CevSimCompatibilityError(f"Deterministic state-sensor backend is unavailable: {reason}")

    def _validate_episode_capabilities(
        self,
        episode: EpisodeConfig,
        backends: Sequence[BackendSelection],
    ) -> None:
        assert self.capabilities is not None
        profile_sets = (
            (episode.observation_profile, self.capabilities.observation_profiles),
            (episode.reward_profile, self.capabilities.reward_profiles),
        )
        for requested, available in profile_sets:
            if not any(entry.id == requested.id and entry.version == requested.version for entry in available):
                raise CevSimCompatibilityError(f"Unsupported profile {requested.id}@{requested.version}")
        for requested in backends:
            if requested.kind == STATE_SENSOR_KIND and requested != DEFAULT_STATE_SENSOR_BACKEND:
                raise CevSimCompatibilityError("The locked deterministic state-sensor backend identity is required")
            if requested.kind == CPU_LIDAR_KIND and requested != DEFAULT_CPU_LIDAR_BACKEND:
                raise CevSimCompatibilityError("The locked deterministic CPU LiDAR backend identity is required")
            if requested.kind == GPU_SENSOR_KIND and requested != DEFAULT_GPU_SENSOR_BACKEND:
                raise CevSimCompatibilityError("The locked Chromium WebGL2 sensor backend identity is required")
            capability = next(
                (
                    entry
                    for entry in self.capabilities.backends
                    if entry.kind == requested.kind
                    and entry.id == requested.capability_id
                    and entry.version == requested.version
                ),
                None,
            )
            if capability is None or not capability.available:
                raise CevSimCompatibilityError(
                    f"Unsupported backend {requested.kind}:{requested.capability_id}@{requested.version}"
                )

    @staticmethod
    def _episode_message(
        bundle: LoadedBundle,
        configuration: EpisodeConfig,
        backends: Sequence[BackendSelection],
        index: int,
        seed: int,
    ) -> pb.EpisodeSpec:
        if not 0 <= seed <= 0xFFFF_FFFF_FFFF_FFFF:
            raise CevSimConfigurationError("Reset seed must be a uint64")
        return pb.EpisodeSpec(
            environment_index=index,
            environment_id=f"environment-{index}",
            run_bundle_id=bundle.bundle_id,
            reset_seed=seed,
            action_repeat=configuration.action_repeat,
            max_episode_steps=configuration.max_episode_steps,
            observation_profile=_profile_message(configuration.observation_profile),
            reward_profile=_profile_message(configuration.reward_profile),
            backend_selections=[_backend_message(entry) for entry in backends],
        )

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            if self.channel is not None:
                self.channel.close()
        finally:
            if self._owned is not None:
                self._owned.close()
            self.channel = None


class CevSimBatch:
    def __init__(
        self,
        *,
        client: SupervisorClient,
        bundle: LoadedBundle,
        configuration: EpisodeConfig,
        backends: tuple[BackendSelection, ...],
        descriptor: pb.BatchDescriptor,
    ) -> None:
        self.client = client
        self.bundle = bundle
        self.configuration = configuration
        self.backends = backends
        self.descriptor = descriptor
        self.batch_id = descriptor.batch_id
        self.count = len(descriptor.environments)
        action_tensor = descriptor.action_space.box.tensor
        if (
            descriptor.action_space.id != "normalized-speed-steering"
            or descriptor.action_space.version != 1
            or descriptor.action_space.WhichOneof("kind") != "box"
            or action_tensor.dtype != pb.SCALAR_TYPE_FLOAT32
            or tuple(action_tensor.shape) != (2,)
            or action_tensor.byte_order != pb.BYTE_ORDER_LITTLE_ENDIAN
            or list(descriptor.action_space.box.low) != [-1.0, -1.0]
            or list(descriptor.action_space.box.high) != [1.0, 1.0]
        ):
            raise CevSimCompatibilityError(
                "PR 8 requires the normalized-speed-steering v1 little-endian float32[2] action space"
            )
        expected_observation = configuration.observation_profile
        if (
            descriptor.observation_space.id != expected_observation.id
            or descriptor.observation_space.version != expected_observation.version
        ):
            raise CevSimCompatibilityError(
                f"Supervisor returned {descriptor.observation_space.id}@{descriptor.observation_space.version}, "
                f"expected {expected_observation.id}@{expected_observation.version}"
            )
        self.action_codec = TensorMapCodec(descriptor.action_space, root_name="action")
        self.observation_codec = TensorMapCodec(
            descriptor.observation_space,
            allow_shared_memory=client.shared_memory_transport,
        )
        self.action_space = self.action_codec.space
        self.observation_space = self.observation_codec.space
        self.states = ["prepared"] * self.count
        self.closed = False

    def episode_spec(self, index: int, seed: int) -> pb.EpisodeSpec:
        if not 0 <= index < self.count:
            raise CevSimConfigurationError(f"Unknown environment index {index}")
        return SupervisorClient._episode_message(
            self.bundle,
            self.configuration,
            self.backends,
            index,
            seed,
        )

    def reset(self, indexes: Sequence[int], seeds: Sequence[int]) -> list[tuple[Any, dict[str, Any]]]:
        normalized = list(indexes)
        if normalized != sorted(set(normalized)) or len(normalized) != len(seeds) or not normalized:
            raise CevSimConfigurationError("Reset indexes must be a non-empty sorted unique list matching seeds")
        response = self.client.call(
            self.client.stub.ResetBatch,
            pb.ResetBatchRequest(
                batch_id=self.batch_id,
                episodes=[self.episode_spec(index, int(seed)) for index, seed in zip(normalized, seeds, strict=True)],
            ),
        )
        _raise_status(response.error)
        self._validate_result_indexes(response.batch_id, response.results, normalized, "ResetBatch")
        output = []
        failures: list[CevSimSupervisorError] = []
        for result in response.results:
            if result.error.code != pb.ERROR_CODE_OK:
                self.states[result.environment_index] = "requires_reset"
                failures.append(_error_from_status(result.error, environment_index=result.environment_index))
                continue
            self.states[result.environment_index] = "ready"
            output.append(
                (
                    self.observation_codec.decode(result.observation),
                    {
                        "episode_hash": result.info.episode_hash,
                        "resolved_hash": result.info.resolved_hash,
                        "step": int(result.info.step),
                        "simulation_time_ns": int(result.info.simulation_time_ns),
                    },
                )
            )
        if failures:
            raise failures[0]
        return output

    def step(self, actions: Sequence[Any]) -> list[tuple[Any, float, bool, bool, dict[str, Any]]]:
        ready = [index for index, state in enumerate(self.states) if state == "ready"]
        if len(actions) != len(ready):
            raise CevSimConfigurationError(f"Step requires {len(ready)} actions, received {len(actions)}")
        response = self.client.call(
            self.client.stub.StepBatch,
            pb.StepBatchRequest(
                batch_id=self.batch_id,
                actions=[
                    pb.EnvironmentAction(environment_index=index, action=self.action_codec.encode(action))
                    for index, action in zip(ready, actions, strict=True)
                ],
            ),
        )
        _raise_status(response.error)
        self._validate_result_indexes(response.batch_id, response.results, ready, "StepBatch")
        output = []
        failures: list[CevSimSupervisorError] = []
        for result in response.results:
            index = result.environment_index
            if result.error.code != pb.ERROR_CODE_OK:
                self.states[index] = "requires_reset" if result.error.code in _REQUIRES_RESET_CODES else "ready"
                failures.append(_error_from_status(result.error, environment_index=index))
                continue
            terminated = bool(result.terminated)
            truncated = bool(result.truncated)
            self.states[index] = "terminal" if terminated or truncated else "ready"
            info = {
                "episode_hash": result.info.episode_hash,
                "trajectory_hash": result.info.trajectory_hash,
                "step": int(result.info.step),
                "simulation_time_ns": int(result.info.simulation_time_ns),
                "reward_terms": [
                    {
                        "id": term.id,
                        "value": term.value,
                        "weight": term.weight,
                        "weighted_value": term.weighted_value,
                    }
                    for term in result.info.reward_terms
                ],
                "termination_reason": _enum_name(
                    pb.TerminationReason,
                    result.info.termination_reason,
                    "TERMINATION_REASON_",
                ),
                "truncation_reason": _enum_name(
                    pb.TruncationReason,
                    result.info.truncation_reason,
                    "TRUNCATION_REASON_",
                ),
                "diagnostic": _decode_json(result.info.diagnostic_json, "transition diagnostic_json"),
            }
            output.append(
                (
                    self.observation_codec.decode(result.observation),
                    float(result.reward),
                    terminated,
                    truncated,
                    info,
                )
            )
        if failures:
            raise failures[0]
        return output

    def finalize(self, indexes: Sequence[int]) -> list[dict[str, Any]]:
        normalized = list(indexes)
        if normalized != sorted(set(normalized)):
            raise CevSimConfigurationError("Finalize indexes must be sorted and unique")
        if not normalized:
            return []
        response = self.client.call(
            self.client.stub.FinalizeBatch,
            pb.FinalizeBatchRequest(batch_id=self.batch_id, environment_indices=normalized),
        )
        _raise_status(response.error)
        self._validate_result_indexes(response.batch_id, response.results, normalized, "FinalizeBatch")
        finalized = []
        failures: list[CevSimSupervisorError] = []
        for result in response.results:
            if result.error.code != pb.ERROR_CODE_OK:
                failures.append(_error_from_status(result.error, environment_index=result.environment_index))
                continue
            self.states[result.environment_index] = "finalized"
            finalized.append(
                {
                    "environment_index": result.environment_index,
                    "episode_hash": result.episode_hash,
                    "trajectory_hash": result.trajectory_hash,
                    "passed": result.passed,
                    "result": _decode_json(result.canonical_result_json, "canonical_result_json"),
                    "artifacts": [
                        {
                            "name": artifact.name,
                            "uri": artifact.uri,
                            "mime_type": artifact.mime_type,
                            "size_bytes": int(artifact.size_bytes),
                            "sha256": artifact.sha256,
                        }
                        for artifact in result.artifacts
                    ],
                }
            )
        if failures:
            raise failures[0]
        return finalized

    def close(self, *, finalize_active_episodes: bool = True) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            response = self.client.call(
                self.client.stub.CloseBatch,
                pb.CloseBatchRequest(
                    batch_id=self.batch_id,
                    finalize_active_episodes=finalize_active_episodes,
                ),
            )
            _raise_status(response.error)
            for result in response.finalized:
                _raise_status(result.error, environment_index=result.environment_index)
        finally:
            self.observation_codec.close()
            self.states = ["closed"] * self.count

    def _validate_result_indexes(
        self,
        batch_id: str,
        results: Sequence[Any],
        expected: Sequence[int],
        operation: str,
    ) -> None:
        actual = [result.environment_index for result in results]
        if batch_id != self.batch_id or actual != list(expected):
            raise CevSimCompatibilityError(
                f"{operation} returned batch/indexes {(batch_id, actual)!r}, "
                f"expected {(self.batch_id, list(expected))!r}"
            )
