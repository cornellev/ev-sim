# Deterministic simulation runs

Every professional simulation launch is defined by a saved `cev-sim.run-manifest` version 1 document. The server normalizes and validates the authoring document, resolves its environment, scripts, bindings, and ROS schemas, then computes SHA-256 definition and resolved hashes. A running session holds that resolved snapshot and never applies Config edits in place.

Binding resolution includes every global library binding plus the ids listed in `scripts.bindingIds`. The Bindings workspace manages those ids through manifest checkboxes. Scripts referenced by effective bindings are resolved automatically; entries in `scripts.artifacts` remain optional hash locks. Portable manifests with `embeddedBindings` use only their frozen embedded set.

## Operator workflow

Open **Config** from the workspace switcher. The page supports catalog create, duplicate, delete, bundle import/export, structured editing, raw JSON editing, server validation, optimistic revision saves, and **Validate & Run**. Unsaved edits are protected during catalog changes and browser navigation.

Reset finalizes the active result and SFLog, resolves the newest saved revision, rebuilds run-scoped resources, and leaves the replacement run paused at step zero. If the environment changed, the workspace loads that environment before applying the pending run.

## Portable bundles

`cev-sim.run-bundle` version 1 includes the authoring manifest and its resolved environment, exact compiled script artifacts and bindings, ROS schemas, dependency hashes, and resolved hash. Import verifies the bundle hash. Existing dependencies are reused only when hashes match; conflicting resources receive an eight-character hash suffix and all references are remapped.

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

Simulation time is `stepIndex * stepNs`, using integer nanoseconds. Realtime speed changes pacing only. Each fixed step applies inputs, scripts, vehicle motion, physics, contacts, clock, sensor capture, delayed delivery, assertions, and telemetry in that order. Stable IDs order topics, bindings, vehicles, sensors, colliders, and contact events.

Manifest camera and LiDAR sensors schedule captures on integer steps. Message headers contain capture simulation time; latency changes delivery time only. Encoded ROS bytes are shared by transport and SFLog telemetry. Sensor random streams derive from the global seed, sensor ID, and sample index.

Logging policies are:

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
