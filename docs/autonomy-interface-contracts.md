# Autonomy interface contracts

Step 1 locks the first-wave perception, localization, and control dataflow as versioned contracts shared by run manifests, schema resolution, client preflight, and the in-simulation topic router.

## Catalog

`app/autonomy/AutonomyContractCatalog.js` is the single source of truth for:

- Catalog kind/version/hash (`cev-sim.autonomy-contract-catalog` v6)
- Logical contract IDs and default wire names
- ROS schema definitions (`.msg` text)
- Producer namespaces (`simulator`, `candidate`, `reference`, `oracle`, `replay`, `bypass`)
- Authority modes (same set minus `simulator`)
- Timeout, validity, fallback, units, `routeDownstream`, and implementation mode (`live`, `catalog-only`, `stub`)

Resolved runs embed `autonomyCatalog` metadata and a transitive `schemas` closure derived from manifest topics. The closure includes `sensor_fusion_msgs/StampedAckermannDrive` when the default controls return is declared.

The catalog hash covers all compatibility-relevant contract metadata (stage, implementation, frame/timestamp policies, timeout/validity, routeDownstream defaults, schema version, and fallback), not only id/type/direction.

## Run manifest v9 topics

Each topic record includes:

| Field | Purpose |
| --- | --- |
| `id` | Stable manifest id referenced by sensors, scenarios, and bindings |
| `contractId` | Catalog contract id |
| `name` | Orchestrator wire name |
| `direction` | `output` (simulator → team) or `input` (team → simulator) |
| `schema.type` / `schema.version` | Required ROS type |
| `required` | Preflight fails when a required **input** is missing on the orchestrator. Catalog defaults may be `true` (including `/controls/command`); the Config Required toggle can set `false` and that value is preserved on normalize. `/controls/command` is also exempt from orchestrator advertisement when controls authority is `reference` and the scenario is not `external-ros` |
| `producer` | Namespace that may write the producer path |
| `authority` | Which producer wins on `active.*` when routed downstream |
| `routeDownstream` | When `true`, router also writes `active.*`; perception/EKF defaults `false` |
| `timeoutNs` / `validityNs` | Stale detection at step boundaries |
| `fallback` | Structured fallback target (`contractId`, optional mode) |

v1–v8 topic rows migrate through `migrateLegacyTopic`. Normalization always emits manifest version 9. Saved manifests that still declare `/ackdrive` or `ackdrive-legacy` rewrite once to `/controls/command` + `controls-command` (stamped SI). There is no runtime `/ackdrive` alias afterward. v7 and earlier documents that omit candidate perception/localization returns receive those observational contracts on migrate. New defaults declare the full perception sync group plus observational candidate return topics and the live `controls-command` input.

## Namespaces and routing

Only `TopicContractRouter` may write `active.*`. Producers write:

- `simulator` → `topics.<wireName>` (legacy shadow) plus router metadata
- `candidate.*`, `reference.*`, `oracle.*` → contract-scoped producer paths

The router validates direction/type/payload geometry, extracts stamped header capture time for inbound contracts, records arrival and apply timestamps, assigns deterministic sequence ids, applies authority/fallback, enforces `validityNs` separately from transport `timeoutNs`, and emits telemetry events (`topic-routed`, `topic-rejected`, `topic-stale`, `topic-invalid`, `topic-fallback-applied`). Every inbound outcome also publishes a replayable `diagnostics.topics.<contractId>` status record (sequence, capture/arrival/apply times, age, code, last-good).

**`routeDownstream`:** Candidate perception and EKF returns default to `routeDownstream: false` (visualize + log only). Control returns (`controls-command`) default to `true` so the plant consumes them via `active.*` and `ControlRuntime`. Observational oracle perception products (`producer: oracle` with `observationalOracle`) populate `oracle.topics.*` only and never become `active.*`.

Live platform outputs now include `/clock`, `/tf`, `/tf_static`, default perception sensors, optional oracle perception products, and the localization suite. Candidate return paths are live **inputs** under `candidate.*` (and `active.*` only when `routeDownstream` is enabled). Oracle truth is never mixed into measured sensor topics.

### Controls contract (Step 6)

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `controls-command` | `/controls/command` | `sensor_fusion_msgs/StampedAckermannDrive` | `candidate` | Stamped SI Ackermann; modes `velocity`, `acceleration`, `stop`; `deadline_ns` is absolute simulation time; sequence must increase |

`ControlCommandAdapter` validates finite fields and converts REP-103 steering (positive left) to Three.js plant steering once at the actuator boundary. `ControlRuntime` is the sole managed-run actuator sink: it tracks requested / selected / applied / achieved, enforces watchdog + `stop|hold|fallback` stale policy, simulation-time delay, and accel/jerk/steer-rate limits, and publishes `visualization.controls.*` plus transition events (`command-timeout`, `command-recovered`, `command-fallback`, `command-saturated`, `command-rate-limited`, `command-rejected`).

Run manifests carry a `controls` block (target vehicle, authority `candidate|reference`, reference shadow, watchdog, stale policy, optional SI fallback, actuator overrides). Vehicle manifests v2 own speed/accel/decel/jerk/steer-rate/delay defaults; v1 migrates with permissive zero-delay values.

