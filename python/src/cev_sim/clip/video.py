"""ffmpeg encoding shared by generic camera clips and Cosmos clips."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np

from cev_sim.clip.contract import ClipError


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


def cosmos_depth_to_gray(depth: np.ndarray, *, far_m: float = 200.0) -> np.ndarray:
    """Map axial meters to the Nano control visualization."""
    level = np.zeros(depth.shape, dtype=np.uint8)
    valid = np.isfinite(depth) & (depth > 0)
    if not np.any(valid):
        return level
    scaled = np.clip(depth[valid] / far_m, 0.0, 1.0)
    quantized = np.trunc(254.0 * scaled + 0.5).astype(np.uint16)
    level[valid] = (1 + quantized).astype(np.uint8)
    return level


def generic_depth_to_gray(depth: np.ndarray, *, near: float, far: float) -> np.ndarray:
    """Near maps to white and far maps to black. Invalid samples stay black."""
    level = np.zeros(depth.shape, dtype=np.uint8)
    valid = np.isfinite(depth) & (depth > 0)
    if not np.any(valid):
        return level
    span = max(float(far) - float(near), 1e-9)
    scaled = np.clip((depth[valid] - float(near)) / span, 0.0, 1.0)
    level[valid] = np.trunc(255.0 * (1.0 - scaled) + 0.5).astype(np.uint8)
    return level


def ffmpeg_arguments(
    *,
    width: int,
    height: int,
    frame_count: int,
    frame_rate: int,
    timescale: int,
    pix_fmt: str,
    crf: int,
) -> tuple[str, ...]:
    return (
        "-f", "rawvideo",
        "-pix_fmt", pix_fmt,
        "-s", f"{width}x{height}",
        "-framerate", str(frame_rate),
        "-i", "pipe:0",
        "-frames:v", str(frame_count),
        "-an",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", str(crf),
        "-fps_mode", "cfr",
        "-video_track_timescale", str(timescale),
    )


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
    rgb_arguments: tuple[str, ...] | None = None,
    depth_arguments: tuple[str, ...] | None = None,
    depth_mode: str = "generic",
    near: float = 0.1,
    far: float = 200.0,
    width: int | None = None,
    height: int | None = None,
    frame_count: int | None = None,
    frame_rate: int = 30,
    timescale: int = 30_000,
) -> None:
    if depth_mode == "cosmos":
        gray = cosmos_depth_to_gray(depth, far_m=far)
    else:
        gray = generic_depth_to_gray(depth, near=near, far=far)
    count = frame_count if frame_count is not None else int(depth.shape[0]) if depth.ndim > 1 else 1
    resolved_width = width or (int(depth.shape[-1] ** 0.5) if False else None)
    if rgb_arguments is None or depth_arguments is None:
        if width is None or height is None:
            raise ClipError("Video encoding requires width and height.")
        rgb_arguments = rgb_arguments or ffmpeg_arguments(
            width=width, height=height, frame_count=count, frame_rate=frame_rate,
            timescale=timescale, pix_fmt="rgba", crf=18,
        )
        depth_arguments = depth_arguments or ffmpeg_arguments(
            width=width, height=height, frame_count=count, frame_rate=frame_rate,
            timescale=timescale, pix_fmt="gray", crf=0,
        )
    _ = resolved_width
    _feed(ffmpeg, rgb_arguments, directory / "rgb.mp4", rgb, runner)
    _feed(ffmpeg, depth_arguments, directory / "depth.mp4", np.ascontiguousarray(gray).tobytes(), runner)


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


def assert_video_contract(
    rgb: dict,
    depth: dict,
    *,
    width: int,
    height: int,
    frame_count: int,
    frame_rate: str,
    timescale: int,
    pts_delta: int,
) -> None:
    for label, probe in (("rgb.mp4", rgb), ("depth.mp4", depth)):
        if probe["width"] != width or probe["height"] != height:
            raise ClipError(f"{label} is {probe['width']}x{probe['height']}.")
        if probe["frames"] != frame_count or len(probe["pts"]) != frame_count:
            raise ClipError(f"{label} does not contain {frame_count} frames.")
        if probe["frameRate"] != frame_rate or probe["averageFrameRate"] != frame_rate:
            raise ClipError(f"{label} frame rate is not {frame_rate}.")
        if probe["pixelFormat"] != "yuv420p":
            raise ClipError(f"{label} pixel format is not yuv420p.")
        if probe["timeBase"] != f"1/{timescale}":
            raise ClipError(f"{label} time base is not 1/{timescale}.")
        if frame_count > 1:
            deltas = {probe["pts"][index + 1] - probe["pts"][index] for index in range(frame_count - 1)}
            if deltas != {pts_delta}:
                raise ClipError(f"{label} presentation timestamps are not CFR at timescale {timescale}.")
    if rgb["pts"] != depth["pts"]:
        raise ClipError("RGB and depth presentation timestamps differ.")
