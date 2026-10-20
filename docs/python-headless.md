# Python Gymnasium and Stable-Baselines3 adapter

The `python/` package is a synchronous client for the cev-sim protocols 1.2 through 1.5
headless supervisor. JavaScript remains the authoritative simulator; Python
owns Gymnasium/SB3 integration and NumPy tensors only.

To start from a saved environment without writing a run manifest, follow
[Getting started with the Python simulator](python-getting-started.md).

## Quickstart

From a checkout that already has `npm install` and Node.js `>=22.22.2 <23`:

```bash
python -m pip install -e './python[viz]'
python python/examples/02_astar_track.py --steps 50
```

`CevSimEnv(bundle)` launches `bin/cev-sim.js` when `cev-sim` is not on `PATH`.
Omitting `output_dir` uses a temporary directory, disables artifacts, and
deletes that directory on `close()`. `gym.make("CevSim-v0", bundle=...)` uses
the same class.

```python
from cev_sim import CevSimEnv

env = CevSimEnv("python/examples/bundles/straight.json")
try:
    observation, info = env.reset(seed=123)
    observation, reward, terminated, truncated, info = env.step(env.action_space.sample())
finally:
    env.close()
```

The other examples are `01_pure_pursuit.py`, `03_rrt_star.py`, and
`04_mpc_kinematic.py`. Each accepts `--steps`, `--bundle`, `--seed`, and
`--render`. Rendering needs the `viz` extra and the planning-oracle profile,
which those examples already select.

## Install

From a checkout:

```bash
python -m pip install -e ./python
python -m pip install -e './python[sb3]'
```

The headless release builder emits a pure-Python wheel and sdist in the
coordinated internal candidate artifact. Verify `release-manifest.json` /
`SHA256SUMS`, then use
`npm run artifacts:install -- --dist <download> --python-venv <venv>` or
install the selected wheel directly. The matching `cev-sim@0.2.0` npm tarball
provides the local supervisor executable; neither package is published to a
registry. See [Headless release and CI gates](headless-release.md) and
[CHANGELOG.md](../CHANGELOG.md).

Python 3.10–3.13 is supported. The base package does not install
Stable-Baselines3 or PyTorch. Unit tests (`pytest -m 'not integration'`)
collect without the `sb3` extra; Gymnasium/SB3 integration tests require
`./python[sb3,test]`. JS-backed unit tests (`test_bundle.py` envelope/rfc8785
checks and the session fixture) skip unless `node_modules` is present.
Generated Protobuf bindings are committed and
must be regenerated, never edited, after an additive protocol change:

```bash
python python/scripts/generate_proto.py
python python/scripts/generate_proto.py --check
```

## Planning and controls

`load_world(bundle)` reads the verified route, obstacle footprints, drivable
surfaces, vehicle limits, start pose, and goal in the planar frame
`(x, z, yaw)`. Forward is `(cos(yaw), -sin(yaw))`.
`world.occupancy_grid(resolution_m, inflate_m=...)` marks drivable free cells
as 0 and obstacle or off-road cells as 1.

`planning-oracle@1` is opt-in. It keeps every measured-state tensor and adds
`oracle/ego/pose`, `oracle/ego/velocity`, `oracle/ego/steering`, other actors'
poses and footprints, and `oracle/goal`. The default profile remains
`measured-state` and still excludes oracle pose.

`planning-occupancy@1` keeps those tensors and adds a 1000 by 1000 costmap at
5 cm (`oracle/occupancy`, `oracle/occupancy/origin`,
`oracle/occupancy/resolution`). `env.occupancy()` returns an `OccupancyGrid`.
`inflate_occupancy` expands blocked cells in Python. `sensor-occupancy@1`
adds `oracle/sensor-occupancy`, with 0 unknown, 1 free, and 2 occupied.
`env.sensor_occupancy()` returns a `SensorOccupancyGrid`. That profile needs
an enabled lidar. `configure(..., view="sensor-occupancy", sensors="all")`
builds one. The default `configure` view remains `"planning"`.