### Candidate return contracts (Step 5)

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `perception-detections-2d` | `/perception/detections_2d` | `vision_msgs/Detection2DArray` | `candidate` | Stamped 2D boxes; observational by default |
| `perception-detections-3d` | `/perception/detections_3d` | `vision_msgs/Detection3DArray` | `candidate` | Stamped 3D boxes; observational by default |
| `perception-lanes` | `/perception/lanes` | `sensor_fusion_msgs/StampedLanes` | `candidate` | Stamped lane polylines |
| `perception-semantic` | `/perception/semantic` | `sensor_msgs/Image` | `candidate` | Class ids `16UC1` |
| `localization-estimate` | `/localization/odometry` | `nav_msgs/Odometry` | `candidate` | External EKF/filter return; observational by default |
| `perception-detections` | `/perception/detections` | `sensor_fusion_msgs/Boxes` | `candidate` | Legacy unstamped boxes (catalog-only adapter) |
| `perception-lanes-legacy` | `/perception/lanes_legacy` | `sensor_fusion_msgs/Lanes` | `candidate` | Legacy unstamped lanes (catalog-only adapter) |

`CandidateOutputRuntime` normalizes accepted/rejected returns into `visualization.perception.*` and `visualization.localization.*` with capture/arrival/apply metadata so Analysis/Replay can scrub candidate overlays beside sensors and oracle truth at the same capture stamp. Default scrubbing uses latest-at-or-before lookback with an age badge; exact-sync mode requires matching capture stamps.

### Perception contracts (Step 4)

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `front-camera-image` | `/sensors/front_camera/image_raw` | `sensor_msgs/Image` | `simulator` | Measured RGBA (`rgba8`); photometric noise only; coherent frame-drop before capture |
| `front-camera-info` | `/sensors/front_camera/camera_info` | `sensor_msgs/CameraInfo` | `simulator` | Explicit `fx/fy/cx/cy` or FOV defaults; Brown–Conrady `plumb_bob` |
| `front-lidar-points` | `/sensors/front_lidar/points` | `sensor_msgs/PointCloud2` | `simulator` | Measured `x/y/z/intensity` in REP-103 sensor frame; range noise + point dropout |
| `front-camera-depth` | `/oracle/front_camera/depth` | `sensor_msgs/Image` | `oracle` | Metric depth `32FC1` (meters) |
| `front-camera-semantic` | `/oracle/front_camera/semantic` | `sensor_msgs/Image` | `oracle` | Class ids `16UC1` |
| `front-camera-instance` | `/oracle/front_camera/instance` | `sensor_msgs/Image` | `oracle` | Stable instance ids `32SC1` |
| `front-lidar-semantic` | `/oracle/front_lidar/points_semantic` | `sensor_msgs/PointCloud2` | `oracle` | Exact `x/y/z`, `cos_incidence`, `instance_id`, `semantic_id`, `ray_index` |
| `oracle-detections-2d` | `/oracle/perception/detections_2d` | `vision_msgs/Detection2DArray` | `oracle` | Tight visible 2D boxes + visibility/occlusion |
| `oracle-detections-3d` | `/oracle/perception/detections_3d` | `vision_msgs/Detection3DArray` | `oracle` | Geometric 3D boxes in the declared frame |
| `oracle-lanes` | `/oracle/perception/lanes` | `sensor_fusion_msgs/StampedLanes` | `oracle` | Stamped lane polylines for the capture |
| `oracle-traffic-controls` | `/oracle/perception/traffic_controls` | `sensor_fusion_msgs/TrafficControlStates` | `oracle` | Sign/light state for the capture |
| `front-camera-diagnostics` / `front-lidar-diagnostics` | `/diagnostics/...` | `diagnostic_msgs/DiagnosticArray` | `simulator` | Queue depth, drops, capture/encode/transport timings, missed deadlines |

### Localization contracts (Step 3)

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `imu` | `/sensors/imu/data` | `sensor_msgs/Imu` | `simulator` | Gravity-inclusive specific force and angular rate in the sensor frame; `orientation_covariance[0] = -1` |
| `gnss` | `/sensors/gnss/fix` | `sensor_msgs/NavSatFix` | `simulator` | WGS84 fix from manifest datum + ENU offset; dropout omits the sample, outage publishes `STATUS_NO_FIX` |
| `wheel-odometry` | `/sensors/wheel/odometry` | `nav_msgs/Odometry` | `simulator` | Encoder-quantized dead reckoning in `odom → base_link`, independent of oracle truth |
| `truth-odometry` | `/oracle/vehicle/odometry` | `nav_msgs/Odometry` | `oracle` | Exact vehicle state for scoring; published in the transform phase before measured sensors |
| `localization-estimate` | `/localization/odometry` | `nav_msgs/Odometry` | `candidate` | External EKF/filter return with stamped capture time for later ATE/RPE/NEES scoring |

## Preflight

Before `SimulationEngine.applyRunManifest`, `RunSessionController` calls `ClientManager.preflight(resolved)`:

1. Every schema in the resolved closure must be registered locally.
2. The resolved catalog hash must match the runtime catalog hash when present.
3. If any input requires orchestrator advertisement, the orchestrator WebSocket must be connected and catalog echo/read must succeed.
4. A known topic with the wrong type fails immediately.
5. Missing **required** input topics fail; absent optional inputs remain valid.
6. `/controls/command` does **not** require orchestrator advertisement when controls authority is `reference` and the scenario uses a local controller (`route-follower`, `script`, or `script-with-route`). An `external-ros` controller still requires the topic on the wire, including saved scenarios that still name the topic `ackdrive`.

## External orchestrator requirements

Mirror custom definitions from `public/messages/` into the orchestrator `custom_types/` directory (or sync through the types API). The simulator pushes the full autonomy catalog on startup via `syncTypesToServer`.

The only live controls return is `/controls/command` (`sensor_fusion_msgs/StampedAckermannDrive`). Legacy `/ackdrive` is not registered and is not accepted at runtime; old manifests migrate on normalize.

## Related docs

- [Run manifests](./run-manifests.md) — manifest lifecycle and bundles
- [ROS integration](./ros-integration.md) — orchestrator setup and transport
