"""Shared constants for a Cosmos 3 Nano transfer clip."""

from cev_sim.clip.contract import ClipError as ClipError

CLIP_KIND = "cev-sim.cosmos-clip"
CLIP_VERSION = 1
FRAME_COUNT = 121
WIDTH = 1280
HEIGHT = 720
FRAME_RATE_NUMERATOR = 30
FRAME_RATE_DENOMINATOR = 1
CAPTURE_INTERVAL_NS = 33_333_333
RGB_FRAME_BYTES = WIDTH * HEIGHT * 4
DEPTH_FRAME_VALUES = WIDTH * HEIGHT
DEPTH_FRAME_BYTES = DEPTH_FRAME_VALUES * 4
DEPTH_F32_BYTES = FRAME_COUNT * DEPTH_FRAME_BYTES
DEPTH_FAR_M = 200.0
VIDEO_TIMESCALE = 30_000
PTS_DELTA = VIDEO_TIMESCALE // FRAME_RATE_NUMERATOR
ANALYTIC_RENDERER = {"id": "canonical-analytic", "version": 1}
FILENAMES = (
    "rgb.mp4",
    "depth.mp4",
    "depth.f32",
    "camera_info.json",
    "clip.json",
    "frames.jsonl",
)

RGB_FFMPEG_ARGUMENTS = (
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", f"{WIDTH}x{HEIGHT}",
    "-framerate", str(FRAME_RATE_NUMERATOR),
    "-i", "pipe:0",
    "-frames:v", str(FRAME_COUNT),
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-fps_mode", "cfr",
    "-video_track_timescale", str(VIDEO_TIMESCALE),
)
DEPTH_FFMPEG_ARGUMENTS = (
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "-s", f"{WIDTH}x{HEIGHT}",
    "-framerate", str(FRAME_RATE_NUMERATOR),
    "-i", "pipe:0",
    "-frames:v", str(FRAME_COUNT),
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", "0",
    "-fps_mode", "cfr",
    "-video_track_timescale", str(VIDEO_TIMESCALE),
)
DEPTH_VISUALIZATION = {
    "invalidLevel": 0,
    "rangeMeters": [0, DEPTH_FAR_M],
    "mapping": "invalid or non-positive depth maps to 0; otherwise 1 + round(254 * clamp(depth / 200, 0, 1))",
    "round": "half-away-from-zero",
    "encoding": "gray8",
    "pixelFormat": "yuv420p",
    "crf": 0,
}


def clip_directory_name(episode_hash: str, camera_id: str, window_index: int) -> str:
    return f"clip-{episode_hash}-{camera_id}-{window_index}"
