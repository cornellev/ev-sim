import gzip
import json
import shutil
import struct
import subprocess
import zlib
from pathlib import Path

import numpy as np
import pytest

from cev_sim.config import GPU_SENSOR_CAPABILITY, GPU_SENSOR_CONFIG_HASH, GPU_SENSOR_VERSION
from cev_sim.cosmos_clip.check import check_clip
from cev_sim.cosmos_clip.contract import CAPTURE_INTERVAL_NS, FRAME_COUNT, ClipError
from cev_sim.cosmos_clip.export import (
    CapturedFrame,
    assert_frame_content,
    export_clip,
    stage_clip,
)
from cev_sim.cosmos_clip.messages import decode_camera_payload
from cev_sim.cosmos_clip.sflog import read_sflog
from cev_sim.cosmos_clip.video import depth_to_gray

EPISODE = "ab" * 32
RESOLVED = "cd" * 32
SEMANTIC = "ef" * 32
WORLD = "12" * 32
CAMERA = "front-camera"
STEP_NS = 11_111_111


def _varuint(value: int) -> bytes:
    out = bytearray()
    remaining = value
    while True:
        byte = remaining & 0x7F
        remaining >>= 7
        if remaining:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _sized(payload: bytes) -> bytes:
    return _varuint(len(payload)) + payload


def _u32(value: int) -> bytes:
    return struct.pack("<I", value)


def _text(value: str) -> bytes:
    return _u32(len(value.encode())) + value.encode()


def _envelope(type_name: str, body: bytes) -> bytes:
    name = type_name.encode()
    rest = struct.pack("<H", len(name)) + name + body
    return bytes([0xFF]) + _u32(len(rest)) + rest


def _image(stamp_ns: int, encoding: str, data: bytes) -> bytes:
    sec, nanosec = divmod(stamp_ns, 1_000_000_000)
    body = b"".join([
        struct.pack("<iI", sec, nanosec),
        _text("front_camera_optical_frame"),
        _u32(2),
        _u32(2),
        _text(encoding),
        bytes([0]),
        _u32(8),
        _u32(len(data)),
        data,
    ])
    return _envelope("sensor_msgs/Image", body)


def _camera_info(stamp_ns: int) -> bytes:
    sec, nanosec = divmod(stamp_ns, 1_000_000_000)
    distortion = struct.pack("<5d", 0, 0, 0, 0, 0)
    matrix = struct.pack("<9d", 469.16113422283404, 0, 639.5, 0, 469.16113422283404, 359.5, 0, 0, 1)
    rectification = struct.pack("<9d", 1, 0, 0, 0, 1, 0, 0, 0, 1)
    projection = struct.pack("<12d", 469.16113422283404, 0, 639.5, 0, 0, 469.16113422283404, 359.5, 0, 0, 0, 1, 0)
    body = b"".join([
        struct.pack("<iI", sec, nanosec),
        _text("front_camera_optical_frame"),
        _u32(720),
        _u32(1280),
        _text("none"),
        _u32(5),
        distortion,
        matrix,
        rectification,
        projection,
        _u32(0),
        _u32(0),
    ])
    return _envelope("sensor_msgs/CameraInfo", body)


def _js_round(value: float) -> int:
    return int(np.floor(value + 0.5)) if value >= 0 else int(np.ceil(value - 0.5))


def _schema(schema_id: int, path: str, metadata: dict) -> bytes:
    wrapped = json.dumps({
        "source": "sensors",
        "category": "devices",
        "replayRole": "derived",
        "logClass": "heavy",
        "description": None,
        "metadata": metadata,
    }).encode()
    return bytes([0x01, schema_id, 0x09]) + _sized(path.encode()) + _sized(b"") + _sized(wrapped)


def _cycle(stamp_ns: int, step: int, items: list[tuple[int, bytes]]) -> bytes:
    time_us = _js_round(stamp_ns / 1000)
    out = bytes([0x02]) + _varuint(time_us * 2 + 1) + _varuint(step) + _varuint(len(items))
    for schema_id, payload in items:
        out += _varuint(schema_id) + _sized(payload)
    return out


