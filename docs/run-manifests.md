# Deterministic simulation runs

Every professional simulation launch is defined by a saved `cev-sim.run-manifest` version 5 document. The server normalizes and validates the authoring document, resolves its environment, scripts, bindings, autonomy catalog metadata, deterministic calibration bundle, ROS schema closure, and contract endpoints, then computes SHA-256 definition and resolved hashes. A running session holds that resolved snapshot and never applies Config edits in place.

Binding resolution includes every global library binding plus the ids listed in `scripts.bindingIds`. The Bindings workspace manages those ids through manifest checkboxes. Scripts referenced by effective bindings are resolved automatically; entries in `scripts.artifacts` remain optional hash locks. Portable manifests with `embeddedBindings` use only their frozen embedded set.

## Operator workflow

Open **Config** from the workspace switcher. The page supports catalog create, duplicate, delete, bundle import/export, structured editing, raw JSON editing, server validation, optimistic revision saves, and **Validate & Run**. Unsaved edits are protected during catalog changes and browser navigation.

Reset finalizes the active result and SFLog, resolves the newest saved revision, rebuilds run-scoped resources, and leaves the replacement run paused at step zero. If the environment changed, the workspace loads that environment before applying the pending run.

## Portable bundles

`cev-sim.run-bundle` version 1 includes the authoring manifest and its resolved environment, exact compiled script artifacts and bindings, ROS schemas, autonomy catalog metadata, contract endpoints, dependency hashes, and resolved hash. Import verifies the bundle hash. Existing dependencies are reused only when hashes match; conflicting resources receive an eight-character hash suffix and all references are remapped.

## HTTP API

The storage service exposes these endpoints under `/api/storage`:

- `GET|POST /run-manifests`
- `GET|PUT|DELETE /run-manifests/:id`
- `POST /run-manifests/:id/duplicate`
- `POST /run-manifests/:id/validate`
- `POST /run-manifests/:id/resolve`
- `GET /run-manifests/:id/export`
- `POST /run-manifests/import`

`PUT` accepts `{ manifest, expectedRevision }`. A stale expected revision returns a conflict error rather than overwriting newer content.

## Runtime guarantees

Simulation time is `stepIndex * stepNs`, using integer nanoseconds. Realtime speed changes pacing only. Each fixed step applies inputs, scripts, vehicle motion, physics, contacts, clock, transforms (`/tf`, `/tf_static`, and oracle odometry), sensor capture, delayed delivery, assertions, and telemetry in that order. Stable IDs order topics, bindings, vehicles, sensors, colliders, and contact events.

## Frames, calibration, and synchronization

Manifest version 5 stores sensor extrinsics in REP-103 (`+X` forward, `+Y` left, `+Z` up) relative to `base_link`. Cameras declare a mount frame (`*_link`) and an optical measurement frame (`*_optical_frame`, `+Z` forward, `+X` right, `+Y` down). LiDAR mount and measurement frames are identical. Localization sensors use mount/measurement frames (`imu_link`, `gnss_link`, `wheel_odom_link`). Scene/vehicle coordinates remain internal Three.js coordinates; conversion happens only at the ROS/TF boundary.

`sensorRig` also declares canonical `map`, `odom`, and `base_link` frame ids, the owning vehicle id, and optional synchronization groups keyed by declared topic ids. Default manifests include `perception-primary` (camera + LiDAR) and `localization-primary` (IMU, GNSS, wheel odometry). Sensors in the same group captured on the same simulation step share a synchronization key in telemetry metadata.

Resolution builds a deterministic `cev-sim.calibration-bundle` artifact (sorted frames, static transforms, intrinsics/distortion, scan geometry, schedules, and output topic ids). Its SHA-256 hash is included in `resolvedHash`, portable run bundles, and SFLog attachments as `calibration.json`. The full provenance source remains `run-manifest.json`.

Manifest sensors schedule captures on integer steps. Message headers contain capture simulation time; latency changes delivery time only. Encoded ROS bytes are shared by transport and SFLog telemetry. Sensor random streams derive from the global seed, sensor ID, and sample index.

