"""Validate a published Cosmos transfer clip."""

from __future__ import annotations

import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np

from cev_sim.config import GPU_SENSOR_CAPABILITY, GPU_SENSOR_CONFIG_HASH, GPU_SENSOR_VERSION

from .contract import (
    ANALYTIC_RENDERER,
    CAPTURE_INTERVAL_NS,
    CLIP_KIND,
    CLIP_VERSION,
    DEPTH_F32_BYTES,
    DEPTH_FRAME_VALUES,
    FILENAMES,
    FRAME_COUNT,
    HEIGHT,
    RGB_FRAME_BYTES,
    WIDTH,
    ClipError,
    clip_directory_name,
)
from .video import assert_video_contract, probe_video


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def depth_statistics(depth: np.ndarray) -> dict:
    valid = np.isfinite(depth) & (depth > 0)
    count = int(np.count_nonzero(valid))
    if count == 0:
        return {"depthValidCount": 0, "depthValidFraction": 0.0, "depthMin": None, "depthMax": None}
    values = depth[valid]
    return {
        "depthValidCount": count,
        "depthValidFraction": count / int(depth.size),
        "depthMin": float(np.min(values)),
        "depthMax": float(np.max(values)),
    }


def _reject(errors: list[str], message: str) -> None:
    errors.append(message)


def _load_json(path: Path, errors: list[str]):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        _reject(errors, f"{path.name} is not UTF-8 JSON: {error}")
        return None


