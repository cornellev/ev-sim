"""Shared VIS-11 bake-model contracts used by the bounded Python job service."""

from __future__ import annotations

import hashlib
import json
import struct
from typing import Any

try:
    import rfc8785
except ImportError:  # pragma: no cover - JS parity tests require rfc8785
    rfc8785 = None

FAKE_MODEL_ID = "cev-sim.fake-intrinsic-material"
FAKE_MODEL_REVISION = "fake@1"
FAKE_ALGORITHM_ID = "intrinsic-channel-estimator"
FAKE_ALGORITHM_REVISION = "1"
FAKE_WEIGHTS_SEED = "cev-sim.fake-intrinsic-material:fake@1:weights"
FAKE_WEIGHTS_DIGEST = hashlib.sha256(FAKE_WEIGHTS_SEED.encode("utf-8")).hexdigest()
PROVIDER_ID = "intrinsic-material-model"
PROVIDER_VERSION = 1
MODEL_OUTPUT_KIND = "cev-sim.bake-model-output-set"
MODEL_OUTPUT_CHANNELS = (
    "base-color",
    "confidence",
    "emissive",
    "known-mask",
    "metalness",
    "normal",
    "occlusion",
    "roughness",
)
VALUE_CHANNELS = (
    "base-color",
    "emissive",
    "metalness",
    "normal",
    "occlusion",
    "roughness",
)
CHANNEL_LAYOUTS = {
    "base-color": ("float32-le-rgb", 3, 4),
    "emissive": ("float32-le-rgb", 3, 4),
    "metalness": ("float32-le-scalar", 1, 4),
    "normal": ("float32-le-xyz", 3, 4),
    "occlusion": ("float32-le-scalar", 1, 4),
    "roughness": ("float32-le-scalar", 1, 4),
    "confidence": ("float32-le-scalar", 1, 4),
    "known-mask": ("uint8-scalar", 1, 1),
}


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_utf8(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def canonical_dumps(value: Any) -> bytes:
    if rfc8785 is None:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    dumped = rfc8785.dumps(value)
    return dumped if isinstance(dumped, bytes) else dumped.encode("utf-8")


def hash_document(value: Any) -> str:
    return sha256_bytes(canonical_dumps(value))


def float32_le(values: list[float] | tuple[float, ...]) -> bytes:
    return struct.pack("<" + "f" * len(values), *[0.0 if _is_neg_zero(v) else float(v) for v in values])


def _is_neg_zero(value: float) -> bool:
    return value == 0.0 and str(value).startswith("-")


def nearest_resize(
    source: list[float] | bytes,
    source_w: int,
    source_h: int,
    dest_w: int,
    dest_h: int,
    channels: int,
    as_bytes: bool = False,
):
    if source_w == dest_w and source_h == dest_h:
        return bytes(source) if as_bytes else list(source)
    dest_len = dest_w * dest_h * channels
    dest = bytearray(dest_len) if as_bytes else [0.0] * dest_len
    for y in range(dest_h):
        source_y = min(source_h - 1, (y * source_h) // dest_h)
        for x in range(dest_w):
            source_x = min(source_w - 1, (x * source_w) // dest_w)
            source_index = (source_y * source_w + source_x) * channels
            dest_index = (y * dest_w + x) * channels
            for channel in range(channels):
                dest[dest_index + channel] = source[source_index + channel]
    return bytes(dest) if as_bytes else dest


def infer_fake_intrinsic_channels(
    beauty: bytes,
    validity: bytes,
    width: int,
    height: int,
    seed: int = 0,
) -> dict[str, bytes]:
    pixels = width * height
    if len(beauty) != pixels * 4:
        raise ValueError("beauty must be RGBA8 at the working resolution")
    if len(validity) != pixels:
        raise ValueError("validity must be uint8 at the working resolution")
    base_color = [0.0] * (pixels * 3)
    normal = [0.0] * (pixels * 3)
    roughness = [0.0] * pixels
    metalness = [0.0] * pixels
    emissive = [0.0] * (pixels * 3)
    occlusion = [0.0] * pixels
    confidence = [0.0] * pixels
    known_mask = bytearray(pixels)
    seed_int = int(seed)
    for pixel in range(pixels):
        known = 1 if validity[pixel] else 0
        known_mask[pixel] = known
        if not known:
            continue
        red = beauty[pixel * 4] / 255.0
        green = beauty[pixel * 4 + 1] / 255.0
        blue = beauty[pixel * 4 + 2] / 255.0
        base_color[pixel * 3] = red
        base_color[pixel * 3 + 1] = green
        base_color[pixel * 3 + 2] = blue
        normal[pixel * 3 + 2] = 1.0
        roughness[pixel] = ((seed_int + pixel) % 251) / 250.0
        metalness[pixel] = blue * 0.25
        occlusion[pixel] = 1.0
        confidence[pixel] = 1.0
    return {
        "base-color": float32_le(base_color),
        "normal": float32_le(normal),
        "roughness": float32_le(roughness),
        "metalness": float32_le(metalness),
        "emissive": float32_le(emissive),
        "occlusion": float32_le(occlusion),
        "confidence": float32_le(confidence),
        "known-mask": bytes(known_mask),
    }


def restore_channels(
    channels: dict[str, bytes],
    source_w: int,
    source_h: int,
    effective_w: int,
    effective_h: int,
) -> dict[str, bytes]:
    if source_w == effective_w and source_h == effective_h:
        return channels
    restored = {}
    for channel, payload in channels.items():
        _encoding, components, _width_bytes = CHANNEL_LAYOUTS[channel]
        if channel == "known-mask":
            restored[channel] = nearest_resize(payload, effective_w, effective_h, source_w, source_h, 1, as_bytes=True)
            continue
        count = len(payload) // 4
        values = list(struct.unpack("<" + "f" * count, payload))
        resized = nearest_resize(values, effective_w, effective_h, source_w, source_h, components)
        restored[channel] = float32_le(resized)
    return restored


def effective_dimensions(source_w: int, source_h: int, resize_policy: dict[str, Any] | None) -> tuple[int, int]:
    policy = resize_policy or {"mode": "identity"}
    if policy.get("mode", "identity") == "identity":
        return source_w, source_h
    return int(policy["width"]), int(policy["height"])


def run_fake_inference(
    beauty: bytes,
    validity: bytes,
    source_w: int,
    source_h: int,
    resize_policy: dict[str, Any] | None,
    seed: int = 0,
) -> tuple[dict[str, bytes], tuple[int, int]]:
    effective_w, effective_h = effective_dimensions(source_w, source_h, resize_policy)
    working_beauty = nearest_resize(beauty, source_w, source_h, effective_w, effective_h, 4, as_bytes=True)
    working_validity = nearest_resize(validity, source_w, source_h, effective_w, effective_h, 1, as_bytes=True)
    inferred = infer_fake_intrinsic_channels(working_beauty, working_validity, effective_w, effective_h, seed)
    return restore_channels(inferred, source_w, source_h, effective_w, effective_h), (effective_w, effective_h)
