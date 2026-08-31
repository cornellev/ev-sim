# Deterministic simulation runs

Every professional simulation launch is defined by a saved `cev-sim.run-manifest` version 9 document. The server normalizes and validates the authoring document, resolves its environment, canonical world description, physics backend identity, scripts, bindings, autonomy catalog metadata, deterministic calibration bundle, ROS schema closure, and contract endpoints, then computes SHA-256 definition, full resolved, and simulation-semantic hashes. A running session holds that resolved snapshot and never applies Config edits in place.

Binding resolution includes every global library binding plus the ids listed in `scripts.bindingIds`. The Bindings workspace manages those ids through manifest checkboxes. Scripts referenced by effective bindings are resolved automatically; entries in `scripts.artifacts` remain optional hash locks. Portable manifests with `embeddedBindings` use only their frozen embedded set.

## Operator workflow

Open **Config** from the workspace switcher. The page supports catalog create, duplicate, delete, bundle import/export, structured editing, raw JSON editing, server validation, optimistic revision saves, and **Validate & Run**. Unsaved edits are protected during catalog changes and browser navigation. Use the header **Advanced** switch to reveal frames, noise, latency, and contract fields while keeping essential sensor and topic settings visible by default; the preference persists across Config and Vehicle Editor. The **Controls** tab authors the target vehicle, authority (`candidate` / `reference`), watchdog, stale policy (`stop` default, or `hold` / `fallback`), and per-run actuator overrides.

Reset finalizes the active result and SFLog, resolves the newest saved revision, rebuilds run-scoped resources, and leaves the replacement run paused at step zero. If the environment changed, the workspace loads that environment before applying the pending run.

## Portable bundles

`cev-sim.run-bundle` version 1 includes the authoring manifest and its resolved environment, normalized `world: { description, hash }`, sorted backend selections, exact compiled script artifacts and bindings, ROS schemas, autonomy catalog metadata, contract endpoints, dependency hashes, full `resolvedHash`, and `simulationSemanticHash`. `dependencyHashes.world` repeats the canonical world SHA-256. Import verifies old and new bundles in the exact form received; re-resolution of an old bundle derives world/backend fields without changing the v1 bundle or v9 manifest schemas. `resolvedHash` protects the entire portable bundle. `simulationSemanticHash` uses the world hash—not the authored environment hash—as environment identity, and projects out logging, artifact/resource policy, wall pacing, and presentation-only settings before feeding `episodeHash`. Existing dependencies are reused only when hashes match; conflicting resources receive an eight-character hash suffix and all references are remapped.

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

Environment domain precedence is explicit authored data (including empty
arrays), then persisted hydrated template data, then deterministic template
defaults. `cev-sim.world-description` v1 sorts IDs by UTF-8 bytes, validates
all references and finite geometry, preserves the route-network hash, and
contains roads/drivable surfaces, buildings, features, obstacle prisms, and
aggregate bounds. The physics backend selection is pinned to
`rapier3d-swept-prism-v1` / `0.19.3` with a config hash covering gravity,
vehicle AABB semantics, and contact-model version. Preparation rejects a
mismatched selection.

Simulation time is `stepIndex * stepNs`, using integer nanoseconds. Realtime speed changes pacing only. Managed `timer` and `simulation-timer` bindings both advance from this integer clock; wall timers remain available only to library/editor execution. Each fixed step applies inputs, scripts, scenario pre-motion, **controls** (actuator selection/delay/limits), vehicle motion, physics, contacts, clock, transforms (`/tf`, `/tf_static`, and oracle odometry), sensor capture, delayed delivery, assertions, and telemetry in that order. Stable IDs order topics, bindings, vehicles, sensors, colliders, and contact events. Managed runs never write `vehicle.velocity` / `steeringAngle` from raw topic handlers; only `ControlRuntime` applied setpoints reach the plant.

## Frames, calibration, and synchronization

Manifest version 9 stores sensor extrinsics in REP-103 (`+X` forward, `+Y` left, `+Z` up) relative to `base_link`. v8 and earlier documents normalize to v9; saved `/ackdrive` topics rewrite to `/controls/command`. Cameras declare a mount frame (`*_link`) and an optical measurement frame (`*_optical_frame`, `+Z` forward, `+X` right, `+Y` down). LiDAR mount and measurement frames are identical. Localization sensors use mount/measurement frames (`imu_link`, `gnss_link`, `wheel_odom_link`). Scene/vehicle coordinates remain internal Three.js coordinates; conversion happens only at the ROS/TF boundary.

