# Autonomy interface contracts

Production run-manifest v13 uses native `cev.*` value contracts. Definitions and
validation live in `app/simulation/NativeTopicContracts.js`; default topic roles
live in `NativeTopicCatalog.js`. Resolved bundles pin `nativeTopicContracts` and
its dependency hash. Historical ROS catalogs remain server-only inspection data.

## Topic records

| Field | Purpose |
| --- | --- |
| `id` / `contractId` | Stable manifest binding and logical role |
| `name` | Local topic name; Zenoh wire keys come from admitted routes |
| `direction` | `output` from simulator or `input` from external producer |
| `valueContract` | Exact native contract ID and version |
| `required` | Missing required external routes fail preparation |
| `producer` / `authority` | Producer namespace and active selection policy |
| `routeDownstream` | Allows the router to write `active.*` |
| `timeoutNs` / `validityNs` | Simulation-time stale and validity limits |
| `fallback` | Explicit fallback contract and optional mode |

Sensor products carry capture time, frame, sequence, calibration, and delivery
metadata separately from their values. Native values contain no ROS headers.

## Namespaces and routing

Only `TopicContractRouter` may write `active.*`. Producers write:

- `simulator` → `topics.<wireName>` (local topic alias) plus router metadata
- `candidate.*`, `reference.*`, `oracle.*` → contract-scoped producer paths

The router validates direction/native contract/payload geometry, reads envelope capture time for inbound contracts, records arrival and apply timestamps, assigns deterministic sequence ids, applies authority/fallback, enforces `validityNs` separately from transport `timeoutNs`, and emits telemetry events (`topic-routed`, `topic-rejected`, `topic-stale`, `topic-invalid`, `topic-fallback-applied`). Every inbound outcome also publishes a replayable `diagnostics.topics.<contractId>` status record (sequence, capture/arrival/apply times, age, code, last-good).

**`routeDownstream`:** Candidate perception and EKF returns default to `routeDownstream: false` (visualize + log only). Control returns (`controls-command`) default to `true` so the plant consumes them via `active.*` and `ControlRuntime`. Observational oracle perception products (`producer: oracle` with `observationalOracle`) populate `oracle.topics.*` only and never become `active.*`.

Live platform outputs now include `/clock`, `/tf`, `/tf_static`, default perception sensors, optional oracle perception products, and the localization suite. Candidate return paths are live **inputs** under `candidate.*` (and `active.*` only when `routeDownstream` is enabled). Oracle truth is never mixed into measured sensor topics.

### Controls contract (Step 6)

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `controls-command` | `/controls/command` | `cev.control-command@1` | `candidate` | Native SI controls; modes `velocity`, `acceleration`, `stop`; `deadlineNs` is absolute simulation time; sequence must increase |

`ControlCommandAdapter` validates finite fields and converts REP-103 steering (positive left) to Three.js plant steering once at the actuator boundary. `ControlRuntime` is the sole managed-run actuator sink: it tracks requested / selected / applied / achieved, enforces watchdog + `stop|hold|fallback` stale policy, simulation-time delay, and accel/jerk/steer-rate limits, and publishes `visualization.controls.*` plus transition events (`command-timeout`, `command-recovered`, `command-fallback`, `command-saturated`, `command-rate-limited`, `command-rejected`).

Run manifests carry a `controls` block (target vehicle, authority `candidate|reference`, reference shadow, watchdog, stale policy, optional SI fallback, actuator overrides). Vehicle manifests v2 own speed/accel/decel/jerk/steer-rate/delay defaults; v1 migrates with permissive zero-delay values.

Optional semantic `controls.zeroSpeedResponse: "brake-v1"` selects bounded
contact braking for zero-speed velocity/stop commands across command sources.
Omission is legacy. The shared plant receives effective run actuator limits;
unsupported targets fail before activation. `visualization.controls.snapshot`
includes the actual accepted `commandSource` when known, separate from authority.
Keyboard input is labelled manual, not model execution. Older recorded snapshots
without a source remain unknown; logs are not rewritten.

### Candidate return contracts (Step 5)

Configured candidate products start `waiting` until an output is accepted;
unconfigured products are `inactive`. `ok` requires a valid accepted result,
including valid empty detections. Existing stale/rejected/missing-frame handling
is retained, and reset returns to waiting/inactive without synthesizing estimates.

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `perception-detections-2d` | `/perception/detections_2d` | `cev.detections-2d@1` | `candidate` | Native 2D boxes; observational by default |
| `perception-detections-3d` | `/perception/detections_3d` | `cev.detections-3d@1` | `candidate` | Native 3D boxes; observational by default |
| `perception-lanes` | `/perception/lanes` | `cev.lanes@1` | `candidate` | Native lane polylines |
| `perception-semantic` | `/perception/semantic` | `cev.image@1` | `candidate` | Class ids `semantic-u16-le` |
| `localization-estimate` | `/localization/odometry` | `cev.odometry@1` | `candidate` | External EKF/filter return; observational by default |

