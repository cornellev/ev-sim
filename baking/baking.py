import json
import os
import time
import shutil
import threading
import hashlib
import re
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import bake_server
import fprocess

try:
    import gs_export
except ImportError:
    gs_export = None

queue = deque()
pending_samples = {}
processing_samples = {}
run_manifests = {}
building_bake_state = {}
sample_results = {}
lock = threading.Lock()
RAW_ROOT = Path(os.environ.get("CEV_SIM_BAKE_RAW_ROOT") or (Path.cwd() / "raw")).resolve()
BAKED_ROOT = Path(os.environ.get("CEV_SIM_BAKE_OUTPUT_ROOT") or (Path.cwd() / "baked")).resolve()
SAFE_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


@dataclass
class SampleFile:
    name: str
    path: str
    file_role: str
    pass_id: str
    view_id: str
    metadata: dict = field(default_factory=dict)


@dataclass
class SampleJob:
    sample_id: str
    run_id: str
    frame_index: int
    files: list[SampleFile] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


def clear_data():
    with lock:
        pending_samples.clear()
        processing_samples.clear()
        queue.clear()
        run_manifests.clear()
        building_bake_state.clear()
        sample_results.clear()


def files_check():
    RAW_ROOT.mkdir(parents=True, exist_ok=True)
    BAKED_ROOT.mkdir(parents=True, exist_ok=True)


def _safe_run_id(value):
    run_id = str(value or "default")
    if run_id in {".", ".."} or not SAFE_RUN_ID.fullmatch(run_id):
        raise ValueError("runId must be a 1-128 character filesystem-safe slug")
    return run_id


def _safe_filename(value):
    name = str(value or "")
    drive, _tail = os.path.splitdrive(name)
    if (
        not name
        or len(name.encode("utf-8")) > 255
        or name in {".", ".."}
        or drive
        or os.path.isabs(name)
        or "/" in name
        or "\\" in name
        or "\x00" in name
    ):
        raise ValueError("upload filename must be one safe path component")
    return name


def _jailed(root, *parts):
    destination = root.joinpath(*map(str, parts)).resolve()
    try:
        destination.relative_to(root)
    except ValueError as error:
        raise ValueError("bake output path escapes its configured root") from error
    return destination


def _write_bytes_no_follow(destination, payload):
    destination.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(destination, flags, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload)


def _write_json_no_follow(destination, value):
    payload = json.dumps(value, indent=2).encode("utf-8")
    _write_bytes_no_follow(Path(destination), payload)


def _append_text_no_follow(destination, text):
    path_value = Path(destination)
    path_value.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path_value, flags, 0o600)
    with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
        stream.write(text)


def _parse_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _sample_key(metadata):
    sample_id = metadata.get("sampleId")
    if sample_id:
        return sample_id

    run_id = metadata.get("runId", "default")
    frame_index = _parse_int(metadata.get("frameIndex"), 0)
    return f"{run_id}:{frame_index}"


def _file_key(metadata):
    file_role = metadata.get("fileRole", "render")
    pass_id = metadata.get("passId", "beauty")
    view_id = metadata.get("viewId") or metadata.get("cameraId", "view")
    return f"{file_role}:{pass_id}:{view_id}"


def _run_dir(run_id):
    return str(_jailed(BAKED_ROOT, _safe_run_id(run_id)))


def _manifest_path(run_id):
    return os.path.join(_run_dir(run_id), "manifest.json")


def _frames_log_path(run_id):
    return os.path.join(_run_dir(run_id), "frames.jsonl")


def _building_state_path(run_id):
    return os.path.join(_run_dir(run_id), "building_bake_state.json")


def save_photo(payload, name, metadata=None):
    files_check()
    metadata = metadata or {}

    run_id = _safe_run_id(metadata.get("runId", "default"))
    name = _safe_filename(name)
    frame_index = _parse_int(metadata.get("frameIndex"), 0)
    if frame_index < 0:
        raise ValueError("frameIndex must be non-negative")
    target_dir = _jailed(RAW_ROOT, run_id, "samples", f"{frame_index:05d}")
    target_dir.mkdir(parents=True, exist_ok=True)

    destination = _jailed(target_dir, name)
    _write_bytes_no_follow(destination, payload)

    return str(destination)


