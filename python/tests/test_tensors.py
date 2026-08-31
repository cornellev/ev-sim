from __future__ import annotations

from collections import OrderedDict

import gymnasium as gym
import numpy as np
import pytest

from cev_sim.errors import CevSimCompatibilityError, CevSimConfigurationError
from cev_sim.headless.v1 import headless_pb2 as pb
from cev_sim.tensors import TensorMapCodec, pack_named_tensor, space_from_proto


def box_spec(name: str, scalar_type: int, shape: tuple[int, ...], low: float = -100, high: float = 100) -> pb.SpaceSpec:
    return pb.SpaceSpec(
        id=name,
        version=1,
        box=pb.BoxSpace(
            tensor=pb.TensorSpec(
                dtype=scalar_type,
                shape=shape,
                byte_order=pb.BYTE_ORDER_LITTLE_ENDIAN,
            ),
            low=[low],
            high=[high],
        ),
    )


@pytest.mark.parametrize(
    ("scalar_type", "values"),
    [
        (pb.SCALAR_TYPE_FLOAT32, [1.25, -2.5]),
        (pb.SCALAR_TYPE_FLOAT64, [1.25, -2.5]),
        (pb.SCALAR_TYPE_INT8, [1, -2]),
        (pb.SCALAR_TYPE_UINT8, [1, 2]),
        (pb.SCALAR_TYPE_INT16, [1, -2]),
        (pb.SCALAR_TYPE_UINT16, [1, 2]),
        (pb.SCALAR_TYPE_INT32, [1, -2]),
        (pb.SCALAR_TYPE_UINT32, [1, 2]),
        (pb.SCALAR_TYPE_INT64, [1, -2]),
        (pb.SCALAR_TYPE_UINT64, [1, 2]),
        (pb.SCALAR_TYPE_BOOL, [True, False]),
    ],
)
def test_inline_tensor_codec_supports_every_scalar_type(scalar_type: int, values: list[object]) -> None:
    low = (
        0
        if scalar_type
        in {
            pb.SCALAR_TYPE_UINT8,
            pb.SCALAR_TYPE_UINT16,
            pb.SCALAR_TYPE_UINT32,
            pb.SCALAR_TYPE_UINT64,
            pb.SCALAR_TYPE_BOOL,
        }
        else -100
    )
    high = 1 if scalar_type == pb.SCALAR_TYPE_BOOL else 100
    specification = box_spec("value", scalar_type, (2,), low, high)
    codec = TensorMapCodec(specification, root_name="value")
    encoded = pb.TensorMap(entries=[pack_named_tensor("value", scalar_type, (2,), values)])
    decoded = codec.decode(encoded)
    assert decoded.shape == (2,)
    np.testing.assert_array_equal(decoded, np.asarray(values, dtype=decoded.dtype))


def test_flat_dictionary_space_preserves_utf8_order() -> None:
    specification = pb.SpaceSpec(
        id="observation",
        version=1,
        dictionary=pb.DictSpace(
            entries=[
                pb.DictSpaceEntry(key="a", space=box_spec("a", pb.SCALAR_TYPE_FLOAT32, (1,))),
                pb.DictSpaceEntry(key="é", space=box_spec("é", pb.SCALAR_TYPE_FLOAT64, (1,))),
            ]
        ),
    )
    converted = space_from_proto(specification)
    assert isinstance(converted, gym.spaces.Dict)
    assert list(converted.spaces) == ["a", "é"]
    value = TensorMapCodec(specification).decode(
        pb.TensorMap(
            entries=[
                pack_named_tensor("a", pb.SCALAR_TYPE_FLOAT32, (1,), [1]),
                pack_named_tensor("é", pb.SCALAR_TYPE_FLOAT64, (1,), [2]),
            ]
        )
    )
    assert isinstance(value, OrderedDict)


def test_codec_rejects_malformed_payloads_and_unsupported_storage() -> None:
    boolean = box_spec("value", pb.SCALAR_TYPE_BOOL, (1,), 0, 1)
    codec = TensorMapCodec(boolean, root_name="value")
    invalid_bool = pack_named_tensor("value", pb.SCALAR_TYPE_BOOL, (1,), [True])
    invalid_bool.tensor.payload.packed_data = b"\x02"
    with pytest.raises(CevSimCompatibilityError, match="Boolean"):
        codec.decode(pb.TensorMap(entries=[invalid_bool]))

    shared = pack_named_tensor("value", pb.SCALAR_TYPE_BOOL, (1,), [True])
    shared.tensor.payload.ClearField("packed_data")
    shared.tensor.payload.shared_memory.region_name = "future"
    with pytest.raises(CevSimCompatibilityError, match="packed_data"):
        codec.decode(pb.TensorMap(entries=[shared]))

    wrong_length = pack_named_tensor("value", pb.SCALAR_TYPE_BOOL, (1,), [True])
    wrong_length.tensor.payload.packed_data = b""
    with pytest.raises(CevSimCompatibilityError, match="requires 1 bytes"):
        codec.decode(pb.TensorMap(entries=[wrong_length]))


