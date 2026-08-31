from __future__ import annotations

import numpy as np
import pytest

from cev_sim import CevSimCompatibilityError, CevSimEnvironmentError, CevSimSupervisorError
from cev_sim.bundle import LoadedBundle
from cev_sim.client import SupervisorClient, _decode_json, _error_from_status, _raise_status, _resolved_backends
from cev_sim.config import (
    CPU_LIDAR_CAPABILITY,
    CPU_LIDAR_KIND,
    CPU_LIDAR_VERSION,
    DEFAULT_CPU_LIDAR_BACKEND,
    MEASURED_PERCEPTION_PROFILE,
    MEASURED_PERCEPTION_PROFILE_VERSION,
    MEASURED_PERCEPTION_SCHEMA_HASH,
    MEASURED_STATE_PROFILE,
    MEASURED_STATE_PROFILE_VERSION,
    MEASURED_STATE_SCHEMA_HASH,
    PROTOCOL_MAJOR,
    PROTOCOL_MINOR,
    ROUTE_SAFETY_PROFILE,
    ROUTE_SAFETY_PROFILE_VERSION,
    ROUTE_SAFETY_SCHEMA_HASH,
    STATE_SENSOR_CAPABILITY,
    STATE_SENSOR_KIND,
    STATE_SENSOR_VERSION,
    EpisodeConfig,
)
from cev_sim.env import CevSimEnv
from cev_sim.headless.v1 import headless_pb2 as pb
from cev_sim.sb3 import CevSimVecEnv


def capabilities() -> pb.GetCapabilitiesResponse:
    return pb.GetCapabilitiesResponse(
        protocol=pb.ProtocolVersion(major=PROTOCOL_MAJOR, minor=PROTOCOL_MINOR),
        runtime_name="cev-sim",
        runtime_version="0.1.0",
        transports=["unix", "tcp-insecure", "grpc+unix+shared-memory-v1"],
        observation_profiles=[
            pb.ProfileCapability(
                id=MEASURED_STATE_PROFILE,
                version=MEASURED_STATE_PROFILE_VERSION,
                config_schema_hash=MEASURED_STATE_SCHEMA_HASH,
            ),
            pb.ProfileCapability(
                id=MEASURED_PERCEPTION_PROFILE,
                version=MEASURED_PERCEPTION_PROFILE_VERSION,
                config_schema_hash=MEASURED_PERCEPTION_SCHEMA_HASH,
            ),
        ],
        reward_profiles=[
            pb.ProfileCapability(
                id=ROUTE_SAFETY_PROFILE,
                version=ROUTE_SAFETY_PROFILE_VERSION,
                config_schema_hash=ROUTE_SAFETY_SCHEMA_HASH,
            )
        ],
        backends=[
            pb.BackendCapability(
                id=STATE_SENSOR_CAPABILITY,
                version=STATE_SENSOR_VERSION,
                kind=STATE_SENSOR_KIND,
                available=True,
            ),
            pb.BackendCapability(
                id=CPU_LIDAR_CAPABILITY,
                version=CPU_LIDAR_VERSION,
                kind=CPU_LIDAR_KIND,
                available=True,
            ),
        ],
    )


def test_response_and_environment_errors_are_distinct_and_typed() -> None:
    envelope = pb.ErrorStatus(code=pb.ERROR_CODE_INTERNAL, message="envelope")
    with pytest.raises(CevSimSupervisorError) as raised:
        _raise_status(envelope)
    assert type(raised.value) is CevSimSupervisorError

    result = pb.ErrorStatus(
        code=pb.ERROR_CODE_WORKER_CRASHED,
        message="worker",
        retryable=True,
        canonical_detail_json=b'{"signal":"SIGKILL"}',
    )
    error = _error_from_status(result, environment_index=3)
    assert isinstance(error, CevSimEnvironmentError)
    assert error.environment_index == 3
    assert error.retryable is True
    assert error.details == {"signal": "SIGKILL"}

    incompatible = pb.ErrorStatus(code=pb.ERROR_CODE_PROTOCOL_MISMATCH, message="protocol")
    with pytest.raises(CevSimCompatibilityError, match="protocol"):
        _raise_status(incompatible)


def test_malformed_error_json_is_a_compatibility_failure() -> None:
    with pytest.raises(CevSimCompatibilityError, match="invalid diagnostic"):
        _decode_json(b"not-json", "diagnostic")


def test_capability_negotiation_checks_transport_profiles_and_backend() -> None:
    client = object.__new__(SupervisorClient)
    client.target = "unix:/tmp/cev-sim.sock"
    client._validate_capabilities(capabilities())

    incompatible = capabilities()
    incompatible.observation_profiles[0].config_schema_hash = "wrong"
    with pytest.raises(CevSimCompatibilityError, match="measured-state"):
        client._validate_capabilities(incompatible)

    incompatible = capabilities()
    incompatible.ClearField("transports")
    with pytest.raises(CevSimCompatibilityError, match="transport"):
        client._validate_capabilities(incompatible)

    incompatible = capabilities()
    incompatible.backends[0].available = False
    incompatible.backends[0].unavailable_reason = "disabled"
    with pytest.raises(CevSimCompatibilityError, match="disabled"):
        client._validate_capabilities(incompatible)


def test_lidar_bundles_auto_select_the_locked_cpu_backend() -> None:
    bundle = LoadedBundle(
        document={
            "resolved": {
                "backendSelections": [
                    {
                        "kind": 1,
                        "capabilityId": "physics",
                        "version": "1",
                        "configHash": "0" * 64,
                    }
                ],
                "manifest": {"sensorRig": {"sensors": [{"id": "lidar", "type": "lidar3d", "enabled": True}]}},
            }
        },
        canonical_json=b"{}",
        bundle_id="1" * 64,
        resolved_hash="1" * 64,
        simulation_semantic_hash="2" * 64,
    )
    backends = _resolved_backends(bundle, EpisodeConfig())
    assert DEFAULT_CPU_LIDAR_BACKEND in backends
    assert [entry.kind for entry in backends] == [1, STATE_SENSOR_KIND, CPU_LIDAR_KIND]


def test_unseeded_seed_streams_are_reproducible() -> None:
    env = object.__new__(CevSimEnv)
    env._np_random = np.random.default_rng(91)
    first = [env._reset_seed(None) for _ in range(3)]
    env._np_random = np.random.default_rng(91)
    assert [env._reset_seed(None) for _ in range(3)] == first
    assert env._reset_seed(2**64 - 1) == 2**64 - 1

    vector = object.__new__(CevSimVecEnv)
    vector._rngs = [np.random.default_rng(7), np.random.default_rng(8)]
    sequence = [vector._next_seed(0), vector._next_seed(1)]
    vector._rngs = [np.random.default_rng(7), np.random.default_rng(8)]
    assert [vector._next_seed(0), vector._next_seed(1)] == sequence
