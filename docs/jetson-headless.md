# Jetson headless deployment

Jetson ARM64 uses the same Node worker and Python client artifacts as other
Linux hosts. GPU rendering is a probed optional capability: a Jetson may pass
state/CPU-LiDAR/Python gates while reporting Chromium hardware WebGL2
unavailable. Software renderers such as SwiftShader and llvmpipe never satisfy
the production GPU backend and requested camera/GPU-LiDAR batches fail
explicitly during capability validation.

## Host preparation

Provision Node 22.14 or newer, Python 3.10–3.13, Chromium, Vulkan/EGL tools,
and the JetPack/L4T graphics stack. Run the supervisor as a dedicated non-root
user. Give that user only the required render/video device groups, commonly
`render` and `video`; do not solve device access by running the service as
root or disabling the Chromium sandbox by default.

Place the runner configuration at `/etc/cev-sim/supervisor.json`. The
`renderer.chromiumExecutable` path must be explicit. Start with sandboxing
enabled, a small context pool, and GPU budgets that leave memory for the OS,
supervisor, and one process per environment.

Validate the host:

```bash
npm run host:validate -- \
  --role jetson-arm64 \
  --config /etc/cev-sim/supervisor.json \
  --output jetson-host.json
```

The v1 report records architecture, Node/Python/Chromium, JetPack/L4T and
device model when available, GPU device-node ownership and access, effective
UID/GID/groups, Vulkan/EGL/NVIDIA diagnostics, total memory, power mode,
sandbox configuration, and the production `gpu-preflight` result.
Use `--require-gpu` only when rendered sensors are mandatory for that host.

## Install a candidate

Download the coordinated Actions artifact, then verify SHA-256 records before
installation:

```bash
npm run artifacts:install -- --dist /srv/cev-sim/candidate --verify-only
npm run artifacts:install -- \
  --dist /srv/cev-sim/candidate \
  --node-prefix /srv/cev-sim/runtime \
  --python-venv /srv/cev-sim/venv
```

Keep the Unix socket in a short, private runtime directory such as
`/run/user/<uid>/cev-sim/supervisor.sock`, not a shared writable directory.
Artifact output should use a dedicated volume with sufficient space for full
evaluation SFLogs. Do not place credentials in bundles, supervisor config,
reports, or SFLogs.

## Resource boundary

The supervisor enforces application limits and one OS process per environment,
but production deployment should add a cgroup-v2/systemd boundary. Size it
above selected per-environment limits plus supervisor, Chromium, GPU, and log
overhead. For example:

```ini
[Service]
User=cev-sim
Group=cev-sim
SupplementaryGroups=render video
ExecStart=/srv/cev-sim/runtime/node_modules/.bin/cev-sim supervisor --socket %t/cev-sim/supervisor.sock --config /etc/cev-sim/supervisor.json
RuntimeDirectory=cev-sim
RuntimeDirectoryMode=0700
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/cev-sim/runs
MemoryMax=24G
TasksMax=256
Restart=on-failure
```

Adjust `MemoryMax`, `TasksMax`, and device policy to the actual Jetson SKU.
The service manager owns restarts of the supervisor; worker restart budgets
remain scoped to individual environments. A worker OOM or GPU/context loss is
an infrastructure failure requiring reset and is never converted into a Gym
transition.

## Docker option

NVIDIA's Jetson container runtime may be used when its device and graphics
mounts match the installed JetPack release. Preserve a private bind-mounted
UDS directory and artifact volume, run with a non-root UID, set memory/PID
limits, and validate inside the final container. Host validation outside the
container does not prove Chromium/ANGLE capability inside it.

## Hardware CI

Register the isolated runner with label `cev-sim-jetson-arm64`. The scheduled
workflow never handles pull requests or release secrets. It always runs
state-only, CPU-LiDAR, and Python tests. It runs rendered-sensor tests only
when the host report proves production hardware WebGL2. Those tests load
`CEV_SIM_SUPERVISOR_CONFIG` (`/etc/cev-sim/supervisor.json`) so Chromium gets
the same ANGLE/launch arguments as `gpu-preflight`; the executable path alone
falls back to software WebGL on Thor. The x64 NVIDIA runner label
`cev-sim-gpu-x64` is the mandatory rendered-sensor gate and must pass.
