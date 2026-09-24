"""Generic camera clips and Cosmos v2 renderer branches."""

import json
from pathlib import Path

import numpy as np
import pytest

from cev_sim.clip.contract import ClipError
from cev_sim.clip.export import load_run, pair_camera_frames
from cev_sim.clip.sflog import Update
from cev_sim.clip.video import generic_depth_to_gray
from cev_sim.config import (
    GPU_SENSOR_CONFIG_HASH,
    GPU_SENSOR_VERSION,
    ROUTED_GPU_SENSOR_CONFIG_HASH,
    ROUTED_GPU_SENSOR_VERSION,
)
from cev_sim.cosmos_clip.check import check_clip
from cev_sim.cosmos_clip.contract import ANALYTIC_RENDERER


def _update(path: str, stamp: int, step_ns: int, payload: bytes, *, width: int, height: int, encoding: str) -> Update:
    return Update(
        path=path,
        type_name="sensor_msgs/Image",
        time_us=stamp // 1000,
        cycle=stamp // step_ns,
        payload=payload,
        message={
            "stampNs": stamp,
            "encoding": encoding,
            "width": width,
            "height": height,
            "data": payload,
        },
    )


def test_generic_pairing_rejects_a_missing_or_misaligned_frame():
    step_ns = 20_000_000
    stamp = 40_000_000
    width = 4
    height = 2
    rgb = _update(
        "devices.side.image", stamp, step_ns, b"\x00" * (width * height * 4),
        width=width, height=height, encoding="rgba8",
    )
    with pytest.raises(ClipError, match="missing depth or CameraInfo"):
        pair_camera_frames(
            [rgb], "side", step_ns=step_ns, expected_stamps=[stamp], width=width, height=height,
        )
    depth = _update(
        "devices.side.depth",
        stamp + step_ns,
        step_ns,
        b"\x00" * (width * height * 4),
        width=width,
        height=height,
        encoding="32FC1",
    )
    info = Update(
        path="devices.side.cameraInfo",
        type_name="sensor_msgs/CameraInfo",
        time_us=stamp // 1000,
        cycle=stamp // step_ns,
        payload=b"",
        message={"stampNs": stamp},
    )
    with pytest.raises(ClipError, match="missing depth or CameraInfo"):
        pair_camera_frames(
            [rgb, depth, info], "side", step_ns=step_ns,
            expected_stamps=[stamp], width=width, height=height,
        )


def test_generic_depth_visualization_is_inverted_and_preserves_invalid_samples():
    depth = np.array([
        [0.1, 1.0, 10.0],
        [float("nan"), 0.0, -2.0],
    ], dtype="<f4")
    gray = generic_depth_to_gray(depth, near=0.1, far=10.0)
    assert gray[0, 0] == 255
    assert gray[0, 2] == 0
    assert gray[1, 0] == 0
    assert gray[1, 1] == 0
    assert gray[1, 2] == 0
    assert int(gray[0, 1]) < 255
    restored = np.frombuffer(np.asarray(depth, dtype="<f4").tobytes(), dtype="<f4")
    assert restored[1] == pytest.approx(1.0)