`sensorRig` also declares canonical `map`, `odom`, and `base_link` frame ids, the owning vehicle id, and optional synchronization groups keyed by declared topic ids. Default manifests include `perception-primary` (camera + LiDAR measured and optional oracle products) and `localization-primary` (IMU, GNSS, wheel odometry). Sensors in the same group captured on the same simulation step share a synchronization key in telemetry metadata.

Resolution builds a deterministic `cev-sim.calibration-bundle` artifact (sorted frames, static transforms, intrinsics/distortion, product selection, scan geometry, label-catalog version, schedules/deadlines, and output topic ids). Its SHA-256 hash is included in `resolvedHash`, portable run bundles, and SFLog attachments as `calibration.json`. The full provenance source remains `run-manifest.json`.

Manifest sensors schedule captures on integer steps. Message headers contain capture simulation time; latency changes delivery time only. Encoded ROS bytes are shared by transport and SFLog telemetry. Sensor random streams derive from the global seed, sensor ID, and sample index. Wall-clock capture/encode/transport timings are diagnostics only and never change scheduling or payloads.

Camera `calibration.products` and LiDAR `calibration.products` gate expensive oracle render products. Frame dropout drops the entire capture bundle coherently; LiDAR point dropout applies only to the measured cloud.

### Localization sensor parameters (defaults)

| Sensor | Rate | Key calibration | Units |
| --- | --- | --- | --- |
| IMU | 100 Hz | `gravity`, per-axis `angularVelocityStdDev`, `linearAccelerationStdDev`, drift τ, saturation | rad/s, m/s² |
| GNSS | 10 Hz | `datum` (lat/lng/alt), `positionNoiseEnu`, `faults.dropoutProbability`, `faults.outageProbability`, multipath τ | deg, m |
| Wheel odometry | 50 Hz | `wheelRadius`, `ticksPerRevolution`, `trackWidth`, `slipFactor`, pose/twist noise | m, ticks/rev |

GNSS treats map/odom position as ENU offset from the manifest datum. Wheel odometry integrates an independent measured `odom → base_link` estimate; oracle truth on `/oracle/vehicle/odometry` remains isolated for scoring.

## Headless PR 5 profiles and spaces

PR 5 leaves `cev-sim.run-manifest` version 9, `cev-sim.run-bundle` version 1,
and Protobuf v1 unchanged. Episode-local profile presets are selected only by
`ProfileRef { id, version, config_hash }`:

The state-sensor backend is kind `STATE_SENSOR`, capability
`deterministic-state-sensors`, version `1`, with config hash
`dc27525458e0f720321213cd0a1abac8842266ae86f3d82172d8cda518924cf5`.

- Observation `measured-state` v1 has one preset. Its config hash is
  `5c81866540bbdf0031f6c700554d65c7becc6fe76b5abaa5e81a20f14aa99e6d`
  and schema hash is
  `f1e342c273110d10b905550cc2f0f42cd5a0a7fc46d9e468edf9602fafd3e128`.
- Reward `route-safety` v1 has the 16 canonical combinations of collision,
  off-road, and wrong-way termination plus optional smoothness. The default
  terminates on collision and off-road, penalizes but does not terminate on
  wrong-way, and disables smoothness. Its config hash is
  `29dd55136f4207d78b8c3e9d4202f33849f12d9b415c7ed17fff641ee876b1f4`;
  the profile schema hash is
  `214ad749f21030998ca0da8b02a123f8e70893c4602929be3f2448e4c7fce9b7`.

The action space is `normalized-speed-steering` v1, little-endian
`float32[2]`, ordered `[speed, steering]`, with both elements in `[-1,1]`.
Its canonical space hash is
`283885ba2896078f0272a8d50c65bf01ee7ccf3787ec3bb4e1f10e42efa7a652`.
Speed maps symmetrically to `[-maxSpeed,+maxSpeed]`; steering maps to the
REP-103 steering limit. Actions are rejected if their dtype, shape, packed
length, finiteness, or bounds are invalid.

Measured observations are UTF-8-sorted little-endian `TensorMap` entries.
Every enabled state sensor is keyed by its stable ID:

