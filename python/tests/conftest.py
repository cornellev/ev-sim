from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CLI_PATH = REPOSITORY_ROOT / "bin" / "cev-sim.js"


def pytest_ignore_collect(collection_path: Path, config: pytest.Config) -> bool:
    del config
    if collection_path.name != "test_integration.py":
        return False
    return importlib.util.find_spec("stable_baselines3") is None


@pytest.fixture(scope="session")
def repository_root() -> Path:
    return REPOSITORY_ROOT


@pytest.fixture(scope="session")
def headless_fixture(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("python-headless-fixture")
    subprocess.run(
        [
            "node",
            "--experimental-default-type=module",
            str(REPOSITORY_ROOT / "tests" / "helpers" / "pythonHeadlessFixture.js"),
            str(root),
        ],
        cwd=REPOSITORY_ROOT,
        check=True,
    )
    return json.loads((root / "expected.json").read_text())
