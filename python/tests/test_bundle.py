from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest
import rfc8785

from cev_sim.bundle import canonical_bundle_bytes, load_bundle
from cev_sim.errors import CevSimConfigurationError


def test_visual_layer_exact_bytes_match_javascript_golden(repository_root: Path) -> None:
    fixture = json.loads(
        (repository_root / "tests/fixtures/visual-layer/owned-layer.v1.json").read_text()
    )
    canonical = rfc8785.dumps(fixture["document"])
    assert hashlib.sha256(canonical).hexdigest() == fixture["visualLayerHash"]


def test_visual_layer_rfc8785_bytes_match_javascript(repository_root: Path) -> None:
    if not (repository_root / "node_modules").is_dir():
        pytest.skip("JavaScript workspace dependencies are not installed")
    value = {
        "z": -0.0,
        "integer_like_keys": {"2": "two", "10": "ten"},
        "unicode": {"😀": "astral", "é": "accent", "a": "ascii"},
        "numbers": [1e-7, 1e-6, 1e20, 1e21, 333333333.3333333],
        "nested": [{"b": True, "a": None}],
    }
    script = """
import { canonicalExactStringify } from './app/simulation/visual/VisualLayer.js';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => process.stdout.write(canonicalExactStringify(JSON.parse(input))));
"""
    javascript = subprocess.run(
        ["node", "--experimental-default-type=module", "--input-type=module", "-e", script],
        cwd=repository_root,
        input=json.dumps(value),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.encode()
    assert rfc8785.dumps(value) == javascript


def test_rfc8785_bytes_match_javascript_canonical_stringify(repository_root: Path) -> None:
    if not (repository_root / "node_modules").is_dir():
        pytest.skip("JavaScript workspace dependencies are not installed")
    value = {
        "z": -0.0,
        "unicode": {"😀": "astral", "é": "accent", "a": "ascii"},
        "numbers": [1e-7, 1e-6, 1e20, 1e21, 333333333.3333333],
        "nested": [{"b": True, "a": None}],
    }
    script = """
import { canonicalStringify } from './app/simulation/RunManifest.js';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => process.stdout.write(canonicalStringify(JSON.parse(input))));
"""
    javascript = subprocess.run(
        ["node", "--experimental-default-type=module", "--input-type=module", "-e", script],
        cwd=repository_root,
        input=json.dumps(value),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.encode()
    assert canonical_bundle_bytes(value) == javascript


def test_bundle_loader_validates_envelope_and_canonicalizes(headless_fixture: dict[str, object]) -> None:
    loaded = load_bundle(str(headless_fixture["bundlePath"]))
    assert loaded.bundle_id == loaded.resolved_hash
    assert loaded.canonical_json.startswith(b'{"exportedAt"')
    assert b"\n" not in loaded.canonical_json


@pytest.mark.parametrize("value", [b"[]", b'{"kind":"wrong","version":1}'])
def test_bundle_loader_rejects_invalid_documents(value: bytes) -> None:
    with pytest.raises(CevSimConfigurationError):
        load_bundle(value)


def test_generated_bindings_are_current(repository_root: Path) -> None:
    subprocess.run(
        [sys.executable, str(repository_root / "python" / "scripts" / "generate_proto.py"), "--check"],
        cwd=repository_root,
        check=True,
    )


def test_legacy_bundle_bytes_and_digests_stay_frozen(repository_root: Path) -> None:
    root = repository_root / "tests/fixtures/visual-layer"
    vectors = json.loads((root / "legacy-bundles.v1.json").read_text())
    for name, vector in vectors.items():
        received = (root / f"legacy-{name}.v10.json").read_bytes()
        bundle = load_bundle(received, expected_bundle_bytes_hash=vector["bundleBytesHash"])
        assert bundle.received_bytes == bundle.canonical_json == received
        assert bundle.bundle_bytes_hash == bundle.canonical_json_hash == vector["bundleBytesHash"]
        assert bundle.identity_profile is None
        assert bundle.required_protocol_minor == 2
        assert bundle.resolved_hash == vector["resolvedHash"]
        assert bundle.simulation_semantic_hash == vector["simulationSemanticHash"]


def test_v11_loader_preserves_received_bytes_and_negotiation_requirements(headless_fixture: dict[str, object]) -> None:
    bundle = load_bundle(str(headless_fixture["bundlePath"]))
    assert bundle.identity_profile == "world-bound@2"
    assert bundle.required_protocol_minor == 3
    pretty = json.dumps(bundle.document, indent=2).encode()
    loaded = load_bundle(pretty)
    assert loaded.received_bytes == pretty
    assert loaded.bundle_bytes_hash == hashlib.sha256(pretty).hexdigest()
    assert loaded.canonical_json == bundle.canonical_json
    assert loaded.canonical_json_hash != loaded.bundle_bytes_hash
    with pytest.raises(CevSimConfigurationError, match="byte digest"):
        load_bundle(pretty + b"\n", expected_bundle_bytes_hash=loaded.bundle_bytes_hash)
    for profile in (None, {"id": "world-bound", "version": 1}, {"id": "world-bound", "version": "2"}):
        document = json.loads(pretty)
        document["resolved"]["identityProfile"] = profile
        with pytest.raises(CevSimConfigurationError, match="identityProfile"):
            load_bundle(document)


@pytest.mark.parametrize("received", [b'{"a":1,"a":2}', b'\xff', b'{"a":NaN}', b'{"a":"\\ud800"}'])
def test_bundle_ingestion_rejects_invalid_json(received: bytes) -> None:
    with pytest.raises(CevSimConfigurationError):
        load_bundle(received)


def test_versioned_canonical_serializers_keep_integer_key_contracts() -> None:
    value = {"resolved": {"version": 10}, "map": {"10": "ten", "2": "two"}}
    assert b'"map":{"2":"two","10":"ten"}' in canonical_bundle_bytes(value)
    value["resolved"]["version"] = 11
    assert b'"map":{"10":"ten","2":"two"}' in canonical_bundle_bytes(value)


def test_v11_exact_golden_and_numeric_json_match_javascript(repository_root: Path) -> None:
    root = repository_root / "tests/fixtures/visual-layer"
    expected = json.loads((root / "world-bound-state.v2.json").read_text())
    received = (root / "world-bound-state.v11.json").read_bytes()
    bundle = load_bundle(received)
    assert bundle.canonical_json == received
    assert bundle.bundle_bytes_hash == expected["bundleBytesHash"]
    document = dict(bundle.document)
    document["evidence"] = {"finite_float": 1e20, "negative_zero": -0.0}
    exact = canonical_bundle_bytes(document)
    assert load_bundle(exact).canonical_json == exact
    document["resolved"]["manifest"]["clock"]["stepNs"] = 2**53
    document["manifest"] = document["resolved"]["manifest"]
    with pytest.raises(CevSimConfigurationError, match="safe integer"):
        load_bundle(json.dumps(document).encode())
    document = json.loads(received)
    document["resolved"]["scenario"]["scenario"]["triggers"][0]["condition"]["step"] = 2**53
    with pytest.raises(CevSimConfigurationError, match="safe integer"):
        load_bundle(json.dumps(document).encode())