def _write_sflog(path: Path, frames: list[dict]) -> None:
    first = frames[0]
    metadata = {
        "captureTimeNs": first.get("descriptorStamp", first["stamp"]),
        "sequenceId": first.get("descriptorSample", 0),
        "captureStep": first.get("descriptorStep", first["step"]),
    }
    raw = bytearray()
    for schema_id, signal in ((1, "image"), (2, "depth"), (3, "cameraInfo")):
        raw += _schema(schema_id, f"devices.{CAMERA}.{signal}", metadata)
    for frame in frames:
        items = []
        if frame.get("rgb", True):
            encoding = frame.get("rgbEncoding", "rgba8")
            payload = frame.get("rgbPayload") or _image(frame["stamp"], encoding, b"\x01\x02\x03\x04")
            items.append((1, payload))
        if frame.get("depth", True):
            items.append((2, frame.get("depthPayload") or _image(frame["stamp"], "32FC1", struct.pack("<f", 1.5))))
        if frame.get("info", True):
            items.append((3, _camera_info(frame["stamp"])))
        raw += _cycle(frame["stamp"], frame["step"], items)
    compressed = gzip.compress(bytes(raw))
    header = b"SFLG" + struct.pack("<HHI", 1, 3, 2) + b"{}"
    start = 0
    end = _js_round(frames[-1]["stamp"] / 1000)
    chunk = b"CHNK" + struct.pack(
        "<QQIIII", start, end, len(raw), len(compressed), zlib.crc32(bytes(raw)) & 0xFFFFFFFF, 0,
    ) + compressed
    index_offset = len(header) + len(chunk)
    index = b"INDX" + struct.pack("<IQQQB", 1, start, end, len(header), 0)
    path.write_bytes(header + chunk + index + struct.pack("<Q", index_offset) + b"SEND")


def _camera() -> dict:
    return {
        "id": CAMERA,
        "type": "camera",
        "measurementFrameId": "front_camera_optical_frame",
        "render": {"provider": {"id": "canonical-analytic", "version": 1}},
        "noise": {"model": "none", "standardDeviation": 0, "bias": 0, "dropoutProbability": 0},
        "calibration": {
            "width": 1280,
            "height": 720,
            "near": 0.1,
            "far": 200,
            "distortionModel": "none",
            "distortion": [],
            "intrinsics": {"fx": 469.16113422283404, "fy": 469.16113422283404, "cx": 639.5, "cy": 359.5},
            "products": {
                "rgb": True,
                "cameraInfo": True,
                "depth": True,
                "semantic": False,
                "instance": False,
                "detections2d": False,
                "detections3d": False,
                "lanes": False,
                "trafficControls": False,
                "diagnostics": False,
            },
        },
    }


def _write_run(root: Path, frames: list[dict], **overrides) -> None:
    root.mkdir()
    camera = _camera()
    if overrides.get("camera"):
        camera.update(overrides["camera"])
    if overrides.get("calibration"):
        camera["calibration"].update(overrides["calibration"])
    bundle = {
        "kind": "cev-sim.run-bundle",
        "version": 1,
        "resolvedHash": RESOLVED,
        "simulationSemanticHash": SEMANTIC,
        "resolved": {
            "world": {"hash": WORLD},
            "manifest": {
                "clock": {"stepNs": STEP_NS},
                "logging": {"policy": "required", "profileId": "simulation-run-full-sensors"},
                "sensorRig": {"sensors": [camera]},
            },
        },
    }
    results = {
        "kind": "cev-sim.run-result",
        "version": 1,
        "completed": True,
        "interrupted": False,
        "step": "363",
        "episodeHash": EPISODE,
        "resolvedHash": RESOLVED,
        "simulationSemanticHash": SEMANTIC,
    }
    results.update(overrides.get("results") or {})
    provenance = {
        "kind": "cev-sim.headless.provenance",
        "version": 1,
        "backendSelections": [{
            "kind": 4,
            "capabilityId": GPU_SENSOR_CAPABILITY,
            "version": GPU_SENSOR_VERSION,
            "configHash": GPU_SENSOR_CONFIG_HASH,
        }],
    }
    (root / "run-bundle.json").write_text(json.dumps(bundle), encoding="utf-8")
    (root / "run-results.json").write_text(json.dumps(results), encoding="utf-8")
    (root / "provenance.json").write_text(json.dumps(provenance), encoding="utf-8")
    _write_sflog(root / "run.sflog", frames)


def _grid(count: int, *, stamp_gap_at: int | None = None) -> list[dict]:
    frames = []
    stamp = CAPTURE_INTERVAL_NS
    step = 3
    for index in range(count):
        frames.append({"stamp": stamp, "step": step})
        jumped = stamp_gap_at == index
        stamp += CAPTURE_INTERVAL_NS * (2 if jumped else 1)
        step += 6 if jumped else 3
    return frames