def test_codec_rejects_name_spec_order_and_bound_mismatches() -> None:
    first = box_spec("a", pb.SCALAR_TYPE_FLOAT32, (1,))
    second = box_spec("b", pb.SCALAR_TYPE_FLOAT32, (1,))
    dictionary = pb.SpaceSpec(
        id="observation",
        version=1,
        dictionary=pb.DictSpace(
            entries=[
                pb.DictSpaceEntry(key="a", space=first),
                pb.DictSpaceEntry(key="b", space=second),
            ]
        ),
    )
    codec = TensorMapCodec(dictionary)
    valid_a = pack_named_tensor("a", pb.SCALAR_TYPE_FLOAT32, (1,), [1])
    valid_b = pack_named_tensor("b", pb.SCALAR_TYPE_FLOAT32, (1,), [2])

    with pytest.raises(CevSimCompatibilityError, match="names"):
        codec.decode(pb.TensorMap(entries=[valid_b, valid_a]))

    wrong_shape = pack_named_tensor("a", pb.SCALAR_TYPE_FLOAT32, (2,), [1, 2])
    with pytest.raises(CevSimCompatibilityError, match="specification"):
        codec.decode(pb.TensorMap(entries=[wrong_shape, valid_b]))

    invalid_bounds = box_spec("invalid", pb.SCALAR_TYPE_FLOAT32, (1,), 2, 1)
    with pytest.raises(CevSimCompatibilityError, match="lower bound"):
        space_from_proto(invalid_bounds)


def test_spaces_reject_unknown_dtypes_endianness_duplicates_and_nesting() -> None:
    unknown = box_spec("unknown", 99, (1,))
    with pytest.raises(CevSimCompatibilityError, match="scalar type"):
        space_from_proto(unknown)

    big_endian = box_spec("big", pb.SCALAR_TYPE_FLOAT32, (1,))
    big_endian.box.tensor.byte_order = pb.BYTE_ORDER_BIG_ENDIAN
    with pytest.raises(CevSimCompatibilityError, match="little-endian"):
        space_from_proto(big_endian)

    duplicate = pb.SpaceSpec(
        id="duplicate",
        version=1,
        dictionary=pb.DictSpace(
            entries=[
                pb.DictSpaceEntry(key="same", space=box_spec("one", pb.SCALAR_TYPE_FLOAT32, (1,))),
                pb.DictSpaceEntry(key="same", space=box_spec("two", pb.SCALAR_TYPE_FLOAT32, (1,))),
            ]
        ),
    )
    with pytest.raises(CevSimCompatibilityError, match="unique"):
        space_from_proto(duplicate)

    nested = pb.SpaceSpec(
        id="nested",
        version=1,
        dictionary=pb.DictSpace(
            entries=[pb.DictSpaceEntry(key="child", space=duplicate)]
        ),
    )
    with pytest.raises(CevSimCompatibilityError, match="flat dictionaries"):
        space_from_proto(nested)


def test_decoded_tensors_own_their_memory() -> None:
    specification = box_spec("value", pb.SCALAR_TYPE_FLOAT32, (2,))
    codec = TensorMapCodec(specification, root_name="value")
    encoded = pb.TensorMap(entries=[pack_named_tensor("value", pb.SCALAR_TYPE_FLOAT32, (2,), [1, 2])])
    decoded = codec.decode(encoded)
    encoded.entries[0].tensor.payload.packed_data = b"\x00" * 8
    np.testing.assert_array_equal(decoded, np.asarray([1, 2], dtype=np.float32))


def test_action_encoding_validates_shape_finiteness_and_bounds() -> None:
    codec = TensorMapCodec(box_spec("action-space", pb.SCALAR_TYPE_FLOAT32, (2,), -1, 1), root_name="action")
    encoded = codec.encode([0.25, -0.5])
    assert encoded.entries[0].name == "action"
    np.testing.assert_allclose(codec.decode(encoded), [0.25, -0.5])
    for invalid in ([0], [0, np.nan], [0, 2]):
        with pytest.raises(CevSimConfigurationError):
            codec.encode(invalid)


def test_non_box_wire_spaces_fail_explicitly() -> None:
    with pytest.raises(CevSimCompatibilityError, match="does not define"):
        space_from_proto(pb.SpaceSpec(id="discrete", version=1, discrete=pb.DiscreteSpace(count=2)))
