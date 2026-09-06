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