def _export(tmp_path: Path, frames: list[dict], **overrides):
    run = tmp_path / "run"
    if run.exists():
        shutil.rmtree(run)
    window = overrides.pop("window", 0)
    _write_run(run, frames, **overrides)
    return export_clip(
        run,
        tmp_path / "clips",
        CAMERA,
        window,
        versions={"ffmpeg": "test", "ffprobe": "test"},
    )


def test_depth_visualization_uses_half_away_rounding():
    depth = np.array([np.nan, -1, 0, 100 / 254, 100, 200, 400], dtype="<f4")
    gray = depth_to_gray(depth)
    assert gray[:3].tolist() == [0, 0, 0]
    assert int(gray[3]) == 2
    assert int(gray[4]) == 128
    assert int(gray[5]) == 255
    assert int(gray[6]) == 255


def test_image_and_camera_info_roundtrip_stamps():
    image = decode_camera_payload(_image(33_333_333, "rgba8", b"rgba"))
    info = decode_camera_payload(_camera_info(33_333_333))
    assert image["encoding"] == "rgba8"
    assert image["stampNs"] == 33_333_333
    assert image["data"] == b"rgba"
    assert info["distortionModel"] == "none"
    assert info["k"][0] == pytest.approx(469.16113422283404)
    assert info["stampNs"] == 33_333_333


def test_sflog_reader_rejects_a_bad_crc(tmp_path: Path):
    path = tmp_path / "run.sflog"
    _write_sflog(path, _grid(1))
    data = bytearray(path.read_bytes())
    data[-20] ^= 0xFF
    path.write_bytes(data)
    with pytest.raises(ClipError, match="CRC|index"):
        read_sflog(path)


def test_sflog_reader_keeps_schemas_across_chunks(tmp_path: Path):
    first = _grid(1)
    metadata = {"captureTimeNs": first[0]["stamp"], "sequenceId": 0, "captureStep": first[0]["step"]}
    chunk_one = bytearray()
    for schema_id, signal in ((1, "image"), (2, "depth"), (3, "cameraInfo")):
        chunk_one += _schema(schema_id, f"devices.{CAMERA}.{signal}", metadata)
    chunk_one += _cycle(first[0]["stamp"], first[0]["step"], [
        (1, _image(first[0]["stamp"], "rgba8", b"\x01\x02\x03\x04")),
        (2, _image(first[0]["stamp"], "32FC1", struct.pack("<f", 1.5))),
        (3, _camera_info(first[0]["stamp"])),
    ])
    second = {"stamp": CAPTURE_INTERVAL_NS * 2, "step": 6}
    chunk_two = _cycle(second["stamp"], second["step"], [
        (1, _image(second["stamp"], "rgba8", b"\x05\x06\x07\x08")),
        (2, _image(second["stamp"], "32FC1", struct.pack("<f", 2.5))),
        (3, _camera_info(second["stamp"])),
    ])
    header = b"SFLG" + struct.pack("<HHI", 1, 3, 2) + b"{}"
    body = bytearray(header)
    index_entries = b""
    for raw in (bytes(chunk_one), chunk_two):
        compressed = gzip.compress(raw)
        offset = len(body)
        start = 0
        end = _js_round(second["stamp"] / 1000)
        body += b"CHNK" + struct.pack(
            "<QQIIII", start, end, len(raw), len(compressed), zlib.crc32(raw) & 0xFFFFFFFF, 0,
        ) + compressed
        index_entries += struct.pack("<QQQB", start, end, offset, 0)
    index_offset = len(body)
    body += b"INDX" + struct.pack("<I", 2) + index_entries + struct.pack("<Q", index_offset) + b"SEND"
    path = tmp_path / "run.sflog"
    path.write_bytes(body)
    updates = [update for update in read_sflog(path) if update.path.endswith(".image")]
    assert [update.message["stampNs"] for update in updates] == [first[0]["stamp"], second["stamp"]]


def test_sflog_reader_returns_descriptor_metadata(tmp_path: Path):
    path = tmp_path / "run.sflog"
    _write_sflog(path, _grid(1))
    updates = read_sflog(path)
    image = next(update for update in updates if update.path.endswith(".image"))
    assert image.metadata["captureTimeNs"] == CAPTURE_INTERVAL_NS
    assert image.metadata["sequenceId"] == 0
    assert image.message["encoding"] == "rgba8"