| Entry | Layout |
| --- | --- |
| `sensors/<id>/value` (IMU) | `float32[6]`: angular velocity XYZ, linear acceleration XYZ |
| `sensors/<id>/value` (GNSS) | `float64[3]`: latitude, longitude, altitude |
| `sensors/<id>/value` (wheel odometry) | `float32[13]`: position XYZ, quaternion XYZW, linear velocity XYZ, angular velocity XYZ |
| `sensors/<id>/validity` | `bool[1]` |
| `sensors/<id>/{sequence,age_steps}` | `uint64[1]` |
| `sensors/<id>/is_new` | `bool[1]` |
| `task/value` | `float32[7]`: progress ratio, remaining ratio, signed cross-track error, heading error, route distance remaining, off-road, wrong-way |
| `task/validity` | `bool[7]` |
| `task/{sequence,is_new,age_steps}` | `uint64[1]`, `bool[1]`, `uint64[1]` |

Before a sensor's first delivered sample its value is zero, validity and
`is_new` are false, and sequence/age are zero. GNSS outage delivers a new
invalid zero sample; dropout retains the previous delivery and increases its
age. Observation-space hashes include the complete sorted layout, so sensor
calibration and declaration order do not affect pooling but stable IDs, types,
and counts do.

`max_episode_steps` counts accepted policy actions, not fixed substeps; zero
is unbounded. One action is resubmitted for up to `action_repeat` substeps so
the normal watchdog, response delay, acceleration/jerk, and steering-rate
limits remain active. A terminal substep or simulation-time bound stops the
repeat immediately and records the actual count in diagnostic JSON.

The stable reward-term order is route-progress-ratio delta (`+1`), completion
(`+1`), collision (`-1`), off-road (`-1`), wrong-way (`-0.25`), normalized
acceleration (`-0.05` when enabled), and normalized jerk (`-0.01` when
enabled). Disabled smoothness terms remain present with zero weight. Failure
precedence is collision, off-road, wrong-way, assertion failure, scenario
failure, then success; termination on the same transition as a semantic bound
wins over truncation. Policy limits map to `MAX_EPISODE_STEPS`, while scenario
duration and manifest simulation bounds map to `MAX_SIMULATION_TIME`.

Topic contracts are edited in the Config **Topics** tab (catalog picker, producer, authority, route-downstream, timeout, fallback) or normalized from legacy JSON. Perception and localization candidate returns default to observational (`routeDownstream: false`). Controls default to `/controls/command` with `routeDownstream: true`. See [Autonomy interface contracts](./autonomy-interface-contracts.md) for namespace and preflight rules. Preparation fails before the run reaches `ready` when preflight detects schema mismatches or missing orchestrator returns that the run actually consumes. Local reference controllers (scenario route follower or script) do not need `/controls/command` advertised.

Logging writes a native SFLog (see [SFLog](sflog.md)). Policies are:

- `required`: the log must open before the first step.
- `optional`: logging starts automatically; the run continues with degraded status if storage is unavailable.
- `disabled`: no SFLog session is created.

Run logs contain `run-manifest.json` at start and `run-results.json` at finalization, plus manifest identity, hashes, run ID, and browser/WebGL/runtime provenance in metadata. Results include `simulationSemanticHash`, `episodeHash`, and the final bounded `trajectoryHash`; operational logging policy and output paths do not affect them. Replay reads recorded state and sensor bytes instead of rerunning sensors on the replay GPU. Capture-aligned `visualization.controls.snapshot` scrubs requested/applied/achieved with arcs in Analysis and Replay.

## Headless CLI execution

PR 6 consumes exported `cev-sim.run-bundle` v1 envelopes directly through the
[`cev-sim` CLI](headless-cli.md). The runner verifies the full resolved hash,
simulation-semantic hash, embedded manifest, world, and backend selections; it
does not accept an authoring manifest or call the storage resolver. Streaming
and tape actions both enter the existing normalized policy/action-repeat
contract. Core results, the verified bundle, and runtime provenance publish
atomically, with evaluation/training/disabled policies controlling SFLog
retention. Caller artifact policy and output location remain operational and
do not change episode or trajectory identity.

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

Signals are published live under `scenario.metrics.<id>`. Scenario route followers, scripts, external-ros, and disturbances submit normalized commands to `ControlRuntime` (reference or bypass) rather than writing the plant directly when a managed run is active. Scenario-enabled runs default controls authority to `reference` so the built-in route follower can close the loop.

## MCP

The simulator MCP endpoint exposes the complete manifest lifecycle through `run_manifest_*` tools: catalog CRUD, optimistic updates, validation, immutable resolution, portable import/export, and browser-backed launch. Read-only catalog and document resources are available at `fusion://run-manifests` and `fusion://run-manifests/{manifestId}`.
