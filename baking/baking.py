import os
import time
import shutil
import threading
from collections import deque
from dataclasses import dataclass, field

import bake_server

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


def process():
    if not queue:
        return

    job = queue.popleft()
    sample_dir = os.path.join(
        "raw",
        job.run_id,
        "samples",
        f"{job.frame_index:05d}",
    )
    baked_dir = os.path.join("baked", job.run_id, f"{job.frame_index:05d}")
    os.makedirs(baked_dir, exist_ok=True)

    for sample_file in job.files:
        baked_path = os.path.join(baked_dir, sample_file.name)
        if os.path.exists(sample_file.path):
            shutil.copy2(sample_file.path, baked_path)


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
