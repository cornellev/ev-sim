# cev-sim Python adapter

This package is the Gymnasium and Stable-Baselines3 client for the protocol
1.2–1.5 cev-sim supervisor. JavaScript remains the simulator. Details are in
[`docs/python-headless.md`](../docs/python-headless.md).

## Quickstart

The walkthrough is [Getting started](../docs/python-getting-started.md).

```bash
python -m pip install -e './python[viz]'
python python/examples/00_free_drive.py --steps 50
```

```python
import cev_sim

config = cev_sim.configure(environment="igvc", vehicle="big-car", goal=None)
with cev_sim.launch(config) as sim:
    observation, info = sim.reset(seed=1)
    observation, reward, terminated, truncated, info = sim.step(sim.action_space.sample())
```

From a checkout, `launch` finds `bin/cev-sim.js` and checks that Node.js is
`>=22.22.2 <23`. `logging=False`, the default, discards artifacts.
`configure` uses the planning view. `CevSimEnv(bundle)` still defaults to
measured-state.

The package and coordinated npm runtime are licensed under Apache-2.0.