def _cosmos_clip(directory: Path, *, version: int, renderer: dict, backend_version: str, backend_hash: str) -> None:
    directory.mkdir(parents=True)
    frame_count = 121
    width = 1280
    height = 720
    depth = np.full((frame_count, width * height), 4.0, dtype="<f4")
    (directory / "depth.f32").write_bytes(depth.tobytes())
    for name in ("rgb.mp4", "depth.mp4", "camera_info.json", "frames.jsonl"):
        (directory / name).write_bytes(b"")
    records = []
    for index in range(frame_count):
        records.append({
            "index": index,
            "captureTimeNs": 33_333_333 * (index + 1),
            "sampleIndex": index,
            "simulationStep": 3 * (index + 1),
            "rgbByteLength": width * height * 4,
            "depthValueCount": width * height,
            "depthByteLength": width * height * 4,
            "depthSha256": "0" * 64,
            "depthValidCount": width * height,
            "depthMin": 4.0,
            "depthMax": 4.0,
        })
    clip = {
        "kind": "cev-sim.cosmos-clip",
        "version": version,
        "episodeHash": "episode",
        "cameraId": "front-camera",
        "windowIndex": 0,
        "frameCount": frame_count,
        "width": width,
        "height": height,
        "renderer": renderer,
        "resolvedRenderer": renderer,
        "backend": {
            "capabilityId": "chromium-webgl2-rendered-sensors",
            "version": backend_version,
            "configHash": backend_hash,
        },
        "noise": {"model": "none", "standardDeviation": 0, "bias": 0, "dropoutProbability": 0},
        "timing": {"captureIntervalNs": 33_333_333},
        "hashes": {},
        "files": {},
    }
    (directory / "camera_info.json").write_text(json.dumps({
        "distortionModel": "none",
        "distortion": [0, 0, 0, 0, 0],
    }), encoding="utf-8")
    (directory / "frames.jsonl").write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
    (directory / "clip.json").write_text(json.dumps(clip), encoding="utf-8")


def test_cosmos_v1_still_rejects_pbr(tmp_path: Path):
    directory = tmp_path / "clip-episode-front-camera-0"
    _cosmos_clip(
        directory,
        version=1,
        renderer={"id": "pbr-mesh", "version": 1},
        backend_version=ROUTED_GPU_SENSOR_VERSION,
        backend_hash=ROUTED_GPU_SENSOR_CONFIG_HASH,
    )
    with pytest.raises(ClipError, match="canonical-analytic"):
        check_clip(directory)


def test_cosmos_v2_accepts_renderer_identity_before_media_checks(tmp_path: Path):
    analytic = tmp_path / "analytic"
    analytic_dir = analytic / "clip-episode-front-camera-0"
    _cosmos_clip(
        analytic_dir,
        version=2,
        renderer=dict(ANALYTIC_RENDERER),
        backend_version=GPU_SENSOR_VERSION,
        backend_hash=GPU_SENSOR_CONFIG_HASH,
    )
    with pytest.raises(ClipError, match="depth hash|SHA-256|ffprobe|frame"):
        check_clip(analytic_dir)
    pbr = tmp_path / "pbr"
    pbr_dir = pbr / "clip-episode-front-camera-0"
    _cosmos_clip(
        pbr_dir,
        version=2,
        renderer={"id": "pbr-mesh", "version": 1},
        backend_version=ROUTED_GPU_SENSOR_VERSION,
        backend_hash=ROUTED_GPU_SENSOR_CONFIG_HASH,
    )
    with pytest.raises(ClipError) as caught:
        check_clip(pbr_dir)
    assert "canonical-analytic" not in str(caught.value)
    assert "v2" not in str(caught.value)


def _finished_run(root: Path, *, interrupted: bool | None) -> None:
    digest = "ab" * 32
    results = {
        "kind": "cev-sim.run-result",
        "version": 1,
        "completed": True,
        "step": "363",
        "resolvedHash": digest,
        "simulationSemanticHash": digest,
    }
    if interrupted is not None:
        results["interrupted"] = interrupted
    (root / "run-bundle.json").write_text(json.dumps({
        "kind": "cev-sim.run-bundle",
        "version": 1,
        "resolvedHash": digest,
        "simulationSemanticHash": digest,
    }), encoding="utf-8")
    (root / "run-results.json").write_text(json.dumps(results), encoding="utf-8")
    (root / "provenance.json").write_text(json.dumps({
        "kind": "cev-sim.headless.provenance",
        "version": 1,
    }), encoding="utf-8")


def test_finished_reference_run_may_omit_interrupted(tmp_path: Path):
    _finished_run(tmp_path, interrupted=None)
    _bundle, results, _provenance = load_run(tmp_path, require_full_cosmos=True)
    assert results["completed"] is True
    assert "interrupted" not in results


def test_explicitly_interrupted_run_is_rejected(tmp_path: Path):
    _finished_run(tmp_path, interrupted=True)
    with pytest.raises(ClipError, match="did not complete"):
        load_run(tmp_path)