def on_manifest(payload):
    if not payload:
        return

    run_id = _safe_run_id(payload.get("runId", "default"))
    with lock:
        run_manifests[run_id] = payload

    os.makedirs(_run_dir(run_id), exist_ok=True)
    _write_json_no_follow(_manifest_path(run_id), payload)

    print(f"Run manifest saved for {run_id}")


def _enqueue_sample(sample_id):
    accumulator = pending_samples.pop(sample_id, None)
    if not accumulator:
        return

    job = SampleJob(
        sample_id=sample_id,
        run_id=accumulator["run_id"],
        frame_index=accumulator["frame_index"],
        files=list(accumulator["files"].values()),
        metadata=accumulator["metadata"],
    )
    queue.append(job)
    print(
        f"Sample queued: {sample_id} "
        f"({len(job.files)}/{accumulator.get('expected_files', len(job.files))} files)"
    )


def on_photo(raw_photo):
    metadata = raw_photo.metadata or {}
    sample_id = _sample_key(metadata)
    file_key = _file_key(metadata)
    name = raw_photo.name or f"frame_{int(time.time() * 1000)}.png"

    destination = save_photo(raw_photo.payload, name, metadata)
    if _parse_bool(metadata.get("debugOnly"), False):
        return

    with lock:
        accumulator = pending_samples.setdefault(
            sample_id,
            {
                "run_id": metadata.get("runId", "default"),
                "frame_index": _parse_int(metadata.get("frameIndex"), 0),
                "expected_files": _parse_int(metadata.get("expectedFiles"), 0),
                "metadata": {},
                "files": {},
            },
        )

        accumulator["expected_files"] = max(
            accumulator["expected_files"],
            _parse_int(metadata.get("expectedFiles"), 0),
        )
        accumulator["metadata"].update(metadata)
        accumulator["files"][file_key] = SampleFile(
            name=name,
            path=destination,
            file_role=metadata.get("fileRole", "render"),
            pass_id=metadata.get("passId", "beauty"),
            view_id=metadata.get("viewId") or metadata.get("cameraId", "view"),
            metadata=dict(metadata),
        )

        expected = accumulator["expected_files"]
        received = len(accumulator["files"])
        if expected > 0 and received >= expected:
            _enqueue_sample(sample_id)


def on_sample_complete(payload):
    metadata = payload or {}
    sample_id = _sample_key(metadata)
    expected_files = _parse_int(metadata.get("expectedFiles"), 0)

    with lock:
        accumulator = pending_samples.setdefault(
            sample_id,
            {
                "run_id": metadata.get("runId", "default"),
                "frame_index": _parse_int(metadata.get("frameIndex"), 0),
                "expected_files": expected_files,
                "metadata": {},
                "files": {},
            },
        )

        if expected_files > 0:
            accumulator["expected_files"] = max(accumulator["expected_files"], expected_files)
        accumulator["metadata"].update(metadata)

        expected = accumulator["expected_files"]
        received = len(accumulator["files"])
        if expected > 0 and received >= expected:
            _enqueue_sample(sample_id)
        elif received > 0 and expected == 0:
            accumulator["expected_files"] = received
            _enqueue_sample(sample_id)


def on_clear_data():
    print("clearing...")
    clear_data()

    for folder in [RAW_ROOT, BAKED_ROOT]:
        if folder.exists():
            for entry in folder.iterdir():
                if entry.is_symlink() or entry.is_file():
                    entry.unlink()
                elif entry.is_dir():
                    shutil.rmtree(entry)


