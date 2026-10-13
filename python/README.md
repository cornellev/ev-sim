# cev-sim Python adapter

This package is the Gymnasium and Stable-Baselines3 client for the protocol
1.2–1.5 cev-sim supervisor. JavaScript remains the simulator. Details are in
[`docs/python-headless.md`](../docs/python-headless.md).

## Quickstart

```bash
python -m pip install -e './python[viz]'
python python/examples/02_astar_track.py --steps 50
```

From a checkout, `CevSimEnv(bundle)` finds `bin/cev-sim.js`, checks that Node.js
is `>=22.22.2 <23`, and stores artifacts in a temporary directory that
`close()` removes. Planners that need ground-truth pose select
`PLANNING_ORACLE_OBSERVATION_PROFILE`. The default observation stays
measured-state.

The package and coordinated npm runtime are licensed under Apache-2.0.
