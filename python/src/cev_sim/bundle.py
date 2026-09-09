from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
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


@dataclass(frozen=True)
class LoadedRunPackage:
    path: Path
    bundle: LoadedBundle
    manifest: Mapping[str, Any]
    archive_hash: str
    package_manifest_hash: str
    bundle_bytes_hash: str
    assets: tuple[Mapping[str, Any], ...]


BundleInput = str | Path | bytes | bytearray | Mapping[str, Any]
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
_USTAR_BLOCK = 512
_PACKAGE_ARCHIVE_LIMIT = 8 * 1024**3
_PACKAGE_ASSET_LIMIT = 1024**3
_PACKAGE_BUNDLE_LIMIT = 32 * 1024**2
_PACKAGE_MANIFEST_LIMIT = 4 * 1024**2
_PACKAGE_ASSET_ENTRIES = 16_384
_ASSET_NAME_PREFIX = "assets/sha256/"
_ASSET_MEDIA_TYPES = {
    "application/octet-stream",
    "image/jpeg",
    "image/ktx2",
    "image/png",
    "model/gltf+json",
    "model/gltf-binary",
}
_ASSET_ROLES = {"actor", "buffer", "environment-map", "mesh", "texture"}


def _validate_sha256(value: Any, label: str) -> None:
    if not isinstance(value, str) or _SHA256_PATTERN.fullmatch(value) is None:
        raise CevSimConfigurationError(f"{label} must be a lowercase SHA-256 hex digest")


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


def _check_pbr_shape(resolved: Mapping[str, Any], manifest: Mapping[str, Any]) -> None:
    recipe = manifest.get("renderRecipe")
    if recipe is not None and (
        not isinstance(recipe, Mapping)
        or recipe.get("kind") != "cev-sim.pbr-render-recipe"
        or recipe.get("version") != 1
    ):
        raise CevSimConfigurationError("renderRecipe must be cev-sim.pbr-render-recipe version 1")
    render_scene = resolved.get("renderScene")
    description = render_scene.get("description") if isinstance(render_scene, Mapping) else None
    provider = description.get("provider") if isinstance(description, Mapping) else None
    if not isinstance(provider, Mapping) or provider.get("id") != "pbr-mesh":
        return
    if provider.get("version") != 1:
        raise CevSimConfigurationError("Unsupported PBR render provider version")
    visual_layer = resolved.get("visualLayer")
    evidence = resolved.get("evidence")
    dependencies = resolved.get("dependencyHashes")
    world = resolved.get("world")
    if not all(isinstance(value, Mapping) for value in (render_scene, visual_layer, evidence, dependencies, world)):
        raise CevSimConfigurationError(
            "PBR bundles require world, visualLayer, renderScene, evidence, and dependency hashes"
        )
    for label, value in (
        ("world.hash", world.get("hash")),
        ("visualLayer.hash", visual_layer.get("hash")),
        ("renderScene.hash", render_scene.get("hash")),
        ("renderScene.visualLayerHash", description.get("visualLayerHash")),
        ("renderScene.worldHash", description.get("worldHash")),
        ("renderScene.assetClosureHash", description.get("assetClosureHash")),
        ("dependencyHashes.evidence", dependencies.get("evidence")),
    ):
        _validate_sha256(value, label)
    if (
        dependencies.get("visualLayer") != visual_layer.get("hash")
        or dependencies.get("renderScene") != render_scene.get("hash")
        or description.get("visualLayerHash") != visual_layer.get("hash")
        or description.get("worldHash") != world.get("hash")
    ):
        raise CevSimConfigurationError("PBR bundle resource cross-references do not agree")
    visual_assets = evidence.get("visualAssets")
    if not isinstance(visual_assets, Mapping):
        raise CevSimConfigurationError("PBR evidence requires visualAssets metadata")
    for label in ("descriptorHash", "accessHash", "assetClosureHash"):
        _validate_sha256(visual_assets.get(label), f"evidence.visualAssets.{label}")
    if visual_assets.get("descriptorHash") != visual_layer.get("hash"):
        raise CevSimConfigurationError("PBR evidence descriptor does not match visualLayer")
    if visual_assets.get("assetClosureHash") != description.get("assetClosureHash"):
        raise CevSimConfigurationError("PBR evidence asset closure does not match renderScene")
    if not isinstance(visual_assets.get("roots"), list) or not isinstance(visual_assets.get("uses"), list):
        raise CevSimConfigurationError("PBR evidence roots and uses must be arrays")
    correspondence = evidence.get("correspondence")
    if correspondence is not None:
        if not isinstance(correspondence, Mapping) or correspondence.get("status") != "unverified-reference":
            raise CevSimConfigurationError("Attached correspondence evidence must remain an unverified reference")
        _validate_sha256(correspondence.get("reportHash"), "evidence.correspondence.reportHash")


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
            _check_pbr_shape(resolved, manifest)
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