@pytest.mark.parametrize(("frames", "message"), [
    ([{"stamp": CAPTURE_INTERVAL_NS, "step": 3}, {"stamp": CAPTURE_INTERVAL_NS, "step": 3}], "Duplicate"),
    ([{"stamp": CAPTURE_INTERVAL_NS, "step": 3, "depth": False}], "missing depth"),
    (_grid(2), "ended before window"),
    (_grid(FRAME_COUNT, stamp_gap_at=4), "gap or duplicate"),
    ([{"stamp": CAPTURE_INTERVAL_NS, "step": 4}], "simulation step grid"),
    ([{"stamp": CAPTURE_INTERVAL_NS * 2, "step": 6}], "not at 33333333"),
    ([{"stamp": CAPTURE_INTERVAL_NS, "step": 3, "descriptorStamp": 1}], "descriptor stamp"),
    ([{"stamp": CAPTURE_INTERVAL_NS, "step": 3, "rgbEncoding": "mono8"}], "rgba8"),
])
def test_exporter_rejects_capture_streams(tmp_path: Path, frames, message):
    with pytest.raises(ClipError, match=message):
        _export(tmp_path, frames)


def test_exporter_rejects_short_frames_before_encoding(tmp_path: Path):
    with pytest.raises(ClipError, match="3686400"):
        _export(tmp_path, _grid(FRAME_COUNT))


def test_exporter_rejects_an_incomplete_run(tmp_path: Path):
    with pytest.raises(ClipError, match="did not complete"):
        _export(tmp_path, _grid(1), results={"completed": False, "interrupted": True})


def test_exporter_rejects_a_non_analytic_renderer(tmp_path: Path):
    camera = _camera()
    camera["render"] = {"provider": {"id": "pbr-mesh", "version": 1}}
    with pytest.raises(ClipError, match="canonical-analytic"):
        _export(tmp_path, _grid(1), camera=camera)


def test_exporter_rejects_nonzero_noise_and_distortion(tmp_path: Path):
    with pytest.raises(ClipError, match="noise"):
        _export(tmp_path, _grid(1), camera={
            "noise": {"model": "gaussian", "standardDeviation": 1, "bias": 0, "dropoutProbability": 0},
        })
    with pytest.raises(ClipError, match="distortion"):
        _export(tmp_path, _grid(1), calibration={"distortionModel": "plumb_bob", "distortion": [0.1, 0, 0, 0, 0]})


def test_frame_content_rejects_empty_color_and_depth():
    rgb = bytes(1280 * 720 * 4)
    depth = np.zeros(1280 * 720, dtype="<f4").tobytes()
    with pytest.raises(ClipError, match="no color"):
        assert_frame_content(rgb, depth)
    colored = bytearray(rgb)
    colored[0] = 1
    with pytest.raises(ClipError, match="no finite positive depth"):
        assert_frame_content(bytes(colored), depth)


def _publication_args(destination: Path):
    return {
        "destination": destination,
        "frames": [CapturedFrame(
            CAPTURE_INTERVAL_NS,
            0,
            3,
            b"\x01\x00\x00\x00",
            struct.pack("<f", 1.25),
            {
                "frameId": "front_camera_optical_frame",
                "distortionModel": "none",
                "distortion": [0, 0, 0, 0, 0],
                "k": [469.16113422283404, 0, 639.5, 0, 469.16113422283404, 359.5, 0, 0, 1],
            },
        )],
        "camera": _camera(),
        "bundle": {"resolved": {"world": {"hash": WORLD}}},
        "results": {"episodeHash": EPISODE, "simulationSemanticHash": SEMANTIC, "resolvedHash": RESOLVED},
        "backend": {
            "capabilityId": GPU_SENSOR_CAPABILITY,
            "version": "1",
            "configHash": GPU_SENSOR_CONFIG_HASH,
        },
        "versions": {"ffmpeg": "ffmpeg version test", "ffprobe": "ffprobe version test"},
        "window_index": 0,
        "check_content": False,
    }


def test_encoder_failure_removes_the_staging_directory(tmp_path: Path):
    destination = tmp_path / f"clip-{EPISODE}-{CAMERA}-0"

    def fail(argv, input=None, check=False, capture_output=True):
        return subprocess.CompletedProcess(argv, 1, stderr=b"libx264 missing")

    with pytest.raises(ClipError, match="ffmpeg failed"):
        stage_clip(**_publication_args(destination), runner=fail)
    assert list(tmp_path.iterdir()) == []


def test_checker_failure_does_not_publish(tmp_path: Path):
    destination = tmp_path / f"clip-{EPISODE}-{CAMERA}-0"

    def succeed(argv, input=None, check=False, capture_output=True):
        Path(argv[-1]).write_bytes(b"not a video")
        return subprocess.CompletedProcess(argv, 0)

    with pytest.raises(ClipError):
        stage_clip(**_publication_args(destination), runner=succeed)
    assert not destination.exists()
    assert list(tmp_path.iterdir()) == []


