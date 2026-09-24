"""Decode the project TopicCodec envelopes for Image and CameraInfo."""

from __future__ import annotations

import struct

from .contract import ClipError


class _Cursor:
    def __init__(self, data: bytes):
        self.data = data
        self.offset = 0

    def take(self, size: int) -> bytes:
        if size < 0 or self.offset + size > len(self.data):
            raise ClipError("Truncated sensor message.")
        chunk = self.data[self.offset:self.offset + size]
        self.offset += size
        return chunk

    def u8(self) -> int:
        return self.take(1)[0]

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def i32(self) -> int:
        return struct.unpack("<i", self.take(4))[0]

    def f64(self) -> float:
        return struct.unpack("<d", self.take(8))[0]

    def string(self) -> str:
        return self.take(self.u32()).decode("utf-8")

    def finished(self) -> None:
        if self.offset != len(self.data):
            raise ClipError("Sensor message has trailing bytes.")


def _header(cursor: _Cursor) -> dict:
    sec = cursor.i32()
    nanosec = cursor.u32()
    frame_id = cursor.string()
    if sec < 0 or nanosec >= 1_000_000_000:
        raise ClipError("Sensor header stamp is not a canonical nanosecond time.")
    return {"stampNs": sec * 1_000_000_000 + nanosec, "frameId": frame_id}


def _image(body: bytes) -> dict:
    cursor = _Cursor(body)
    header = _header(cursor)
    height = cursor.u32()
    width = cursor.u32()
    encoding = cursor.string()
    is_bigendian = cursor.u8()
    step = cursor.u32()
    data = cursor.take(cursor.u32())
    cursor.finished()
    if is_bigendian != 0:
        raise ClipError("Sensor images must be little-endian.")
    return {**header, "height": height, "width": width, "encoding": encoding, "step": step, "data": data}


def _camera_info(body: bytes) -> dict:
    cursor = _Cursor(body)
    header = _header(cursor)
    height = cursor.u32()
    width = cursor.u32()
    distortion_model = cursor.string()
    distortion = [cursor.f64() for _ in range(cursor.u32())]
    intrinsics = [cursor.f64() for _ in range(9)]
    rectification = [cursor.f64() for _ in range(9)]
    projection = [cursor.f64() for _ in range(12)]
    binning_x = cursor.u32()
    binning_y = cursor.u32()
    cursor.finished()
    return {
        **header,
        "height": height,
        "width": width,
        "distortionModel": distortion_model,
        "distortion": distortion,
        "k": intrinsics,
        "r": rectification,
        "p": projection,
        "binningX": binning_x,
        "binningY": binning_y,
    }


def decode_camera_payload(payload: bytes) -> dict | None:
    """Return a decoded Image or CameraInfo, or None for any other payload."""
    if len(payload) < 7 or payload[0] != 0xFF:
        return None
    length = struct.unpack_from("<I", payload, 1)[0]
    if length != len(payload) - 5:
        raise ClipError("Dynamic topic envelope length does not match its payload.")
    name_length = struct.unpack_from("<H", payload, 5)[0]
    name_end = 7 + name_length
    if name_end > len(payload):
        raise ClipError("Dynamic topic type name is truncated.")
    name = payload[7:name_end].decode("utf-8")
    body = payload[name_end:]
    if name == "sensor_msgs/Image":
        return {"type": name, **_image(body)}
    if name == "sensor_msgs/CameraInfo":
        return {"type": name, **_camera_info(body)}
    return None