`CandidateOutputRuntime` normalizes accepted/rejected returns into `visualization.perception.*` and `visualization.localization.*` with capture/arrival/apply metadata so Analysis/Replay can scrub candidate overlays beside sensors and oracle truth at the same capture time. Default scrubbing uses latest-at-or-before lookback with an age badge; exact-sync mode requires matching capture times.

### Perception contracts (Step 4)

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `front-camera-image` | `/sensors/front_camera/image_raw` | `cev.image@1` | `simulator` | Measured RGBA (`rgba8`); photometric noise only; coherent frame-drop before capture |
| `front-camera-info` | `/sensors/front_camera/camera_info` | `cev.camera-info@1` | `simulator` | Explicit `fx/fy/cx/cy` or FOV defaults; Brown–Conrady `plumb_bob` |
| `front-lidar-points` | `/sensors/front_lidar/points` | `cev.points@1` | `simulator` | Measured `x/y/z/intensity` in REP-103 sensor frame; range noise + point dropout |
| `front-camera-depth` | `/oracle/front_camera/depth` | `cev.image@1` | `oracle` | Metric depth `depth-f32-le` (meters) |
| `front-camera-semantic` | `/oracle/front_camera/semantic` | `cev.image@1` | `oracle` | Class ids `semantic-u16-le` |
| `front-camera-instance` | `/oracle/front_camera/instance` | `cev.image@1` | `oracle` | Stable instance ids `instance-u32-le` |
| `front-lidar-semantic` | `/oracle/front_lidar/points_semantic` | `cev.semantic-points@1` | `oracle` | Exact `x/y/z`, `cos_incidence`, `instance_id`, `semantic_id`, `ray_index` |
| `oracle-detections-2d` | `/oracle/perception/detections_2d` | `cev.detections-2d@1` | `oracle` | Tight visible 2D boxes + visibility/occlusion |
| `oracle-detections-3d` | `/oracle/perception/detections_3d` | `cev.detections-3d@1` | `oracle` | Geometric 3D boxes in the declared frame |
| `oracle-lanes` | `/oracle/perception/lanes` | `cev.lanes@1` | `oracle` | Native lane polylines for the capture |
| `oracle-traffic-controls` | `/oracle/perception/traffic_controls` | `cev.traffic-controls@1` | `oracle` | Sign/light state for the capture |
| `front-camera-diagnostics` / `front-lidar-diagnostics` | `/diagnostics/...` | `cev.diagnostics@1` | `simulator` | Queue depth, drops, capture/encode/transport timings, missed deadlines |

### Localization contracts (Step 3)

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `imu` | `/sensors/imu/data` | `cev.imu@1` | `simulator` | Gravity-inclusive specific force and angular rate in the sensor frame; `orientationAvailable: false` |
| `gnss` | `/sensors/gnss/fix` | `cev.gnss@1` | `simulator` | WGS84 fix from manifest datum + ENU offset; dropout omits the sample, outage publishes `STATUS_NO_FIX` |
| `wheel-odometry` | `/sensors/wheel/odometry` | `cev.odometry@1` | `simulator` | Encoder-quantized dead reckoning in `odom → base_link`, independent of oracle truth |
| `truth-odometry` | `/oracle/vehicle/odometry` | `cev.odometry@1` | `oracle` | Exact vehicle state for scoring; published in the transform phase before measured sensors |
| `localization-estimate` | `/localization/odometry` | `cev.odometry@1` | `candidate` | External EKF/filter return with envelope capture time for later ATE/RPE/NEES scoring |


## Preflight

`ClientManager.preflight()` and shared headless admission require v13, exact
native contract bindings, valid embedded descriptors and mappings, available
sensor/backend products, required routes, and explicit host transport capability.
Local reference controllers require no external command route. Native
`external-topic` scenarios and direct external command runs consume only their
admitted controls routes. Historical scenarios require reviewed adoption.

Plugin topic producers/consumers require `topicAbi: 2`. Publications specify
`{value, valueContract}` and remain bounded, deferred, and transactional. Plugins
cannot publish controls or queue heavy sensor products through that API.

## Related docs

- [Run manifests](run-manifests.md)
- [Zenoh / Protobuf integration](protobuf-routing.md)
- [Historical ROS artifacts](ros-integration.md)
