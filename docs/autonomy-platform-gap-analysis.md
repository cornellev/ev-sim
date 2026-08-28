# Autonomy platform gap analysis and action plan

**Canonical reference for agents.** Use this document when planning simulator work for the full autonomous-vehicle stack (perception, localization, planning, control) or when scoping what cev-sim must provide vs what team-owned modules implement.

**Keywords:** autonomy, dataflow, perception, EKF, localization, controls, planning, reference modules, oracle, candidate, run manifest, sensor contract, action plan, gap analysis.

**Related:** team whiteboard architecture (Lucidchart export). **Visual companion:** [autonomy-platform-gap-analysis.canvas.tsx](/Users/jgrimminck/.cursor/projects/Users-jgrimminck-Coding-js-sensor-fusion/canvases/autonomy-platform-gap-analysis.canvas.tsx) (Cursor canvas; same content, interactive).

**Last reviewed:** 2026-08-27.

---

## Purpose

The whiteboard describes the **total team capability** for a real autonomous car. cev-sim is the **development and verification platform**: it must supply sensors, ground truth, reference substitutes, bidirectional I/O, logging, replay, and scoring so each team (perception, localization/planning, control) can prepare and test **their own** programs without the simulator taking over their algorithms.

**Design principle:** For every pipeline stage, the simulator provides:

1. **Inputs** the team needs (sensors, map semantics, truth state).
2. **Return paths** for team outputs (detections, estimates, commands).
3. **Visualization and validators** to verify those outputs.
4. **Optional reference implementations** that are deterministic and replaceable—not production competitors.

Only **one producer** may be authoritative per stage at a time. All alternatives are logged for shadow comparison.

---

## Priority order (current)

**Prioritize general dataflow first.** Planning-specific dataflow is intentionally deferred.

| Priority | Focus |
|----------|--------|
| **Immediate** | Sensor out → perception & EKF; control commands in → vehicle & visualization |
| **Next** | Tracing, full replay, metrics/CI for perception/EKF/control loops |
| **Later** | Planning (costmap, behavior, path, spline), then scale (NAS, parallel workers, Gym) |

**First mixed workflows to support:**

1. Sim camera + LiDAR → team perception → sim overlays + truth validator  
2. Sim IMU + GNSS + odometry → team EKF → sim estimate overlay + error metrics  
3. Sim reference state/path → team controls → sim command display + vehicle plant  

Planning workflows (costmap, A*, spline, behavior FSM) reuse the same stage model **after** the above loops are correct, observable, replayable, and testable.

---

## Stage execution modes

Every logical stage in a run manifest should support:

| Mode | Producer | Downstream authority | Verification |
|------|----------|----------------------|--------------|
| **Candidate** | Team-owned module | Candidate is authoritative | Reference/oracle may run in parallel; validators score candidate |
| **Reference** | Simulator reference module | Reference is authoritative | Used when team stage absent or when isolating another stage |
| **Oracle** | Privileged simulator truth | Only when manifest explicitly selects oracle | Scoring truth; not default candidate input |
| **Shadow** | Candidate + reference both run | Manifest names one authority | Both logged and compared |
| **Replay / fixture** | Recorded output | Recorded output fills stage | Reproduce downstream failures without live upstream |
| **Bypass** | Typed pass-through | Where contracts allow | Manifest records bypass explicitly |

**Authority rules:**

- Keep `candidate.*`, `reference.*`, `oracle.*`, and `active.*` namespaces separate.
- Only the simulator router writes the canonical `active.*` path downstream.
- Oracle data is privileged and must not leak into candidate training paths unless oracle mode is selected.

---

## What exists today (summary)

