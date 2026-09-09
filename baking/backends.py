"""Six-channel intrinsic-material backends. The fake backend is CI-safe."""

from __future__ import annotations

import os
from typing import Any, Protocol

from contracts import (
    FAKE_ALGORITHM_ID,
    FAKE_ALGORITHM_REVISION,
    FAKE_MODEL_ID,
    FAKE_MODEL_REVISION,
    FAKE_WEIGHTS_DIGEST,
    MODEL_OUTPUT_CHANNELS,
    run_fake_inference,
)


class IntrinsicMaterialBackend(Protocol):
    model_id: str
    model_revision: str
    weights_digest: str
    algorithm_id: str
    algorithm_revision: str
    runtime_kind: str
    nondeterminism_scope: str

    def infer(
        self,
        *,
        beauty: bytes,
        validity: bytes,
        width: int,
        height: int,
        seed: int,
        resize_policy: dict[str, Any] | None,
        prompts: dict[str, str] | None,
        inference: dict[str, Any],
        **kwargs: Any,
    ) -> dict[str, bytes]:
        ...


class FakeIntrinsicMaterialBackend:
    model_id = FAKE_MODEL_ID
    model_revision = FAKE_MODEL_REVISION
    weights_digest = FAKE_WEIGHTS_DIGEST
    algorithm_id = FAKE_ALGORITHM_ID
    algorithm_revision = FAKE_ALGORITHM_REVISION
    runtime_kind = "fake-intrinsic-material"
    nondeterminism_scope = "none"

    def infer(
        self,
        *,
        beauty: bytes,
        validity: bytes,
        width: int,
        height: int,
        seed: int,
        resize_policy: dict[str, Any] | None,
        prompts: dict[str, str] | None,
        inference: dict[str, Any],
        **kwargs,
    ) -> dict[str, bytes]:
        del prompts, inference, kwargs
        channels, _effective = run_fake_inference(beauty, validity, width, height, resize_policy, seed)
        missing = [channel for channel in MODEL_OUTPUT_CHANNELS if channel not in channels]
        if missing:
            raise RuntimeError(f"fake backend omitted channels: {missing}")
        return channels


class OperatorInjectedBackend:
    """Refuses to start unless an operator pins immutable model/weights identity."""

    def __init__(
        self,
        *,
        model_id: str,
        model_revision: str,
        weights_digest: str,
        algorithm_id: str,
        algorithm_revision: str,
        delegate: IntrinsicMaterialBackend | None = None,
    ):
        if not model_id or not model_revision or not weights_digest or not algorithm_id or not algorithm_revision:
            raise RuntimeError(
                "Real intrinsic-material backend refuses startup without immutable model revision, "
                "algorithm revision, and weights digest.",
            )
        if delegate is None:
            raise RuntimeError(
                "Real intrinsic-material backend is operator-injected and is not bundled. "
                "Set BAKE_MODEL_BACKEND to a loader that supplies a six-channel implementation.",
            )
        self.model_id = model_id
        self.model_revision = model_revision
        self.weights_digest = weights_digest
        self.algorithm_id = algorithm_id
        self.algorithm_revision = algorithm_revision
        self.runtime_kind = "operator-injected-intrinsic-material"
        self.nondeterminism_scope = "gpu-model-output"
        self._delegate = delegate

    def infer(self, **kwargs):
        result = self._delegate.infer(**kwargs)
        missing = [channel for channel in MODEL_OUTPUT_CHANNELS if channel not in result]
        if missing:
            raise RuntimeError(f"injected backend omitted channels: {missing}")
        return result


def load_backend(config: dict[str, Any] | None = None) -> IntrinsicMaterialBackend:
    config = config or {}
    kind = (config.get("backend") or os.environ.get("BAKE_MODEL_BACKEND") or "fake").strip()
    if kind in {"fake", "fake-intrinsic-material"}:
        return FakeIntrinsicMaterialBackend()
    if kind in {"legacy-image-fill", "flux-fill"}:
        raise RuntimeError("legacy image-fill backends are non-promotable and cannot serve intrinsic-material-model@1")
    model_id = config.get("modelId") or os.environ.get("BAKE_MODEL_ID")
    model_revision = config.get("modelRevision") or os.environ.get("BAKE_MODEL_REVISION")
    weights_digest = config.get("weightsDigest") or os.environ.get("BAKE_MODEL_WEIGHTS_DIGEST")
    algorithm_id = config.get("algorithmId") or os.environ.get("BAKE_MODEL_ALGORITHM_ID")
    algorithm_revision = config.get("algorithmRevision") or os.environ.get("BAKE_MODEL_ALGORITHM_REVISION")
    if kind != "real":
        raise RuntimeError(f"unsupported intrinsic-material backend {kind}")
    return OperatorInjectedBackend(
        model_id=model_id,
        model_revision=model_revision,
        weights_digest=weights_digest,
        algorithm_id=algorithm_id,
        algorithm_revision=algorithm_revision,
        delegate=None,
    )
