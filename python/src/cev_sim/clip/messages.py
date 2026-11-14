"""Read native camera products retained as SFLog JSON values."""

from __future__ import annotations

import base64
import binascii
import json
import math

from .contract import ClipError


def decode_camera_payload(payload: bytes | dict, metadata: dict | None = None) -> dict | None:
    """Decode admitted native products; historical ROS payloads have no preview."""
    metadata = metadata or {}
    contract = metadata.get("valueContract", {})
    if contract.get("id") not in ("cev.image", "cev.camera-info") or contract.get("version") != 1:
        return None
    try:
        value = payload if isinstance(payload, dict) else json.loads(payload)
        width, height = value["width"], value["height"]
        if any(type(size) is not int or size <= 0 for size in (width, height)):
            raise ValueError("Invalid dimensions.")
        stamp = metadata["captureTimeNs"]
        frame = metadata["frameId"]
        if type(stamp) is not int or stamp < 0 or not isinstance(frame, str) or not frame:
            raise ValueError("Invalid capture metadata.")
        result = {"type": contract["id"], "width": width, "height": height, "stampNs": stamp, "frameId": frame}
        if contract["id"] == "cev.image":
            formats = {
                "rgba8": ("rgba8", 4),
                "depth-f32-le": ("32FC1", 4),
                "semantic-u16-le": ("16UC1", 2),
                "instance-u32-le": ("32SC1", 4),
            }
            encoding, size = formats[value["pixelFormat"]]
            typed = value["data"]
            if typed.get("__sflogTypedArray") != "Uint8Array":
                raise ValueError("Invalid image data type.")
            data = base64.b64decode(typed["base64"], validate=True) if "base64" in typed else bytes(typed["values"])
            if value["strideBytes"] != width * size or len(data) != width * height * size:
                raise ValueError("Image bytes do not match dimensions.")
            return {**result, "encoding": encoding, "step": value["strideBytes"], "data": data}
        for key, length in (("intrinsic", 9), ("rectification", 9), ("projection", 12)):
            matrix = value[key]
            if len(matrix) != length or any(
                type(item) not in (int, float) or not math.isfinite(item) for item in matrix
            ):
                raise ValueError("Invalid camera matrix.")
        if (
            not isinstance(value["distortionModel"], str)
            or not isinstance(value["distortion"], list)
            or any(type(item) not in (int, float) or not math.isfinite(item) for item in value["distortion"])
        ):
            raise ValueError("Invalid camera distortion.")
        return {
            **result,
            "distortionModel": value["distortionModel"],
            "distortion": value["distortion"],
            "k": value["intrinsic"],
            "r": value["rectification"],
            "p": value["projection"],
        }
    except (ValueError, binascii.Error, KeyError, TypeError, AttributeError, UnicodeDecodeError) as error:
        raise ClipError(f"Invalid native camera product: {error}") from error
