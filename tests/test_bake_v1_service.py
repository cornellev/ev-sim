"""VIS-11 bounded bake v1 service tests. No Torch or model weights required."""

from __future__ import annotations

import json
import sys
import threading
import time
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

import pytest

ROOT = Path(__file__).resolve().parents[1]
BAKING_DIR = ROOT / "baking"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "bake" / "intrinsic-material-model.v1.json"

sys.path.insert(0, str(BAKING_DIR))

import bake_server  # noqa: E402
from backends import (  # noqa: E402
    FakeIntrinsicMaterialBackend,
    OperatorInjectedBackend,
    load_backend,
)
from contracts import (  # noqa: E402
    FAKE_WEIGHTS_DIGEST,
    MODEL_OUTPUT_CHANNELS,
    hash_document,
    infer_fake_intrinsic_channels,
    run_fake_inference,
    sha256_bytes,
)
from v1_service import BakeV1Error, BakeV1Service  # noqa: E402


def load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text("utf-8"))


def beauty_validity(fixture: dict) -> tuple[bytes, bytes]:
    return bytes.fromhex(fixture["rawBuffers"]["beauty"]), bytes.fromhex(fixture["rawBuffers"]["validity"])


def wait_state(service: BakeV1Service, job_id: str, wanted: set[str], timeout: float = 2.0) -> dict:
    deadline = time.time() + timeout
    status = service.status(job_id)
    while time.time() < deadline:
        if status["state"] in wanted:
            return status
        time.sleep(0.01)
        status = service.status(job_id)
    raise AssertionError(f"job {job_id} stayed in {status} before {wanted}")


def upload_fixture_inputs(service: BakeV1Service, job_id: str, fixture: dict) -> None:
    beauty, validity = beauty_validity(fixture)
    sample_id = fixture["request"]["inputs"][0]["sampleId"]
    view_id = fixture["request"]["inputs"][0]["viewId"]
    service.upload_input(job_id, sample_id, view_id, "beauty", beauty, sha256_bytes(beauty))
    service.upload_input(job_id, sample_id, view_id, "validity", validity, sha256_bytes(validity))


def complete_fixture_job(service: BakeV1Service, fixture: dict, cache_mode: str | None = None) -> dict:
    request = json.loads(json.dumps(fixture["request"]))
    if cache_mode is not None:
        request["cachePolicy"] = {"mode": cache_mode}
    created = service.create_job(request)
    if created["state"] != "completed":
        upload_fixture_inputs(service, created["jobId"], fixture)
        service.submit(created["jobId"], created["requestHash"])
        status = wait_state(service, created["jobId"], {"completed", "failed", "cancelled"})
        assert status["state"] == "completed", status
    return created


class IncompleteBackend(FakeIntrinsicMaterialBackend):
    def infer(self, **kwargs):
        result = super().infer(**kwargs)
        result.pop("normal", None)
        return result


class SlowBackend(FakeIntrinsicMaterialBackend):
    def __init__(self, delay: float = 0.4):
        self.delay = delay

    def infer(self, *, cancelled=None, **kwargs):
        deadline = time.time() + self.delay
        while time.time() < deadline:
            if cancelled is not None and cancelled.is_set():
                break
            time.sleep(0.01)
        return FakeIntrinsicMaterialBackend().infer(cancelled=cancelled, **kwargs)


def test_shared_fixture_hash_parity_and_fake_inference():
    rfc8785 = pytest.importorskip("rfc8785")
    fixture = load_fixture()
    assert fixture["kind"] == "cev-sim.bake-intrinsic-material-fixture"
    assert fixture["providerOptions"]["weightsDigest"] == FAKE_WEIGHTS_DIGEST
    assert hash_document(fixture["request"]) == fixture["requestHash"]
    assert hash_document(fixture["response"]) == fixture["responseHash"]
    assert hash_document(fixture["modelOutputSet"]) == fixture["modelOutputHash"]
    beauty, validity = beauty_validity(fixture)
    inferred = infer_fake_intrinsic_channels(beauty, validity, 2, 1, seed=11)
    restored, effective = run_fake_inference(beauty, validity, 2, 1, {"mode": "identity"}, 11)
    assert effective == (2, 1)
    assert inferred["base-color"].hex() == fixture["rawBuffers"]["base-color"]
    assert restored["base-color"] == inferred["base-color"]
    assert rfc8785.dumps(fixture["request"]) is not None