| Area | Status | Notes |
|------|--------|-------|
| Deterministic sim loop | Strong | Fixed-step order in `SimulationEngine.js` |
| Run manifests | Strong | Camera + LiDAR, `/clock`, `/ackdrive` |
| Camera / LiDAR | Partial | Manifest path; LiDAR frame semantics need lock-down |
| IMU / GNSS / odometry | Missing | Message stubs only |
| TF / extrinsics | Partial | `rootFrameId` stored; not fully published at runtime |
| Perception return path | Missing | No ingest/visualization of team detections |
| EKF return path | Missing | Truth in telemetry only |
| Controls return | Partial | `/ackdrive` (legacy units); ideal setpoints |
| Planning references | Partial | A* + route follower for scenarios, not stage harness |
| Logging / replay | Partial | SFLog strong; spatial replay is pose-only |
| CI / headless | Weak | Lint + unit tests; sim requires browser tab |

Evidence paths: see [Repository evidence](#repository-evidence) below.

---

## Detailed action plan (simulator work)

### Immediate (steps 1–6)

#### 1. Lock the first dataflow contracts

Every later feature depends on stable message meaning, timestamps, frames, and ownership. Start with perception, localization, and controls paths; **do not design the planning API yet.**

**Work:**

- Versioned topic catalog for simulator **outputs:** `/clock`, `/tf`, `/tf_static`, camera `Image`/`CameraInfo`, LiDAR `PointCloud2`, IMU, GNSS, wheel/truth odometry, vehicle truth state.
- Versioned **return** catalog: perception detections/lanes, estimated odometry/state, vehicle control commands. Prefer standard ROS messages; custom schemas only where needed.
- SI units, frame IDs, covariance, capture vs delivery timestamps, sequence ID, validity horizon, timeout, error/status semantics.
- Extend run manifest: direction, schema, required/optional, producer namespace, authority, timeout, fallback.
- Separate `candidate.*` / `reference.*` / `oracle.*` / `active.*`; only router writes `active.*`.

**Touchpoints:** `RunManifest.js`, `Client.js`, `ClientManager.js`, `TopicInputQueue.js`, `BindingRuntime.js`, telemetry descriptors, contract tests.

**Done when:** A loopback client subscribes to every declared output and publishes each return type; validation fails before run start on schema mismatch.

#### 2. Make simulation time, frames, and calibration operational

**Work:**

- REP-103/105 `map → odom → base_link → sensor` via `/tf` and `/tf_static`.
- Sensor-rig poses as authoritative extrinsics; export calibration in logs/datasets.
- Capture time in headers; delivery time separate for latency.
- Fix LiDAR PointCloud2 frame convention; validate camera/LiDAR axes and units.
- Synchronization-group metadata for camera, LiDAR, IMU, truth.

**Touchpoints:** `RunManifest.js` (`sensorRig.rootFrameId`), `SensorMessages.js`, device transforms, `SensorPublisher.js`, `SimulationEngine.js` clock.

**Done when:** Frame checker resolves every sensor to `base_link`/`map` at capture time; repeated runs produce identical transform/calibration bundles.

#### 3. Add the localization sensor suite

**Work:**

- `sensor_msgs/Imu` with bias, drift, covariance, saturation, latency, dropout.
- Wheel odometry / encoders; `nav_msgs/Odometry` with measured vs ground-truth namespaces.
- `sensor_msgs/NavSatFix` with datum, covariance, outage/multipath models.
- Derive measurements from vehicle state + deterministic noise; never publish raw truth as measured channel.
- Noise/fault parameters in run manifests for experiment sweeps.

**Touchpoints:** `SensorTypeRegistry.js`, `SensorRuntimeRegistry.js`, new device classes, `SensorMessages.js`.

**Done when:** External EKF runs on simulated measurements only; estimate publishback scorable against namespaced truth.

#### 4. Harden camera and LiDAR delivery for perception

**Work:**

- Correct PointCloud2 coordinates in declared sensor frame; oracle-only semantic hit stream.
- Calibration version IDs, distortion, deterministic dropout/latency.
- Live depth + semantic/instance render targets.
- Truth-aligned boxes, lane masks/polylines, sign/light state, visibility/occlusion.
- Sensor health: queue depth, drops, capture/encode/transport duration, missed deadlines.

**Touchpoints:** `ManifestCamera.js`, `ManifestLidar3d.js`, `Lidar3dShader.js`, `SensorPublisher.js`.

**Done when:** Synchronized capture bundle is self-describing (image, calib, cloud, optional depth/labels, transforms, timestamps, health).

#### 5. Ingest and visualize perception and EKF outputs

**Work:**

- Subscribe to candidate detection/lane/segmentation/state via deterministic input queue.
- Preserve source vs arrival timestamps; reject invalid/stale with visible markers.
- Overlays: 2D/3D boxes, lanes, depth/seg, estimated pose, covariance vs truth.
- Non-authoritative by default (visualization only unless manifest routes downstream).
- Log candidate outputs to telemetry/SFLog for Analysis/replay parity.

**Touchpoints:** `ClientManager.js`, `TopicInputQueue.js`, `TelemetryRuntime.js`, overlay layers, `AnalysisPage.js`, `ReplayScene.js`.

**Done when:** Teams return results externally and scrub them beside sensors and truth at the same sim timestamp.

#### 6. Complete the controls return path and command visualization

**Work:**

- Stamped SI-unit control command (sequence, mode, deadline, steer/speed/accel). Adapter for legacy `/ackdrive` mph/degrees.
- Apply at step boundaries; stale-command policy (hold, stop, manifest fallback).
- Separate commanded vs achieved state; rate limits, saturation, delay, watchdog.
- Visualize command, predicted arc, achieved motion, age, saturation, heartbeat.
- Simulator reference path/controller for controls testing before planning exists.

**Touchpoints:** `SimulationEngine.js` `_applyQueuedInputs`, `ScenarioRuntime.js`, vehicle classes, run manifest topics.

**Done when:** Controls process closes loop; UI shows requested vs achieved with timeout/limit events.

### Next (steps 7–10)

#### 7. End-to-end dataflow health and tracing

Rate, latency, queue depth, drops, schema/frame errors, deadline misses; correlation IDs; live dataflow inspector; deterministic network faults.

**Done when:** Failed response traceable to sensor frame → candidate output → command → applied step and every delay/drop.

#### 8. Record and replay the complete bidirectional loop

Record sensors, transforms, candidate outputs, commands, achieved state, authority/fault/health events. Decode heavy payloads in replay; replay-as-fixture for downstream tests.

**Done when:** Offline replay shows same sensors, returns, commands, overlays, timing as live run.

#### 9. Focused verification for perception, EKF, and controls

mAP/IoU, lane metrics, ATE/RPE/NEES, tracking/latency; control tracking, stability, comfort, collision; artifact baselines.

**Done when:** CI/experiment attributes regression to transport vs perception vs EKF vs control.

#### 10. Automate closed-loop tests and headless execution

Fake loopback modules (valid/stale/malformed/delayed); contract/frame/authority/replay/determinism tests in CI; kernel extractable from browser for headless manifests.

**Done when:** PR runs bidirectional loop unattended and fails with focused artifact.

### Later (steps 11–12)

#### 11. Planning dataflow (after steps 1–10 stable)

Reuse stage routing for costmap, behavior, path, trajectory, spline. HD-map/traffic/dynamic-object contracts; promote A* and route follower to registered references; planning viz/metrics last.

**Done when:** Planning team swaps references without new transport machinery.

#### 12. Scale storage, sensors, and campaigns

Pluggable log backend (local/NAS/S3), worker/offscreen sensors, parallel workers, Gym APIs, capacity/determinism reports.

---

## Delivery gates

| Gate | Scope | Exit criterion |
|------|--------|----------------|
| **1 — General dataflow backbone** | Contracts, namespaces, authority, timestamps, TF/calibration, delivery health | Loopback receives sensors, returns timestamped output, sim logs and visualizes without private adapters |
| **2 — Perception, EKF, controls loop** | IMU/GNSS/odom; hardened cam/LiDAR; ingest team outputs; control commands; combined viz | Each of perception, EKF, controls teams can develop against sim and visualize/score returns |
| **3 — Reproducible verification** | Full replay, metrics, faults, headless CI, dataset export for first three teams | Failed run reproducible offline with stage-specific evidence |
| **4 — Planning + scale** | Planning contracts/references; parallel workers; async GPU; NAS; Gym | Planning uses proven dataflow; unattended multi-team suites with indexed evidence |

---

## P0 platform workstreams (cross-cutting)

1. **Composable stage harness and authority routing** — manifest stage modes; single authority per sink.  
2. **Autonomy interface specification** — versioned topic/telemetry catalog + module manifest.  
3. **Clock, TF, calibration authority** — `/tf`, sync groups, frame validators.  
4. **Localization sensor suite** — IMU, GNSS, odometry sensor types.  
5. **Sensor correctness and ground-truth products** — depth, labels, oracle occupancy.  
6. **Closed-loop vehicle and actuator contract** — SI commands, limits, delays, plant fidelity options.  
7. **Headless deterministic runner** — CI/batch without browser tab dependency.

P1 after dataflow: perception/EKF/control evaluation, team-scale logs/export, scenario faults, sensor-aware replay.  
P2: reference autonomy toolkit (full chain), compute scaling, Gym/system-ID APIs.

---

## Capability gaps by whiteboard box

| Domain | Box | Status | Simulator role |
|--------|-----|--------|----------------|
| Perception | LiDAR, Camera | Partial | Native sensor + oracle |
| Perception | RGB-D, object rec, lanes, costmap | Missing | Reference + oracle + validator |
| Localization | IMU, GPS, odometry | Missing / partial | Native sensors + truth |
| Localization | Kalman / EKF | Missing | Reference EKF + validator |
| Planning | Behavior, planning, RL, spline | Partial / missing | Reference stages + validators (**later priority**) |
| Control | Controller, MPC, sys-ID, plant | Partial / missing | Reference controllers + plant + validators |
| Platform | Sensors I/O, accel, logging, viz | Partial | Native I/O, evidence service, verification UI |

Full row-level detail: see canvas capability map or extend this table as implementation progresses.

---

## Repository evidence

| Finding | Location |
|---------|----------|
| Deterministic phase order | `app/simulation/SimulationEngine.js` (~448–578) |
| Sensor types (camera, lidar3d only) | `app/3d/devices/SensorTypeRegistry.js` (~143–284) |
| Default manifest I/O | `app/simulation/RunManifest.js` (~157–216) |
| Sensor publish pipeline | `app/3d/devices/SensorPublisher.js` (~28–132) |
| Scenario controllers | `app/scenarios/ScenarioDocument.js`, `ScenarioRuntime.js` |
| Kinematic vehicle | `app/3d/vehicles/BigCar.js` (~302–336) |
| Physics (kinematic sweep) | `app/physics/PhysicsEngine.js` (~98–180) |
| Browser experiment queue | `app/experiments/ExperimentRunController.js` (~100–200) |
| Baseline comparison | `app/experiments/BaselineComparison.js` (~147–277) |
| Local SFLog storage | `server/logging/LogService.js` |
| Pose-only replay | `app/replay/ReplayScene.js` (~112–146) |
| CI scope | `.github/workflows/ci.yml` |

---

## How agents should use this document

1. **Scoping simulator features:** Follow [Detailed action plan](#detailed-action-plan-simulator-work) in order; do not skip to planning (step 11) before dataflow (steps 1–6) unless explicitly prototyping in isolation.
2. **Team integration:** Assume team modules connect via orchestrator/topics and run-manifest declared endpoints—not by reading simulator-private `SignalStore` state unless bindings explicitly bridge signals.
3. **Implementation:** Prefer extending `SensorTypeRegistry`, run manifest topics, `TopicInputQueue`, telemetry descriptors, and overlay/replay layers over one-off scene hacks.
4. **Verification:** Every new endpoint needs contract tests + manifest validation + (when possible) loopback integration test before UI polish.

When updating this analysis after major platform changes, edit **this file** first, then refresh the canvas if visual layout is still useful.
