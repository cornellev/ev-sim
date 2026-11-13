from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest
import rfc8785

from cev_sim.bundle import canonical_bundle_bytes, load_bundle, load_run_package
from cev_sim.errors import CevSimConfigurationError


def snapshot(repository_root: Path, name: str = "publish") -> dict:
    return json.loads((repository_root / f"tests/fixtures/protobuf/run-{name}.v12.json").read_bytes())


def test_v12_snapshots_match_javascript_bytes_and_identity_vectors(repository_root: Path) -> None:
    root = repository_root / "tests/fixtures/protobuf"
    vectors = json.loads((root / "run-snapshots.v12.json").read_bytes())
    for name, vector in vectors.items():
        received = (root / vector["file"]).read_bytes()
        bundle = load_bundle(received, expected_bundle_bytes_hash=vector["bundleBytesHash"])
        assert bundle.received_bytes == bundle.canonical_json == received
        assert bundle.canonical_json_hash == vector["bundleBytesHash"]
        assert bundle.resolved_hash == vector["resolvedHash"]
        assert bundle.simulation_semantic_hash == vector["simulationSemanticHash"]
        assert bundle.identity_profile == "world-bound@2"
        assert bundle.required_protocol_minor == 3
        assert canonical_bundle_bytes(bundle.document) == rfc8785.dumps(bundle.document)
        if name != "disabled":
            resource = bundle.document["resolved"]["protobufInterface"]
            assert resource["hash"] == vector["interfaceHash"]
            assert resource["document"]["schemas"][0]["fingerprint"] == vector["schemaFingerprint"]
            # Interface@1 retains JS integer-key ordering; the v12 envelope uses JCS.
            assert hashlib.sha256(rfc8785.dumps(resource["document"])).hexdigest() != resource["hash"]
    pretty = json.dumps(snapshot(repository_root), indent=2).encode()
    loaded = load_bundle(pretty)
    assert loaded.received_bytes == pretty
    assert loaded.bundle_bytes_hash != loaded.canonical_json_hash


@pytest.mark.parametrize("change", ["resource", "dependency", "fingerprint", "base64", "precision", "order"])
def test_v12_loader_rejects_missing_or_tampered_snapshots(repository_root: Path, change: str) -> None:
    document = snapshot(repository_root)
    resolved = document["resolved"]
    resource = resolved["protobufInterface"]
    interface = resource["document"]
    if change == "resource":
        del resolved["protobufInterface"]
    elif change == "dependency":
        resolved["dependencyHashes"]["protobufInterface"] = "f" * 64
    elif change == "fingerprint":
        interface["schemas"][0]["fingerprint"] = "f" * 64
    elif change == "base64":
        interface["schemas"][0]["descriptorBase64"] = "AAAA"
    elif change == "precision":
        interface["bootstrap"][0]["value"]["wheelbase_m"] += 1e-10
    else:
        interface["routes"].reverse()
    with pytest.raises(CevSimConfigurationError, match="[Pp]rotobuf"):
        load_bundle(document)


@pytest.mark.parametrize("change", ["selection", "boolean", "hash", "disabled_resource", "disabled_controller"])
def test_v12_loader_requires_explicit_valid_selection(repository_root: Path, change: str) -> None:
    document = snapshot(repository_root, "disabled")
    resolved = document["resolved"]
    config = resolved["manifest"]["protobuf"]
    if change == "selection":
        del resolved["manifest"]["protobuf"]
    elif change == "boolean":
        config["externalController"] = 1
    elif change == "hash":
        config.update(mode="zenoh", interfaceHash="F" * 64)
    elif change == "disabled_resource":
        resolved["protobufInterface"] = None
    else:
        config["externalController"] = True
    document["manifest"] = resolved["manifest"]
    with pytest.raises(CevSimConfigurationError, match="[Pp]rotobuf"):
        load_bundle(document)


def test_v12_package_preserves_embedded_descriptors_and_exact_bundle_bytes(
    repository_root: Path, tmp_path: Path,
) -> None:
    package_path = tmp_path / "protobuf.run-package"
    source = repository_root / "tests/fixtures/protobuf/run-controls.v12.json"
    script = """
import { promises as fs } from 'node:fs';
import { encodeRunPackage } from './server/headless/VisualAssetPack.js';
const bundleBytes = await fs.readFile(process.argv[1]);
await fs.writeFile(process.argv[2], encodeRunPackage({ bundleBytes }).bytes);
"""
    subprocess.run(
        ["node", "--experimental-default-type=module", "-e", script, str(source), str(package_path)],
        cwd=repository_root, check=True,
    )
    package = load_run_package(package_path)
    assert package.bundle.received_bytes == source.read_bytes()
    assert package.bundle_bytes_hash == hashlib.sha256(source.read_bytes()).hexdigest()
    assert package.assets == ()
    assert package.bundle.document["resolved"]["protobufInterface"]["document"]["schemas"]
