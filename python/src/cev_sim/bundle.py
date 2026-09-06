from __future__ import annotations

import hashlib
import json
import math
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
    received_bytes: bytes = b""
    bundle_bytes_hash: str = ""
    canonical_json_hash: str = ""
    identity_profile: str | None = None
    required_protocol_minor: int = 2


BundleInput = str | Path | bytes | bytearray | Mapping[str, Any]
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


def _legacy_json(value: Any) -> bytes:
    # Preserve JS Object/JSON.stringify integer-key ordering, including its
    # historical difference from JCS. Never use this for the exact v11 contract.
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
        indexes = [key for key in keys if re.fullmatch(r"0|[1-9][0-9]*", key)
                   and int(key) < 0xFFFF_FFFF]
        ordered = sorted(indexes, key=int) + [key for key in keys if key not in indexes]
        return b"{" + b",".join(rfc8785.dumps(key) + b":" + _legacy_json(value[key])
                                for key in ordered) + b"}"
    if isinstance(value, list):
        return b"[" + b",".join(_legacy_json(entry) for entry in value) + b"]"
    return rfc8785.dumps(value)


def canonical_bundle_bytes(document: Mapping[str, Any]) -> bytes:
    try:
        resolved = document.get("resolved")
        if isinstance(resolved, Mapping) and resolved.get("version") == 11:
            return rfc8785.dumps(document)
        return _legacy_json(document)
    except (rfc8785.CanonicalizationError, TypeError, ValueError, UnicodeError) as error:
        raise CevSimConfigurationError(f"Run bundle cannot be serialized canonically: {error}") from error


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _json_integer(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value == math.floor(value)


def _parse_integer(value: str) -> int | float:
    parsed = int(value)
    # JSON numbers have the same binary64 interpretation as JavaScript. Large
    # numeric counters are checked by their schema, not by their lexical spelling.
    return parsed if abs(parsed) <= 2**53 - 1 else float(value)


def _check_counters(manifest: Mapping[str, Any], scenario: Mapping[str, Any]) -> None:
    def check(value: Any, name: str) -> None:
        if value is not None and (not _json_integer(value) or abs(value) > 2**53 - 1):
            raise CevSimConfigurationError(f"{name} must be a safe integer in run-manifest v11")

    seed = manifest.get("seed")
    if type(seed) in (int, float):
        check(seed, "seed")
    for key in ("stepNs", "maxSteps"):
        check(manifest.get("clock", {}).get(key), f"clock.{key}")
    check(manifest.get("controls", {}).get("watchdogNs"), "controls.watchdogNs")
    check(manifest.get("controls", {}).get("actuatorOverrides", {}).get("responseDelayNs"),
          "controls.actuatorOverrides.responseDelayNs")
    for assertion in manifest.get("assertions", []):
        for key in ("startStep", "endStep"):
            check(assertion.get("window", {}).get(key), f"assertion.window.{key}")
    for sensor in manifest.get("sensorRig", {}).get("sensors", []):
        for key in ("phaseNs", "maxQueueFrames"):
            check(sensor.get(key), f"sensor.{key}")
        for key in ("fixedNs", "jitterNs"):
            check(sensor.get("latency", {}).get(key), f"sensor.latency.{key}")
    for trigger in scenario.get("triggers", []):
        for key in ("timeNs", "step"):
            check(trigger.get("condition", {}).get(key), f"scenario.trigger.condition.{key}")
        for action in trigger.get("actions", []):
            check(action.get("durationNs"), "scenario.trigger.action.durationNs")
    for condition in scenario.get("completion", {}).get("conditions", []):
        check(condition.get("durationNs"), "scenario.completion.durationNs")
        check(condition.get("cadence", {}).get("everyN"), "scenario.completion.cadence.everyN")


def _invalid_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number {value}")


def load_bundle(value: BundleInput, *, expected_bundle_bytes_hash: str | None = None) -> LoadedBundle:
    try:
        if isinstance(value, Mapping):
            document = dict(value)
            received = canonical_bundle_bytes(document)
        else:
            received = bytes(value) if isinstance(value, (bytes, bytearray)) else Path(value).read_bytes()
            document = json.loads(received.decode("utf-8"), object_pairs_hook=_unique_object,
                                  parse_constant=_invalid_constant, parse_int=_parse_integer)
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        raise CevSimConfigurationError(f"Could not read run bundle: {error}") from error
    bytes_hash = hashlib.sha256(received).hexdigest()
    if expected_bundle_bytes_hash is not None and expected_bundle_bytes_hash != bytes_hash:
        raise CevSimConfigurationError("Exact run bundle byte digest does not match")
    if not isinstance(document, dict):
        raise CevSimConfigurationError("Run bundle must be a JSON object")
    if (document.get("kind") != "cev-sim.run-bundle"
            or not _json_integer(document.get("version")) or document["version"] != 1):
        raise CevSimConfigurationError("Run bundle must be cev-sim.run-bundle version 1")
    resolved = document.get("resolved")
    if not isinstance(resolved, dict) or resolved.get("kind") != "cev-sim.run-manifest":
        raise CevSimConfigurationError("Run bundle requires a resolved run manifest")
    version = resolved.get("version")
    if not _json_integer(version) or version not in (10, 11):
        raise CevSimConfigurationError("Unsupported resolved version; import and re-resolve historical bundles")
    identity_profile = None
    if version == 11:
        profile = resolved.get("identityProfile")
        if (not isinstance(profile, dict) or profile != {"id": "world-bound", "version": 2}
                or not _json_integer(profile["version"])):
            raise CevSimConfigurationError("Manifest v11 requires identityProfile world-bound@2")
        identity_profile = "world-bound@2"
    elif "identityProfile" in resolved:
        raise CevSimConfigurationError("Unsupported identity profile on a legacy bundle")
    manifest = document.get("manifest")
    if (not isinstance(manifest, dict) or manifest != resolved.get("manifest")
            or manifest.get("kind") != "cev-sim.run-manifest" or manifest.get("version") != version):
        raise CevSimConfigurationError("Bundle and resolved manifest versions/content must agree")
    resolved_hash = document.get("resolvedHash")
    semantic_hash = document.get("simulationSemanticHash")
    for label, digest in (("resolvedHash", resolved_hash), ("simulationSemanticHash", semantic_hash)):
        if not isinstance(digest, str) or _SHA256_PATTERN.fullmatch(digest) is None:
            raise CevSimConfigurationError(f"Run bundle {label} must be a lowercase SHA-256 hex digest")
        if resolved.get(label) != digest:
            raise CevSimConfigurationError(f"Run bundle and resolved {label} must agree")
    if version == 11:
        try:
            _check_counters(manifest, (resolved.get("scenario") or {}).get("scenario") or {})
        except (AttributeError, TypeError) as error:
            raise CevSimConfigurationError(f"Invalid run identity counter structure: {error}") from error
    canonical = canonical_bundle_bytes(document)
    return LoadedBundle(
        document=document,
        canonical_json=canonical,
        bundle_id=resolved_hash,
        resolved_hash=resolved_hash,
        simulation_semantic_hash=semantic_hash,
        received_bytes=received,
        bundle_bytes_hash=bytes_hash,
        canonical_json_hash=hashlib.sha256(canonical).hexdigest(),
        identity_profile=identity_profile,
        required_protocol_minor=3 if identity_profile else 2,
    )