def _ustar_octal(value: int, length: int) -> bytes:
    encoded = format(value, "o").rjust(length - 1, "0")
    if len(encoded) > length - 1:
        raise CevSimConfigurationError("USTAR numeric field exceeds the frozen width")
    return encoded.encode("ascii") + b"\0"


def _ustar_header(name: str, size: int) -> bytes:
    encoded_name = name.encode("ascii")
    if len(encoded_name) >= 100:
        raise CevSimConfigurationError("USTAR entry name exceeds the frozen width")
    header = bytearray(_USTAR_BLOCK)
    header[:len(encoded_name)] = encoded_name
    header[100:108] = _ustar_octal(0o644, 8)
    header[108:116] = _ustar_octal(0, 8)
    header[116:124] = _ustar_octal(0, 8)
    header[124:136] = _ustar_octal(size, 12)
    header[136:148] = _ustar_octal(0, 12)
    header[148:156] = b"        "
    header[156] = ord("0")
    header[257:263] = b"ustar\0"
    header[263:265] = b"00"
    checksum = format(sum(header), "o").rjust(6, "0").encode("ascii") + b"\0 "
    header[148:156] = checksum
    return bytes(header)


def _package_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"kind", "version", "bundle", "assets"}:
        raise CevSimConfigurationError("Package manifest has an invalid shape")
    if value.get("kind") != "cev-sim.run-package" or type(value.get("version")) is not int or value["version"] != 1:
        raise CevSimConfigurationError("Package manifest must be cev-sim.run-package version 1")
    bundle = value.get("bundle")
    if not isinstance(bundle, dict) or set(bundle) != {"sha256", "sizeBytes"}:
        raise CevSimConfigurationError("Package manifest bundle identity is invalid")
    _validate_sha256(bundle.get("sha256"), "package.bundle.sha256")
    if type(bundle.get("sizeBytes")) is not int or not 0 <= bundle["sizeBytes"] <= _PACKAGE_BUNDLE_LIMIT:
        raise CevSimConfigurationError("Package bundle size is invalid")
    assets = value.get("assets")
    if not isinstance(assets, list) or len(assets) > _PACKAGE_ASSET_ENTRIES:
        raise CevSimConfigurationError("Package asset list exceeds its limit")
    prior = ""
    seen: set[str] = set()
    for asset in assets:
        if not isinstance(asset, dict) or set(asset) != {"sha256", "mediaType", "sizeBytes", "role"}:
            raise CevSimConfigurationError("Package asset metadata is invalid")
        digest = asset.get("sha256")
        _validate_sha256(digest, "package.assets.sha256")
        if digest in seen or digest.encode() <= prior.encode():
            raise CevSimConfigurationError("Package assets must be unique and UTF-8 sorted")
        seen.add(digest)
        prior = digest
        if type(asset.get("sizeBytes")) is not int or not 0 <= asset["sizeBytes"] <= _PACKAGE_ASSET_LIMIT:
            raise CevSimConfigurationError("Package asset size is invalid")
        media_type = asset.get("mediaType")
        role = asset.get("role")
        if (not isinstance(media_type, str) or not isinstance(role, str)
                or media_type not in _ASSET_MEDIA_TYPES or role not in _ASSET_ROLES):
            raise CevSimConfigurationError("Package asset media type or role is unsupported")
        if (role == "buffer") != (media_type == "application/octet-stream"):
            raise CevSimConfigurationError("Package buffer metadata is inconsistent")
        if role in {"mesh", "actor"} and media_type not in {"model/gltf-binary", "model/gltf+json"}:
            raise CevSimConfigurationError("Package mesh and actor assets must be glTF")
        if role == "texture" and media_type not in {"image/png", "image/jpeg", "image/ktx2"}:
            raise CevSimConfigurationError("Package texture assets must use a supported image media type")
    return value


def _package_closure(bundle: LoadedBundle) -> list[Mapping[str, Any]]:
    resolved = bundle.document["resolved"]
    render_scene = resolved.get("renderScene")
    description = render_scene.get("description") if isinstance(render_scene, Mapping) else None
    provider = description.get("provider") if isinstance(description, Mapping) else None
    if not isinstance(provider, Mapping) or provider.get("id") != "pbr-mesh" or provider.get("version") != 1:
        return []
    closure = description.get("assetClosure")
    assets = closure.get("assets") if isinstance(closure, Mapping) else None
    if not isinstance(assets, list):
        raise CevSimConfigurationError("PBR package is missing its exact asset closure")
    return assets


