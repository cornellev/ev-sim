from __future__ import annotations

import math
import sys
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import gymnasium as gym
import numpy as np

from .errors import CevSimCompatibilityError, CevSimConfigurationError
from .headless.v1 import headless_pb2 as pb

_WIRE_DTYPES: dict[int, np.dtype[Any]] = {
    pb.SCALAR_TYPE_FLOAT32: np.dtype("<f4"),
    pb.SCALAR_TYPE_FLOAT64: np.dtype("<f8"),
    pb.SCALAR_TYPE_INT8: np.dtype("i1"),
    pb.SCALAR_TYPE_UINT8: np.dtype("u1"),
    pb.SCALAR_TYPE_INT16: np.dtype("<i2"),
    pb.SCALAR_TYPE_UINT16: np.dtype("<u2"),
    pb.SCALAR_TYPE_INT32: np.dtype("<i4"),
    pb.SCALAR_TYPE_UINT32: np.dtype("<u4"),
    pb.SCALAR_TYPE_INT64: np.dtype("<i8"),
    pb.SCALAR_TYPE_UINT64: np.dtype("<u8"),
    pb.SCALAR_TYPE_BOOL: np.dtype("u1"),
}


def _native_dtype(scalar_type: int) -> np.dtype[Any]:
    dtype = _WIRE_DTYPES.get(scalar_type)
    if dtype is None:
        raise CevSimCompatibilityError(f"Unsupported tensor scalar type {scalar_type}")
    if scalar_type == pb.SCALAR_TYPE_BOOL:
        return np.dtype(np.bool_)
    return dtype.newbyteorder("=")


def _shape(values: Sequence[int]) -> tuple[int, ...]:
    shape = tuple(int(value) for value in values)
    if any(value < 0 for value in shape):
        raise CevSimCompatibilityError("Tensor dimensions must be non-negative")
    return shape


def _element_count(shape: tuple[int, ...]) -> int:
    return math.prod(shape, start=1)


def _sorted_utf8(values: Sequence[str]) -> bool:
    try:
        encoded = [value.encode("utf-8") for value in values]
    except (AttributeError, UnicodeEncodeError) as error:
        raise CevSimCompatibilityError(f"Tensor names must be valid UTF-8 strings: {error}") from error
    return encoded == sorted(encoded)


def _box_bound(values: Sequence[float], shape: tuple[int, ...], dtype: np.dtype[Any], *, low: bool) -> Any:
    count = _element_count(shape)
    if len(values) not in (1, count):
        raise CevSimCompatibilityError("Box bounds must contain one broadcast value or one value per element")
    source = np.asarray(values, dtype=np.float64)
    if np.issubdtype(dtype, np.floating):
        limit = np.finfo(dtype)
        source = np.clip(source, limit.min, limit.max)
    elif np.issubdtype(dtype, np.integer):
        limit = np.iinfo(dtype)
        source = np.clip(source, limit.min, limit.max)
    elif dtype == np.dtype(np.bool_):
        source = np.clip(source, 0, 1)
    if len(values) == 1:
        if dtype == np.dtype(np.bool_):
            return int(source[0])
        return dtype.type(source[0])
    return source.astype(dtype).reshape(shape)


def box_space_from_proto(space: pb.SpaceSpec) -> gym.spaces.Box:
    if space.WhichOneof("kind") != "box":
        raise CevSimCompatibilityError(f"Space {space.id!r} is not a Box")
    spec = space.box.tensor
    if spec.byte_order != pb.BYTE_ORDER_LITTLE_ENDIAN:
        raise CevSimCompatibilityError(f"Space {space.id!r} does not use little-endian tensors")
    shape = _shape(spec.shape)
    dtype = _native_dtype(spec.dtype)
    low = _box_bound(space.box.low, shape, dtype, low=True)
    high = _box_bound(space.box.high, shape, dtype, low=False)
    if np.any(np.asarray(low) > np.asarray(high)):
        raise CevSimCompatibilityError(f"Space {space.id!r} has a lower bound above its upper bound")
    try:
        return gym.spaces.Box(low=low, high=high, shape=shape, dtype=dtype)
    except (TypeError, ValueError) as error:
        raise CevSimCompatibilityError(f"Space {space.id!r} is not a valid Box: {error}") from error


