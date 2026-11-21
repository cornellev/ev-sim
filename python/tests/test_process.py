from __future__ import annotations

import subprocess
import sys

from cev_sim.config import SupervisorLaunch
from cev_sim.process import OwnedSupervisor


def test_close_reaps_a_detached_descendant() -> None:
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        start_new_session=True,
    )
    owner = OwnedSupervisor(SupervisorLaunch(executable="node", shutdown_grace_s=1, kill_grace_s=1))
    owner._descendants = [child.pid]
    try:
        owner.close()
        owner.close()
        assert child.poll() is not None
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=2)