def get_queue_status():
    with lock:
        return {
            "queuedSamples": len(queue),
            "pendingSamples": len(pending_samples),
            "processingSamples": len(processing_samples),
            "pending": [
                {
                    "sampleId": sample_id,
                    "expectedFiles": state["expected_files"],
                    "receivedFiles": len(state["files"]),
                }
                for sample_id, state in pending_samples.items()
            ],
            "processing": [
                {
                    "sampleId": sample_id,
                    "runId": job.run_id,
                    "frameIndex": job.frame_index,
                }
                for sample_id, job in processing_samples.items()
            ],
        }


def get_sample_result(sample_id, view_id):
    with lock:
        views = sample_results.get(sample_id, {})
        if view_id in views:
            path = views[view_id]
            if path and os.path.exists(path):
                return {"status": "ready", "path": path}

        if sample_id in pending_samples:
            return {"status": "pending"}

        for job in queue:
            if job.sample_id == sample_id:
                return {"status": "pending"}

        if sample_id in processing_samples:
            return {"status": "pending"}

    return {"status": "not_found"}


def _slug(value):
    text = str(value or "view")
    normalized = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in text)
    return (normalized.strip("_") or "view")[:80]


def _mask_tag(sample_file):
    mask_tags = sample_file.metadata.get("maskTags", "")
    tags = [tag.strip() for tag in mask_tags.split(",") if tag.strip()]
    if tags:
        return "_".join(tags)

    pass_id = sample_file.pass_id or "mask"
    return pass_id[5:] if pass_id.startswith("mask_") else pass_id


def _mask_is_nonempty(mask_path, min_bytes=128):
    try:
        return os.path.getsize(mask_path) >= min_bytes
    except OSError:
        return False


def _processing_metadata(job, render_file, mask_file, tag):
    building_id = mask_file.metadata.get("buildingId", "")
    model_seed = mask_file.metadata.get("modelSeed")
    return {
        "sampleId": job.sample_id,
        "runId": job.run_id,
        "frameIndex": job.frame_index,
        "viewId": mask_file.view_id,
        "tag": tag,
        "buildingId": building_id,
        "modelSeed": model_seed,
        "render": {
            "name": render_file.name,
            "passId": render_file.pass_id,
            "fileRole": render_file.file_role,
        },
        "mask": {
            "name": mask_file.name,
            "passId": mask_file.pass_id,
            "fileRole": mask_file.file_role,
            "maskTags": mask_file.metadata.get("maskTags", ""),
            "includeTags": mask_file.metadata.get("includeTags", ""),
            "excludeTags": mask_file.metadata.get("excludeTags", ""),
            "buildingId": building_id,
        },
    }


def _record_building_state(job, mask_file, output_path):
    building_id = mask_file.metadata.get("buildingId")
    if not building_id:
        return

    run_id = job.run_id
    with lock:
        state = building_bake_state.setdefault(run_id, {})
        entry = state.setdefault(building_id, {
            "buildingId": building_id,
            "revision": 0,
            "acceptedSlivers": [],
        })
        entry["revision"] += 1
        entry["acceptedSlivers"].append({
            "sampleId": job.sample_id,
            "frameIndex": job.frame_index,
            "maskPassId": mask_file.pass_id,
            "outputPath": output_path,
            "modelSeed": mask_file.metadata.get("modelSeed"),
        })

    os.makedirs(_run_dir(run_id), exist_ok=True)
    _write_json_no_follow(_building_state_path(run_id), building_bake_state[run_id])


def _write_frame_record(job, frame_record):
    run_id = job.run_id
    baked_dir = os.path.join(_run_dir(run_id), f"{job.frame_index:05d}")
    os.makedirs(baked_dir, exist_ok=True)

    meta_path = os.path.join(baked_dir, "meta.json")
    _write_json_no_follow(meta_path, frame_record)

    _append_text_no_follow(_frames_log_path(run_id), json.dumps(frame_record) + "\n")