def space_from_proto(space: pb.SpaceSpec) -> gym.Space[Any]:
    kind = space.WhichOneof("kind")
    if kind == "box":
        return box_space_from_proto(space)
    if kind == "dictionary":
        keys = [entry.key for entry in space.dictionary.entries]
        if not _sorted_utf8(keys) or len(keys) != len(set(keys)):
            raise CevSimCompatibilityError("Dictionary space entries must be UTF-8 sorted and unique")
        converted: OrderedDict[str, gym.Space[Any]] = OrderedDict()
        for entry in space.dictionary.entries:
            if entry.space.WhichOneof("kind") != "box":
                raise CevSimCompatibilityError("PR 8 supports only flat dictionaries of Box tensors")
            converted[entry.key] = box_space_from_proto(entry.space)
        return gym.spaces.Dict(converted)
    raise CevSimCompatibilityError(
        f"PR 8 does not define a packed tensor layout for {kind or 'unspecified'} space {space.id!r}"
    )


@dataclass(frozen=True)
class _TensorExpectation:
    name: str
    spec: pb.TensorSpec
    space: gym.spaces.Box


class TensorMapCodec:
    """Strict codec for the inline Box tensor layouts advertised in protocol 1.1."""

    def __init__(self, specification: pb.SpaceSpec, *, root_name: str | None = None) -> None:
        self.specification = specification
        self.space = space_from_proto(specification)
        kind = specification.WhichOneof("kind")
        if kind == "box":
            if not root_name:
                raise CevSimCompatibilityError("A root tensor name is required for a Box TensorMap")
            self.expectations = (_TensorExpectation(root_name, specification.box.tensor, self.space),)
        elif kind == "dictionary":
            dictionary_space = self.space
            assert isinstance(dictionary_space, gym.spaces.Dict)
            self.expectations = tuple(
                _TensorExpectation(entry.key, entry.space.box.tensor, dictionary_space.spaces[entry.key])
                for entry in specification.dictionary.entries
            )
        else:  # space_from_proto already rejects this branch.
            raise CevSimCompatibilityError(f"Unsupported TensorMap space {kind}")
        self._by_name = {entry.name: entry for entry in self.expectations}

    def decode(self, tensor_map: pb.TensorMap) -> Any:
        names = [entry.name for entry in tensor_map.entries]
        expected = [entry.name for entry in self.expectations]
        if names != expected or not _sorted_utf8(names):
            raise CevSimCompatibilityError(
                f"TensorMap names do not match the advertised space: expected {expected!r}, received {names!r}"
            )
        decoded = OrderedDict(
            (entry.name, self._decode_tensor(entry.tensor, self._by_name[entry.name])) for entry in tensor_map.entries
        )
        if self.specification.WhichOneof("kind") == "box":
            return next(iter(decoded.values()))
        return decoded

    def _decode_tensor(self, tensor: pb.PackedTensor, expected: _TensorExpectation) -> np.ndarray[Any, Any]:
        spec = tensor.spec
        expected_shape = _shape(expected.spec.shape)
        if (
            spec.dtype != expected.spec.dtype
            or _shape(spec.shape) != expected_shape
            or spec.byte_order != pb.BYTE_ORDER_LITTLE_ENDIAN
            or expected.spec.byte_order != pb.BYTE_ORDER_LITTLE_ENDIAN
        ):
            raise CevSimCompatibilityError(f"Tensor {expected.name!r} does not match its advertised specification")
        if tensor.payload.WhichOneof("storage") != "packed_data":
            raise CevSimCompatibilityError("PR 8 supports only inline packed_data tensor payloads")
        wire_dtype = _WIRE_DTYPES.get(spec.dtype)
        if wire_dtype is None:
            raise CevSimCompatibilityError(f"Unsupported tensor scalar type {spec.dtype}")
        payload = tensor.payload.packed_data
        count = _element_count(expected_shape)
        expected_bytes = count * wire_dtype.itemsize
        if len(payload) != expected_bytes:
            raise CevSimCompatibilityError(
                f"Tensor {expected.name!r} requires {expected_bytes} bytes, received {len(payload)}"
            )
        if spec.dtype == pb.SCALAR_TYPE_BOOL:
            raw = np.frombuffer(payload, dtype=np.uint8)
            if np.any((raw != 0) & (raw != 1)):
                raise CevSimCompatibilityError(f"Boolean tensor {expected.name!r} contains a value other than 0 or 1")
            value = raw.astype(np.bool_, copy=True)
        else:
            value = np.frombuffer(payload, dtype=wire_dtype).astype(_native_dtype(spec.dtype), copy=True)
        value = value.reshape(expected_shape)
        if not expected.space.contains(value):
            raise CevSimCompatibilityError(f"Tensor {expected.name!r} lies outside its advertised Box")
        return value

    def encode(self, value: Any) -> pb.TensorMap:
        if len(self.expectations) != 1:
            raise CevSimConfigurationError("Encoding dictionary observations is not supported")
        expectation = self.expectations[0]
        try:
            array = np.asarray(value)
            if array.shape != expectation.space.shape:
                raise CevSimConfigurationError(
                    f"Action shape must be {expectation.space.shape}, received {array.shape}"
                )
            numeric = np.asarray(array, dtype=np.float64)
        except (TypeError, ValueError) as error:
            raise CevSimConfigurationError(f"Action is not numeric: {error}") from error
        if not np.all(np.isfinite(numeric)):
            raise CevSimConfigurationError("Action values must be finite")
        cast = array.astype(expectation.space.dtype, copy=False)
        if not expectation.space.contains(cast):
            raise CevSimConfigurationError("Action lies outside the advertised Box")
        packed = _pack_array(expectation.spec, cast)
        return pb.TensorMap(entries=[pb.NamedTensor(name=expectation.name, tensor=packed)])


