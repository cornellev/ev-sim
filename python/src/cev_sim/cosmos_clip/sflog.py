"""Read-only decoder for finalized SFLog v1 files.

The reader walks the SFLG header, gzip chunks, CRC32, index, and SEND locator.
It interprets schema and cycle records and decodes only sensor_msgs/Image and
sensor_msgs/CameraInfo payloads.
"""

from __future__ import annotations

import gzip
import json
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from .contract import ClipError
from .messages import decode_camera_payload

MAX_CHUNK_BYTES = 64 * 1024 * 1024
TYPE_NAMES = {
    0x00: "json",
    0x01: "boolean",
    0x02: "int32",
    0x03: "uint32",
    0x04: "int64",
    0x05: "uint64",
    0x06: "float32",
    0x07: "float64",
    0x08: "string",
    0x09: "bytes",
    0x0A: "vec3",
    0x0B: "pose3",
    0x0C: "float64[]",
    0x0D: "int32[]",
    0x0E: "boolean[]",
}


@dataclass
class Schema:
    id: int
    path: str
    type_name: str
    unit: str | None
    metadata: dict


@dataclass
class Update:
    path: str
    type_name: str
    time_us: int
    cycle: int
    payload: bytes
    metadata: dict = field(default_factory=dict)
    message: dict | None = None


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.offset = 0

    def remaining(self) -> int:
        return len(self.data) - self.offset

    def _take(self, size: int) -> bytes:
        if size < 0 or self.offset + size > len(self.data):
            raise ClipError("Unexpected end of SFLog data.")
        chunk = self.data[self.offset:self.offset + size]
        self.offset += size
        return chunk

    def u8(self) -> int:
        return self._take(1)[0]

    def u16(self) -> int:
        return struct.unpack_from("<H", self._take(2))[0]

    def u32(self) -> int:
        return struct.unpack_from("<I", self._take(4))[0]

    def u64(self) -> int:
        return struct.unpack_from("<Q", self._take(8))[0]

    def varuint(self) -> int:
        value = 0
        shift = 0
        while True:
            byte = self.u8()
            value |= (byte & 0x7F) << shift
            if byte < 0x80:
                return value
            shift += 7
            if shift > 63:
                raise ClipError("SFLog varuint is too long.")

    def sized(self) -> bytes:
        return self._take(self.varuint())

    def string(self) -> str:
        return self.sized().decode("utf-8")


def _decode_records(payload: bytes, schemas: dict[int, Schema]) -> list[Update]:
    reader = _Reader(payload)
    updates: list[Update] = []
    last_time_us = 0
    while reader.remaining():
        tag = reader.u8()
        if tag == 0x01:
            schema_id = reader.varuint()
            type_name = TYPE_NAMES.get(reader.u8(), "json")
            path = reader.string()
            unit = reader.string() or None
            wrapped = json.loads(reader.string() or "{}")
            if not isinstance(wrapped, dict):
                raise ClipError(f"SFLog schema {path} metadata is not an object.")
            schemas[schema_id] = Schema(
                id=schema_id,
                path=path,
                type_name=type_name,
                unit=unit,
                metadata=wrapped.get("metadata") if isinstance(wrapped.get("metadata"), dict) else {},
            )
            continue
        if tag == 0x02:
            timestamp_code = reader.varuint()
            if timestamp_code % 2 == 1:
                time_us = timestamp_code // 2
            else:
                time_us = last_time_us + timestamp_code // 2
            last_time_us = time_us
            cycle = reader.varuint()
            count = reader.varuint()
            for _ in range(count):
                schema_id = reader.varuint()
                schema = schemas.get(schema_id)
                raw = reader.sized()
                if schema is None:
                    raise ClipError(f"SFLog update references unknown schema {schema_id}.")
                message = None
                if schema.type_name == "bytes":
                    message = decode_camera_payload(raw)
                updates.append(Update(
                    path=schema.path,
                    type_name=schema.type_name,
                    time_us=time_us,
                    cycle=cycle,
                    payload=raw,
                    metadata=schema.metadata,
                    message=message,
                ))
            continue
        if tag == 0x03:
            reader.varuint()
            reader.sized()
            reader.sized()
            reader.sized()
            reader.sized()
            continue
        if tag == 0x04:
            reader.varuint()
            count = reader.varuint()
            for _ in range(count):
                schema_id = reader.varuint()
                if schema_id not in schemas:
                    raise ClipError(f"SFLog checkpoint references unknown schema {schema_id}.")
                reader.sized()
            continue
        if tag == 0x05:
            reader.varuint()
            reader.sized()
            reader.sized()
            reader.sized()
            continue
        raise ClipError(f"Unknown SFLog record tag 0x{tag:02x}.")
    return updates