```python
from cev_sim import (
    PLANNING_ORACLE_OBSERVATION_PROFILE,
    CevSimEnv,
    EpisodeConfig,
    load_world,
)

world = load_world("python/examples/bundles/straight.json")
env = CevSimEnv(
    "python/examples/bundles/straight.json",
    episode=EpisodeConfig(observation_profile=PLANNING_ORACLE_OBSERVATION_PROFILE),
)
observation, info = env.reset(
    seed=1,
    options={"start_pose": (world.start.x, world.start.z, world.start.yaw), "goal": (world.goal.x, world.goal.z)},
)
```

`options` accepts `start_pose=(x, z, yaw[, speed])` and `goal=(x, z[, yaw])`,
plus positive `position_tolerance_m` (default 1 m) and `yaw_tolerance_rad`
(default π). A start pose that overlaps an obstacle or leaves the drivable
surface is rejected. A goal reached within those tolerances ends the episode
successfully. The bundle route still drives `task/*`; planners should read
`oracle/goal`. Overrides are episode identity: the episode hash changes only
when a start pose or goal is present. `CevSimVecEnv.set_reset_options` carries
the same mapping, including automatic resets after a terminal step.

`create_bundle(path)` runs `cev-sim create-bundle` and writes a validated
bundle. `npm run fixtures:planning` refreshes
`python/examples/bundles/straight.json` and `curve.json`.

## Quick-start API

`configure` and `launch` are the session helpers. `configure` writes a
temporary free-drive bundle with `cev-sim create-bundle --finish none`, then
`launch` starts one worker. The tutorial is
[python-getting-started.md](python-getting-started.md).

```python
import cev_sim

config = cev_sim.configure(environment="igvc", vehicle="big-car", goal=None)
with cev_sim.launch(config) as sim:
    observation, info = sim.reset(seed=1)
    observation, reward, terminated, truncated, info = sim.step(sim.action_space.sample())
```

`configure` arguments:

| Argument | Default | Meaning |
| --- | --- | --- |
| `environment` | required | Saved or built-in environment id. |
| `vehicle` | manifest car, `big-car` for the built-in run | Saved or built-in vehicle id. A saved vehicle with a dynamics plant uses that plant when the package is installed in the same data directory. |
| `start` | bundle pose | `(x, z)`, `(x, z, yaw)`, or `(x, z, yaw, speed)`. A two-number start takes its yaw from the nearest route segment. |
| `goal` | `None` | `(x, z)` or `(x, z, yaw)`. `None` is a free drive. |
| `goal_tolerance_m` | `1.0` | Success radius when `goal` is set. |
| `max_steps` | `0` | Policy-step limit. `0` does not truncate. |
| `view` | `"planning"` | `"planning"` selects `planning-oracle@1`. `"measured"` selects `measured-state`. `"occupancy"` selects `planning-occupancy@1`. `"sensor-occupancy"` selects `sensor-occupancy@1` and requires `sensors="all"`. |
| `sensors` | `"state"` | `"state"` keeps state sensors. `"all"` keeps the saved rig, including lidar. |
| `logging` | `False` | `False` discards artifacts. A directory path keeps an evaluation log. |
| `data_dir` | `CEV_SIM_DATA_DIR`, then checkout `server/data` | Saved environment and vehicle store. Omitted when only built-ins exist. |

`launch(config, **env_kwargs)` returns a `CevSimEnv`. Extra keywords are the
`CevSimEnv` arguments, such as `render_mode="human"`. The environment is a
context manager. `sim.run_config` keeps the bundle directory alive until the
environment is closed. `config.save(path)` copies the bundle. `config.world`
is the `PlanningWorld`.

Free drive still contains a verified ego route, because a headless episode
requires one. `--finish none` replaces the finish-zone trigger with a trigger
on the flag `cev-sim.free-drive.stop`, which nothing sets. The episode then
ends on collision, off-road, `max_steps`, or when the caller stops.
A goal is a protocol 1.5 reset override, not a finish zone, so changing it
does not rebuild the bundle.

`environments.list()` and `vehicles.list()` return `CatalogEntry` records
(`id`, `name`, `built_in`) from `cev-sim catalog`.

`CevSimEnv` and `gym.make("CevSim-v0")` still default to `measured-state`.
`configure` is the call that defaults to the planning view.

