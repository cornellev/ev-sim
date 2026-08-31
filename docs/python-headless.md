# Python Gymnasium and Stable-Baselines3 adapter

The `python/` package is a synchronous client for the cev-sim protocol 1.2
headless supervisor. JavaScript remains the authoritative simulator; Python
owns Gymnasium/SB3 integration and NumPy tensors only.

## Install

From a checkout:

```bash
python -m pip install -e ./python
python -m pip install -e './python[sb3]'
```

PR 12 also builds a pure-Python wheel and sdist in the coordinated internal
candidate artifact. Verify `release-manifest.json`/`SHA256SUMS`, then use
`npm run artifacts:install -- --dist <download> --python-venv <venv>` or
install the selected wheel directly. The matching `cev-sim@0.1.0` npm tarball
provides the local supervisor executable; neither package is published to a
registry. See [Headless release and CI gates](headless-release.md).

Python 3.10–3.13 is supported. The base package does not install
Stable-Baselines3 or PyTorch. Generated Protobuf bindings are committed and
must be regenerated, never edited, after an additive protocol change:

```bash
python python/scripts/generate_proto.py
python python/scripts/generate_proto.py --check
```

## Gymnasium environment

Supply an existing Unix/TCP supervisor target or explicitly request an owned
installed `cev-sim` executable. An output directory is always required because
every episode publishes its core result artifacts.

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

## Stable-Baselines3 vector environment

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

## Compatibility and failures

The client validates protocol 1.2, runtime name, profile schemas, backend
versions, space layouts, tensor names, dtype, shape, endianness, packed length,
boolean representation, and bounds. CPU/GPU LiDAR identities,
`DEFAULT_CPU_LIDAR_BACKEND`, `DEFAULT_GPU_SENSOR_BACKEND`, and
`MEASURED_PERCEPTION_OBSERVATION_PROFILE` are public package exports.

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

Owned launch uses the configured executable directly, without a shell or
implicit `npx`. `close()` first closes the batch, then the gRPC channel, asks
the supervisor process group to stop, escalates after bounded grace periods,
and removes its private Unix socket directory.
