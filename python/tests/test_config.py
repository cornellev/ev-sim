from __future__ import annotations

import pytest

from cev_sim import ArtifactPolicy, EpisodeConfig, ResourceLimits, SupervisorLaunch
from cev_sim.errors import CevSimConfigurationError


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