def test_existing_destination_is_not_overwritten(tmp_path: Path):
    destination = tmp_path / f"clip-{EPISODE}-{CAMERA}-0"
    destination.mkdir()
    (destination / "keep.txt").write_text("keep", encoding="utf-8")
    with pytest.raises(ClipError, match="already exists"):
        stage_clip(**_publication_args(destination))
    assert (destination / "keep.txt").read_text(encoding="utf-8") == "keep"


def _shell(directory: Path, *, frames: list[dict] | None = None, clip: dict | None = None) -> None:
    directory.mkdir()
    document = {
        "kind": "cev-sim.cosmos-clip",
        "version": 1,
        "episodeHash": EPISODE,
        "cameraId": CAMERA,
        "windowIndex": 0,
        "frameCount": FRAME_COUNT,
        "width": 1280,
        "height": 720,
        "renderer": {"id": "canonical-analytic", "version": 1},
        "resolvedRenderer": {"id": "canonical-analytic", "version": 1},
        "backend": {
            "capabilityId": GPU_SENSOR_CAPABILITY,
            "version": "1",
            "configHash": GPU_SENSOR_CONFIG_HASH,
        },
        "noise": {"model": "none", "standardDeviation": 0, "bias": 0, "dropoutProbability": 0},
        "timing": {"captureIntervalNs": CAPTURE_INTERVAL_NS},
    }
    document.update(clip or {})
    (directory / "clip.json").write_text(json.dumps(document), encoding="utf-8")
    (directory / "camera_info.json").write_text(json.dumps({
        "distortionModel": "none",
        "distortion": [0, 0, 0, 0, 0],
    }), encoding="utf-8")
    records = frames if frames is not None else [
        {
            "index": index,
            "captureTimeNs": CAPTURE_INTERVAL_NS * (index + 1),
            "sampleIndex": index,
            "simulationStep": 3 * (index + 1),
            "rgbByteLength": 3_686_400,
            "depthValueCount": 921_600,
        }
        for index in range(FRAME_COUNT)
    ]
    (directory / "frames.jsonl").write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
    for name in ("rgb.mp4", "depth.mp4", "depth.f32"):
        (directory / name).write_bytes(b"")


def test_checker_rejects_contract_violations(tmp_path: Path):
    missing = tmp_path / "missing"
    _shell(missing)
    (missing / "depth.mp4").unlink()
    with pytest.raises(ClipError, match="filenames"):
        check_clip(missing)

    named = tmp_path / f"clip-{EPISODE}-{CAMERA}-0"
    _shell(named, clip={"kind": "other"})
    with pytest.raises(ClipError, match="kind"):
        check_clip(named)

    rendered = tmp_path / "rendered"
    _shell(rendered, clip={
        "renderer": {"id": "pbr-mesh", "version": 1},
        "episodeHash": "rendered",
        "cameraId": "cam",
        "windowIndex": 0,
    })
    rendered.rename(tmp_path / "clip-rendered-cam-0")
    with pytest.raises(ClipError, match="canonical-analytic"):
        check_clip(tmp_path / "clip-rendered-cam-0")

    noisy = tmp_path / f"clip-{EPISODE}-other-0"
    _shell(noisy, clip={
        "cameraId": "other",
        "noise": {"model": "none", "standardDeviation": 1, "bias": 0, "dropoutProbability": 0},
    })
    with pytest.raises(ClipError, match="noise"):
        check_clip(noisy)

    distorted = tmp_path / "distorted"
    _shell(distorted)
    (distorted / "camera_info.json").write_text(
        json.dumps({"distortionModel": "plumb_bob", "distortion": [0.2]}),
        encoding="utf-8",
    )
    with pytest.raises(ClipError, match="Distortion"):
        check_clip(distorted)

    gapped = tmp_path / "gapped"
    bad_frames = [
        {
            "index": index,
            "captureTimeNs": CAPTURE_INTERVAL_NS * (index + 1) + (CAPTURE_INTERVAL_NS if index > 3 else 0),
            "sampleIndex": index,
            "simulationStep": 3 * (index + 1),
            "rgbByteLength": 3_686_400,
            "depthValueCount": 921_600,
        }
        for index in range(FRAME_COUNT)
    ]
    _shell(gapped, frames=bad_frames)
    with pytest.raises(ClipError, match="33333333"):
        check_clip(gapped)