After `reset`, `sim.loop()` stays true until the episode is terminated or
truncated. It does not step. `sim.clock.steps()` is the simulation step,
`sim.clock.time()` is elapsed seconds, and `sim.clock.dt()` is the seconds in
one simulation step. `sim.pose()`, `sim.velocity()`, `sim.steering()`, and
`sim.goal()` copy the latest planning-oracle values. `goal()` is the route end
during a free drive. Those four readers require the planning view.
`sim.occupancy()` requires `planning-occupancy` or `sensor-occupancy`.
`sim.sensor_occupancy()` requires `sensor-occupancy`.

## Gymnasium environment

Supply an existing Unix/TCP supervisor target, or omit both `target` and
`launch` to start a local supervisor. `output_dir` is optional. Pass it, with
an artifact policy, when episode artifacts should be kept.

```python
from cev_sim import ArtifactPolicy, CevSimEnv, SupervisorLaunch

env = CevSimEnv(
    "run-bundle.json",
    output_dir="runs/gym",
    launch=SupervisorLaunch(executable="cev-sim"),
    artifact_policy=ArtifactPolicy(profile="training"),
)
try:
    observation, info = env.reset(seed=123)
    observation, reward, terminated, truncated, info = env.step(
        env.action_space.sample()
    )
finally:
    env.close()
```

`reset(seed=N)` uses exactly `N` as the simulator reset seed. Later unseeded
resets draw deterministic uint64 seeds from Gymnasium's generator. Resetting an
active or terminal episode finalizes it first. A terminal `step()` returns the
actual final observation; callers must reset before stepping again.

`EpisodeConfig`, `ArtifactPolicy`, `ResourceLimits`, and `SupervisorLaunch`
are frozen configuration values exported by `cev_sim`. The default episode
uses one fixed step per action, no policy-step bound, the measured-state and
default route-safety profiles, bundle-selected physics, and deterministic
state sensors. If the bundle manifest enables `lidar3d`, the client also adds
the locked `DEFAULT_CPU_LIDAR_BACKEND` selection and verifies that the
supervisor advertises `deterministic-cpu-bvh-lidar` version `1`. CPU point
clouds are published to topics and SFLog; the default Python observation
remains the same flat measured-state dictionary.

Select `measured-perception` explicitly for policy-visible measured RGB and
LiDAR range/incidence tensors:

```python
from cev_sim import CevSimEnv, EpisodeConfig, MEASURED_PERCEPTION_OBSERVATION_PROFILE

env = CevSimEnv(
    "camera-run-bundle.json",
    output_dir="runs/perception",
    target="unix:/tmp/cev-sim.sock",
    episode=EpisodeConfig(
        observation_profile=MEASURED_PERCEPTION_OBSERVATION_PROFILE,
    ),
)
```

Cameras select `DEFAULT_GPU_SENSOR_BACKEND`; LiDAR may use that backend or
`DEFAULT_CPU_LIDAR_BACKEND`. The profile preserves every measured-state/task
entry and adds `uint8[height,width,4]` camera values and
`float32[elevation,azimuth,2]` LiDAR range/incidence values. Depth,
semantic/instance IDs, detections, and other oracle products are never exposed
to the policy.

To connect without owning the supervisor:

```python
env = CevSimEnv(
    "run-bundle.json",
    output_dir="runs/remote",
    target="unix:/tmp/cev-sim.sock",
)
```

PR 7 TCP is cleartext and unauthenticated. Use non-loopback TCP only behind an
appropriate private network, firewall, VPN, or authenticated proxy. Closing an
environment closes its batch and channel but never terminates an externally
supplied supervisor.

## RL/SB3

`CevSimVecEnv` maps one supervisor batch to the SB3 `VecEnv` API. The
supervisor already provides one OS process per environment, so no Python
`SubprocVecEnv` wrapper is needed.

```python
from stable_baselines3 import PPO

from cev_sim import EpisodeConfig, SupervisorLaunch
from cev_sim.sb3 import CevSimVecEnv

env = CevSimVecEnv(
    "run-bundle.json",
    8,
    output_dir="runs/ppo",
    launch=SupervisorLaunch(executable="cev-sim"),
    episode=EpisodeConfig(max_episode_steps=1_000),
)
try:
    PPO("MultiInputPolicy", env, n_steps=128, batch_size=256).learn(100_000)
finally:
    env.close()
```

