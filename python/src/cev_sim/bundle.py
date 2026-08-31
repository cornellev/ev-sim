from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import rfc8785

from .errors import CevSimConfigurationError


@dataclass(frozen=True)
class LoadedBundle:
    document: Mapping[str, Any]
    canonical_json: bytes
    bundle_id: str
    resolved_hash: str
    simulation_semantic_hash: str


BundleInput = str | Path | bytes | bytearray | Mapping[str, Any]
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


def canonical_bundle_bytes(document: Mapping[str, Any]) -> bytes:
    try:
        return rfc8785.dumps(document)
    except (rfc8785.CanonicalizationError, TypeError, ValueError) as error:
        raise CevSimConfigurationError(f"Run bundle cannot be serialized canonically: {error}") from error


def load_bundle(value: BundleInput) -> LoadedBundle:
    try:
        if isinstance(value, Mapping):
            document = dict(value)
        elif isinstance(value, (bytes, bytearray)):
            document = json.loads(bytes(value))
        else:
            document = json.loads(Path(value).read_bytes())
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError) as error:
        raise CevSimConfigurationError(f"Could not read run bundle: {error}") from error
    if not isinstance(document, dict):
        raise CevSimConfigurationError("Run bundle must be a JSON object")
    if document.get("kind") != "cev-sim.run-bundle" or document.get("version") != 1:
        raise CevSimConfigurationError("Run bundle must be cev-sim.run-bundle version 1")
    resolved_hash = document.get("resolvedHash")
    semantic_hash = document.get("simulationSemanticHash")
    if not isinstance(resolved_hash, str) or _SHA256_PATTERN.fullmatch(resolved_hash) is None:
        raise CevSimConfigurationError("Run bundle resolvedHash must be a lowercase SHA-256 hex digest")
    if not isinstance(semantic_hash, str) or _SHA256_PATTERN.fullmatch(semantic_hash) is None:
        raise CevSimConfigurationError("Run bundle simulationSemanticHash must be a lowercase SHA-256 hex digest")
    return LoadedBundle(
        document=document,
        canonical_json=canonical_bundle_bytes(document),
        bundle_id=resolved_hash,
        resolved_hash=resolved_hash,
        simulation_semantic_hash=semantic_hash,
    )