### Localization sensor parameters (defaults)

| Sensor | Rate | Key calibration | Units |
| --- | --- | --- | --- |
| IMU | 100 Hz | `gravity`, per-axis `angularVelocityStdDev`, `linearAccelerationStdDev`, drift τ, saturation | rad/s, m/s² |
| GNSS | 10 Hz | `datum` (lat/lng/alt), `positionNoiseEnu`, `faults.dropoutProbability`, `faults.outageProbability`, multipath τ | deg, m |
| Wheel odometry | 50 Hz | `wheelRadius`, `ticksPerRevolution`, `trackWidth`, `slipFactor`, pose/twist noise | m, ticks/rev |

GNSS treats map/odom position as ENU offset from the manifest datum. Wheel odometry integrates an independent measured `odom → base_link` estimate; oracle truth on `/oracle/vehicle/odometry` remains isolated for scoring.

Topic contracts are edited in the Config **Topics** tab (catalog picker, producer, authority, timeout, fallback) or normalized from legacy JSON. See [Autonomy interface contracts](./autonomy-interface-contracts.md) for namespace and preflight rules. Preparation fails before the run reaches `ready` when preflight detects schema or orchestrator mismatches.

Logging writes a native SFLog (see [SFLog](sflog.md)). Policies are:

- `required`: the log must open before the first step.
- `optional`: logging starts automatically; the run continues with degraded status if storage is unavailable.
- `disabled`: no SFLog session is created.

Run logs contain `run-manifest.json` at start and `run-results.json` at finalization, plus manifest identity, hashes, run ID, and browser/WebGL/runtime provenance in metadata. Replay reads recorded state and sensor bytes instead of rerunning sensors on the replay GPU.

## Scenario episode metrics

When a run selects a scenario, `ScenarioRuntime` collects ego-only episode metrics each fixed step and merges them into `finalize().metrics` (and `run-results.json`). Built-ins:

| Metric | Unit | Direction | Aggregation | Notes |
| --- | --- | --- | --- | --- |
| `route-progress` | m | higher | max | Arc distance past the ego’s initial route projection; never negative. |
| `route-progress-ratio` | ratio | higher | max | `route-progress` divided by route distance remaining at the start projection. |
| `off-road` | boolean | lower | any | `1` if any corner of the yaw-oriented ground footprint leaves the paved road/intersection union. |
| `wrong-way` | boolean | lower | any | Realized planar motion opposed to the assigned verified route’s local directed tangent. Near-zero speed samples are ignored. |
| `kinematic-infeasibility` | boolean | lower | any | `1` when absolute longitudinal acceleration exceeds `10.4 m/s²` or absolute curvature exceeds `0.3 m⁻¹`. |
| `acceleration` | m/s² | lower | peak abs | Peak absolute longitudinal acceleration from consecutive poses. |
| `jerk` | m/s³ | lower | peak abs | Peak absolute longitudinal jerk. |
| `log-divergence` | m | lower | mean | Mean L2 XZ distance to time-aligned, linearly interpolated `initialState.vehicles[].keyframes`. |
| `failure` | boolean | lower | episode | `egoCollision \|\| offRoad`. Metric-only — it does **not** change `passed`, outcomes, completion, or case status. |

Missing prerequisites (route, road network, footprint dimensions, keyframes / coverage) yield `null`, not zero. Non-scenario runs expose the same built-ins as unavailable (`null`) through experiment extraction. Selecting a newly added metric against an older baseline that lacks it remains `incomplete` under the existing comparison rules. Suite/result/baseline document versions are unchanged.

Signals are published live under `scenario.metrics.<id>`.

## MCP

The simulator MCP endpoint exposes the complete manifest lifecycle through `run_manifest_*` tools: catalog CRUD, optimistic updates, validation, immutable resolution, portable import/export, and browser-backed launch. Read-only catalog and document resources are available at `fusion://run-manifests` and `fusion://run-manifests/{manifestId}`.
