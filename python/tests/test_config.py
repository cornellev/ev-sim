from __future__ import annotations

from pathlib import Path

import pytest

from cev_sim import ArtifactPolicy, EpisodeConfig, ResourceLimits, SupervisorLaunch
from cev_sim.errors import CevSimConfigurationError, CevSimLaunchError
from cev_sim.process import node_version_supported, require_supported_node, resolve_supervisor_command


def test_configuration_types_are_strict_and_frozen() -> None:
    assert EpisodeConfig().action_repeat == 1
    assert ArtifactPolicy().profile == "training"
    assert ResourceLimits().restart_budget == 0
    with pytest.raises(CevSimConfigurationError):
        EpisodeConfig(action_repeat=0)
    with pytest.raises(CevSimConfigurationError):
        ArtifactPolicy(full_sflog_sample_rate=2)
    with pytest.raises(CevSimConfigurationError):
        ResourceLimits(max_queue_bytes=-1)
    with pytest.raises(CevSimConfigurationError):
        SupervisorLaunch(extra_args=("--socket", "other"))
    assert SupervisorLaunch().executable == "cev-sim"


def test_node_version_window() -> None:
    assert node_version_supported((22, 22, 2))
    assert node_version_supported((22, 23, 0))
    assert not node_version_supported((22, 22, 1))
    assert not node_version_supported((23, 0, 0))


def test_checkout_supervisor_uses_node(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("cev_sim.process.shutil.which", lambda _name: None)
    monkeypatch.setattr("cev_sim.process.require_supported_node", lambda: "/usr/bin/node")
    command = resolve_supervisor_command("cev-sim")
    assert command[0] == "/usr/bin/node"
    assert command[1].endswith(str(Path("bin") / "cev-sim.js"))
    assert Path(command[1]).is_file()


def test_explicit_javascript_supervisor_checks_node(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    script = tmp_path / "cev-sim.js"
    script.write_text("// supervisor\n", encoding="utf-8")
    monkeypatch.setattr("cev_sim.process.require_supported_node", lambda: "/usr/bin/node")
    assert resolve_supervisor_command(script) == ["/usr/bin/node", str(script.resolve())]


def test_unsupported_node_version_names_the_fix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("cev_sim.process.shutil.which", lambda name: "/usr/bin/node" if name == "node" else None)

    class Result:
        returncode = 0
        stdout = "v20.11.0\n"
        stderr = ""

    monkeypatch.setattr("cev_sim.process.subprocess.run", lambda *_args, **_kwargs: Result())
    with pytest.raises(CevSimLaunchError, match="Install a Node.js 22"):
        require_supported_node()