def _pack_array(spec: pb.TensorSpec, value: np.ndarray[Any, Any]) -> pb.PackedTensor:
    wire_dtype = _WIRE_DTYPES.get(spec.dtype)
    if wire_dtype is None:
        raise CevSimCompatibilityError(f"Unsupported tensor scalar type {spec.dtype}")
    if spec.byte_order != pb.BYTE_ORDER_LITTLE_ENDIAN:
        raise CevSimCompatibilityError("Only little-endian tensor packing is supported")
    if spec.dtype == pb.SCALAR_TYPE_BOOL:
        encoded = np.asarray(value, dtype=np.uint8)
    else:
        encoded = np.asarray(value, dtype=wire_dtype)
    if sys.byteorder != "little" and encoded.dtype.itemsize > 1:
        encoded = encoded.byteswap().view(encoded.dtype.newbyteorder("<"))
    return pb.PackedTensor(
        spec=pb.TensorSpec(dtype=spec.dtype, shape=spec.shape, byte_order=spec.byte_order),
        payload=pb.TensorPayload(packed_data=encoded.tobytes(order="C")),
    )


def pack_named_tensor(name: str, scalar_type: int, shape: Sequence[int], values: Any) -> pb.NamedTensor:
    normalized_shape = _shape(shape)
    native = _native_dtype(scalar_type)
    value = np.asarray(values, dtype=native)
    if value.size != _element_count(normalized_shape):
        raise CevSimConfigurationError("Tensor value count does not match shape")
    value = value.reshape(normalized_shape)
    spec = pb.TensorSpec(
        dtype=scalar_type,
        shape=normalized_shape,
        byte_order=pb.BYTE_ORDER_LITTLE_ENDIAN,
    )
    return pb.NamedTensor(name=name, tensor=_pack_array(spec, value))


def batch_observations(
    observations: Sequence[Mapping[str, np.ndarray[Any, Any]]],
) -> OrderedDict[str, np.ndarray[Any, Any]]:
    if not observations:
        raise CevSimConfigurationError("At least one observation is required")
    keys = list(observations[0])
    if any(list(observation) != keys for observation in observations):
        raise CevSimCompatibilityError("Batched observations have incompatible keys")
    return OrderedDict((key, np.stack([observation[key] for observation in observations])) for key in keys)
