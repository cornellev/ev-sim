from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ScalarType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SCALAR_TYPE_UNSPECIFIED: _ClassVar[ScalarType]
    SCALAR_TYPE_FLOAT32: _ClassVar[ScalarType]
    SCALAR_TYPE_FLOAT64: _ClassVar[ScalarType]
    SCALAR_TYPE_INT8: _ClassVar[ScalarType]
    SCALAR_TYPE_UINT8: _ClassVar[ScalarType]
    SCALAR_TYPE_INT16: _ClassVar[ScalarType]
    SCALAR_TYPE_UINT16: _ClassVar[ScalarType]
    SCALAR_TYPE_INT32: _ClassVar[ScalarType]
    SCALAR_TYPE_UINT32: _ClassVar[ScalarType]
    SCALAR_TYPE_INT64: _ClassVar[ScalarType]
    SCALAR_TYPE_UINT64: _ClassVar[ScalarType]
    SCALAR_TYPE_BOOL: _ClassVar[ScalarType]

class ByteOrder(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    BYTE_ORDER_UNSPECIFIED: _ClassVar[ByteOrder]
    BYTE_ORDER_LITTLE_ENDIAN: _ClassVar[ByteOrder]
    BYTE_ORDER_BIG_ENDIAN: _ClassVar[ByteOrder]

class BackendKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    BACKEND_KIND_UNSPECIFIED: _ClassVar[BackendKind]
    BACKEND_KIND_PHYSICS: _ClassVar[BackendKind]
    BACKEND_KIND_STATE_SENSOR: _ClassVar[BackendKind]
    BACKEND_KIND_CPU_LIDAR: _ClassVar[BackendKind]
    BACKEND_KIND_GPU_SENSOR: _ClassVar[BackendKind]
    BACKEND_KIND_ARTIFACT: _ClassVar[BackendKind]

class ArtifactProfile(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ARTIFACT_PROFILE_UNSPECIFIED: _ClassVar[ArtifactProfile]
    ARTIFACT_PROFILE_EVALUATION: _ClassVar[ArtifactProfile]
    ARTIFACT_PROFILE_TRAINING: _ClassVar[ArtifactProfile]
    ARTIFACT_PROFILE_DISABLED: _ClassVar[ArtifactProfile]

class ErrorCode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ERROR_CODE_OK: _ClassVar[ErrorCode]
    ERROR_CODE_INVALID_REQUEST: _ClassVar[ErrorCode]
    ERROR_CODE_PROTOCOL_MISMATCH: _ClassVar[ErrorCode]
    ERROR_CODE_BUNDLE_INVALID: _ClassVar[ErrorCode]
    ERROR_CODE_BUNDLE_HASH_MISMATCH: _ClassVar[ErrorCode]
    ERROR_CODE_INCOMPATIBLE_SPACE: _ClassVar[ErrorCode]
    ERROR_CODE_UNSUPPORTED_CAPABILITY: _ClassVar[ErrorCode]
    ERROR_CODE_BATCH_NOT_FOUND: _ClassVar[ErrorCode]
    ERROR_CODE_ENVIRONMENT_NOT_FOUND: _ClassVar[ErrorCode]
    ERROR_CODE_EPISODE_TERMINAL: _ClassVar[ErrorCode]
    ERROR_CODE_RESOURCE_LIMIT: _ClassVar[ErrorCode]
    ERROR_CODE_STEP_TIMEOUT: _ClassVar[ErrorCode]
    ERROR_CODE_WORKER_CRASHED: _ClassVar[ErrorCode]
    ERROR_CODE_ARTIFACT_FAILURE: _ClassVar[ErrorCode]
    ERROR_CODE_INTERNAL: _ClassVar[ErrorCode]

class TerminationReason(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TERMINATION_REASON_UNSPECIFIED: _ClassVar[TerminationReason]
    TERMINATION_REASON_NONE: _ClassVar[TerminationReason]
    TERMINATION_REASON_SUCCESS: _ClassVar[TerminationReason]
    TERMINATION_REASON_COLLISION: _ClassVar[TerminationReason]
    TERMINATION_REASON_OFF_ROAD: _ClassVar[TerminationReason]
    TERMINATION_REASON_WRONG_WAY: _ClassVar[TerminationReason]
    TERMINATION_REASON_SCENARIO_FAILURE: _ClassVar[TerminationReason]
    TERMINATION_REASON_ASSERTION_FAILURE: _ClassVar[TerminationReason]

class TruncationReason(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TRUNCATION_REASON_UNSPECIFIED: _ClassVar[TruncationReason]
    TRUNCATION_REASON_NONE: _ClassVar[TruncationReason]
    TRUNCATION_REASON_MAX_EPISODE_STEPS: _ClassVar[TruncationReason]
    TRUNCATION_REASON_MAX_SIMULATION_TIME: _ClassVar[TruncationReason]
    TRUNCATION_REASON_CANCELLED: _ClassVar[TruncationReason]

class HealthState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    HEALTH_STATE_UNSPECIFIED: _ClassVar[HealthState]
    HEALTH_STATE_SERVING: _ClassVar[HealthState]
    HEALTH_STATE_DEGRADED: _ClassVar[HealthState]
    HEALTH_STATE_NOT_SERVING: _ClassVar[HealthState]
SCALAR_TYPE_UNSPECIFIED: ScalarType
SCALAR_TYPE_FLOAT32: ScalarType
SCALAR_TYPE_FLOAT64: ScalarType
SCALAR_TYPE_INT8: ScalarType
SCALAR_TYPE_UINT8: ScalarType
SCALAR_TYPE_INT16: ScalarType
SCALAR_TYPE_UINT16: ScalarType
SCALAR_TYPE_INT32: ScalarType
SCALAR_TYPE_UINT32: ScalarType
SCALAR_TYPE_INT64: ScalarType
SCALAR_TYPE_UINT64: ScalarType
SCALAR_TYPE_BOOL: ScalarType
BYTE_ORDER_UNSPECIFIED: ByteOrder
BYTE_ORDER_LITTLE_ENDIAN: ByteOrder
BYTE_ORDER_BIG_ENDIAN: ByteOrder
BACKEND_KIND_UNSPECIFIED: BackendKind
BACKEND_KIND_PHYSICS: BackendKind
BACKEND_KIND_STATE_SENSOR: BackendKind
BACKEND_KIND_CPU_LIDAR: BackendKind
BACKEND_KIND_GPU_SENSOR: BackendKind
BACKEND_KIND_ARTIFACT: BackendKind
ARTIFACT_PROFILE_UNSPECIFIED: ArtifactProfile
ARTIFACT_PROFILE_EVALUATION: ArtifactProfile
ARTIFACT_PROFILE_TRAINING: ArtifactProfile
ARTIFACT_PROFILE_DISABLED: ArtifactProfile
ERROR_CODE_OK: ErrorCode
ERROR_CODE_INVALID_REQUEST: ErrorCode
ERROR_CODE_PROTOCOL_MISMATCH: ErrorCode
ERROR_CODE_BUNDLE_INVALID: ErrorCode
ERROR_CODE_BUNDLE_HASH_MISMATCH: ErrorCode
ERROR_CODE_INCOMPATIBLE_SPACE: ErrorCode
ERROR_CODE_UNSUPPORTED_CAPABILITY: ErrorCode
ERROR_CODE_BATCH_NOT_FOUND: ErrorCode
ERROR_CODE_ENVIRONMENT_NOT_FOUND: ErrorCode
ERROR_CODE_EPISODE_TERMINAL: ErrorCode
ERROR_CODE_RESOURCE_LIMIT: ErrorCode
ERROR_CODE_STEP_TIMEOUT: ErrorCode
ERROR_CODE_WORKER_CRASHED: ErrorCode
ERROR_CODE_ARTIFACT_FAILURE: ErrorCode
ERROR_CODE_INTERNAL: ErrorCode
TERMINATION_REASON_UNSPECIFIED: TerminationReason
TERMINATION_REASON_NONE: TerminationReason
TERMINATION_REASON_SUCCESS: TerminationReason
TERMINATION_REASON_COLLISION: TerminationReason
TERMINATION_REASON_OFF_ROAD: TerminationReason
TERMINATION_REASON_WRONG_WAY: TerminationReason
TERMINATION_REASON_SCENARIO_FAILURE: TerminationReason
TERMINATION_REASON_ASSERTION_FAILURE: TerminationReason
TRUNCATION_REASON_UNSPECIFIED: TruncationReason
TRUNCATION_REASON_NONE: TruncationReason
TRUNCATION_REASON_MAX_EPISODE_STEPS: TruncationReason
TRUNCATION_REASON_MAX_SIMULATION_TIME: TruncationReason
TRUNCATION_REASON_CANCELLED: TruncationReason
HEALTH_STATE_UNSPECIFIED: HealthState
HEALTH_STATE_SERVING: HealthState
HEALTH_STATE_DEGRADED: HealthState
HEALTH_STATE_NOT_SERVING: HealthState

class ProtocolVersion(_message.Message):
    __slots__ = ("major", "minor")
    MAJOR_FIELD_NUMBER: _ClassVar[int]
    MINOR_FIELD_NUMBER: _ClassVar[int]
    major: int
    minor: int
    def __init__(self, major: _Optional[int] = ..., minor: _Optional[int] = ...) -> None: ...

class GetCapabilitiesRequest(_message.Message):
    __slots__ = ("client_protocol",)
    CLIENT_PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    client_protocol: ProtocolVersion
    def __init__(self, client_protocol: _Optional[_Union[ProtocolVersion, _Mapping]] = ...) -> None: ...

class ProfileCapability(_message.Message):
    __slots__ = ("id", "version", "description", "config_schema_hash")
    ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    CONFIG_SCHEMA_HASH_FIELD_NUMBER: _ClassVar[int]
    id: str
    version: int
    description: str
    config_schema_hash: str
    def __init__(self, id: _Optional[str] = ..., version: _Optional[int] = ..., description: _Optional[str] = ..., config_schema_hash: _Optional[str] = ...) -> None: ...

class BackendCapability(_message.Message):
    __slots__ = ("id", "version", "kind", "description", "sensor_types", "features", "available", "unavailable_reason", "determinism_scope")
    ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    SENSOR_TYPES_FIELD_NUMBER: _ClassVar[int]
    FEATURES_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_FIELD_NUMBER: _ClassVar[int]
    UNAVAILABLE_REASON_FIELD_NUMBER: _ClassVar[int]
    DETERMINISM_SCOPE_FIELD_NUMBER: _ClassVar[int]
    id: str
    version: str
    kind: BackendKind
    description: str
    sensor_types: _containers.RepeatedScalarFieldContainer[str]
    features: _containers.RepeatedScalarFieldContainer[str]
    available: bool
    unavailable_reason: str
    determinism_scope: str
    def __init__(self, id: _Optional[str] = ..., version: _Optional[str] = ..., kind: _Optional[_Union[BackendKind, str]] = ..., description: _Optional[str] = ..., sensor_types: _Optional[_Iterable[str]] = ..., features: _Optional[_Iterable[str]] = ..., available: _Optional[bool] = ..., unavailable_reason: _Optional[str] = ..., determinism_scope: _Optional[str] = ...) -> None: ...

class GetCapabilitiesResponse(_message.Message):
    __slots__ = ("protocol", "runtime_name", "runtime_version", "platform", "architecture", "backends", "observation_profiles", "reward_profiles", "transports", "error", "diagnostic_json", "identity_profiles", "asset_admission_profiles")
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_NAME_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_VERSION_FIELD_NUMBER: _ClassVar[int]
    PLATFORM_FIELD_NUMBER: _ClassVar[int]
    ARCHITECTURE_FIELD_NUMBER: _ClassVar[int]
    BACKENDS_FIELD_NUMBER: _ClassVar[int]
    OBSERVATION_PROFILES_FIELD_NUMBER: _ClassVar[int]
    REWARD_PROFILES_FIELD_NUMBER: _ClassVar[int]
    TRANSPORTS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DIAGNOSTIC_JSON_FIELD_NUMBER: _ClassVar[int]
    IDENTITY_PROFILES_FIELD_NUMBER: _ClassVar[int]
    ASSET_ADMISSION_PROFILES_FIELD_NUMBER: _ClassVar[int]
    protocol: ProtocolVersion
    runtime_name: str
    runtime_version: str
    platform: str
    architecture: str
    backends: _containers.RepeatedCompositeFieldContainer[BackendCapability]
    observation_profiles: _containers.RepeatedCompositeFieldContainer[ProfileCapability]
    reward_profiles: _containers.RepeatedCompositeFieldContainer[ProfileCapability]
    transports: _containers.RepeatedScalarFieldContainer[str]
    error: ErrorStatus
    diagnostic_json: bytes
    identity_profiles: _containers.RepeatedScalarFieldContainer[str]
    asset_admission_profiles: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, protocol: _Optional[_Union[ProtocolVersion, _Mapping]] = ..., runtime_name: _Optional[str] = ..., runtime_version: _Optional[str] = ..., platform: _Optional[str] = ..., architecture: _Optional[str] = ..., backends: _Optional[_Iterable[_Union[BackendCapability, _Mapping]]] = ..., observation_profiles: _Optional[_Iterable[_Union[ProfileCapability, _Mapping]]] = ..., reward_profiles: _Optional[_Iterable[_Union[ProfileCapability, _Mapping]]] = ..., transports: _Optional[_Iterable[str]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ..., diagnostic_json: _Optional[bytes] = ..., identity_profiles: _Optional[_Iterable[str]] = ..., asset_admission_profiles: _Optional[_Iterable[str]] = ...) -> None: ...

class AssetAdmissionRef(_message.Message):
    __slots__ = ("handle", "bundle_bytes_hash")
    HANDLE_FIELD_NUMBER: _ClassVar[int]
    BUNDLE_BYTES_HASH_FIELD_NUMBER: _ClassVar[int]
    handle: str
    bundle_bytes_hash: str
    def __init__(self, handle: _Optional[str] = ..., bundle_bytes_hash: _Optional[str] = ...) -> None: ...

class RunBundle(_message.Message):
    __slots__ = ("bundle_id", "resolved_hash", "canonical_json", "simulation_semantic_hash", "asset_admission")
    BUNDLE_ID_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_HASH_FIELD_NUMBER: _ClassVar[int]
    CANONICAL_JSON_FIELD_NUMBER: _ClassVar[int]
    SIMULATION_SEMANTIC_HASH_FIELD_NUMBER: _ClassVar[int]
    ASSET_ADMISSION_FIELD_NUMBER: _ClassVar[int]
    bundle_id: str
    resolved_hash: str
    canonical_json: bytes
    simulation_semantic_hash: str
    asset_admission: AssetAdmissionRef
    def __init__(self, bundle_id: _Optional[str] = ..., resolved_hash: _Optional[str] = ..., canonical_json: _Optional[bytes] = ..., simulation_semantic_hash: _Optional[str] = ..., asset_admission: _Optional[_Union[AssetAdmissionRef, _Mapping]] = ...) -> None: ...

class AdmitRunPackageRequest(_message.Message):
    __slots__ = ("client_protocol", "staging_id", "archive_hash")
    CLIENT_PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    STAGING_ID_FIELD_NUMBER: _ClassVar[int]
    ARCHIVE_HASH_FIELD_NUMBER: _ClassVar[int]
    client_protocol: ProtocolVersion
    staging_id: str
    archive_hash: str
    def __init__(self, client_protocol: _Optional[_Union[ProtocolVersion, _Mapping]] = ..., staging_id: _Optional[str] = ..., archive_hash: _Optional[str] = ...) -> None: ...

class AdmitRunPackageResponse(_message.Message):
    __slots__ = ("admission", "error")
    ADMISSION_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    admission: AssetAdmissionRef
    error: ErrorStatus
    def __init__(self, admission: _Optional[_Union[AssetAdmissionRef, _Mapping]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class ReleaseAssetAdmissionRequest(_message.Message):
    __slots__ = ("handle",)
    HANDLE_FIELD_NUMBER: _ClassVar[int]
    handle: str
    def __init__(self, handle: _Optional[str] = ...) -> None: ...

class ReleaseAssetAdmissionResponse(_message.Message):
    __slots__ = ("error",)
    ERROR_FIELD_NUMBER: _ClassVar[int]
    error: ErrorStatus
    def __init__(self, error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class ProfileRef(_message.Message):
    __slots__ = ("id", "version", "config_hash")
    ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    CONFIG_HASH_FIELD_NUMBER: _ClassVar[int]
    id: str
    version: int
    config_hash: str
    def __init__(self, id: _Optional[str] = ..., version: _Optional[int] = ..., config_hash: _Optional[str] = ...) -> None: ...

class BackendSelection(_message.Message):
    __slots__ = ("kind", "capability_id", "version", "config_hash")
    KIND_FIELD_NUMBER: _ClassVar[int]
    CAPABILITY_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    CONFIG_HASH_FIELD_NUMBER: _ClassVar[int]
    kind: BackendKind
    capability_id: str
    version: str
    config_hash: str
    def __init__(self, kind: _Optional[_Union[BackendKind, str]] = ..., capability_id: _Optional[str] = ..., version: _Optional[str] = ..., config_hash: _Optional[str] = ...) -> None: ...

class EpisodeSpec(_message.Message):
    __slots__ = ("environment_index", "environment_id", "run_bundle_id", "reset_seed", "action_repeat", "max_episode_steps", "observation_profile", "reward_profile", "backend_selections")
    ENVIRONMENT_INDEX_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENT_ID_FIELD_NUMBER: _ClassVar[int]
    RUN_BUNDLE_ID_FIELD_NUMBER: _ClassVar[int]
    RESET_SEED_FIELD_NUMBER: _ClassVar[int]
    ACTION_REPEAT_FIELD_NUMBER: _ClassVar[int]
    MAX_EPISODE_STEPS_FIELD_NUMBER: _ClassVar[int]
    OBSERVATION_PROFILE_FIELD_NUMBER: _ClassVar[int]
    REWARD_PROFILE_FIELD_NUMBER: _ClassVar[int]
    BACKEND_SELECTIONS_FIELD_NUMBER: _ClassVar[int]
    environment_index: int
    environment_id: str
    run_bundle_id: str
    reset_seed: int
    action_repeat: int
    max_episode_steps: int
    observation_profile: ProfileRef
    reward_profile: ProfileRef
    backend_selections: _containers.RepeatedCompositeFieldContainer[BackendSelection]
    def __init__(self, environment_index: _Optional[int] = ..., environment_id: _Optional[str] = ..., run_bundle_id: _Optional[str] = ..., reset_seed: _Optional[int] = ..., action_repeat: _Optional[int] = ..., max_episode_steps: _Optional[int] = ..., observation_profile: _Optional[_Union[ProfileRef, _Mapping]] = ..., reward_profile: _Optional[_Union[ProfileRef, _Mapping]] = ..., backend_selections: _Optional[_Iterable[_Union[BackendSelection, _Mapping]]] = ...) -> None: ...

class ResourceLimits(_message.Message):
    __slots__ = ("max_rss_bytes_per_environment", "max_heap_bytes_per_environment", "max_actors_per_environment", "max_sensors_per_environment", "max_observation_bytes", "max_queue_bytes", "max_artifact_bytes", "step_wall_timeout_ms", "episode_wall_timeout_ms", "restart_budget", "max_shared_memory_bytes_per_environment", "max_gpu_bytes_per_environment")
    MAX_RSS_BYTES_PER_ENVIRONMENT_FIELD_NUMBER: _ClassVar[int]
    MAX_HEAP_BYTES_PER_ENVIRONMENT_FIELD_NUMBER: _ClassVar[int]
    MAX_ACTORS_PER_ENVIRONMENT_FIELD_NUMBER: _ClassVar[int]
    MAX_SENSORS_PER_ENVIRONMENT_FIELD_NUMBER: _ClassVar[int]
    MAX_OBSERVATION_BYTES_FIELD_NUMBER: _ClassVar[int]
    MAX_QUEUE_BYTES_FIELD_NUMBER: _ClassVar[int]
    MAX_ARTIFACT_BYTES_FIELD_NUMBER: _ClassVar[int]
    STEP_WALL_TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    EPISODE_WALL_TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    RESTART_BUDGET_FIELD_NUMBER: _ClassVar[int]
    MAX_SHARED_MEMORY_BYTES_PER_ENVIRONMENT_FIELD_NUMBER: _ClassVar[int]
    MAX_GPU_BYTES_PER_ENVIRONMENT_FIELD_NUMBER: _ClassVar[int]
    max_rss_bytes_per_environment: int
    max_heap_bytes_per_environment: int
    max_actors_per_environment: int
    max_sensors_per_environment: int
    max_observation_bytes: int
    max_queue_bytes: int
    max_artifact_bytes: int
    step_wall_timeout_ms: int
    episode_wall_timeout_ms: int
    restart_budget: int
    max_shared_memory_bytes_per_environment: int
    max_gpu_bytes_per_environment: int
    def __init__(self, max_rss_bytes_per_environment: _Optional[int] = ..., max_heap_bytes_per_environment: _Optional[int] = ..., max_actors_per_environment: _Optional[int] = ..., max_sensors_per_environment: _Optional[int] = ..., max_observation_bytes: _Optional[int] = ..., max_queue_bytes: _Optional[int] = ..., max_artifact_bytes: _Optional[int] = ..., step_wall_timeout_ms: _Optional[int] = ..., episode_wall_timeout_ms: _Optional[int] = ..., restart_budget: _Optional[int] = ..., max_shared_memory_bytes_per_environment: _Optional[int] = ..., max_gpu_bytes_per_environment: _Optional[int] = ...) -> None: ...

class ArtifactPolicy(_message.Message):
    __slots__ = ("profile", "output_uri", "full_sflog_sample_rate", "full_sflog_on_failure")
    PROFILE_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_URI_FIELD_NUMBER: _ClassVar[int]
    FULL_SFLOG_SAMPLE_RATE_FIELD_NUMBER: _ClassVar[int]
    FULL_SFLOG_ON_FAILURE_FIELD_NUMBER: _ClassVar[int]
    profile: ArtifactProfile
    output_uri: str
    full_sflog_sample_rate: float
    full_sflog_on_failure: bool
    def __init__(self, profile: _Optional[_Union[ArtifactProfile, str]] = ..., output_uri: _Optional[str] = ..., full_sflog_sample_rate: _Optional[float] = ..., full_sflog_on_failure: _Optional[bool] = ...) -> None: ...

class TensorSpec(_message.Message):
    __slots__ = ("dtype", "shape", "byte_order")
    DTYPE_FIELD_NUMBER: _ClassVar[int]
    SHAPE_FIELD_NUMBER: _ClassVar[int]
    BYTE_ORDER_FIELD_NUMBER: _ClassVar[int]
    dtype: ScalarType
    shape: _containers.RepeatedScalarFieldContainer[int]
    byte_order: ByteOrder
    def __init__(self, dtype: _Optional[_Union[ScalarType, str]] = ..., shape: _Optional[_Iterable[int]] = ..., byte_order: _Optional[_Union[ByteOrder, str]] = ...) -> None: ...

class BoxSpace(_message.Message):
    __slots__ = ("tensor", "low", "high")
    TENSOR_FIELD_NUMBER: _ClassVar[int]
    LOW_FIELD_NUMBER: _ClassVar[int]
    HIGH_FIELD_NUMBER: _ClassVar[int]
    tensor: TensorSpec
    low: _containers.RepeatedScalarFieldContainer[float]
    high: _containers.RepeatedScalarFieldContainer[float]
    def __init__(self, tensor: _Optional[_Union[TensorSpec, _Mapping]] = ..., low: _Optional[_Iterable[float]] = ..., high: _Optional[_Iterable[float]] = ...) -> None: ...

class DiscreteSpace(_message.Message):
    __slots__ = ("count", "start")
    COUNT_FIELD_NUMBER: _ClassVar[int]
    START_FIELD_NUMBER: _ClassVar[int]
    count: int
    start: int
    def __init__(self, count: _Optional[int] = ..., start: _Optional[int] = ...) -> None: ...

class MultiDiscreteSpace(_message.Message):
    __slots__ = ("counts", "starts")
    COUNTS_FIELD_NUMBER: _ClassVar[int]
    STARTS_FIELD_NUMBER: _ClassVar[int]
    counts: _containers.RepeatedScalarFieldContainer[int]
    starts: _containers.RepeatedScalarFieldContainer[int]
    def __init__(self, counts: _Optional[_Iterable[int]] = ..., starts: _Optional[_Iterable[int]] = ...) -> None: ...

class DictSpaceEntry(_message.Message):
    __slots__ = ("key", "space")
    KEY_FIELD_NUMBER: _ClassVar[int]
    SPACE_FIELD_NUMBER: _ClassVar[int]
    key: str
    space: SpaceSpec
    def __init__(self, key: _Optional[str] = ..., space: _Optional[_Union[SpaceSpec, _Mapping]] = ...) -> None: ...

class DictSpace(_message.Message):
    __slots__ = ("entries",)
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[DictSpaceEntry]
    def __init__(self, entries: _Optional[_Iterable[_Union[DictSpaceEntry, _Mapping]]] = ...) -> None: ...

class TupleSpace(_message.Message):
    __slots__ = ("entries",)
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[SpaceSpec]
    def __init__(self, entries: _Optional[_Iterable[_Union[SpaceSpec, _Mapping]]] = ...) -> None: ...

class SpaceSpec(_message.Message):
    __slots__ = ("id", "version", "box", "discrete", "multi_discrete", "dictionary", "tuple")
    ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    BOX_FIELD_NUMBER: _ClassVar[int]
    DISCRETE_FIELD_NUMBER: _ClassVar[int]
    MULTI_DISCRETE_FIELD_NUMBER: _ClassVar[int]
    DICTIONARY_FIELD_NUMBER: _ClassVar[int]
    TUPLE_FIELD_NUMBER: _ClassVar[int]
    id: str
    version: int
    box: BoxSpace
    discrete: DiscreteSpace
    multi_discrete: MultiDiscreteSpace
    dictionary: DictSpace
    tuple: TupleSpace
    def __init__(self, id: _Optional[str] = ..., version: _Optional[int] = ..., box: _Optional[_Union[BoxSpace, _Mapping]] = ..., discrete: _Optional[_Union[DiscreteSpace, _Mapping]] = ..., multi_discrete: _Optional[_Union[MultiDiscreteSpace, _Mapping]] = ..., dictionary: _Optional[_Union[DictSpace, _Mapping]] = ..., tuple: _Optional[_Union[TupleSpace, _Mapping]] = ...) -> None: ...

class SharedMemoryRef(_message.Message):
    __slots__ = ("region_name", "generation", "offset_bytes", "length_bytes", "sequence")
    REGION_NAME_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    OFFSET_BYTES_FIELD_NUMBER: _ClassVar[int]
    LENGTH_BYTES_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    region_name: str
    generation: int
    offset_bytes: int
    length_bytes: int
    sequence: int
    def __init__(self, region_name: _Optional[str] = ..., generation: _Optional[int] = ..., offset_bytes: _Optional[int] = ..., length_bytes: _Optional[int] = ..., sequence: _Optional[int] = ...) -> None: ...

class TensorPayload(_message.Message):
    __slots__ = ("packed_data", "shared_memory")
    PACKED_DATA_FIELD_NUMBER: _ClassVar[int]
    SHARED_MEMORY_FIELD_NUMBER: _ClassVar[int]
    packed_data: bytes
    shared_memory: SharedMemoryRef
    def __init__(self, packed_data: _Optional[bytes] = ..., shared_memory: _Optional[_Union[SharedMemoryRef, _Mapping]] = ...) -> None: ...

class PackedTensor(_message.Message):
    __slots__ = ("spec", "payload")
    SPEC_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    spec: TensorSpec
    payload: TensorPayload
    def __init__(self, spec: _Optional[_Union[TensorSpec, _Mapping]] = ..., payload: _Optional[_Union[TensorPayload, _Mapping]] = ...) -> None: ...

class NamedTensor(_message.Message):
    __slots__ = ("name", "tensor")
    NAME_FIELD_NUMBER: _ClassVar[int]
    TENSOR_FIELD_NUMBER: _ClassVar[int]
    name: str
    tensor: PackedTensor
    def __init__(self, name: _Optional[str] = ..., tensor: _Optional[_Union[PackedTensor, _Mapping]] = ...) -> None: ...

class TensorMap(_message.Message):
    __slots__ = ("entries",)
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[NamedTensor]
    def __init__(self, entries: _Optional[_Iterable[_Union[NamedTensor, _Mapping]]] = ...) -> None: ...

class EnvironmentDescriptor(_message.Message):
    __slots__ = ("environment_index", "environment_id", "episode_hash")
    ENVIRONMENT_INDEX_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENT_ID_FIELD_NUMBER: _ClassVar[int]
    EPISODE_HASH_FIELD_NUMBER: _ClassVar[int]
    environment_index: int
    environment_id: str
    episode_hash: str
    def __init__(self, environment_index: _Optional[int] = ..., environment_id: _Optional[str] = ..., episode_hash: _Optional[str] = ...) -> None: ...

class BatchDescriptor(_message.Message):
    __slots__ = ("batch_id", "environments", "action_space", "observation_space")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENTS_FIELD_NUMBER: _ClassVar[int]
    ACTION_SPACE_FIELD_NUMBER: _ClassVar[int]
    OBSERVATION_SPACE_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    environments: _containers.RepeatedCompositeFieldContainer[EnvironmentDescriptor]
    action_space: SpaceSpec
    observation_space: SpaceSpec
    def __init__(self, batch_id: _Optional[str] = ..., environments: _Optional[_Iterable[_Union[EnvironmentDescriptor, _Mapping]]] = ..., action_space: _Optional[_Union[SpaceSpec, _Mapping]] = ..., observation_space: _Optional[_Union[SpaceSpec, _Mapping]] = ...) -> None: ...

class CreateBatchRequest(_message.Message):
    __slots__ = ("client_protocol", "run_bundles", "episodes", "resource_limits", "artifact_policy")
    CLIENT_PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    RUN_BUNDLES_FIELD_NUMBER: _ClassVar[int]
    EPISODES_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_LIMITS_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_POLICY_FIELD_NUMBER: _ClassVar[int]
    client_protocol: ProtocolVersion
    run_bundles: _containers.RepeatedCompositeFieldContainer[RunBundle]
    episodes: _containers.RepeatedCompositeFieldContainer[EpisodeSpec]
    resource_limits: ResourceLimits
    artifact_policy: ArtifactPolicy
    def __init__(self, client_protocol: _Optional[_Union[ProtocolVersion, _Mapping]] = ..., run_bundles: _Optional[_Iterable[_Union[RunBundle, _Mapping]]] = ..., episodes: _Optional[_Iterable[_Union[EpisodeSpec, _Mapping]]] = ..., resource_limits: _Optional[_Union[ResourceLimits, _Mapping]] = ..., artifact_policy: _Optional[_Union[ArtifactPolicy, _Mapping]] = ...) -> None: ...

class CreateBatchResponse(_message.Message):
    __slots__ = ("batch", "error")
    BATCH_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    batch: BatchDescriptor
    error: ErrorStatus
    def __init__(self, batch: _Optional[_Union[BatchDescriptor, _Mapping]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class ResetBatchRequest(_message.Message):
    __slots__ = ("batch_id", "episodes")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    EPISODES_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    episodes: _containers.RepeatedCompositeFieldContainer[EpisodeSpec]
    def __init__(self, batch_id: _Optional[str] = ..., episodes: _Optional[_Iterable[_Union[EpisodeSpec, _Mapping]]] = ...) -> None: ...

class EpisodeResetInfo(_message.Message):
    __slots__ = ("episode_hash", "resolved_hash", "step", "simulation_time_ns")
    EPISODE_HASH_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_HASH_FIELD_NUMBER: _ClassVar[int]
    STEP_FIELD_NUMBER: _ClassVar[int]
    SIMULATION_TIME_NS_FIELD_NUMBER: _ClassVar[int]
    episode_hash: str
    resolved_hash: str
    step: int
    simulation_time_ns: int
    def __init__(self, episode_hash: _Optional[str] = ..., resolved_hash: _Optional[str] = ..., step: _Optional[int] = ..., simulation_time_ns: _Optional[int] = ...) -> None: ...

class ResetResult(_message.Message):
    __slots__ = ("environment_index", "observation", "info", "error")
    ENVIRONMENT_INDEX_FIELD_NUMBER: _ClassVar[int]
    OBSERVATION_FIELD_NUMBER: _ClassVar[int]
    INFO_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    environment_index: int
    observation: TensorMap
    info: EpisodeResetInfo
    error: ErrorStatus
    def __init__(self, environment_index: _Optional[int] = ..., observation: _Optional[_Union[TensorMap, _Mapping]] = ..., info: _Optional[_Union[EpisodeResetInfo, _Mapping]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class ResetBatchResponse(_message.Message):
    __slots__ = ("batch_id", "results", "error")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    results: _containers.RepeatedCompositeFieldContainer[ResetResult]
    error: ErrorStatus
    def __init__(self, batch_id: _Optional[str] = ..., results: _Optional[_Iterable[_Union[ResetResult, _Mapping]]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class EnvironmentAction(_message.Message):
    __slots__ = ("environment_index", "action")
    ENVIRONMENT_INDEX_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    environment_index: int
    action: TensorMap
    def __init__(self, environment_index: _Optional[int] = ..., action: _Optional[_Union[TensorMap, _Mapping]] = ...) -> None: ...

class StepBatchRequest(_message.Message):
    __slots__ = ("batch_id", "actions")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    actions: _containers.RepeatedCompositeFieldContainer[EnvironmentAction]
    def __init__(self, batch_id: _Optional[str] = ..., actions: _Optional[_Iterable[_Union[EnvironmentAction, _Mapping]]] = ...) -> None: ...

class RewardTerm(_message.Message):
    __slots__ = ("id", "value", "weight", "weighted_value")
    ID_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    WEIGHT_FIELD_NUMBER: _ClassVar[int]
    WEIGHTED_VALUE_FIELD_NUMBER: _ClassVar[int]
    id: str
    value: float
    weight: float
    weighted_value: float
    def __init__(self, id: _Optional[str] = ..., value: _Optional[float] = ..., weight: _Optional[float] = ..., weighted_value: _Optional[float] = ...) -> None: ...

class EpisodeTransitionInfo(_message.Message):
    __slots__ = ("episode_hash", "trajectory_hash", "step", "simulation_time_ns", "reward_terms", "termination_reason", "truncation_reason", "diagnostic_json")
    EPISODE_HASH_FIELD_NUMBER: _ClassVar[int]
    TRAJECTORY_HASH_FIELD_NUMBER: _ClassVar[int]
    STEP_FIELD_NUMBER: _ClassVar[int]
    SIMULATION_TIME_NS_FIELD_NUMBER: _ClassVar[int]
    REWARD_TERMS_FIELD_NUMBER: _ClassVar[int]
    TERMINATION_REASON_FIELD_NUMBER: _ClassVar[int]
    TRUNCATION_REASON_FIELD_NUMBER: _ClassVar[int]
    DIAGNOSTIC_JSON_FIELD_NUMBER: _ClassVar[int]
    episode_hash: str
    trajectory_hash: str
    step: int
    simulation_time_ns: int
    reward_terms: _containers.RepeatedCompositeFieldContainer[RewardTerm]
    termination_reason: TerminationReason
    truncation_reason: TruncationReason
    diagnostic_json: bytes
    def __init__(self, episode_hash: _Optional[str] = ..., trajectory_hash: _Optional[str] = ..., step: _Optional[int] = ..., simulation_time_ns: _Optional[int] = ..., reward_terms: _Optional[_Iterable[_Union[RewardTerm, _Mapping]]] = ..., termination_reason: _Optional[_Union[TerminationReason, str]] = ..., truncation_reason: _Optional[_Union[TruncationReason, str]] = ..., diagnostic_json: _Optional[bytes] = ...) -> None: ...

class StepResult(_message.Message):
    __slots__ = ("environment_index", "observation", "reward", "terminated", "truncated", "info", "error")
    ENVIRONMENT_INDEX_FIELD_NUMBER: _ClassVar[int]
    OBSERVATION_FIELD_NUMBER: _ClassVar[int]
    REWARD_FIELD_NUMBER: _ClassVar[int]
    TERMINATED_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_FIELD_NUMBER: _ClassVar[int]
    INFO_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    environment_index: int
    observation: TensorMap
    reward: float
    terminated: bool
    truncated: bool
    info: EpisodeTransitionInfo
    error: ErrorStatus
    def __init__(self, environment_index: _Optional[int] = ..., observation: _Optional[_Union[TensorMap, _Mapping]] = ..., reward: _Optional[float] = ..., terminated: _Optional[bool] = ..., truncated: _Optional[bool] = ..., info: _Optional[_Union[EpisodeTransitionInfo, _Mapping]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class StepBatchResponse(_message.Message):
    __slots__ = ("batch_id", "results", "error")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    results: _containers.RepeatedCompositeFieldContainer[StepResult]
    error: ErrorStatus
    def __init__(self, batch_id: _Optional[str] = ..., results: _Optional[_Iterable[_Union[StepResult, _Mapping]]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class FinalizeBatchRequest(_message.Message):
    __slots__ = ("batch_id", "environment_indices")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENT_INDICES_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    environment_indices: _containers.RepeatedScalarFieldContainer[int]
    def __init__(self, batch_id: _Optional[str] = ..., environment_indices: _Optional[_Iterable[int]] = ...) -> None: ...

class ArtifactRef(_message.Message):
    __slots__ = ("name", "uri", "mime_type", "size_bytes", "sha256")
    NAME_FIELD_NUMBER: _ClassVar[int]
    URI_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    SIZE_BYTES_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    name: str
    uri: str
    mime_type: str
    size_bytes: int
    sha256: str
    def __init__(self, name: _Optional[str] = ..., uri: _Optional[str] = ..., mime_type: _Optional[str] = ..., size_bytes: _Optional[int] = ..., sha256: _Optional[str] = ...) -> None: ...

class FinalizeResult(_message.Message):
    __slots__ = ("environment_index", "episode_hash", "trajectory_hash", "passed", "canonical_result_json", "artifacts", "error")
    ENVIRONMENT_INDEX_FIELD_NUMBER: _ClassVar[int]
    EPISODE_HASH_FIELD_NUMBER: _ClassVar[int]
    TRAJECTORY_HASH_FIELD_NUMBER: _ClassVar[int]
    PASSED_FIELD_NUMBER: _ClassVar[int]
    CANONICAL_RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    environment_index: int
    episode_hash: str
    trajectory_hash: str
    passed: bool
    canonical_result_json: bytes
    artifacts: _containers.RepeatedCompositeFieldContainer[ArtifactRef]
    error: ErrorStatus
    def __init__(self, environment_index: _Optional[int] = ..., episode_hash: _Optional[str] = ..., trajectory_hash: _Optional[str] = ..., passed: _Optional[bool] = ..., canonical_result_json: _Optional[bytes] = ..., artifacts: _Optional[_Iterable[_Union[ArtifactRef, _Mapping]]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class FinalizeBatchResponse(_message.Message):
    __slots__ = ("batch_id", "results", "error")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    results: _containers.RepeatedCompositeFieldContainer[FinalizeResult]
    error: ErrorStatus
    def __init__(self, batch_id: _Optional[str] = ..., results: _Optional[_Iterable[_Union[FinalizeResult, _Mapping]]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class CloseBatchRequest(_message.Message):
    __slots__ = ("batch_id", "finalize_active_episodes")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    FINALIZE_ACTIVE_EPISODES_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    finalize_active_episodes: bool
    def __init__(self, batch_id: _Optional[str] = ..., finalize_active_episodes: _Optional[bool] = ...) -> None: ...

class CloseBatchResponse(_message.Message):
    __slots__ = ("batch_id", "finalized", "error")
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    FINALIZED_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    batch_id: str
    finalized: _containers.RepeatedCompositeFieldContainer[FinalizeResult]
    error: ErrorStatus
    def __init__(self, batch_id: _Optional[str] = ..., finalized: _Optional[_Iterable[_Union[FinalizeResult, _Mapping]]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class HealthRequest(_message.Message):
    __slots__ = ("include_environments",)
    INCLUDE_ENVIRONMENTS_FIELD_NUMBER: _ClassVar[int]
    include_environments: bool
    def __init__(self, include_environments: _Optional[bool] = ...) -> None: ...

class EnvironmentHealth(_message.Message):
    __slots__ = ("environment_index", "state", "rss_bytes", "heap_bytes", "last_completed_step", "detail", "batch_id", "restart_count", "requires_reset")
    ENVIRONMENT_INDEX_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    RSS_BYTES_FIELD_NUMBER: _ClassVar[int]
    HEAP_BYTES_FIELD_NUMBER: _ClassVar[int]
    LAST_COMPLETED_STEP_FIELD_NUMBER: _ClassVar[int]
    DETAIL_FIELD_NUMBER: _ClassVar[int]
    BATCH_ID_FIELD_NUMBER: _ClassVar[int]
    RESTART_COUNT_FIELD_NUMBER: _ClassVar[int]
    REQUIRES_RESET_FIELD_NUMBER: _ClassVar[int]
    environment_index: int
    state: HealthState
    rss_bytes: int
    heap_bytes: int
    last_completed_step: int
    detail: str
    batch_id: str
    restart_count: int
    requires_reset: bool
    def __init__(self, environment_index: _Optional[int] = ..., state: _Optional[_Union[HealthState, str]] = ..., rss_bytes: _Optional[int] = ..., heap_bytes: _Optional[int] = ..., last_completed_step: _Optional[int] = ..., detail: _Optional[str] = ..., batch_id: _Optional[str] = ..., restart_count: _Optional[int] = ..., requires_reset: _Optional[bool] = ...) -> None: ...

class HealthResponse(_message.Message):
    __slots__ = ("state", "runtime_version", "uptime_ms", "active_batches", "active_environments", "environments", "error")
    STATE_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_VERSION_FIELD_NUMBER: _ClassVar[int]
    UPTIME_MS_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_BATCHES_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_ENVIRONMENTS_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENTS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    state: HealthState
    runtime_version: str
    uptime_ms: int
    active_batches: int
    active_environments: int
    environments: _containers.RepeatedCompositeFieldContainer[EnvironmentHealth]
    error: ErrorStatus
    def __init__(self, state: _Optional[_Union[HealthState, str]] = ..., runtime_version: _Optional[str] = ..., uptime_ms: _Optional[int] = ..., active_batches: _Optional[int] = ..., active_environments: _Optional[int] = ..., environments: _Optional[_Iterable[_Union[EnvironmentHealth, _Mapping]]] = ..., error: _Optional[_Union[ErrorStatus, _Mapping]] = ...) -> None: ...

class ErrorStatus(_message.Message):
    __slots__ = ("code", "message", "retryable", "canonical_detail_json")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    RETRYABLE_FIELD_NUMBER: _ClassVar[int]
    CANONICAL_DETAIL_JSON_FIELD_NUMBER: _ClassVar[int]
    code: ErrorCode
    message: str
    retryable: bool
    canonical_detail_json: bytes
    def __init__(self, code: _Optional[_Union[ErrorCode, str]] = ..., message: _Optional[str] = ..., retryable: _Optional[bool] = ..., canonical_detail_json: _Optional[bytes] = ...) -> None: ...
