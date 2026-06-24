import os
import time
import shutil
import threading
from collections import deque
from dataclasses import dataclass, field

import bake_server
import fprocess

queue = deque()
pending_samples = {}
lock = threading.Lock()


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
    for folder in ["raw", "baked"]:
        if os.path.exists(folder):
            for filename in os.listdir(folder):
                file_path = os.path.join(folder, filename)
                if os.path.isfile(file_path):
                    os.remove(file_path)


def files_check():
    if not os.path.exists("raw"):
        os.makedirs("raw")
    if not os.path.exists("baked"):
        os.makedirs("baked")


def _parse_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


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


def save_photo(payload, name, metadata=None):
    files_check()
    metadata = metadata or {}

    run_id = metadata.get("runId", "default")
    frame_index = _parse_int(metadata.get("frameIndex"), 0)
    target_dir = os.path.join("raw", run_id, "samples", f"{frame_index:05d}")
    os.makedirs(target_dir, exist_ok=True)

    destination = os.path.join(target_dir, name)
    with open(destination, "wb") as f:
        f.write(payload)

    return destination


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
    with lock:
        pending_samples.clear()
        queue.clear()

    for folder in ["raw", "baked"]:
        if os.path.exists(folder):
            for filename in os.listdir(folder):
                file_path = os.path.join(folder, filename)
                if os.path.isfile(file_path):
                    os.remove(file_path)
                elif os.path.isdir(file_path):
                    shutil.rmtree(file_path)


def get_queue_status():
    with lock:
        return {
            "queuedSamples": len(queue),
            "pendingSamples": len(pending_samples),
            "pending": [
                {
                    "sampleId": sample_id,
                    "expectedFiles": state["expected_files"],
                    "receivedFiles": len(state["files"]),
                }
                for sample_id, state in pending_samples.items()
            ],
        }


def _slug(value):
    text = str(value or "view")
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in text)


def _mask_tag(sample_file):
    mask_tags = sample_file.metadata.get("maskTags", "")
    tags = [tag.strip() for tag in mask_tags.split(",") if tag.strip()]
    if tags:
        return "_".join(tags)

    pass_id = sample_file.pass_id or "mask"
    return pass_id[5:] if pass_id.startswith("mask_") else pass_id


def _processing_metadata(job, render_file, mask_file, tag):
    return {
        "sampleId": job.sample_id,
        "runId": job.run_id,
        "frameIndex": job.frame_index,
        "viewId": mask_file.view_id,
        "tag": tag,
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
        },
    }


def _process_sample_job(job):
    baked_dir = os.path.join("baked", job.run_id, f"{job.frame_index:05d}")
    os.makedirs(baked_dir, exist_ok=True)

    renders_by_view = {}
    masks_by_view = {}

    for sample_file in job.files:
        if sample_file.file_role == "render":
            renders_by_view.setdefault(sample_file.view_id, sample_file)
        elif sample_file.file_role == "mask":
            masks_by_view.setdefault(sample_file.view_id, []).append(sample_file)

    for view_id, render_file in renders_by_view.items():
        masks = sorted(
            masks_by_view.get(view_id, []),
            key=lambda file: file.pass_id,
        )

        if not masks:
            shutil.copy2(
                render_file.path,
                os.path.join(baked_dir, f"final_{_slug(view_id)}.png"),
            )
            continue

        current_image = render_file.path
        for mask_file in masks:
            tag = _mask_tag(mask_file)
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

            current_image = result_path

        if os.path.exists(current_image):
            shutil.copy2(
                current_image,
                os.path.join(baked_dir, f"final_{_slug(view_id)}.png"),
            )


def process():
    if not queue:
        return

    job = queue.popleft()
    _process_sample_job(job)


if __name__ == "__main__":
    print("Beginning baking server!")
    clear_data()

    bake_server.add_photo_listener(on_photo)
    bake_server.add_sample_complete_listener(on_sample_complete)
    bake_server.add_clear_listener(on_clear_data)
    bake_server.set_queue_status_provider(get_queue_status)

    bake_server.begin_server_async()

    while True:
        process()
        time.sleep(0.05)