def test_load_backend_defaults_to_fake_and_refuses_unpinned_real(monkeypatch):
    for key in (
        "BAKE_MODEL_BACKEND",
        "BAKE_MODEL_ID",
        "BAKE_MODEL_REVISION",
        "BAKE_MODEL_WEIGHTS_DIGEST",
        "BAKE_MODEL_ALGORITHM_ID",
        "BAKE_MODEL_ALGORITHM_REVISION",
    ):
        monkeypatch.delenv(key, raising=False)
    backend = load_backend()
    assert isinstance(backend, FakeIntrinsicMaterialBackend)
    with pytest.raises(RuntimeError, match="non-promotable"):
        load_backend({"backend": "legacy-image-fill"})
    with pytest.raises(RuntimeError, match="immutable"):
        load_backend({"backend": "real"})
    with pytest.raises(RuntimeError, match="not bundled"):
        OperatorInjectedBackend(
            model_id="x",
            model_revision="1",
            weights_digest="a" * 64,
            algorithm_id="algo",
            algorithm_revision="1",
            delegate=None,
        )


def test_upload_and_queue_bounds(tmp_path: Path):
    fixture = load_fixture()
    service = BakeV1Service(root=tmp_path, max_upload_bytes=4, max_queue_jobs=1)
    bounded = BakeV1Service(root=tmp_path / "digest", max_upload_bytes=64, max_queue_jobs=1)
    try:
        created = service.create_job(fixture["request"])
        with pytest.raises(BakeV1Error) as mismatch:
            service.upload_input(created["jobId"], "s", "v", "beauty", b"abcdef", "0" * 64)
        assert mismatch.value.code == "BAKE_PROVIDER_CAPABILITY_MISMATCH"
        created = bounded.create_job(fixture["request"])
        with pytest.raises(BakeV1Error) as digest:
            bounded.upload_input(created["jobId"], "s", "v", "beauty", b"abcdef", "0" * 64)
        assert digest.value.code == "BAKE_TRANSFER_DIGEST_MISMATCH"
        second_request = json.loads(json.dumps(fixture["request"]))
        second_request["seed"] = 12
        with pytest.raises(BakeV1Error) as queued:
            bounded.create_job(second_request)
        assert queued.value.code == "BAKE_PROVIDER_CAPABILITY_MISMATCH"
        retry = bounded.create_job(fixture["request"])
        assert retry["jobId"] == created["jobId"]
    finally:
        service.close()
        bounded.close()


def test_fake_inference_job_and_idempotent_retry(tmp_path: Path):
    fixture = load_fixture()
    service = BakeV1Service(root=tmp_path)
    try:
        first = complete_fixture_job(service, fixture)
        assert first["requestHash"] == fixture["requestHash"]
        result = service.result(created_id := first["jobId"])
        assert result["modelOutputSet"]["requestHash"] == fixture["requestHash"]
        assert [entry["channel"] for entry in result["modelOutputSet"]["samples"][0]["outputs"]] == list(
            MODEL_OUTPUT_CHANNELS
        )
        output = result["modelOutputSet"]["samples"][0]["outputs"][0]
        payload, digest = service.buffer(created_id, output["sha256"])
        assert digest == output["sha256"]
        assert sha256_bytes(payload) == digest
        retry = service.create_job(fixture["request"])
        assert retry["jobId"] == first["jobId"]
        service.submit(created_id, first["requestHash"])
        assert service.status(created_id)["state"] == "completed"
    finally:
        service.close()


def test_cancellation_and_incomplete_backend(tmp_path: Path):
    fixture = load_fixture()
    slow = BakeV1Service(root=tmp_path / "slow", backend=SlowBackend(0.5), worker_pool_size=1, max_queue_jobs=2)
    try:
        created = slow.create_job(fixture["request"])
        upload_fixture_inputs(slow, created["jobId"], fixture)
        slow.submit(created["jobId"], created["requestHash"])
        slow.cancel(created["jobId"])
        status = wait_state(slow, created["jobId"], {"cancelled", "failed", "completed"})
        assert status["state"] == "cancelled"
    finally:
        slow.close()

    incomplete = BakeV1Service(root=tmp_path / "incomplete", backend=IncompleteBackend())
    try:
        created = incomplete.create_job(fixture["request"])
        upload_fixture_inputs(incomplete, created["jobId"], fixture)
        incomplete.submit(created["jobId"], created["requestHash"])
        status = wait_state(incomplete, created["jobId"], {"failed", "cancelled", "completed"})
        assert status["state"] == "failed"
        assert status["code"] == "BAKE_MODEL_INCOMPLETE"
    finally:
        incomplete.close()


