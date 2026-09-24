"""Validate a published generic camera clip."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from cev_sim.clip.contract import CLIP_KIND, CLIP_VERSION, FILENAMES, ClipError, clip_directory_name
from cev_sim.clip.video import assert_video_contract, probe_video
from cev_sim.cosmos_clip.check import depth_statistics, sha256_bytes, sha256_file


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
) -> dict:
    directory = Path(path)
    if not directory.is_dir():
        raise ClipError(f"{directory} is not a clip directory.")
    names = {entry.name for entry in directory.iterdir()}
    missing = [name for name in FILENAMES if name not in names]
    extra = sorted(names - set(FILENAMES))
    if missing or extra:
        raise ClipError(f"Clip filenames must be exactly {', '.join(FILENAMES)}.")
    errors: list[str] = []
    clip = _load_json(directory / "clip.json", errors)
    camera = _load_json(directory / "camera_info.json", errors)
    if errors or not isinstance(clip, dict) or not isinstance(camera, dict):
        raise ClipError("; ".join(errors))
    if clip.get("kind") != CLIP_KIND or clip.get("version") != CLIP_VERSION:
        _reject(errors, "clip.json kind or version is not cev-sim.camera-clip v1.")
    frame_count = int(clip.get("frameCount") or 0)
    width = int(clip.get("width") or 0)
    height = int(clip.get("height") or 0)
    expected_name = clip_directory_name(
        str(clip.get("episodeHash") or ""),
        str(clip.get("cameraId") or ""),
        int(clip.get("windowIndex") if isinstance(clip.get("windowIndex"), int) else -1),
    )
    if (published_name or directory.name) != expected_name:
        _reject(errors, f"Directory name {published_name or directory.name} does not match {expected_name}.")
    if frame_count < 1 or width < 1 or height < 1:
        _reject(errors, "clip.json geometry is invalid.")
    requested = clip.get("requestedDurationNs")
    actual = clip.get("actualDurationNs")
    if not isinstance(requested, int) or not isinstance(actual, int) or actual > requested:
        _reject(errors, "Requested duration must cover the actual capture duration.")
    timing = clip.get("timing") or {}
    records = []
    try:
        lines = (directory / "frames.jsonl").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise ClipError(f"frames.jsonl is unreadable: {error}") from error
    if len(lines) != frame_count:
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
            if record.get("rgbByteLength") != width * height * 4 or record.get("depthValueCount") != width * height:
                _reject(errors, f"Frame {index} does not match the clip dimensions.")
    if len(records) == frame_count and frame_count:
        try:
            stamps = [int(record["captureTimeNs"]) for record in records]
            samples = [int(record["sampleIndex"]) for record in records]
        except (KeyError, TypeError, ValueError):
            _reject(errors, "Frame records are missing capture time or sample index.")
        else:
            if len(set(stamps)) != frame_count:
                _reject(errors, "Capture timestamps contain a duplicate.")
            if stamps[0] != timing.get("firstCaptureTimeNs") or stamps[-1] != timing.get("lastCaptureTimeNs"):
                _reject(errors, "Capture timestamps do not match clip timing.")
            if stamps[-1] != actual:
                _reject(errors, "Actual duration does not match the last capture.")
            if samples != list(range(frame_count)):
                _reject(errors, "Sample indices are not consecutive.")
            if frame_count > 1 and timing.get("captureIntervalNs") != stamps[1] - stamps[0]:
                _reject(errors, "Capture interval does not match the first timestamp delta.")
    if errors:
        raise ClipError("; ".join(errors))
    depth_bytes = (directory / "depth.f32").read_bytes()
    expected_bytes = frame_count * width * height * 4
    if len(depth_bytes) != expected_bytes:
        raise ClipError(f"depth.f32 is {len(depth_bytes)} bytes.")
    depth = np.frombuffer(depth_bytes, dtype="<f4").reshape(frame_count, width * height).copy()
    if (clip.get("hashes") or {}).get("depthRawSha256") != sha256_file(directory / "depth.f32"):
        _reject(errors, "Aggregate depth hash does not match depth.f32.")
    valid_counts = []
    minima = []
    maxima = []
    for index, record in enumerate(records):
        frame = depth[index]
        stats = depth_statistics(frame)
        frame_hash = sha256_bytes(np.ascontiguousarray(frame).astype("<f4").tobytes())
        if record.get("depthSha256") != frame_hash:
            _reject(errors, f"Frame {index} depth hash does not match depth.f32.")
        if stats["depthValidCount"] == 0:
            _reject(errors, f"Frame {index} has no finite positive depth.")
        else:
            valid_counts.append(stats["depthValidCount"])
            minima.append(stats["depthMin"])
            maxima.append(stats["depthMax"])
            if not math.isclose(float(record.get("depthMin")), stats["depthMin"], rel_tol=0, abs_tol=0):
                _reject(errors, f"Frame {index} depth minimum does not match depth.f32.")
    file_hashes = {name: sha256_file(directory / name) for name in FILENAMES if name != "clip.json"}
    recorded_files = clip.get("files") or {}
    for name, digest in file_hashes.items():
        if recorded_files.get(name) != digest:
            _reject(errors, f"Recorded SHA-256 for {name} does not match the file.")
    if errors:
        raise ClipError("; ".join(errors))
    rate = clip.get("frameRate") or {}
    numerator = int(rate.get("numerator") or 0)
    timescale = int(timing.get("timescale") or 0)
    pts_delta = int(timing.get("ptsDelta") or 0)
    rgb_probe = probe(directory / "rgb.mp4")
    depth_probe = probe(directory / "depth.mp4")
    assert_video_contract(
        rgb_probe,
        depth_probe,
        width=width,
        height=height,
        frame_count=frame_count,
        frame_rate=f"{numerator}/1",
        timescale=timescale,
        pts_delta=pts_delta,
    )
    valid_total = sum(valid_counts)
    return {
        "ok": True,
        "frameCount": frame_count,
        "width": width,
        "height": height,
        "frameRate": f"{numerator}/1",
        "requestedDurationNs": requested,
        "actualDurationNs": actual,
        "files": {**file_hashes, "clip.json": sha256_file(directory / "clip.json")},
        "validDepthFraction": valid_total / (frame_count * width * height),
        "depthRange": [min(minima), max(maxima)] if minima else [None, None],
    }
