from __future__ import annotations

from typing import Any


class CevSimError(Exception):
    """Base class for Python adapter failures."""


class CevSimConfigurationError(CevSimError, ValueError):
    """The local adapter configuration is invalid."""


class CevSimLaunchError(CevSimError):
    """An owned supervisor could not be started or stopped cleanly."""


class CevSimCompatibilityError(CevSimError):
    """The remote protocol, runtime capability, or space is unsupported."""


class CevSimTransportError(CevSimError):
    """A gRPC call failed before a valid cev-sim response was received."""


class CevSimSupervisorError(CevSimError):
    """A supervisor response contained a non-success ErrorStatus."""

    def __init__(
        self,
        code: int,
        message: str,
        *,
        retryable: bool = False,
        details: Any = None,
        environment_index: int | None = None,
    ) -> None:
        self.code = int(code)
        self.retryable = bool(retryable)
        self.details = details
        self.environment_index = environment_index
        location = "" if environment_index is None else f" for environment {environment_index}"
        super().__init__(f"cev-sim supervisor error {self.code}{location}: {message}")


class CevSimEnvironmentError(CevSimSupervisorError):
    """A per-environment result contained a non-success ErrorStatus."""