SB3 terminal environments are finalized and reset before `step_wait()`
returns. The returned observation is the next episode's initial observation;
the real final observation is in `info["terminal_observation"]`, normal
time-limit semantics are in `info["TimeLimit.truncated"]`, and the finalized
JSON is in `info["terminal_finalization"]`. The complete finalization envelope
is retained in `info["cev_sim.final_result"]`.

## Reference

The client discovers capabilities using protocol 1.2 and negotiates up to 1.5.
A protocol 1.5 supervisor advertises `planning-oracle@1`,
`planning-occupancy@1`, and `sensor-occupancy@1`. Supervisors below 1.5
remain usable for measured-state and measured-perception. Start and goal
overrides are sent only after the negotiated minor is at least 5.
The client validates runtime name, profile schemas, backend versions, space layouts,
tensor names, dtype, shape, endianness, packed length,
boolean representation, and bounds. CPU/GPU LiDAR identities,
`DEFAULT_CPU_LIDAR_BACKEND`, `DEFAULT_GPU_SENSOR_BACKEND`, and
`MEASURED_PERCEPTION_OBSERVATION_PROFILE` are public package exports.

`load_run_package(path)` strictly streams the frozen USTAR profile, verifies
every entry and exact bundle digest, and returns `LoadedRunPackage` without
retaining asset bytes. `SupervisorClient(..., package_inbox=...)` admits it
through a context-managed `AssetAdmission`, which can be passed to
`create_batch`. Owned supervisors derive the inbox from their private socket
directory. External Unix supervisors require `package_inbox`; TCP, protocol
1.2/1.3, and supervisors without `cev-sim.run-package@1` fail before staging.
Staging uses a `0600` temporary file, streaming hash, file fsync, atomic rename,
and directory fsync. Client shutdown releases outstanding admissions
best-effort. Ordinary Gymnasium/SB3 bundle inputs are unchanged.

On a protocol 1.2 Unix socket, tensors of at least 64 KiB use
`grpc+unix+shared-memory-v1`; smaller tensors stay inline. Python opens the
randomized region read-only without following symlinks where supported,
requires a private regular file owned by the current user, maps the whole
arena, validates the header before and after copying, and closes the mapping.
Copying is the default so observations and SB3 terminal observations survive
the next response generation. TCP and protocol 1.1 remain inline. Shared
references on another transport, invalid/stale generations, token/sequence or
tensor-spec mismatches, torn headers, truncated regions, and unsupported
discrete/nested layouts fail explicitly.

Malformed requests and infrastructure failures raise typed `CevSimError`
subclasses: `CevSimConfigurationError`, `CevSimLaunchError`,
`CevSimCompatibilityError`, `CevSimTransportError`,
`CevSimSupervisorError`, and `CevSimEnvironmentError`. A worker crash,
resource limit, timeout, or uncertain transport failure is never returned as
an RL truncation. A vector adapter fails closed after a partial batch error
because healthy peers may already have advanced.

Owned launch resolves an explicit executable, a `cev-sim` binary on `PATH`,
or `bin/cev-sim.js` from the checkout. A `.js` entrypoint is run with `node`
after checking Node.js `>=22.22.2 <23`. The command is not passed through a
shell or `npx`. `close()` first closes the batch, then the gRPC channel, asks
the supervisor process group to stop, escalates after bounded grace periods,
and removes its private Unix socket directory.

### VIS-12a bundle identity

`load_bundle` retains `received_bytes` and their `bundle_bytes_hash` alongside
`canonical_json` and `canonical_json_hash`. An optional
`expected_bundle_bytes_hash` validates an externally supplied exact digest.
It rejects duplicate JSON keys and malformed UTF-8; v11 uses JCS, while v10
keeps its legacy serialization. These digests do not replace authoritative
JavaScript semantic verification.

Loaded v11 bundles declare `identity_profile = "world-bound@2"` and
`required_protocol_minor = 3`. The client checks both the protocol and the
advertised identity profile before creating a batch. Legacy v10 bundles remain
usable with protocol 1.2 supervisors, including explicitly launched local
supervisors. No local Python simulator or semantic hash implementation is added.
