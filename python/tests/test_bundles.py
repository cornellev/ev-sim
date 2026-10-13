from __future__ import annotations

import json
from pathlib import Path

from cev_sim.bundles import create_bundle


def test_create_bundle_forwards_route_options(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, list[str]] = {}

    def fake_run(command: list[str], **_kwargs: object) -> object:
        captured["command"] = command
        output = Path(command[command.index("--output") + 1])
        output.write_text("{}\n", encoding="utf-8")

        class Result:
            returncode = 0
            stdout = json.dumps({"kind": "cev-sim.headless.planning-bundle", "output": str(output)})
            stderr = ""

        return Result()

    monkeypatch.setattr("cev_sim.bundles.resolve_supervisor_command", lambda _executable=None: ["cev-sim"])
    monkeypatch.setattr("cev_sim.bundles.subprocess.run", fake_run)
    destination = tmp_path / "route.json"
    payload = create_bundle(
        destination,
        manifest="igvc-default",
        road="road:0",
        sensors="state",
        max_steps=100,
    )
    assert payload["kind"] == "cev-sim.headless.planning-bundle"
    assert captured["command"] == [
        "cev-sim",
        "create-bundle",
        "--output",
        str(destination),
        "--sensors",
        "state",
        "--manifest",
        "igvc-default",
        "--road",
        "road:0",
        "--max-steps",
        "100",
    ]