def read_sflog(path: Path) -> list[Update]:
    """Decode a finalized SFLog and return every cycle update in file order."""
    data = Path(path).read_bytes()
    if len(data) < 28 or data[:4] != b"SFLG" or data[-4:] != b"SEND":
        raise ClipError(f"{path} is not a finalized SFLog v1 file.")
    version, flags, metadata_length = struct.unpack_from("<HHI", data, 4)
    if version != 1 or flags != 0x0003:
        raise ClipError(f"{path} has an unsupported SFLog header.")
    header_end = 12 + metadata_length
    if metadata_length > 16 * 1024 * 1024 or header_end > len(data) - 12:
        raise ClipError(f"{path} has an invalid SFLog header.")
    index_offset = struct.unpack_from("<Q", data, len(data) - 12)[0]
    if index_offset < header_end or index_offset > len(data) - 16:
        raise ClipError(f"{path} has an invalid SFLog index locator.")
    if data[index_offset:index_offset + 4] != b"INDX":
        raise ClipError(f"{path} index magic is not INDX.")
    index_count = struct.unpack_from("<I", data, index_offset + 4)[0]
    index_bytes = 8 + index_count * 25
    if index_offset + index_bytes != len(data) - 12:
        raise ClipError(f"{path} index does not end at the SEND locator.")

    updates: list[Update] = []
    schemas: dict[int, Schema] = {}
    cursor = header_end
    chunk_index = 0
    while cursor < index_offset:
        if data[cursor:cursor + 4] != b"CHNK":
            raise ClipError(f"{path} has a gap before chunk {chunk_index}.")
        start_us, end_us, uncompressed_length, compressed_length, crc, reserved = struct.unpack_from(
            "<QQIIII", data, cursor + 4,
        )
        if reserved != 0:
            raise ClipError(f"{path} chunk {chunk_index} has a non-zero reserved field.")
        if uncompressed_length > MAX_CHUNK_BYTES or compressed_length > MAX_CHUNK_BYTES:
            raise ClipError(f"{path} chunk {chunk_index} exceeds 64 MiB.")
        entry_offset = index_offset + 8 + chunk_index * 25
        if chunk_index >= index_count or entry_offset + 25 > index_offset + index_bytes:
            raise ClipError(f"{path} has more chunks than its index.")
        recorded_start, recorded_end, recorded_offset, _checkpoint = struct.unpack_from("<QQQB", data, entry_offset)
        if recorded_offset != cursor or recorded_start != start_us or recorded_end != end_us:
            raise ClipError(f"{path} index entry {chunk_index} does not match its chunk.")
        payload_offset = cursor + 36
        compressed = data[payload_offset:payload_offset + compressed_length]
        if len(compressed) != compressed_length:
            raise ClipError(f"{path} chunk {chunk_index} is truncated.")
        try:
            uncompressed = gzip.decompress(compressed)
        except OSError as error:
            raise ClipError(f"{path} chunk {chunk_index} is not gzip.") from error
        if len(uncompressed) != uncompressed_length or (zlib.crc32(uncompressed) & 0xFFFFFFFF) != crc:
            raise ClipError(f"{path} chunk {chunk_index} failed CRC or length validation.")
        updates.extend(_decode_records(uncompressed, schemas))
        cursor = payload_offset + compressed_length
        chunk_index += 1
    if cursor != index_offset or chunk_index != index_count:
        raise ClipError(f"{path} index count does not match the chunk stream.")
    return updates
