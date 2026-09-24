"""Shared camera-clip contract."""

CLIP_KIND = "cev-sim.camera-clip"
CLIP_VERSION = 1
FILENAMES = (
    "rgb.mp4",
    "depth.mp4",
    "depth.f32",
    "camera_info.json",
    "clip.json",
    "frames.jsonl",
)
GENERIC_DEPTH_VISUALIZATION = {
    "invalidLevel": 0,
    "mapping": (
        "invalid or non-positive depth maps to 0; otherwise "
        "round(255 * (1 - clamp((depth - near) / (far - near), 0, 1)))"
    ),
    "round": "half-away-from-zero",
    "encoding": "gray8",
    "pixelFormat": "yuv420p",
    "crf": 0,
}


class ClipError(Exception):
    """A clip export or check rejection."""


def clip_directory_name(episode_hash: str, camera_id: str, window_index: int) -> str:
    return f"clip-{episode_hash}-{camera_id}-{window_index}"