def check_clip(
    path: Path,
    *,
    published_name: str | None = None,
    probe=probe_video,
    decode_rgb=None,
) -> dict:
    """Return the machine-readable summary or raise ClipError."""
    directory = Path(path)
    errors: list[str] = []
    names = {entry.name for entry in directory.iterdir()} if directory.is_dir() else set()
    if not directory.is_dir():
        raise ClipError(f"{directory} is not a clip directory.")
    missing = [name for name in FILENAMES if name not in names]
    extra = sorted(names - set(FILENAMES))
    if missing or extra:
        raise ClipError(f"Clip filenames must be exactly {', '.join(FILENAMES)}.")
    clip = _load_json(directory / "clip.json", errors)
    camera = _load_json(directory / "camera_info.json", errors)
    if errors or not isinstance(clip, dict) or not isinstance(camera, dict):
        raise ClipError("; ".join(errors))
    if clip.get("kind") != CLIP_KIND or clip.get("version") != CLIP_VERSION:
        _reject(errors, "clip.json kind or version is not cev-sim.cosmos-clip v1.")
    expected_name = clip_directory_name(
        str(clip.get("episodeHash") or ""),
        str(clip.get("cameraId") or ""),
        int(clip.get("windowIndex") if isinstance(clip.get("windowIndex"), int) else -1),
    )
    actual_name = published_name or directory.name
    if actual_name != expected_name:
        _reject(errors, f"Directory name {actual_name} does not match {expected_name}.")
    if clip.get("frameCount") != FRAME_COUNT or clip.get("width") != WIDTH or clip.get("height") != HEIGHT:
        _reject(errors, "clip.json geometry is not 1280x720 for 121 frames.")
    renderer = clip.get("renderer")
    resolved_renderer = clip.get("resolvedRenderer")
    if renderer != ANALYTIC_RENDERER or resolved_renderer != ANALYTIC_RENDERER:
        _reject(errors, "Renderer identity is not the resolved canonical-analytic v1 branch.")
    backend = clip.get("backend") or {}
    if backend.get("capabilityId") != GPU_SENSOR_CAPABILITY or str(backend.get("version")) != GPU_SENSOR_VERSION:
        _reject(errors, "GPU backend is not chromium-webgl2-rendered-sensors v1.")
    if backend.get("configHash") != GPU_SENSOR_CONFIG_HASH:
        _reject(errors, "GPU backend config hash does not match the resolver.")
    noise = clip.get("noise") or {}
    if noise.get("model") != "none" or any(float(noise.get(key) or 0) != 0 for key in (
        "standardDeviation", "bias", "dropoutProbability",
    )):
        _reject(errors, "Clip noise and dropout must be zero.")
    if camera.get("distortionModel") != "none" or any(float(value) != 0 for value in camera.get("distortion") or []):
        _reject(errors, "Distortion model must be none with zero coefficients.")
    if not camera.get("distortion") and camera.get("distortion") != []:
        _reject(errors, "Distortion coefficients must be present and zero.")
    timing = clip.get("timing") or {}
    if timing.get("captureIntervalNs") != CAPTURE_INTERVAL_NS:
        _reject(errors, "Capture interval is not 33333333 ns.")

    records = []
    try:
        lines = (directory / "frames.jsonl").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise ClipError(f"frames.jsonl is unreadable: {error}") from error
    if len(lines) != FRAME_COUNT:
        _reject(errors, f"frames.jsonl has {len(lines)} records.")
    else:
        for index, line in enumerate(lines):
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                _reject(errors, f"frames.jsonl line {index} is not JSON.")
                continue
            records.append(record)
            if record.get("index") != index:
                _reject(errors, f"Frame {index} is not indexed in order.")
            if record.get("rgbByteLength") != RGB_FRAME_BYTES or record.get("depthValueCount") != DEPTH_FRAME_VALUES:
                _reject(errors, f"Frame {index} does not have the 1280x720 raw sizes.")
    if len(records) == FRAME_COUNT:
        try:
            stamps = [int(record["captureTimeNs"]) for record in records]
            steps = [int(record["simulationStep"]) for record in records]
            samples = [int(record["sampleIndex"]) for record in records]
        except (KeyError, TypeError, ValueError):
            _reject(errors, "Frame records are missing capture time, sample index, or simulation step.")
        else:
            deltas = {stamps[index + 1] - stamps[index] for index in range(FRAME_COUNT - 1)}
            if deltas != {CAPTURE_INTERVAL_NS}:
                _reject(errors, "Capture timestamps do not increase by exactly 33333333 ns.")
            if len(set(stamps)) != FRAME_COUNT:
                _reject(errors, "Capture timestamps contain a duplicate.")
            if samples != list(range(samples[0], samples[0] + FRAME_COUNT)):
                _reject(errors, "Sample indices are not consecutive.")
            if steps != list(range(steps[0], steps[0] + FRAME_COUNT * 3, 3)):
                _reject(errors, "Simulation steps are not the 3-step capture grid.")
    if errors:
        raise ClipError("; ".join(errors))

    depth_path = directory / "depth.f32"
    depth_bytes = depth_path.read_bytes()
    if len(depth_bytes) != DEPTH_F32_BYTES:
        raise ClipError(f"depth.f32 is {len(depth_bytes)} bytes.")
    depth = np.frombuffer(depth_bytes, dtype="<f4").reshape(FRAME_COUNT, DEPTH_FRAME_VALUES).copy()
    raw_depth_hash = sha256_file(depth_path)
    hashes = clip.get("hashes") or {}
    if hashes.get("depthRawSha256") != raw_depth_hash:
        _reject(errors, "Aggregate depth hash does not match depth.f32.")
    valid_counts = []
    minima = []
    maxima = []
    if len(records) == FRAME_COUNT:
        for index, record in enumerate(records):
            frame = depth[index]
            stats = depth_statistics(frame)
            frame_hash = sha256_bytes(np.ascontiguousarray(frame).astype("<f4").tobytes())
            if record.get("depthSha256") != frame_hash or record.get("depthByteLength") != frame.nbytes:
                _reject(errors, f"Frame {index} depth hash does not match depth.f32.")
            if record.get("depthValidCount") != stats["depthValidCount"]:
                _reject(errors, f"Frame {index} depth statistics do not match depth.f32.")
            if stats["depthValidCount"] == 0:
                _reject(errors, f"Frame {index} has no finite positive depth.")
            else:
                valid_counts.append(stats["depthValidCount"])
                minima.append(stats["depthMin"])
                maxima.append(stats["depthMax"])
                if not math.isclose(float(record.get("depthMin")), stats["depthMin"], rel_tol=0, abs_tol=0):
                    _reject(errors, f"Frame {index} depth minimum does not match depth.f32.")
                if not math.isclose(float(record.get("depthMax")), stats["depthMax"], rel_tol=0, abs_tol=0):
                    _reject(errors, f"Frame {index} depth maximum does not match depth.f32.")
    file_hashes = {name: sha256_file(directory / name) for name in FILENAMES if name != "clip.json"}
    recorded_files = (clip.get("files") or {})
    for name, digest in file_hashes.items():
        if recorded_files.get(name) != digest:
            _reject(errors, f"Recorded SHA-256 for {name} does not match the file.")

    if not errors:
        rgb_probe = probe(directory / "rgb.mp4")
        depth_probe = probe(directory / "depth.mp4")
        assert_video_contract(rgb_probe, depth_probe)
        decoded = (decode_rgb or _decode_rgb)(directory / "rgb.mp4")
        if len(decoded) != FRAME_COUNT * RGB_FRAME_BYTES:
            _reject(errors, "Decoded RGB video does not contain 121 raw frames.")
        else:
            for index in range(FRAME_COUNT):
                frame = decoded[index * RGB_FRAME_BYTES:(index + 1) * RGB_FRAME_BYTES]
                color = frame.reshape(HEIGHT, WIDTH, 4)[:, :, :3]
                if int(color.max()) == 0:
                    _reject(errors, f"Decoded RGB frame {index} has no color.")
    if errors:
        raise ClipError("; ".join(errors))
    valid_total = sum(valid_counts)
    return {
        "ok": True,
        "frameCount": FRAME_COUNT,
        "width": WIDTH,
        "height": HEIGHT,
        "frameRate": "30/1",
        "timestampDeltaNs": [CAPTURE_INTERVAL_NS],
        "files": {**file_hashes, "clip.json": sha256_file(directory / "clip.json")},
        "validDepthFraction": valid_total / (FRAME_COUNT * DEPTH_FRAME_VALUES),
        "depthRange": [min(minima), max(maxima)],
    }


def _decode_rgb(path: Path) -> np.ndarray:
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
        ],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ClipError(f"Could not decode rgb.mp4: {detail or result.returncode}")
    return np.frombuffer(result.stdout, dtype=np.uint8)