def _process_sample_job(job):
    baked_dir = os.path.join(_run_dir(job.run_id), f"{job.frame_index:05d}")
    os.makedirs(baked_dir, exist_ok=True)

    renders_by_view = {}
    masks_by_view = {}
    aux_files = []

    for sample_file in job.files:
        if sample_file.file_role == "render":
            renders_by_view.setdefault(sample_file.view_id, sample_file)
        elif sample_file.file_role == "mask":
            masks_by_view.setdefault(sample_file.view_id, []).append(sample_file)
        else:
            aux_files.append(sample_file)

    frame_record = {
        "sampleId": job.sample_id,
        "runId": job.run_id,
        "frameIndex": job.frame_index,
        "metadata": dict(job.metadata),
        "files": {
            sample_file.file_role: sample_file.path
            for sample_file in job.files
        },
        "processed": [],
        "final": {},
        "aux": [
            {
                "fileRole": sample_file.file_role,
                "passId": sample_file.pass_id,
                "path": sample_file.path,
            }
            for sample_file in aux_files
        ],
    }

    for view_id, render_file in renders_by_view.items():
        masks = sorted(
            masks_by_view.get(view_id, []),
            key=lambda file: file.pass_id,
        )
        nonempty_masks = [
            mask for mask in masks
            if _mask_is_nonempty(mask.path)
        ]

        if not nonempty_masks:
            final_path = os.path.join(baked_dir, f"final_{_slug(view_id)}.png")
            shutil.copy2(render_file.path, final_path)
            frame_record["final"][view_id] = final_path
            with lock:
                sample_results.setdefault(job.sample_id, {})[view_id] = final_path
            continue

        current_image = render_file.path
        processed_paths = []

        for index, mask_file in enumerate(nonempty_masks):
            chain = _parse_bool(mask_file.metadata.get("chainProcess"), False)
            if index > 0 and not chain:
                break

            tag = mask_file.metadata.get("processTag") or _mask_tag(mask_file)
            output_path = os.path.join(
                baked_dir,
                f"processed_{tag}_{_slug(view_id)}.png",
            )
            result_path = fprocess.process_image(
                current_image,
                mask_file.path,
                tag,
                save_path=output_path,
                metadata=_processing_metadata(job, render_file, mask_file, tag),
            )

            if not result_path:
                print(
                    f"Processing failed for sample {job.sample_id}, "
                    f"view {view_id}, mask {mask_file.pass_id}"
                )
                continue

            processed_paths.append(result_path)
            frame_record["processed"].append({
                "viewId": view_id,
                "maskPassId": mask_file.pass_id,
                "tag": tag,
                "path": result_path,
                "buildingId": mask_file.metadata.get("buildingId", ""),
            })
            _record_building_state(job, mask_file, result_path)

            current_image = result_path

            if not chain:
                break

        if os.path.exists(current_image):
            final_path = os.path.join(baked_dir, f"final_{_slug(view_id)}.png")
            shutil.copy2(current_image, final_path)
            frame_record["final"][view_id] = final_path
            with lock:
                sample_results.setdefault(job.sample_id, {})[view_id] = final_path

    _write_frame_record(job, frame_record)

    if gs_export is not None:
        try:
            gs_export.update_transforms_for_run(job.run_id)
        except Exception as exc:
            print(f"GS export update failed for {job.run_id}: {exc}")


def process():
    with lock:
        if not queue:
            return
        job = queue.popleft()
        processing_samples[job.sample_id] = job
    try:
        _process_sample_job(job)
    finally:
        with lock:
            processing_samples.pop(job.sample_id, None)


if __name__ == "__main__":
    print("Beginning baking server!")
    on_clear_data()

    bake_server.add_photo_listener(on_photo)
    bake_server.add_sample_complete_listener(on_sample_complete)
    bake_server.add_manifest_listener(on_manifest)
    bake_server.add_clear_listener(on_clear_data)
    bake_server.set_queue_status_provider(get_queue_status)
    bake_server.set_result_provider(get_sample_result)

    bake_server.begin_server_async()

    while True:
        process()
        time.sleep(0.05)