def load_run_package(path_value: str | Path) -> LoadedRunPackage:
    # Keep the final path component unresolved so O_NOFOLLOW remains meaningful.
    package_path = Path(path_value).expanduser().absolute()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = None
    try:
        descriptor = os.open(package_path, flags)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise CevSimConfigurationError("Run package must be a regular file")
        if metadata.st_size > _PACKAGE_ARCHIVE_LIMIT:
            raise CevSimConfigurationError("Run package exceeds the archive-byte ceiling")
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        raise CevSimConfigurationError(f"Could not open run package: {error}") from error
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
        raise
    archive_hasher = hashlib.sha256()
    received = 0

    def read_exact(stream: Any, size: int) -> bytes:
        nonlocal received
        chunks: list[bytes] = []
        remaining = size
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                raise CevSimConfigurationError("Run package archive is truncated")
            received += len(chunk)
            if received > _PACKAGE_ARCHIVE_LIMIT:
                raise CevSimConfigurationError("Run package exceeds the archive-byte ceiling")
            archive_hasher.update(chunk)
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def header(stream: Any) -> tuple[str, int] | None:
        raw = read_exact(stream, _USTAR_BLOCK)
        if raw == bytes(_USTAR_BLOCK):
            return None
        name_bytes = raw[:100].split(b"\0", 1)[0]
        try:
            name = name_bytes.decode("ascii")
            size_field = raw[124:136]
            if size_field[-1:] != b"\0" or not re.fullmatch(rb"[0-7]{11}\0", size_field):
                raise ValueError("invalid size")
            size = int(size_field[:-1], 8)
        except (UnicodeError, ValueError) as error:
            raise CevSimConfigurationError("Run package has a malformed USTAR header") from error
        if raw != _ustar_header(name, size):
            raise CevSimConfigurationError("Run package header does not match the frozen USTAR profile")
        if name.startswith("/") or "\\" in name or any(part in {"", ".", ".."} for part in name.split("/")):
            raise CevSimConfigurationError("Run package contains an unsafe entry name")
        return name, size

    def padding(stream: Any, size: int) -> None:
        length = (-size) % _USTAR_BLOCK
        if length and any(read_exact(stream, length)):
            raise CevSimConfigurationError("Run package entry padding must be zero")

    try:
        # The outer finally is the sole descriptor owner, including parse
        # failures. Double-close can close an unrelated thread's reused fd.
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            first = header(stream)
            if first is None or first[0] != "manifest.json" or first[1] > _PACKAGE_MANIFEST_LIMIT:
                raise CevSimConfigurationError("manifest.json must be the first bounded package entry")
            manifest_bytes = read_exact(stream, first[1])
            padding(stream, first[1])
            try:
                manifest_value = json.loads(
                    manifest_bytes.decode("utf-8"),
                    object_pairs_hook=_unique_object,
                    parse_constant=_invalid_constant,
                )
            except (UnicodeError, ValueError) as error:
                raise CevSimConfigurationError(f"Package manifest JSON is invalid: {error}") from error
            manifest = _package_manifest(manifest_value)
            if rfc8785.dumps(manifest) != manifest_bytes:
                raise CevSimConfigurationError("Package manifest must be exact JCS bytes")

            second = header(stream)
            if second is None or second[0] != "bundle.json" or second[1] != manifest["bundle"]["sizeBytes"]:
                raise CevSimConfigurationError("bundle.json must match the second package entry")
            bundle_bytes = read_exact(stream, second[1])
            padding(stream, second[1])
            bundle = load_bundle(bundle_bytes, expected_bundle_bytes_hash=manifest["bundle"]["sha256"])
            if list(manifest["assets"]) != list(_package_closure(bundle)):
                raise CevSimConfigurationError("Package asset manifest does not equal the run-bundle closure")

            for asset in manifest["assets"]:
                entry = header(stream)
                expected_name = f"{_ASSET_NAME_PREFIX}{asset['sha256']}"
                if entry is None or entry != (expected_name, asset["sizeBytes"]):
                    raise CevSimConfigurationError("Package asset entries do not match the closed manifest order")
                asset_hasher = hashlib.sha256()
                remaining = entry[1]
                while remaining:
                    chunk = read_exact(stream, min(1024 * 1024, remaining))
                    asset_hasher.update(chunk)
                    remaining -= len(chunk)
                if asset_hasher.hexdigest() != asset["sha256"]:
                    raise CevSimConfigurationError("Package asset bytes do not match their digest entry")
                padding(stream, entry[1])
            if header(stream) is not None or header(stream) is not None:
                raise CevSimConfigurationError("Run package must end with exactly two zero blocks")
            if stream.read(1):
                raise CevSimConfigurationError("Run package must not contain trailing bytes")
    except OSError as error:
        raise CevSimConfigurationError(f"Could not read run package: {error}") from error
    finally:
        os.close(descriptor)
    return LoadedRunPackage(
        path=package_path,
        bundle=bundle,
        manifest=manifest,
        archive_hash=archive_hasher.hexdigest(),
        package_manifest_hash=hashlib.sha256(manifest_bytes).hexdigest(),
        bundle_bytes_hash=bundle.bundle_bytes_hash,
        assets=tuple(manifest["assets"]),
    )
