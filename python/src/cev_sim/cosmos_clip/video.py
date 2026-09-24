"""ffmpeg encoding for the Cosmos clip's RGB reference and depth visualization."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

from cev_sim.clip.video import (
    assert_video_contract as assert_parameterized_video_contract,
)
from cev_sim.clip.video import (
    cosmos_depth_to_gray,
    probe_video,
    require_encoders,
    tool_version,
)
from cev_sim.clip.video import (
    encode_videos as encode_parameterized_videos,
)

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
)


def depth_to_gray(depth: np.ndarray) -> np.ndarray:
    """Map axial meters to the Nano control visualization."""
    return cosmos_depth_to_gray(depth, far_m=DEPTH_FAR_M)


def encode_videos(
    directory: Path,
    rgb: bytes,
    depth: np.ndarray,
    *,
    runner=subprocess.run,
    ffmpeg: str = "ffmpeg",
) -> None:
    encode_parameterized_videos(
        directory,
        rgb,
        depth,
        runner=runner,
        ffmpeg=ffmpeg,
        rgb_arguments=RGB_FFMPEG_ARGUMENTS,
        depth_arguments=DEPTH_FFMPEG_ARGUMENTS,
        depth_mode="cosmos",
        far=DEPTH_FAR_M,
    )


def assert_video_contract(rgb: dict, depth: dict) -> None:
    assert_parameterized_video_contract(
        rgb,
        depth,
        width=WIDTH,
        height=HEIGHT,
        frame_count=FRAME_COUNT,
        frame_rate=f"{FRAME_RATE_NUMERATOR}/1",
        timescale=VIDEO_TIMESCALE,
        pts_delta=PTS_DELTA,
    )


__all__ = [
    "assert_video_contract",
    "depth_to_gray",
    "encode_videos",
    "probe_video",
    "require_encoders",
    "tool_version",
]
