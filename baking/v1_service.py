"""Bounded VIS-11 bake job service: one worker pool, digest-verified transfers."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from pathlib import Path
from typing import Any

from backends import FakeIntrinsicMaterialBackend
from contracts import (
    CHANNEL_LAYOUTS,
    MODEL_OUTPUT_CHANNELS,
    PROVIDER_ID,
    PROVIDER_VERSION,
    effective_dimensions,
    hash_document,
    sha256_bytes,
)


class BakeV1Error(Exception):
    def __init__(self, code: str, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.code = code
        self.status = status


class BakeV1Service:
    def __init__(
        self,
        *,
        backend=None,
        root: str | os.PathLike[str] | None = None,
        worker_pool_size: int = 1,
        max_queue_jobs: int = 4,
        max_upload_bytes: int = 32 * 1024 * 1024,
        max_storage_bytes: int = 256 * 1024 * 1024,
        max_processing_ms: int = 300_000,
        max_width: int = 4096,
        max_height: int = 4096,
    ):
        self.backend = backend or FakeIntrinsicMaterialBackend()
        self.root = Path(root or os.environ.get("BAKE_V1_ROOT") or (Path.cwd() / "bake-v1"))
        self.cache_root = self.root / "cache" / "sha256"
        self.tmp_root = self.root / "tmp"
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self.tmp_root.mkdir(parents=True, exist_ok=True)
        self.worker_pool_size = worker_pool_size
        self.max_queue_jobs = max_queue_jobs
        self.max_upload_bytes = max_upload_bytes
        self.max_storage_bytes = max_storage_bytes
        self.max_processing_ms = max_processing_ms
        self.max_width = max_width
        self.max_height = max_height
        self._lock = threading.RLock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._by_hash: dict[str, str] = {}
        self._queue: deque[str] = deque()
        self._stored_bytes = 0
        self._in_flight = 0
        self._executor = ThreadPoolExecutor(max_workers=worker_pool_size, thread_name_prefix="bake-v1")

    def close(self):
        self._executor.shutdown(wait=False, cancel_futures=True)

    def capability(self) -> dict[str, Any]:
        backend = self.backend
        return {
            "kind": "cev-sim.bake-model-capability",
            "version": 1,
            "provider": {"id": PROVIDER_ID, "version": PROVIDER_VERSION},
            "model": {"id": backend.model_id, "revision": backend.model_revision},
            "weightsDigest": backend.weights_digest,
            "algorithm": {"id": backend.algorithm_id, "revision": backend.algorithm_revision},
            "requiredChannels": [
                "base-color",
                "emissive",
                "metalness",
                "normal",
                "occlusion",
                "roughness",
            ],
            "constructionModes": ["intrinsic-pbr-proposed"],
            "maxWidth": self.max_width,
            "maxHeight": self.max_height,
            "maxUploadBytes": self.max_upload_bytes,
            "maxQueueJobs": self.max_queue_jobs,
            "maxStorageBytes": self.max_storage_bytes,
            "maxProcessingMs": self.max_processing_ms,
            "workerPoolSize": self.worker_pool_size,
            "cacheModes": ["none", "reuse-request"],
            "nondeterminismScope": backend.nondeterminism_scope,
            "runtimeStack": {"kind": backend.runtime_kind, "version": 1},
            "codecRevision": "intrinsic-model-output@1",
        }

    def _active_count(self) -> int:
        return sum(1 for job in self._jobs.values() if job["state"] in {"open", "queued", "running"})

    def _busy_count(self) -> int:
        return sum(1 for job in self._jobs.values() if job["state"] in {"queued", "running"})

    def create_job(self, request: dict[str, Any]) -> dict[str, Any]:
        request_hash = hash_document(request)
        with self._lock:
            existing_id = self._by_hash.get(request_hash)
            if existing_id:
                job = self._jobs[existing_id]
                return {"jobId": existing_id, "requestHash": request_hash, "state": job["state"]}
            reuse = request.get("cachePolicy", {}).get("mode") == "reuse-request"
            cached = self._read_cache(request_hash) if reuse else None
            if cached is None and self._active_count() >= self.max_queue_jobs:
                raise BakeV1Error(
                    "BAKE_PROVIDER_CAPABILITY_MISMATCH",
                    "Bake model queue is full.",
                    HTTPStatus.TOO_MANY_REQUESTS,
                )
            job_id = f"v1-{request_hash[:16]}"
            job = {
                "jobId": job_id,
                "request": request,
                "requestHash": request_hash,
                "state": "completed" if cached else "open",
                "inputs": {},
                "cancel": threading.Event(),
                "response": cached["response"] if cached else None,
                "modelOutputSet": cached["modelOutputSet"] if cached else None,
                "buffers": cached["buffers"] if cached else {},
                "error": None,
                "code": None,
            }
            self._jobs[job_id] = job
            self._by_hash[request_hash] = job_id
            return {"jobId": job_id, "requestHash": request_hash, "state": job["state"]}

    def upload_input(
        self,
        job_id: str,
        sample_id: str,
        view_id: str,
        role: str,
        payload: bytes,
        digest: str,
    ) -> dict[str, Any]:
        if len(payload) > self.max_upload_bytes:
            raise BakeV1Error("BAKE_PROVIDER_CAPABILITY_MISMATCH", "Upload exceeds the configured byte limit.")
        actual = sha256_bytes(payload)
        if actual != digest:
            raise BakeV1Error("BAKE_TRANSFER_DIGEST_MISMATCH", "Upload digest mismatch.")
        with self._lock:
            job = self._require(job_id)
            if job["state"] in {"cancelled", "failed"}:
                raise BakeV1Error(
                    "BAKE_MODEL_CANCELLED" if job["state"] == "cancelled" else "BAKE_MODEL_INCOMPLETE",
                    "Job cannot accept uploads.",
                )
            if job["cancel"].is_set():
                job["state"] = "cancelled"
                raise BakeV1Error("BAKE_MODEL_CANCELLED", "Bake model job cancelled.")
            if self._stored_bytes + len(payload) > self.max_storage_bytes:
                raise BakeV1Error("BAKE_PROVIDER_CAPABILITY_MISMATCH", "Upload exceeds storage bounds.")
            key = f"{sample_id}:{view_id}:{role}"
            previous = job["inputs"].get(key)
            if previous:
                self._stored_bytes -= previous["byteSize"]
            job["inputs"][key] = {"bytes": payload, "sha256": actual, "byteSize": len(payload)}
            self._stored_bytes += len(payload)
        return {"accepted": True, "sha256": actual, "byteSize": len(payload)}

    def submit(self, job_id: str, request_hash: str) -> dict[str, Any]:
        with self._lock:
            job = self._require(job_id)
            if job["requestHash"] != request_hash:
                raise BakeV1Error("BAKE_RESPONSE_MISMATCH", "Submit requestHash does not match the job.")
            if job["cancel"].is_set() or job["state"] == "cancelled":
                job["state"] = "cancelled"
                raise BakeV1Error("BAKE_MODEL_CANCELLED", "Bake model job cancelled.")
            if job["state"] == "completed":
                return {"state": "completed", "requestHash": request_hash}
            if job["state"] in {"running", "queued"}:
                return {"state": job["state"], "requestHash": request_hash}
            if self._busy_count() >= self.max_queue_jobs:
                raise BakeV1Error(
                    "BAKE_PROVIDER_CAPABILITY_MISMATCH",
                    "Bake model queue is full.",
                    HTTPStatus.TOO_MANY_REQUESTS,
                )
            job["state"] = "queued"
            self._queue.append(job_id)
            self._pump()
        return {"state": job["state"], "requestHash": request_hash}

    def status(self, job_id: str) -> dict[str, Any]:
        job = self._require(job_id)
        return {
            "state": job["state"],
            "requestHash": job["requestHash"],
            "code": job.get("code"),
            "error": job.get("error"),
        }

    def result(self, job_id: str) -> dict[str, Any]:
        job = self._require(job_id)
        if job["state"] != "completed":
            raise BakeV1Error("BAKE_MODEL_INCOMPLETE", "Model result is not ready.", HTTPStatus.CONFLICT)
        return {
            "response": job["response"],
            "modelOutputSet": job["modelOutputSet"],
        }

    def buffer(self, job_id: str, digest: str) -> tuple[bytes, str]:
        job = self._require(job_id)
        payload = job["buffers"].get(digest)
        if payload is None:
            raise BakeV1Error("BAKE_MODEL_INCOMPLETE", "Unknown result buffer.")
        if sha256_bytes(payload) != digest:
            raise BakeV1Error("BAKE_CACHE_CORRUPT", "Result buffer failed rehash.")
        return payload, digest

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._require(job_id)
            job["cancel"].set()
            if job["state"] not in {"completed", "failed"}:
                job["state"] = "cancelled"
                try:
                    self._queue.remove(job_id)
                except ValueError:
                    pass
        return {"state": "cancelled"}

    def _require(self, job_id: str) -> dict[str, Any]:
        job = self._jobs.get(job_id)
        if not job:
            raise BakeV1Error("BAKE_PROVIDER_UNAVAILABLE", f"Unknown bake model job {job_id}.", HTTPStatus.NOT_FOUND)
        return job

    def _pump(self):
        while self._in_flight < self.worker_pool_size and self._queue:
            job_id = self._queue.popleft()
            job = self._jobs[job_id]
            if job["cancel"].is_set() or job["state"] == "cancelled":
                job["state"] = "cancelled"
                continue
            self._in_flight += 1
            self._executor.submit(self._run_job, job_id)

    def _run_job(self, job_id: str):
        try:
            self._process_job(job_id)
        finally:
            with self._lock:
                self._in_flight = max(0, self._in_flight - 1)
                self._pump()

    def _process_job(self, job_id: str):
        started = time.time()
        with self._lock:
            job = self._jobs[job_id]
            if job["cancel"].is_set():
                job["state"] = "cancelled"
                return
            job["state"] = "running"
        try:
            request = job["request"]
            options = request.get("providerOptions") or {}
            inputs = request.get("inputs") or []
            if not inputs:
                raise BakeV1Error("BAKE_MODEL_INCOMPLETE", "Request is missing captured inputs.")
            width = inputs[0]["width"]
            height = inputs[0]["height"]
            for entry in inputs:
                if entry["width"] != width or entry["height"] != height:
                    raise BakeV1Error(
                        "BAKE_PROVIDER_CAPABILITY_MISMATCH",
                        "adapter v1 requires a common source resolution",
                    )
                key = f"{entry['sampleId']}:{entry['viewId']}:{entry['role']}"
                stored = job["inputs"].get(key)
                if not stored:
                    raise BakeV1Error("BAKE_MODEL_INCOMPLETE", f"Missing uploaded input {key}.")
                if stored["sha256"] != entry["sha256"] or stored["byteSize"] != entry["byteSize"]:
                    raise BakeV1Error("BAKE_TRANSFER_DIGEST_MISMATCH", f"Uploaded {entry['role']} digest mismatch.")
            grouped: dict[str, dict[str, Any]] = {}
            for entry in inputs:
                key = f"{entry['sampleId']}:{entry['viewId']}"
                grouped.setdefault(key, {"sampleId": entry["sampleId"], "viewId": entry["viewId"], "roles": {}})
                stored_key = f"{entry['sampleId']}:{entry['viewId']}:{entry['role']}"
                grouped[key]["roles"][entry["role"]] = job["inputs"][stored_key]["bytes"]
            samples = []
            buffers: dict[str, bytes] = {}
            for group in grouped.values():
                if job["cancel"].is_set():
                    raise BakeV1Error("BAKE_MODEL_CANCELLED", "Bake model job cancelled.")
                if (time.time() - started) * 1000 > self.max_processing_ms:
                    raise BakeV1Error("BAKE_MODEL_TIMEOUT", "Bake model processing exceeded the configured bound.")
                beauty = group["roles"].get("beauty")
                validity = group["roles"].get("validity")
                if beauty is None or validity is None:
                    raise BakeV1Error("BAKE_MODEL_INCOMPLETE", "Captured beauty and validity are required.")
                inferred = self.backend.infer(
                    beauty=beauty,
                    validity=validity,
                    width=width,
                    height=height,
                    seed=int(request.get("seed") or 0),
                    resize_policy=options.get("resizePolicy"),
                    prompts=options.get("prompts"),
                    inference=options.get("inference") or {},
                    cancelled=job["cancel"],
                )
                missing = [channel for channel in MODEL_OUTPUT_CHANNELS if channel not in inferred]
                if missing:
                    raise BakeV1Error("BAKE_MODEL_INCOMPLETE", f"Backend omitted channels: {missing}")
                outputs = []
                for channel in MODEL_OUTPUT_CHANNELS:
                    payload = inferred[channel]
                    digest = sha256_bytes(payload)
                    buffers[digest] = payload
                    encoding, components, _bytes = CHANNEL_LAYOUTS[channel]
                    outputs.append({
                        "channel": channel,
                        "encoding": encoding,
                        "components": components,
                        "byteSize": len(payload),
                        "sha256": digest,
                    })
                effective_w, effective_h = effective_dimensions(width, height, options.get("resizePolicy"))
                samples.append({
                    "sampleId": group["sampleId"],
                    "viewId": group["viewId"],
                    "width": width,
                    "height": height,
                    "sourceDimensions": {"width": width, "height": height},
                    "effectiveDimensions": {"width": effective_w, "height": effective_h},
                    "outputs": outputs,
                })
            samples.sort(key=lambda entry: f"{entry['sampleId']}:{entry['viewId']}")
            for sample in samples:
                sample["outputs"] = sorted(sample["outputs"], key=lambda entry: entry["channel"])
            model_output_set = {
                "kind": "cev-sim.bake-model-output-set",
                "version": 1,
                "requestHash": job["requestHash"],
                "samples": samples,
            }
            source_dimensions = {"width": width, "height": height}
            effective = samples[0]["effectiveDimensions"] if samples else source_dimensions
            response = {
                "kind": "cev-sim.bake-provider-response",
                "version": 1,
                "requestHash": job["requestHash"],
                "outputs": list(inputs),
                "providerRevision": "intrinsic-material-model@1",
                "modelRevision": self.backend.model_revision,
                "weightsDigest": self.backend.weights_digest,
                "prompts": options.get("prompts"),
                "configuration": {
                    "algorithmId": options.get("algorithm", {}).get("id", self.backend.algorithm_id),
                    "algorithmRevision": self.backend.algorithm_revision,
                    "resizePolicy": options.get("resizePolicy") or {"mode": "identity"},
                    "inference": options.get("inference") or {},
                    "modelOutputCodec": "intrinsic-model-output@1",
                },
                "runtimeOptions": {"transform": "intrinsic-material-model"},
                "seed": int(request.get("seed") or 0),
                "sourceDimensions": source_dimensions,
                "effectiveDimensions": effective,
                "codecRevisions": {"capture": "aligned-products@1"},
                "runtimeStack": {"kind": self.backend.runtime_kind, "version": 1},
                "nondeterminismScope": self.backend.nondeterminism_scope,
                "cachePolicy": request.get("cachePolicy") or {"mode": "none"},
            }
            if job["cancel"].is_set():
                raise BakeV1Error("BAKE_MODEL_CANCELLED", "Bake model job cancelled.")
            if request.get("cachePolicy", {}).get("mode") == "reuse-request":
                self._publish_cache(job["requestHash"], response, model_output_set, buffers)
            with self._lock:
                job["response"] = response
                job["modelOutputSet"] = model_output_set
                job["buffers"] = buffers
                job["state"] = "completed"
        except BakeV1Error as error:
            with self._lock:
                job["state"] = "cancelled" if error.code == "BAKE_MODEL_CANCELLED" else "failed"
                job["code"] = error.code
                job["error"] = str(error)
        except Exception as error:  # noqa: BLE001
            with self._lock:
                job["state"] = "failed"
                job["code"] = "BAKE_MODEL_INCOMPLETE"
                job["error"] = str(error)

    def _cache_dir(self, request_hash: str) -> Path:
        return self.cache_root / request_hash

    def _read_cache(self, request_hash: str) -> dict[str, Any] | None:
        directory = self._cache_dir(request_hash)
        if not directory.exists():
            return None
        if not directory.is_dir():
            raise BakeV1Error("BAKE_CACHE_CORRUPT", "Cached model output is not a directory.")
        manifest_path = directory / "model-output-set.json"
        response_path = directory / "response.json"
        if not manifest_path.exists() or not response_path.exists():
            raise BakeV1Error("BAKE_CACHE_CORRUPT", "Cached model output is incomplete.")
        model_output_set = json.loads(manifest_path.read_text("utf-8"))
        response = json.loads(response_path.read_text("utf-8"))
        buffers: dict[str, bytes] = {}
        for sample in model_output_set.get("samples", []):
            for output in sample.get("outputs", []):
                path = directory / "buffers" / output["sha256"]
                if not path.exists():
                    raise BakeV1Error("BAKE_CACHE_CORRUPT", "Cached model output is incomplete.")
                payload = path.read_bytes()
                if sha256_bytes(payload) != output["sha256"] or len(payload) != output["byteSize"]:
                    raise BakeV1Error("BAKE_CACHE_CORRUPT", "Cached model output failed rehash.")
                buffers[output["sha256"]] = payload
        expected = {
            output["sha256"]
            for sample in model_output_set.get("samples", [])
            for output in sample.get("outputs", [])
        }
        if set(buffers) != expected:
            raise BakeV1Error("BAKE_CACHE_CORRUPT", "Cached model output is incomplete.")
        return {"response": response, "modelOutputSet": model_output_set, "buffers": buffers}

    def _publish_cache(
        self,
        request_hash: str,
        response: dict[str, Any],
        model_output_set: dict[str, Any],
        buffers: dict[str, bytes],
    ):
        destination = self._cache_dir(request_hash)
        if destination.exists():
            self._read_cache(request_hash)
            return
        tmp = self.tmp_root / uuid.uuid4().hex
        try:
            (tmp / "buffers").mkdir(parents=True, exist_ok=True)
            for digest, payload in buffers.items():
                if sha256_bytes(payload) != digest:
                    raise BakeV1Error("BAKE_CACHE_CORRUPT", "Cache publication digest mismatch.")
                (tmp / "buffers" / digest).write_bytes(payload)
            (tmp / "response.json").write_text(json.dumps(response, separators=(",", ":")), encoding="utf-8")
            (tmp / "model-output-set.json").write_text(
                json.dumps(model_output_set, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(tmp, destination)
            self._read_cache(request_hash)
        except BakeV1Error:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        except Exception as error:
            shutil.rmtree(tmp, ignore_errors=True)
            raise BakeV1Error("BAKE_CACHE_CORRUPT", f"Cached model output publication failed: {error}") from error


def parse_digest_header(value: str | None) -> str:
    text = (value or "").strip()
    if not text.startswith("sha256:") or len(text) != 71:
        raise BakeV1Error("BAKE_TRANSFER_DIGEST_MISMATCH", "Transfer is missing a declared SHA-256 digest.")
    return text[7:]