def test_atomic_cache_publication_and_corrupted_cache(tmp_path: Path):
    fixture = load_fixture()
    first = BakeV1Service(root=tmp_path)
    try:
        created = complete_fixture_job(first, fixture, cache_mode="reuse-request")
        request_hash = created["requestHash"]
        result = first.result(created["jobId"])
        cache_dir = tmp_path / "cache" / "sha256" / request_hash
        assert (cache_dir / "model-output-set.json").is_file()
        assert not any(tmp_path.joinpath("tmp").glob("*"))
        first_hash = hash_document(result["modelOutputSet"])
        digest = result["modelOutputSet"]["samples"][0]["outputs"][0]["sha256"]
    finally:
        first.close()

    second = BakeV1Service(root=tmp_path)
    try:
        reused = complete_fixture_job(second, fixture, cache_mode="reuse-request")
        assert reused["state"] == "completed"
        assert hash_document(second.result(reused["jobId"])["modelOutputSet"]) == first_hash
    finally:
        second.close()

    buffer_path = tmp_path / "cache" / "sha256" / request_hash / "buffers" / digest
    buffer_path.write_bytes(b"corrupt-cache")
    third = BakeV1Service(root=tmp_path)
    try:
        with pytest.raises(BakeV1Error) as corrupt:
            third.create_job({**fixture["request"], "cachePolicy": {"mode": "reuse-request"}})
        assert corrupt.value.code == "BAKE_CACHE_CORRUPT"
    finally:
        third.close()


def test_http_capability_upload_and_result(tmp_path: Path):
    fixture = load_fixture()
    service = BakeV1Service(root=tmp_path)
    bake_server.set_v1_service(service)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), bake_server.BakingRequestHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address[:2]
    try:
        conn = HTTPConnection(host, port, timeout=5)
        conn.request("GET", "/bake/v1/capability")
        capability = json.loads(conn.getresponse().read().decode("utf-8"))
        assert capability["provider"]["id"] == "intrinsic-material-model"
        body = json.dumps({"request": fixture["request"]}).encode("utf-8")
        conn.request(
            "POST",
            "/bake/v1/jobs",
            body=body,
            headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
        )
        created = json.loads(conn.getresponse().read().decode("utf-8"))
        beauty, validity = beauty_validity(fixture)
        sample = fixture["request"]["inputs"][0]
        key = quote(f"{sample['sampleId']}:{sample['viewId']}:beauty", safe="")
        conn.request(
            "PUT",
            f"/bake/v1/jobs/{created['jobId']}/inputs/{key}",
            body=beauty,
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(beauty)),
                "X-Cev-Digest": f"sha256:{sha256_bytes(beauty)}",
                "X-Cev-Sample-Id": sample["sampleId"],
                "X-Cev-View-Id": sample["viewId"],
                "X-Cev-Role": "beauty",
            },
        )
        assert conn.getresponse().status == 200
        key = quote(f"{sample['sampleId']}:{sample['viewId']}:validity", safe="")
        conn.request(
            "PUT",
            f"/bake/v1/jobs/{created['jobId']}/inputs/{key}",
            body=validity,
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(validity)),
                "X-Cev-Digest": f"sha256:{sha256_bytes(validity)}",
                "X-Cev-Sample-Id": sample["sampleId"],
                "X-Cev-View-Id": sample["viewId"],
                "X-Cev-Role": "validity",
            },
        )
        assert conn.getresponse().status == 200
        submit = json.dumps({"requestHash": created["requestHash"]}).encode("utf-8")
        conn.request(
            "POST",
            f"/bake/v1/jobs/{created['jobId']}/submit",
            body=submit,
            headers={"Content-Type": "application/json", "Content-Length": str(len(submit))},
        )
        assert conn.getresponse().status == 200
        deadline = time.time() + 2
        payload = {}
        while time.time() < deadline:
            conn.request("GET", f"/bake/v1/jobs/{created['jobId']}/status")
            payload = json.loads(conn.getresponse().read().decode("utf-8"))
            if payload.get("state") == "completed":
                break
            time.sleep(0.01)
        assert payload.get("state") == "completed", payload
        conn.request("GET", f"/bake/v1/jobs/{created['jobId']}/result")
        result = json.loads(conn.getresponse().read().decode("utf-8"))
        assert result["modelOutputSet"]["requestHash"] == fixture["requestHash"]
        digest = result["modelOutputSet"]["samples"][0]["outputs"][0]["sha256"]
        conn.request("GET", f"/bake/v1/jobs/{created['jobId']}/buffers/{digest}")
        response = conn.getresponse()
        body = response.read()
        assert sha256_bytes(body) == digest
        assert response.getheader("X-Cev-Digest") == f"sha256:{digest}"
        conn.close()
    finally:
        httpd.shutdown()
        service.close()
        bake_server.set_v1_service(None)


def test_no_torch_imported_by_v1_modules():
    assert "torch" not in sys.modules
