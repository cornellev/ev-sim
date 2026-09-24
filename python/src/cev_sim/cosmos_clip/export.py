"""Export one validated RGB/depth clip from a finalized headless run."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from cev_sim.config import GPU_SENSOR_CAPABILITY, GPU_SENSOR_CONFIG_HASH, GPU_SENSOR_VERSION

from .check import check_clip, depth_statistics, sha256_bytes, sha256_file
from .contract import (
    ANALYTIC_RENDERER,
    CAPTURE_INTERVAL_NS,
    CLIP_KIND,
    CLIP_VERSION,
    DEPTH_FFMPEG_ARGUMENTS,
    DEPTH_FRAME_BYTES,
    DEPTH_VISUALIZATION,
    FRAME_COUNT,
    FRAME_RATE_DENOMINATOR,
    FRAME_RATE_NUMERATOR,
    HEIGHT,
    RGB_FFMPEG_ARGUMENTS,
    RGB_FRAME_BYTES,
    WIDTH,
    ClipError,
    clip_directory_name,
)
from .sflog import Update, read_sflog
from .video import encode_videos, require_encoders

STEP_NS = 11_111_111
PERIOD_STEPS = 3


@dataclass
class CapturedFrame:
    stamp_ns: int
    sample_index: int
    simulation_step: int
    rgb: bytes
    depth: bytes
    info: dict


def _load_json(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ClipError(f"{label} is not readable JSON: {error}") from error
    if not isinstance(value, dict):
        raise ClipError(f"{label} must be a JSON object.")
    return value


def _js_round(value: float) -> int:
    if value >= 0:
        return int(math.floor(value + 0.5))
    return int(math.ceil(value - 0.5))


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ClipError(message)


def load_run(run_output: Path) -> tuple[dict, dict, dict]:
    root = Path(run_output)
    bundle = _load_json(root / "run-bundle.json", "run-bundle.json")
    results = _load_json(root / "run-results.json", "run-results.json")
    provenance = _load_json(root / "provenance.json", "provenance.json")
    _require(
        bundle.get("kind") == "cev-sim.run-bundle" and bundle.get("version") == 1,
        "run-bundle.json is not a v1 run bundle.",
    )
    _require(
        results.get("kind") == "cev-sim.run-result" and results.get("version") == 1,
        "run-results.json is not a v1 run result.",
    )
    _require(
        provenance.get("kind") == "cev-sim.headless.provenance" and provenance.get("version") == 1,
        "provenance.json is not v1 headless provenance.",
    )
    _require(results.get("completed") is True and results.get("interrupted") is not True, "The run did not complete.")
    _require(int(results.get("step") or 0) >= 363, "The run ended before the clip's last capture step.")
    _require(bundle.get("resolvedHash") == results.get("resolvedHash"), "Resolved hash does not match the run result.")
    _require(
        bundle.get("simulationSemanticHash") == results.get("simulationSemanticHash"),
        "Simulation semantic hash does not match the run result.",
    )
    return bundle, results, provenance


def _camera(bundle: dict, camera_id: str) -> dict:
    resolved = bundle.get("resolved") or {}
    manifest = resolved.get("manifest") or {}
    sensors = ((manifest.get("sensorRig") or {}).get("sensors") or [])
    camera = next((
        sensor for sensor in sensors
        if sensor.get("id") == camera_id and sensor.get("type") == "camera"
    ), None)
    _require(camera is not None, f"Resolved run has no camera {camera_id}.")
    calibration = camera.get("calibration") or {}
    intrinsics = calibration.get("intrinsics") or {}
    products = calibration.get("products") or {}
    provider = (camera.get("render") or {}).get("provider") or {}
    width = int(calibration.get("width") or 0)
    height = int(calibration.get("height") or 0)
    _require(width == WIDTH and height == HEIGHT, "Camera geometry is not 1280x720.")
    _require(
        provider.get("id") == ANALYTIC_RENDERER["id"] and int(provider.get("version") or 0) == 1,
        "Camera renderer is not canonical-analytic v1.",
    )
    enabled = products.get("rgb") is True and products.get("depth") is True and products.get("cameraInfo") is True
    _require(enabled, "RGB, depth, and CameraInfo must be enabled.")
    for name in ("semantic", "instance", "detections2d", "detections3d", "lanes", "trafficControls", "diagnostics"):
        _require(products.get(name) is False, f"Camera product {name} must be disabled.")
    noise = camera.get("noise") or {}
    _require(noise.get("model") == "none", "Camera noise model must be none.")
    quiet = all(float(noise.get(key) or 0) == 0 for key in ("standardDeviation", "bias", "dropoutProbability"))
    _require(quiet, "Camera noise and dropout must be zero.")
    _require(calibration.get("distortionModel") == "none", "Camera distortion model must be none.")
    coefficients = calibration.get("distortion") or []
    _require(all(float(value) == 0 for value in coefficients), "Camera distortion coefficients must be zero.")
    clock = manifest.get("clock") or {}
    _require(int(clock.get("stepNs") or 0) == STEP_NS, "Simulation step is not 11111111 ns.")
    logging_policy = manifest.get("logging") or {}
    _require(logging_policy.get("policy") == "required", "Logging policy must retain the sensor log.")
    _require(
        logging_policy.get("profileId") == "simulation-run-full-sensors",
        "Logging profile must be simulation-run-full-sensors.",
    )
    _require(math.isclose(float(intrinsics.get("fx")), float(intrinsics.get("fy"))), "fx and fy must match.")
    return camera


def _gpu_backend(provenance: dict) -> dict:
    selections = provenance.get("backendSelections") or []
    selected = next((entry for entry in selections if int(entry.get("kind") or 0) == 4), None)
    _require(selected is not None, "Provenance has no GPU sensor backend.")
    _require(
        selected.get("capabilityId") == GPU_SENSOR_CAPABILITY,
        "GPU backend is not chromium-webgl2-rendered-sensors.",
    )
    _require(str(selected.get("version")) == GPU_SENSOR_VERSION, "GPU backend version is not v1.")
    _require(
        selected.get("configHash") == GPU_SENSOR_CONFIG_HASH,
        "GPU backend config hash does not match the resolver.",
    )
    return selected


def _descriptor_agrees(update: Update, stamp_ns: int, sample_index: int, step: int) -> None:
    metadata = update.metadata
    try:
        recorded_stamp = int(metadata["captureTimeNs"])
        recorded_sample = int(metadata["sequenceId"])
        recorded_step = int(metadata["captureStep"])
    except (KeyError, TypeError, ValueError) as error:
        raise ClipError(f"{update.path} is missing capture descriptor metadata.") from error
    _require(recorded_stamp == stamp_ns, f"{update.path} descriptor stamp does not match its header.")
    _require(recorded_sample == sample_index, f"{update.path} descriptor sample index does not match the capture.")
    _require(recorded_step == step, f"{update.path} descriptor capture step does not match the update cycle.")


def pair_camera_frames(updates: list[Update], camera_id: str) -> list[CapturedFrame]:
    paths = {
        "rgb": f"devices.{camera_id}.image",
        "depth": f"devices.{camera_id}.depth",
        "info": f"devices.{camera_id}.cameraInfo",
    }
    grouped: dict[str, dict[int, Update]] = {key: {} for key in paths}
    for update in updates:
        role = next((key for key, path in paths.items() if update.path == path), None)
        if role is None or update.message is None:
            continue
        stamp = int(update.message["stampNs"])
        _require(stamp not in grouped[role], f"Duplicate {role} capture at {stamp} ns.")
        _require(update.time_us == _js_round(stamp / 1000), f"{role} log time does not match its header stamp.")
        on_grid = stamp % STEP_NS == 0 and update.cycle == stamp // STEP_NS
        _require(on_grid, f"{role} capture is not on the simulation step grid.")
        grouped[role][stamp] = update
    stamps = sorted(grouped["rgb"])
    _require(stamps, f"SFLog has no {paths['rgb']} samples.")
    frames: list[CapturedFrame] = []
    for ordinal, stamp in enumerate(stamps):
        rgb = grouped["rgb"][stamp]
        depth = grouped["depth"].get(stamp)
        info = grouped["info"].get(stamp)
        _require(depth is not None and info is not None, f"Capture {stamp} ns is missing depth or CameraInfo.")
        same_step = depth.cycle == rgb.cycle and info.cycle == rgb.cycle
        _require(same_step, f"Capture {stamp} ns products do not share a simulation step.")
        sample_index = ordinal
        if ordinal == 0:
            for update in (rgb, depth, info):
                _descriptor_agrees(update, stamp, sample_index, rgb.cycle)
        message = rgb.message or {}
        depth_message = depth.message or {}
        info_message = info.message or {}
        _require(message.get("encoding") == "rgba8", "RGB encoding is not rgba8.")
        _require(depth_message.get("encoding") == "32FC1", "Depth encoding is not 32FC1.")
        frames.append(CapturedFrame(
            stamp_ns=stamp,
            sample_index=sample_index,
            simulation_step=rgb.cycle,
            rgb=bytes(message.get("data") or b""),
            depth=bytes(depth_message.get("data") or b""),
            info=info_message,
        ))
    first = frames[0]
    _require(
        first.stamp_ns == CAPTURE_INTERVAL_NS and first.simulation_step == PERIOD_STEPS,
        "First capture is not at 33333333 ns.",
    )
    return frames


def select_window(frames: list[CapturedFrame], window_index: int) -> list[CapturedFrame]:
    _require(isinstance(window_index, int) and window_index >= 0, "Window index must be a non-negative integer.")
    start = window_index * FRAME_COUNT
    end = start + FRAME_COUNT
    _require(len(frames) >= end, f"Run ended before window {window_index}; found {len(frames)} captures.")
    chosen = frames[start:end]
    for index in range(1, FRAME_COUNT):
        previous = chosen[index - 1]
        current = chosen[index]
        _require(
            current.stamp_ns - previous.stamp_ns == CAPTURE_INTERVAL_NS,
            "Capture timestamps contain a gap or duplicate.",
        )
        _require(current.sample_index == previous.sample_index + 1, "Sample indices are not consecutive.")
        _require(
            current.simulation_step == previous.simulation_step + PERIOD_STEPS,
            "Simulation steps are not the 3-step capture grid.",
        )
    return chosen


def validate_logged_frames(frames: list[CapturedFrame]) -> None:
    for frame in frames:
        _require(len(frame.rgb) == RGB_FRAME_BYTES, "RGB frame is not 3686400 bytes.")
        _require(len(frame.depth) == DEPTH_FRAME_BYTES, "Depth frame is not 3686400 bytes.")
        assert_frame_content(frame.rgb, frame.depth)


def assert_frame_content(rgb: bytes, depth: bytes) -> None:
    color = np.frombuffer(rgb, dtype=np.uint8).reshape(HEIGHT, WIDTH, 4)[:, :, :3]
    _require(int(color.max()) > 0, "RGB frame has no color.")
    values = np.frombuffer(depth, dtype="<f4")
    _require(bool(np.any(np.isfinite(values) & (values > 0))), "Depth frame has no finite positive depth.")


def _camera_info_document(camera: dict, info: dict) -> dict:
    calibration = camera["calibration"]
    intrinsics = calibration["intrinsics"]
    matrix = info["k"]
    _require(info.get("distortionModel") == "none", "Logged CameraInfo distortion model is not none.")
    logged_distortion = info.get("distortion") or []
    _require(all(float(value) == 0 for value in logged_distortion), "Logged CameraInfo distortion is not zero.")
    _require(
        info.get("frameId") == camera.get("measurementFrameId"),
        "CameraInfo optical frame does not match the sensor.",
    )
    pairs = (
        (matrix[0], intrinsics["fx"]),
        (matrix[4], intrinsics["fy"]),
        (matrix[2], intrinsics["cx"]),
        (matrix[5], intrinsics["cy"]),
    )
    for logged, authored in pairs:
        _require(
            math.isclose(float(logged), float(authored), rel_tol=0, abs_tol=1e-9),
            "CameraInfo intrinsics do not match the sensor.",
        )
    return {
        "cameraId": camera["id"],
        "opticalFrame": info["frameId"],
        "width": WIDTH,
        "height": HEIGHT,
        "fx": float(intrinsics["fx"]),
        "fy": float(intrinsics["fy"]),
        "cx": float(intrinsics["cx"]),
        "cy": float(intrinsics["cy"]),
        "distortionModel": "none",
        "distortion": [0.0, 0.0, 0.0, 0.0, 0.0],
        "near": float(calibration["near"]),
        "far": float(calibration["far"]),
    }


def _dump(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def stage_clip(
    destination: Path,
    frames: list[CapturedFrame],
    *,
    camera: dict,
    bundle: dict,
    results: dict,
    backend: dict,
    versions: dict[str, str],
    window_index: int,
    runner=None,
    check_content: bool = True,
) -> Path:
    destination = Path(destination)
    _require(not destination.exists(), f"{destination} already exists.")
    staging = destination.with_name(f"{destination.name}.partial-{os.getpid()}")
    _require(not staging.exists(), f"{staging} already exists.")
    published = False
    try:
        staging.mkdir(parents=True)
        depth_path = staging / "depth.f32"
        rgb_chunks = []
        with depth_path.open("wb") as handle:
            for frame in frames:
                if check_content:
                    assert_frame_content(frame.rgb, frame.depth)
                values = np.frombuffer(frame.depth, dtype="<f4")
                handle.write(np.asarray(values, dtype="<f4").tobytes())
                rgb_chunks.append(frame.rgb)
        rgb = b"".join(rgb_chunks)
        info = _camera_info_document(camera, frames[0].info)
        (staging / "camera_info.json").write_text(_dump(info), encoding="utf-8")
        frame_records = []
        for index, frame in enumerate(frames):
            values = np.frombuffer(frame.depth, dtype="<f4")
            stats = depth_statistics(values)
            frame_records.append({
                "index": index,
                "captureTimeNs": frame.stamp_ns,
                "sampleIndex": frame.sample_index,
                "simulationStep": frame.simulation_step,
                "rgbByteLength": len(frame.rgb),
                "rgbSha256": sha256_bytes(frame.rgb),
                "depthByteLength": len(frame.depth),
                "depthValueCount": int(values.size),
                "depthSha256": sha256_bytes(np.asarray(values, dtype="<f4").tobytes()),
                "depthValidCount": stats["depthValidCount"],
                "depthValidFraction": stats["depthValidFraction"],
                "depthMin": stats["depthMin"],
                "depthMax": stats["depthMax"],
            })
        (staging / "frames.jsonl").write_text(
            "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in frame_records),
            encoding="utf-8",
        )
        encode_videos(
            staging,
            rgb,
            np.frombuffer(depth_path.read_bytes(), dtype="<f4"),
            runner=runner or subprocess.run,
        )
        resolved = bundle["resolved"]
        clip = {
            "kind": CLIP_KIND,
            "version": CLIP_VERSION,
            "episodeHash": results["episodeHash"],
            "cameraId": camera["id"],
            "windowIndex": window_index,
            "frameCount": FRAME_COUNT,
            "width": WIDTH,
            "height": HEIGHT,
            "frameRate": {"numerator": FRAME_RATE_NUMERATOR, "denominator": FRAME_RATE_DENOMINATOR},
            "timing": {
                "stepNs": STEP_NS,
                "captureIntervalNs": CAPTURE_INTERVAL_NS,
                "firstCaptureTimeNs": frames[0].stamp_ns,
                "lastCaptureTimeNs": frames[-1].stamp_ns,
                "captureCount": FRAME_COUNT,
                "firstSimulationStep": frames[0].simulation_step,
                "lastSimulationStep": frames[-1].simulation_step,
            },
            "hashes": {
                "world": resolved["world"]["hash"],
                "simulationSemantic": results["simulationSemanticHash"],
                "episode": results["episodeHash"],
                "resolved": results["resolvedHash"],
                "rgbRawSha256": sha256_bytes(rgb),
                "depthRawSha256": sha256_file(depth_path),
            },
            "noise": {
                "model": "none",
                "standardDeviation": 0,
                "bias": 0,
                "dropoutProbability": 0,
            },
            "renderer": dict(ANALYTIC_RENDERER),
            "resolvedRenderer": dict(ANALYTIC_RENDERER),
            "backend": {
                "capabilityId": backend["capabilityId"],
                "version": str(backend["version"]),
                "configHash": backend["configHash"],
            },
            "products": {
                "rgb": {"role": "measured", "encoding": "rgba8", "byteLength": RGB_FRAME_BYTES},
                "depth": {"role": "oracle", "encoding": "32FC1", "byteLength": DEPTH_FRAME_BYTES},
            },
            "depthVisualization": dict(DEPTH_VISUALIZATION),
            "encoder": {
                "ffmpeg": versions["ffmpeg"],
                "ffprobe": versions["ffprobe"],
                "rgbArguments": list(RGB_FFMPEG_ARGUMENTS),
                "depthArguments": list(DEPTH_FFMPEG_ARGUMENTS),
            },
            "files": {
                name: sha256_file(staging / name)
                for name in ("rgb.mp4", "depth.mp4", "depth.f32", "camera_info.json", "frames.jsonl")
            },
        }
        (staging / "clip.json").write_text(_dump(clip), encoding="utf-8")
        check_clip(staging, published_name=destination.name)
        _require(not destination.exists(), f"{destination} already exists.")
        os.rename(staging, destination)
        published = True
        check_clip(destination)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        if published and destination.exists():
            shutil.rmtree(destination)
        raise
    return destination


def export_clip(
    run_output: Path,
    output_root: Path,
    camera_id: str = "front-camera",
    window_index: int = 0,
    *,
    versions: dict[str, str] | None = None,
    runner=None,
) -> Path:
    """Publish one clip directory. Existing destinations are left untouched."""
    bundle, results, provenance = load_run(run_output)
    camera = _camera(bundle, camera_id)
    backend = _gpu_backend(provenance)
    try:
        updates = read_sflog(Path(run_output) / "run.sflog")
    except OSError as error:
        raise ClipError(f"run.sflog is unreadable: {error}") from error
    frames = select_window(pair_camera_frames(updates, camera_id), window_index)
    validate_logged_frames(frames)
    resolved_versions = versions or require_encoders()
    destination = Path(output_root) / clip_directory_name(results["episodeHash"], camera_id, window_index)
    return stage_clip(
        destination,
        frames,
        camera=camera,
        bundle=bundle,
        results=results,
        backend=backend,
        versions=resolved_versions,
        window_index=window_index,
        runner=runner,
    )
