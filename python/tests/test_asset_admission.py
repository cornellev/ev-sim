from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
import rfc8785

from cev_sim import (
    ArtifactPolicy,
    CevSimCompatibilityError,
    CevSimConfigurationError,
    EpisodeConfig,
    ResourceLimits,
    SupervisorLaunch,
    load_run_package,
)
from cev_sim.bundle import _package_manifest, _ustar_header
from cev_sim.client import AssetAdmission, CevSimBatch, SupervisorClient
from cev_sim.headless.v1 import headless_pb2 as pb


def make_package(bundle_path: Path, destination: Path) -> Path:
    bundle = bundle_path.read_bytes()
    manifest = rfc8785.dumps({
        "kind": "cev-sim.run-package", "version": 1,
        "bundle": {"sha256": hashlib.sha256(bundle).hexdigest(), "sizeBytes": len(bundle)},
        "assets": [],
    })
    parts = []
    for name, data in (("manifest.json", manifest), ("bundle.json", bundle)):
        parts.extend((_ustar_header(name, len(data)), data, bytes((-len(data)) % 512)))
    destination.write_bytes(b"".join(parts) + bytes(1024))
    return destination


def test_manifest_rejects_boolean_versions_and_unhashable_metadata() -> None:
    manifest = {"kind": "cev-sim.run-package", "version": True,
                "bundle": {"sha256": "0" * 64, "sizeBytes": 0}, "assets": []}
    with pytest.raises(CevSimConfigurationError, match="version 1"):
        _package_manifest(manifest)
    manifest["version"] = 1
    manifest["assets"] = [{"sha256": "1" * 64, "sizeBytes": 1, "mediaType": [], "role": "mesh"}]
    with pytest.raises(CevSimConfigurationError, match="media type"):
        _package_manifest(manifest)


def test_package_parse_failure_closes_descriptor_once(tmp_path, monkeypatch) -> None:
    source = tmp_path / "invalid.run-package"
    source.write_bytes(b"truncated")
    closed = []
    original = os.close

    def close(descriptor):
        closed.append(descriptor)
        original(descriptor)

    monkeypatch.setattr(os, "close", close)
    with pytest.raises(CevSimConfigurationError, match="truncated"):
        load_run_package(source)
    assert len(closed) == 1


def test_failed_release_is_retryable() -> None:
    client = object.__new__(SupervisorClient)
    client.channel = object()
    client.stub = SimpleNamespace(ReleaseAssetAdmission=object())
    admission = AssetAdmission(client, None, "a" * 64, "b" * 64)
    client._admissions = {admission.handle: admission}
    client.call = lambda *_: SimpleNamespace(error=pb.ErrorStatus(code=pb.ERROR_CODE_INTERNAL, message="retry"))
    with pytest.raises(Exception, match="retry"):
        admission.release()
    assert not admission.released
    assert admission.handle in client._admissions
    client.call = lambda *_: SimpleNamespace(error=pb.ErrorStatus())
    admission.release()
    assert admission.released
    assert not client._admissions


def test_failed_batch_close_remains_registered_for_shutdown_retry() -> None:
    client = object.__new__(SupervisorClient)
    client.stub = SimpleNamespace(CloseBatch=object())
    batch = object.__new__(CevSimBatch)
    batch.client, batch.batch_id, batch.count, batch.closed = client, "batch", 1, False
    batch.observation_codec = SimpleNamespace(close=lambda: None)
    client._batches = {batch.batch_id: batch}
    client.call = lambda *_: SimpleNamespace(error=pb.ErrorStatus(code=pb.ERROR_CODE_INTERNAL, message="retry"))
    with pytest.raises(Exception, match="retry"):
        batch.close()
    assert not batch.closed
    assert batch.batch_id in client._batches
    client.call = lambda *_: SimpleNamespace(error=pb.ErrorStatus(), finalized=[])
    batch.close()
    assert batch.closed
    assert not client._batches


@pytest.mark.integration
def test_owned_unix_package_roundtrip_and_shutdown_cleanup(repository_root, headless_fixture, tmp_path) -> None:
    source = make_package(Path(headless_fixture["bundlePath"]), tmp_path / "input.run-package")
    # Exercise an explicit inbox override too; the client must stage at the
    # same location that its owned supervisor actually consumes.
    inbox = tmp_path / "custom-inbox"
    store = tmp_path / "asset-store"
    config = tmp_path / "supervisor.json"
    config.write_text(json.dumps({"kind": "cev-sim.headless-supervisor-config", "version": 1,
                                  "assetAdmission": {"inboxDir": str(inbox), "storageDir": str(store)}}))
    client = SupervisorClient(launch=SupervisorLaunch(
        executable=repository_root / "bin/cev-sim.js", config_path=config,
    ))
    try:
        package = load_run_package(source)
        with client.admit_run_package(package) as admission:
            batch = client.create_batch(admission, count=1, output_directory=tmp_path / "output",
                                        episode=EpisodeConfig(), resource_limits=ResourceLimits(),
                                        artifact_policy=ArtifactPolicy(profile="disabled"))
            assert len(batch.reset([0], [123])) == 1
            assert not list(inbox.iterdir())
        # Client release must not invalidate a batch still using the admission.
        batch.finalize([0])
        assert len(batch.reset([0], [123])) == 1
        assert list((store / "admissions").glob("*.json"))
    finally:
        client.close()
    assert batch.closed
    assert not list((store / "admissions").glob("*.json"))
    assert not list((store / "bundles").glob("*.json"))


@pytest.mark.parametrize("minor,profiles,target", [(3, [], "unix:/tmp/old.sock"),
                                                   (4, [], "unix:/tmp/disabled.sock"),
                                                   (4, ["cev-sim.run-package@1"], "127.0.0.1:1")])
def test_unsupported_supervisors_fail_before_staging(minor, profiles, target, tmp_path) -> None:
    client = object.__new__(SupervisorClient)
    client.target = target
    client.protocol_minor = minor
    client.capabilities = pb.GetCapabilitiesResponse(asset_admission_profiles=profiles)
    client.package_inbox = tmp_path / "inbox"
    with pytest.raises((CevSimCompatibilityError, CevSimConfigurationError)):
        client.admit_run_package(tmp_path / "does-not-exist.run-package")
    assert not client.package_inbox.exists()
