"""Create a planning run bundle through the JavaScript ``cev-sim`` CLI."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from .errors import CevSimConfigurationError, CevSimLaunchError
from .process import resolve_supervisor_command


def create_bundle(
    output: str | Path,
    *,
    manifest: str | None = None,
    environment: str | None = None,
    data_dir: str | Path | None = None,
    road: str | None = None,
    start_node: str | None = None,
    finish_node: str | None = None,
    sensors: str = "state",
    max_steps: int | None = None,
    executable: str | Path | None = None,
) -> dict[str, Any]:
    """Write a validated planning bundle and return the CLI result JSON.

    The command reads a stored or built-in environment and writes only
    ``output``. It does not modify the caller's data directory.
    """
    if sensors not in {"state", "all"}:
        raise CevSimConfigurationError('sensors must be "state" or "all"')
    if max_steps is not None and (type(max_steps) is not int or max_steps < 0):
        raise CevSimConfigurationError("max_steps must be a non-negative integer")
    destination = Path(output)
    command = [
        *resolve_supervisor_command(executable),
        "create-bundle",
        "--output",
        str(destination),
        "--sensors",
        sensors,
    ]
    if manifest is not None:
        command.extend(["--manifest", manifest])
    if environment is not None:
        command.extend(["--environment", environment])
    if data_dir is not None:
        command.extend(["--data-dir", str(data_dir)])
    if road is not None:
        command.extend(["--road", road])
    if start_node is not None:
        command.extend(["--start-node", start_node])
    if finish_node is not None:
        command.extend(["--finish-node", finish_node])
    if max_steps is not None:
        command.extend(["--max-steps", str(max_steps)])
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise CevSimLaunchError(f"cev-sim create-bundle failed ({result.returncode}): {detail}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise CevSimLaunchError(f"cev-sim create-bundle did not return JSON: {result.stdout!r}") from error
    if not isinstance(payload, dict) or payload.get("kind") != "cev-sim.headless.planning-bundle":
        raise CevSimLaunchError(f"cev-sim create-bundle returned an unexpected result: {payload!r}")
    return payload
