"""Export a paired RGB/depth camera clip from a finalized headless run."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from cev_sim.clip.check import check_clip
from cev_sim.clip.contract import (
    CLIP_KIND,
    CLIP_VERSION,
    FILENAMES,
    GENERIC_DEPTH_VISUALIZATION,
    ClipError,
    clip_directory_name,
)
from cev_sim.clip.sflog import Update, read_sflog
from cev_sim.clip.video import encode_videos, ffmpeg_arguments, require_encoders
from cev_sim.config import (
    GPU_SENSOR_CAPABILITY,
    GPU_SENSOR_CONFIG_HASH,
    GPU_SENSOR_VERSION,
    ROUTED_GPU_SENSOR_CONFIG_HASH,
    ROUTED_GPU_SENSOR_VERSION,
)
from cev_sim.cosmos_clip.check import check_clip as check_cosmos_clip
from cev_sim.cosmos_clip.check import depth_statistics, sha256_bytes, sha256_file
from cev_sim.cosmos_clip.contract import (
    ANALYTIC_RENDERER,
    CAPTURE_INTERVAL_NS,
    DEPTH_FFMPEG_ARGUMENTS,
    DEPTH_VISUALIZATION,
    FRAME_RATE_DENOMINATOR,
    RGB_FFMPEG_ARGUMENTS,
)
from cev_sim.cosmos_clip.contract import (
    CLIP_KIND as COSMOS_KIND,
)
from cev_sim.cosmos_clip.contract import (
    FRAME_COUNT as COSMOS_FRAME_COUNT,
)
from cev_sim.cosmos_clip.contract import (
    HEIGHT as COSMOS_HEIGHT,
)
from cev_sim.cosmos_clip.contract import (
    WIDTH as COSMOS_WIDTH,
)

COSMOS_VERSION = 2
COSMOS_STEP_NS = 11_111_111
COSMOS_PERIOD_STEPS = 3
PBR_RENDERER = {"id": "pbr-mesh", "version": 1}


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


def load_run(run_output: Path, *, require_full_cosmos: bool = False) -> tuple[dict, dict, dict]:
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
    if require_full_cosmos:
        _require(int(results.get("step") or 0) >= 363, "The run ended before the clip's last capture step.")
    _require(bundle.get("resolvedHash") == results.get("resolvedHash"), "Resolved hash does not match the run result.")
    _require(
        bundle.get("simulationSemanticHash") == results.get("simulationSemanticHash"),
        "Simulation semantic hash does not match the run result.",
    )
    return bundle, results, provenance


def _camera(bundle: dict, camera_id: str) -> dict:
    sensors = (((bundle.get("resolved") or {}).get("manifest") or {}).get("sensorRig") or {}).get("sensors") or []
    camera = next((
        sensor for sensor in sensors
        if sensor.get("id") == camera_id and sensor.get("type") == "camera"
    ), None)
    _require(camera is not None, f"Resolved run has no camera {camera_id}.")
    return camera


def _products_enabled(camera: dict) -> None:
    products = (camera.get("calibration") or {}).get("products") or {}
    enabled = products.get("rgb") is True and products.get("depth") is True and products.get("cameraInfo") is True
    _require(enabled, "RGB, depth, and CameraInfo must be enabled.")
    for name in ("semantic", "instance", "detections2d", "detections3d", "lanes", "trafficControls", "diagnostics"):
        _require(products.get(name) is False, f"Camera product {name} must be disabled.")


def _gpu_backend(provenance: dict, *, version: str, config_hash: str) -> dict:
    selections = provenance.get("backendSelections") or []
    selected = next((entry for entry in selections if int(entry.get("kind") or 0) == 4), None)
    _require(selected is not None, "Provenance has no GPU sensor backend.")
    _require(
        selected.get("capabilityId") == GPU_SENSOR_CAPABILITY,
        "GPU backend is not chromium-webgl2-rendered-sensors.",
    )
    _require(str(selected.get("version")) == version, f"GPU backend version is not v{version}.")
    _require(selected.get("configHash") == config_hash, "GPU backend config hash does not match the resolver.")
    return selected


def _schedule(camera: dict, step_ns: int) -> tuple[int, int]:
    rate = float(camera.get("rateHz") or 0)
    _require(rate > 0, "Camera rate must be positive.")
    period_ns = max(1, _js_round(1e9 / rate))
    period_steps = max(1, _js_round(period_ns / step_ns))
    phase_steps = max(0, _js_round(float(camera.get("phaseNs") or 0) / step_ns))
    first = phase_steps if phase_steps > 0 else period_steps
    return first, period_steps


def _expected_stamps(first: int, period_steps: int, step_ns: int, max_step: int) -> list[int]:
    stamps = []
    step = first
    while step <= max_step:
        stamps.append(step * step_ns)
        step += period_steps
    return stamps


def pair_camera_frames(
    updates: list[Update],
    camera_id: str,
    *,
    step_ns: int,
    expected_stamps: list[int],
    width: int,
    height: int,
) -> list[CapturedFrame]:
    paths = {
        "rgb": f"devices.{camera_id}.image",
        "depth": f"devices.{camera_id}.depth",
        "info": f"devices.{camera_id}.cameraInfo",
    }
    grouped: dict[str, dict[int, Update]] = {key: {} for key in paths}
    for update in updates:
        role = next((key for key, item_path in paths.items() if update.path == item_path), None)
        if role is None or update.message is None:
            continue
        stamp = int(update.message["stampNs"])
        _require(stamp not in grouped[role], f"Duplicate {role} capture at {stamp} ns.")
        _require(update.time_us == _js_round(stamp / 1000), f"{role} log time does not match its header stamp.")
        _require(
            stamp % step_ns == 0 and update.cycle == stamp // step_ns,
            f"{role} capture is not on the simulation step grid.",
        )
        grouped[role][stamp] = update
    actual = sorted(grouped["rgb"])
    _require(actual == expected_stamps, "RGB captures do not match the camera schedule.")
    frames: list[CapturedFrame] = []
    rgb_bytes = width * height * 4
    depth_bytes = width * height * 4
    for ordinal, stamp in enumerate(actual):
        rgb = grouped["rgb"][stamp]
        depth = grouped["depth"].get(stamp)
        info = grouped["info"].get(stamp)
        _require(depth is not None and info is not None, f"Capture {stamp} ns is missing depth or CameraInfo.")
        _require(
            depth.cycle == rgb.cycle and info.cycle == rgb.cycle,
            f"Capture {stamp} ns products do not share a simulation step.",
        )
        message = rgb.message or {}
        depth_message = depth.message or {}
        _require(message.get("encoding") == "rgba8", "RGB encoding is not rgba8.")
        _require(depth_message.get("encoding") == "32FC1", "Depth encoding is not 32FC1.")
        _require(
            int(message.get("width") or width) == width and int(message.get("height") or height) == height,
            "RGB dimensions do not match the camera.",
        )
        _require(
            int(depth_message.get("width") or width) == width and int(depth_message.get("height") or height) == height,
            "Depth dimensions do not match the camera.",
        )
        rgb_payload = bytes(message.get("data") or b"")
        depth_payload = bytes(depth_message.get("data") or b"")
        _require(len(rgb_payload) == rgb_bytes, "RGB frame byte length does not match the camera.")
        _require(len(depth_payload) == depth_bytes, "Depth frame byte length does not match the camera.")
        frames.append(CapturedFrame(
            stamp_ns=stamp,
            sample_index=ordinal,
            simulation_step=rgb.cycle,
            rgb=rgb_payload,
            depth=depth_payload,
            info=info.message or {},
        ))
    return frames


def _timing_for_rate(rate_hz: float) -> tuple[int, int, int]:
    rate = max(1, _js_round(rate_hz))
    if rate == 30:
        return 30, 30_000, 1_000
    return rate, rate * 1_000, 1_000


def _dump(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def _publish(destination: Path, write) -> Path:
    destination = Path(destination)
    _require(not destination.exists(), f"{destination} already exists.")
    staging = destination.with_name(f"{destination.name}.partial-{os.getpid()}")
    _require(not staging.exists(), f"{staging} already exists.")
    published = False
    try:
        staging.mkdir(parents=True)
        write(staging)
        _require(not destination.exists(), f"{destination} already exists.")
        os.rename(staging, destination)
        published = True
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
    contract: str = "camera",
    requested_duration_ns: int | None = None,
    versions: dict[str, str] | None = None,
    runner=None,
) -> Path:
    cosmos = contract == "cosmos-v2"
    if contract not in ("camera", "cosmos-v2"):
        raise ClipError("Clip contract must be camera or cosmos-v2.")
    _require(isinstance(window_index, int) and window_index >= 0, "Window index must be a non-negative integer.")
    bundle, results, provenance = load_run(run_output, require_full_cosmos=cosmos)
    camera = _camera(bundle, camera_id)
    calibration = camera.get("calibration") or {}
    width = int(calibration.get("width") or 0)
    height = int(calibration.get("height") or 0)
    _products_enabled(camera)
    manifest = (bundle.get("resolved") or {}).get("manifest") or {}
    clock = manifest.get("clock") or {}
    step_ns = int(clock.get("stepNs") or 0)
    logging_policy = manifest.get("logging") or {}
    _require(logging_policy.get("policy") == "required", "Logging policy must retain the sensor log.")
    _require(
        logging_policy.get("profileId") == "simulation-run-full-sensors",
        "Logging profile must be simulation-run-full-sensors.",
    )
    provider = ((camera.get("render") or {}).get("provider") or {})
    if cosmos:
        _require(width == COSMOS_WIDTH and height == COSMOS_HEIGHT, "Camera geometry is not 1280x720.")
        _require(step_ns == COSMOS_STEP_NS, "Simulation step is not 11111111 ns.")
        _require(float(camera.get("rateHz") or 0) == 30, "Camera rate is not 30 Hz.")
        noise = camera.get("noise") or {}
        _require(noise.get("model") == "none", "Camera noise model must be none.")
        _require(
            all(float(noise.get(key) or 0) == 0 for key in ("standardDeviation", "bias", "dropoutProbability")),
            "Camera noise and dropout must be zero.",
        )
        _require(calibration.get("distortionModel") == "none", "Camera distortion model must be none.")
        _require(
            all(float(value) == 0 for value in calibration.get("distortion") or []),
            "Camera distortion coefficients must be zero.",
        )
        analytic = provider.get("id") == ANALYTIC_RENDERER["id"] and int(provider.get("version") or 0) == 1
        pbr = provider.get("id") == PBR_RENDERER["id"] and int(provider.get("version") or 0) == 1
        _require(analytic or pbr, "cosmos-nano v2 renderer must be canonical-analytic v1 or pbr-mesh v1.")
        backend = _gpu_backend(
            provenance,
            version=GPU_SENSOR_VERSION if analytic else ROUTED_GPU_SENSOR_VERSION,
            config_hash=GPU_SENSOR_CONFIG_HASH if analytic else ROUTED_GPU_SENSOR_CONFIG_HASH,
        )
        renderer = dict(ANALYTIC_RENDERER if analytic else PBR_RENDERER)
        executed = max(int(results.get("step") or 0), 363)
        expected = _expected_stamps(COSMOS_PERIOD_STEPS, COSMOS_PERIOD_STEPS, COSMOS_STEP_NS, executed)
        last_stamp = COSMOS_PERIOD_STEPS * COSMOS_STEP_NS + (COSMOS_FRAME_COUNT - 1) * CAPTURE_INTERVAL_NS
        expected = [stamp for stamp in expected if stamp <= last_stamp]
        expected = expected[:COSMOS_FRAME_COUNT]
        _require(len(expected) == COSMOS_FRAME_COUNT, "Cosmos schedule did not produce 121 frames.")
    else:
        _require(width > 0 and height > 0, "Camera dimensions are invalid.")
        _require(step_ns > 0, "Simulation step is invalid.")
        analytic = provider.get("id") == ANALYTIC_RENDERER["id"] and int(provider.get("version") or 0) == 1
        pbr = provider.get("id") == PBR_RENDERER["id"] and int(provider.get("version") or 0) == 1
        _require(analytic or pbr, "Camera renderer must be canonical-analytic v1 or pbr-mesh v1.")
        backend = _gpu_backend(
            provenance,
            version=ROUTED_GPU_SENSOR_VERSION if pbr else GPU_SENSOR_VERSION,
            config_hash=ROUTED_GPU_SENSOR_CONFIG_HASH if pbr else GPU_SENSOR_CONFIG_HASH,
        )
        renderer = dict(PBR_RENDERER if pbr else ANALYTIC_RENDERER)
        first, period_steps = _schedule(camera, step_ns)
        expected = _expected_stamps(first, period_steps, step_ns, int(results.get("step") or 0))
        _require(expected, "The completed run does not include a camera capture.")
    log_path = Path(run_output) / "run.sflog"
    frames = pair_camera_frames(
        read_sflog(log_path),
        camera_id,
        step_ns=step_ns,
        expected_stamps=expected,
        width=width,
        height=height,
    )
    _require(window_index == 0, "Camera clips publish window 0.")
    rate, timescale, pts_delta = (30, 30_000, 1_000) if cosmos else _timing_for_rate(float(camera.get("rateHz") or 30))
    near = float(calibration.get("near") or 0.1)
    far = float(calibration.get("far") or 200.0)
    resolved_versions = versions or require_encoders()
    destination = Path(output_root) / clip_directory_name(
        str(results.get("episodeHash") or ""),
        camera_id,
        window_index,
    )

    def write(staging: Path) -> None:
        depth_path = staging / "depth.f32"
        rgb_chunks = []
        with depth_path.open("wb") as handle:
            for frame in frames:
                values = np.frombuffer(frame.depth, dtype="<f4")
                _require(bool(np.any(np.isfinite(values) & (values > 0))), "Depth frame has no finite positive depth.")
                color = np.frombuffer(frame.rgb, dtype=np.uint8).reshape(height, width, 4)[:, :, :3]
                _require(int(color.max()) > 0, "RGB frame has no color.")
                handle.write(np.asarray(values, dtype="<f4").tobytes())
                rgb_chunks.append(frame.rgb)
        rgb = b"".join(rgb_chunks)
        intrinsics = calibration.get("intrinsics") or {}
        info = {
            "cameraId": camera["id"],
            "opticalFrame": frames[0].info.get("frameId") or camera.get("measurementFrameId"),
            "width": width,
            "height": height,
            "fx": float(intrinsics.get("fx") or 0),
            "fy": float(intrinsics.get("fy") or 0),
            "cx": float(intrinsics.get("cx") or 0),
            "cy": float(intrinsics.get("cy") or 0),
            "distortionModel": calibration.get("distortionModel") or "none",
            "distortion": [float(value) for value in (calibration.get("distortion") or [])],
            "near": near,
            "far": far,
        }
        (staging / "camera_info.json").write_text(_dump(info), encoding="utf-8")
        records = []
        for index, frame in enumerate(frames):
            values = np.frombuffer(frame.depth, dtype="<f4")
            stats = depth_statistics(values)
            records.append({
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
            "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
            encoding="utf-8",
        )
        if cosmos:
            rgb_arguments = RGB_FFMPEG_ARGUMENTS
            depth_arguments = DEPTH_FFMPEG_ARGUMENTS
            visualization = dict(DEPTH_VISUALIZATION)
        else:
            rgb_arguments = ffmpeg_arguments(
                width=width, height=height, frame_count=len(frames), frame_rate=rate,
                timescale=timescale, pix_fmt="rgba", crf=18,
            )
            depth_arguments = ffmpeg_arguments(
                width=width, height=height, frame_count=len(frames), frame_rate=rate,
                timescale=timescale, pix_fmt="gray", crf=0,
            )
            visualization = {**GENERIC_DEPTH_VISUALIZATION, "near": near, "far": far}
        encode_videos(
            staging,
            rgb,
            np.frombuffer(depth_path.read_bytes(), dtype="<f4").reshape(len(frames), height * width),
            runner=runner or subprocess.run,
            rgb_arguments=rgb_arguments,
            depth_arguments=depth_arguments,
            depth_mode="cosmos" if cosmos else "generic",
            near=near,
            far=far if cosmos else far,
        )
        resolved = bundle["resolved"]
        actual_duration_ns = frames[-1].stamp_ns
        scheduled_steps = int(clock.get("maxSteps") or results.get("step") or 0)
        clip = {
            "kind": COSMOS_KIND if cosmos else CLIP_KIND,
            "version": COSMOS_VERSION if cosmos else CLIP_VERSION,
            "episodeHash": results["episodeHash"],
            "cameraId": camera["id"],
            "windowIndex": window_index,
            "frameCount": len(frames),
            "width": width,
            "height": height,
            "frameRate": {"numerator": rate, "denominator": FRAME_RATE_DENOMINATOR},
            "requestedDurationNs": int(
                requested_duration_ns if requested_duration_ns is not None else actual_duration_ns
            ),
            "actualDurationNs": actual_duration_ns,
            "scheduledDurationNs": scheduled_steps * step_ns,
            "timing": {
                "stepNs": step_ns,
                "captureIntervalNs": frames[1].stamp_ns - frames[0].stamp_ns if len(frames) > 1 else 0,
                "firstCaptureTimeNs": frames[0].stamp_ns,
                "lastCaptureTimeNs": frames[-1].stamp_ns,
                "captureCount": len(frames),
                "firstSimulationStep": frames[0].simulation_step,
                "lastSimulationStep": frames[-1].simulation_step,
                "timescale": timescale,
                "ptsDelta": pts_delta,
            },
            "hashes": {
                "world": resolved["world"]["hash"],
                "simulationSemantic": results["simulationSemanticHash"],
                "episode": results["episodeHash"],
                "resolved": results["resolvedHash"],
                "rgbRawSha256": sha256_bytes(rgb),
                "depthRawSha256": sha256_file(depth_path),
            },
            "noise": camera.get("noise") or {},
            "renderer": renderer,
            "resolvedRenderer": renderer,
            "backend": {
                "capabilityId": backend["capabilityId"],
                "version": str(backend["version"]),
                "configHash": backend["configHash"],
            },
            "products": {
                "rgb": {"role": "measured", "encoding": "rgba8", "byteLength": width * height * 4},
                "depth": {"role": "oracle", "encoding": "32FC1", "byteLength": width * height * 4},
            },
            "depthVisualization": visualization,
            "encoder": {
                "ffmpeg": resolved_versions["ffmpeg"],
                "ffprobe": resolved_versions["ffprobe"],
                "rgbArguments": list(rgb_arguments),
                "depthArguments": list(depth_arguments),
            },
            "files": {name: sha256_file(staging / name) for name in FILENAMES if name != "clip.json"},
        }
        (staging / "clip.json").write_text(_dump(clip), encoding="utf-8")
        if cosmos:
            check_cosmos_clip(staging, published_name=destination.name)
        else:
            check_clip(staging, published_name=destination.name)

    published = _publish(destination, write)
    if cosmos:
        check_cosmos_clip(published)
    else:
        check_clip(published)
    return published


__all__ = ["CapturedFrame", "export_clip", "load_run", "pair_camera_frames"]
