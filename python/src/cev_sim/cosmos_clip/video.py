"""ffmpeg encoding for the clip's RGB reference and depth visualization."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np

from .contract import (
    DEPTH_FAR_M,
    DEPTH_FFMPEG_ARGUMENTS,
    FRAME_COUNT,
    FRAME_RATE_NUMERATOR,
    HEIGHT,
    PTS_DELTA,
    RGB_FFMPEG_ARGUMENTS,
    VIDEO_TIMESCALE,
    WIDTH,
    ClipError,
)


def tool_version(executable: str) -> str:
    binary = shutil.which(executable)
    if not binary:
        raise ClipError(f"{executable} is not on PATH.")
    result = subprocess.run([binary, "-version"], check=False, capture_output=True, text=True)
    if result.returncode != 0 or not result.stdout:
        detail = (result.stderr or result.stdout or f"{executable} failed").strip()
        raise ClipError(f"{executable} is not usable: {detail}")
    return result.stdout.splitlines()[0].strip()


def require_encoders() -> dict[str, str]:
    return {"ffmpeg": tool_version("ffmpeg"), "ffprobe": tool_version("ffprobe")}


def depth_to_gray(depth: np.ndarray) -> np.ndarray:
    """Map axial meters to the Nano control visualization."""
    level = np.zeros(depth.shape, dtype=np.uint8)
    valid = np.isfinite(depth) & (depth > 0)
    if not np.any(valid):
        return level
    scaled = np.clip(depth[valid] / DEPTH_FAR_M, 0.0, 1.0)
    quantized = np.trunc(254.0 * scaled + 0.5).astype(np.uint16)
    level[valid] = (1 + quantized).astype(np.uint8)
    return level


def _feed(executable: str, arguments: tuple[str, ...], output: Path, frames: bytes, runner) -> None:
    result = runner(
        [executable, "-hide_banner", "-loglevel", "error", "-y", *arguments, str(output)],
        input=frames,
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        detail_raw = result.stderr or b""
        if isinstance(detail_raw, bytes):
            detail = detail_raw.decode("utf-8", errors="replace").strip()
        else:
            detail = str(detail_raw).strip()
        raise ClipError(f"ffmpeg failed for {output.name}: {detail or result.returncode}")


def encode_videos(
    directory: Path,
    rgb: bytes,
    depth: np.ndarray,
    *,
    runner=subprocess.run,
    ffmpeg: str = "ffmpeg",
) -> None:
    gray = depth_to_gray(depth)
    _feed(ffmpeg, RGB_FFMPEG_ARGUMENTS, directory / "rgb.mp4", rgb, runner)
    _feed(
        ffmpeg,
        DEPTH_FFMPEG_ARGUMENTS,
        directory / "depth.mp4",
        np.ascontiguousarray(gray).tobytes(),
        runner,
    )


def probe_video(path: Path, *, runner=subprocess.run, ffprobe: str = "ffprobe") -> dict:
    result = runner(
        [
            ffprobe, "-hide_banner", "-loglevel", "error", "-count_frames",
            "-show_entries",
            "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,pix_fmt,time_base,nb_read_frames",
            "-show_entries", "frame=pts",
            "-of", "json",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or "").strip()
        raise ClipError(f"ffprobe failed for {path.name}: {detail or result.returncode}")
    parsed = json.loads(result.stdout or "{}")
    streams = parsed.get("streams") or []
    video = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if len(video) != 1 or audio:
        raise ClipError(f"{path.name} must contain one video stream and no audio.")
    stream = video[0]
    pts = [int(frame["pts"]) for frame in parsed.get("frames") or []]
    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "frameRate": stream.get("r_frame_rate"),
        "averageFrameRate": stream.get("avg_frame_rate"),
        "pixelFormat": stream.get("pix_fmt"),
        "timeBase": stream.get("time_base"),
        "frames": int(stream.get("nb_read_frames") or len(pts)),
        "pts": pts,
    }


def assert_video_contract(rgb: dict, depth: dict) -> None:
    for label, probe in (("rgb.mp4", rgb), ("depth.mp4", depth)):
        if probe["width"] != WIDTH or probe["height"] != HEIGHT:
            raise ClipError(f"{label} is {probe['width']}x{probe['height']}.")
        if probe["frames"] != FRAME_COUNT or len(probe["pts"]) != FRAME_COUNT:
            raise ClipError(f"{label} does not contain {FRAME_COUNT} frames.")
        rate = f"{FRAME_RATE_NUMERATOR}/1"
        if probe["frameRate"] != rate or probe["averageFrameRate"] != rate:
            raise ClipError(f"{label} frame rate is not 30/1.")
        if probe["pixelFormat"] != "yuv420p":
            raise ClipError(f"{label} pixel format is not yuv420p.")
        if probe["timeBase"] != f"1/{VIDEO_TIMESCALE}":
            raise ClipError(f"{label} time base is not 1/{VIDEO_TIMESCALE}.")
        deltas = {probe["pts"][index + 1] - probe["pts"][index] for index in range(FRAME_COUNT - 1)}
        if deltas != {PTS_DELTA}:
            raise ClipError(f"{label} presentation timestamps are not CFR at timescale {VIDEO_TIMESCALE}.")
    if rgb["pts"] != depth["pts"]:
        raise ClipError("RGB and depth presentation timestamps differ.")
