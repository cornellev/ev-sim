# Autonomy platform gap analysis and action plan

**Canonical reference for agents.** Use this document when planning simulator work for the full autonomous-vehicle stack or when deciding what cev-sim must provide versus what team-owned modules implement.

**Keywords:** autonomy, simulation, perception, localization, EKF, planning, controls, scenarios, ODD, validation, reference modules, oracle, candidate, run manifest, replay, HIL, ROS, ASAM.

**Source architecture:** `Autonomous Vehicle Software Architecture - Whiteboard Conversion` PDF and Lucidchart JSON.

**Visual companion:** [autonomy-platform-gap-analysis.canvas.tsx](/Users/jgrimminck/.cursor/projects/Users-jgrimminck-Coding-js-sensor-fusion/canvases/autonomy-platform-gap-analysis.canvas.tsx).

**Last reviewed:** 2026-08-30.

---

## Executive assessment

cev-sim is a **credible team development and integration simulator**, but it is **not yet a professional autonomous-vehicle validation authority**.

Its strongest capabilities are:

- Deterministic fixed-step execution and integer-nanosecond simulation time.
- Versioned run manifests, autonomy contracts, schema closure, authority routing, and preflight.
- Camera, LiDAR, IMU, GNSS, wheel odometry, oracle truth, TF, calibration, and synchronization metadata.
- Candidate perception and localization return paths with visualization and logging.
- Stamped SI controls input with authority selection, delay, limits, watchdog behavior, and requested/applied/achieved telemetry.
- Scenario and experiment authoring, deterministic case expansion, SFLog provenance, and scalar baseline comparison.

Its most consequential gaps are:

- No authoritative headless runner for CI, batch execution, or reliable unattended campaigns.
- Incomplete heavy-sensor and bidirectional replay; no full cross-stage trace reconstruction.
- No professional autonomy scoring such as mAP/IoU, ATE/RPE/NEES, planning safety metrics, or controller tracking/stability metrics.
- Kinematic vehicle motion and swept-AABB collision rather than calibrated vehicle, tire, actuator, and contact dynamics.
- Prototype dynamic-world support: no integrated responsive traffic, pedestrians, cyclists, or physical weather.
- No machine-readable ODD, requirement traceability, scenario coverage, or safety-case evidence workflow.
- No OpenSCENARIO, OpenDRIVE/OpenCRG, OSI, OpenODD, or FMI interoperability layer.
- Single-browser sequential execution, local log storage, and no distributed worker scheduler.
- No SIL/HIL/VIL runtime with target hardware, real networks, rest-bus simulation, or real-time guarantees.

The highest-leverage next investment is the **verification spine**: headless execution, complete replay, traceability, metrics, and closed-loop CI. Adding more autonomy breadth or photorealism before those capabilities would create harder-to-reproduce failures rather than trustworthy evidence.

---

## Simulator responsibility

The whiteboard describes the **total team capability** needed for a real autonomous vehicle. cev-sim should support those teams without replacing their production algorithms.

For every logical pipeline stage, the simulator should provide:

1. Inputs the team needs: sensors, map semantics, dynamic actors, time, frames, calibration, and selected upstream outputs.
2. A typed return path for team outputs.
3. Privileged oracle truth where the simulator can know the answer exactly.
4. A modest deterministic reference implementation or fixture when downstream teams would otherwise be blocked.
5. Visualization, validators, metrics, faults, recording, replay, and evidence.

Reference algorithms must be **replaceable, deterministic, intentionally modest, and contract-conformant**. The simulator's durable value is orchestration, truth, faults, metrics, replay, and evidence—not competing with team-owned perception, localization, planning, or control software.

### Stage execution modes

Every logical stage should support the following modes through the run manifest:

| Mode | Producer | Downstream authority | Verification behavior |
| --- | --- | --- | --- |
| Candidate | Team-owned module | Candidate output is authoritative | Reference and oracle may run in parallel; validators score candidate output |
| Reference | Simulator reference module | Reference output is authoritative | Used when a team stage is absent or another stage is being isolated |
| Oracle | Privileged simulator truth | Oracle is authoritative only when explicitly selected | Normally reserved for scoring and controlled experiments |
| Shadow | Candidate and reference both run | Manifest selects exactly one authority | Both outputs are aligned, logged, and compared |
| Replay / fixture | Recorded or scripted output | Fixture fills the stage | Reproduces downstream failures without live upstream modules |
| Bypass | Typed pass-through | Bypass fills the stage where valid | Manifest records the reduced pipeline explicitly |

Authority rules:

- Keep `candidate.*`, `reference.*`, `oracle.*`, `replay.*`, `bypass.*`, and `active.*` namespaces separate.
- Only the simulator router may write the canonical `active.*` path.
- Exactly one producer may be authoritative for each downstream sink.
- Oracle data is privileged and must not leak into candidate paths unless the manifest explicitly selects oracle mode.
- Non-authoritative outputs remain timestamp-aligned, logged, replayable, and scorable.

---

## Whiteboard architecture interpretation

The supplied Lucidchart JSON defines the following intended flow:

1. Simulation outputs feed camera and IMU; hardware acceleration exchanges accelerated I/O with the simulator.
2. LiDAR and camera feed potential RGB-D/mesh sensor fusion.
3. Sensor fusion and camera data feed object recognition; LiDAR also feeds the costmap/occupancy grid.
4. Object recognition feeds behavior and lane segmentation.
5. IMU, odometry, and GPS feed a Kalman-filter state estimate.
6. Lane, costmap, behavior, and state estimate feed planning.
7. Planning produces AI/RL waypoints, which are converted into a spline-fitted path.
8. The spline path and state estimate feed a controller.
9. The controller and system-identification model feed MPC; MPC produces vehicle controls.
10. Object recognition, state estimate, spline path, MPC output, and raw simulation outputs are logged; logs feed visualization and monitoring.

This architecture is directionally correct, but a professional system also needs explicit tracked-object prediction, HD-map and traffic-rule semantics, health/status channels, authority selection, trace identities, metric outputs, model validity, and evidence lineage.

---

## Current maturity

| Capability area | Current level | What exists | Professional gap |
| --- | --- | --- | --- |
| Deterministic kernel and contracts | Strong development foundation | Fixed phase order, integer-nanosecond clock, seeded inputs/noise, versioned manifests/catalog, authority router, schema preflight | Browser ownership, GPU catch-up compromises, and no cross-platform determinism or capacity report |
| Sensor I/O and truth | Usable team harness | Camera, LiDAR, IMU, GNSS, wheel/truth odometry, TF/calibration, oracle labels, candidate returns | Models are not field-calibrated; radar, ultrasonic, thermal, and adverse-weather physics are absent |
| Vehicle and collision physics | Prototype | Kinematic bicycle motion, actuator limits/delay, Rapier world, swept-AABB collision events | No tire, suspension, powertrain, road-surface, multibody, rollover, or mesh-accurate contact dynamics |
| Dynamic world and traffic | Prototype | Road authoring, route graph, CommonRoad parser/keyframes, traffic-control metadata, visual atmosphere/clouds | No integrated responsive traffic, pedestrians/cyclists, physical weather, wet friction, or behavior diversity |
| Scenario V&V and metrics | Good authoring, weak validation authority | Triggers, disturbances, assertions, sweeps, baselines, route/collision/kinematic metrics | No ODD/requirement coverage, critical-scenario search, autonomy metrics, or safety-case evidence graph |
| Logging, replay, and diagnosis | Partial | SFLog with hashes/attachments, analysis series, autonomy snapshots, replay controls | No complete sensor replay-as-fixture, end-to-end trace graph, remote evidence lifecycle, or audit governance |
| Automation and scale | Partial | MCP/HTTP lifecycle APIs, a sequential browser queue, and one server-owned process-isolated headless experiment queue | No parallel experiment scheduling, quotas, cloud/on-prem execution fabric, or CI closed loop |
| Standards and X-in-the-loop | Early | ROS-style contracts, CommonRoad import, external orchestrator boundary | No OpenX/FMI adapters, real-time scheduler, CAN/Ethernet rest bus, SIL/HIL/VIL topology, or ECU synchronization |

### What tests establish

**High confidence**

- Manifest and contract migration, schema closure, authority metadata, and topic validation.
- Deterministic phase and queue ordering.
- Localization measurement math and seeded behavior.
- Candidate-routing semantics and controls policies.
- Scenario/result document normalization and scalar baseline comparison.

**Medium confidence**

- Scenario metrics, logging codecs, replay-series APIs, MCP/storage lifecycle, and candidate visualization models.
- These areas have meaningful tests but not a complete production-stack loop.

**Low confidence**

- GPU sensor output fidelity, cross-GPU determinism, photorealism, integrated traffic behavior, physical vehicle response, real ROS 2 QoS, distributed execution, and HIL timing.

Several tests use mock vehicles, fake physics, synthetic snapshots, or overridden GPU capture methods. Passing tests prove contracts and deterministic logic; they do **not** establish professional physical or sensor fidelity.

---

## Whiteboard block-by-block assessment

Status meanings:

- **Available:** a usable team-facing development interface exists.
- **Partial:** important inputs, outputs, or tooling exist, but the block is not a complete stage harness or professional model.
- **Missing:** the required stage contract or workflow does not exist.

“Available” does not mean deployment-qualified or field-calibrated.

| Domain | Whiteboard block | Status | Current cev-sim support | Required platform additions |
| --- | --- | --- | --- | --- |
| Perception | LiDAR | Available | Measured `PointCloud2`, separate oracle semantic cloud, seeded noise/dropout/latency, health, REP-103 conversion | Calibrated intensity/reflectivity, multi-return, weather attenuation, motion distortion, validation datasets, cross-GPU fidelity envelope |
| Perception | Camera | Available | Measured RGB/`CameraInfo`; oracle depth, semantic, instance and detections; distortion, noise, latency, coherent dropout | Rolling shutter, exposure/ISP behavior, adverse-weather optics, calibrated profiles, photorealism validation, scalable multi-camera capture |
| Perception | RGB-D / mesh fusion | Partial | Synchronized RGB, oracle depth, LiDAR, calibration, and offline splat/bake machinery | Measured depth, fused-cloud/TSDF/mesh contracts, reference fusion, sync diagnostics, replay decode, reconstruction metrics |
| Perception | Object recognition | Partial | Oracle 2D/3D detections and candidate `DetectionArray` return paths with visualization | Stable tracking IDs, fixture/reference mode, mAP/IoU/latency scoring, dataset export, range/occlusion slices, artifact baselines |
| Perception | Costmap / occupancy grid | Missing | No `nav_msgs/OccupancyGrid` or costmap stage contract | Oracle and sensor-derived occupancy, dynamic occupancy, frame/resolution rules, candidate/reference routing, inflation, overlay/replay, IoU/freshness metrics |
| Perception | Lane segmentation | Partial | Oracle lane polylines plus candidate lanes and semantic-image returns | Dense lane masks/instances, topology/visibility, fixtures, IoU/boundary/lateral metrics, downstream planning routing |
| Localization | IMU | Available | `sensor_msgs/Imu` with deterministic bias, drift, covariance, saturation, latency, and dropout | Field-calibrated profiles, temperature/vibration/cross-axis effects, clock faults, higher-fidelity plant underneath |
| Localization | Odometry | Available | Measured wheel odometry and isolated oracle `nav_msgs/Odometry` | Encoder/ABS interfaces, wheel-specific slip, suspension effects, reset/integrity semantics, calibrated error profiles |
| Localization | GPS / GNSS | Available | `NavSatFix`, WGS84 datum conversion, ENU offsets, covariance, deterministic dropout/outage/multipath state | Satellite geometry, urban-canyon visibility, RTK/corrections, jamming/spoofing, receiver clock and calibration profiles |
| Localization | Kalman state estimate | Partial | External estimate return is validated, logged, and visualized against truth | Replaceable reference EKF, bias-state contract, ATE/RPE/NEES/innovation metrics, covariance views, replay fixtures, recovery tests |
| Planning | Behavior FSM / signs / events | Partial | Scenario triggers/events and oracle traffic-control state; not a driving behavior planner | Behavior contract, reference FSM/tree, right-of-way semantics, intent/prediction, transition coverage, rule and response-time metrics |
| Planning | Planning | Partial | Directed road-graph A* and verified scenario routes; no registered global/local planning stage | HD-map/dynamic-object inputs, path/trajectory outputs, stage authority, replanning deadlines, feasibility/TTC/collision metrics, replay |
| Planning | AI / RL waypoints | Partial | Scenario/script waypoints; no training interface | Policy/waypoint contracts, headless episodes, Gym-style reset/observe/act/step, vector workers, rewards/terminations, curriculum and policy evaluation |
| Planning | Spline-fitted path | Partial | Road splines, route polylines, and control-arc visualization | Timed trajectory schema, reference spline and speed profile, continuity/curvature/jerk checks, collision envelope, horizon visualization |
| Control | Controller | Partial | Stamped SI control return, route/script references, authority, watchdog, delay, limits, requested/applied/achieved telemetry | Reference PID/LQR/Stanley fixtures, lifecycle/heartbeat, trajectory feedback, tracking/stability metrics, end-to-end CI |
| Control | MPC | Missing | No solver, horizon, constraint, or plant-model interface | Controller-neutral horizon contract, model/constraint configuration, deterministic reference MPC/fixture, deadline fallback, overlays, constraint metrics |
| Control | System identification | Missing | Kinematic limits only; no parameter-fit workflow | Identifiable plant parameters, excitation scenarios, high-rate I/O export, fit artifacts, residual/holdout metrics, calibrated-model promotion |
| Control | Car controls / plant | Partial | Stamped commands reach a kinematic bicycle plant through rate, jerk, steering, delay, and stale-command policies | Selectable dynamic plants, tire/slip/friction, mass/inertia, suspension, powertrain/brakes, actuator buses, mesh contact, calibration, HIL parity |
| Platform | Simulation outputs / sensors | Available | Fixed-step schedules, clock, TF, calibration, sync groups, seeded noise, latency queues, contract routing, schema preflight | QoS and clock-domain contracts, transport faults, OSI adapters, capacity guarantees, headless sensor profiles, validation reports |
| Platform | Hardware acceleration | Partial | WebGL camera/LiDAR, asynchronous GL readback, bounded encoding worker | Offscreen/headless GPU workers, multi-worker encode, performance budgets, deterministic fallbacks, render-farm scheduling, HIL stimulus timing |
| Platform | Logger on NAS | Partial | SFLog records resolved provenance, sensor bytes, candidate outputs, controls snapshots, and results to local storage | NAS/S3 backend, indexing/retention/RBAC, resumable upload, immutable evidence, rosbag2/MCAP and ML-dataset export, fleet-log ingestion |
| Platform | Visualization / monitoring | Partial | Live, Analysis, and Replay surfaces show telemetry, autonomy outputs, controls, and pose paths | Full sensor/cloud/grid/path/horizon replay, endpoint health and traces, resource/real-time-factor monitoring, multi-run dashboards, report export |

---

## Gap to a professional simulation environment

### P0: verification foundation

#### 1. Authoritative headless execution

**Current:** The fixed-step kernel is deterministic at unit level, but real runs and experiments are owned by a browser tab.

**Add:**

- Extract a UI-independent world and simulation kernel.
- Provide CLI and worker execution APIs.
- Support deterministic reset, step, pause, resume, and cancellation.
- Add offscreen GPU and deterministic non-rendering sensor profiles.
- Enforce resource limits and publish capacity/deadline diagnostics.
- Produce machine-readable results, logs, hashes, and execution provenance.

**Complete when:** A resolved manifest runs unattended in CI and produces consistent state, contract, calibration, and result hashes under a declared execution profile.

#### 2. Complete replay and cross-stage tracing

**Current:** SFLog captures rich data, but spatial replay is primarily poses and selected autonomy overlays.

**Add:**

- Decode camera, point-cloud, segmentation, occupancy, path, trajectory, and horizon payloads.
- Carry correlation identities from sensor capture through team output, authority selection, command, and achieved response.
- Record every delay, drop, fallback, rejection, fault, and authority transition.
- Support replay-as-fixture at every stage.
- Reconstruct the exact selected dataflow and timing without rerunning upstream modules.

**Complete when:** A failed response is reproducible offline with the same input, output, authority, command, achieved motion, and timing/fault decisions.

#### 3. Stage-specific quantitative validation

**Add:**

- Perception: mAP, IoU, tracking metrics, range/occlusion slices, calibration and latency.
- Localization: ATE, RPE, NEES, innovation consistency, drift, outage recovery.
- Planning: collision, TTC, rule compliance, feasibility, route progress, deadlock, replanning deadlines.
- Control: path/trajectory error, overshoot, stability, saturation, command age, comfort, energy where applicable.
- Transport: freshness, rate, queue depth, drops, reordering, schema/frame errors, deadline misses.
- Artifact baselines for sensor frames and structured outputs, not only scalar reducers.

**Complete when:** A regression report attributes failure to transport, perception, localization, planning, control, plant, or scenario behavior and links the exact evidence.

#### 4. Closed-loop CI

**Add:**

- Fake perception, EKF, planning, and controls modules for valid, stale, malformed, delayed, and dropped responses.
- A bounded nominal sensor-to-command smoke scenario.
- Deterministic sensor, localization, transport, and actuator fault cases.
- Build and browser checks in addition to lint and Node unit tests.
- Metric thresholds, replay artifacts, and concise failure traces.

**Complete when:** Pull requests run a closed sensor-to-command loop and fail with a focused trace, replay, and metric artifact.

### P1: autonomy-stage completeness and coverage

#### 5. Scenario, ODD, and requirement coverage

**Add:**

- Functional, logical, and concrete scenario levels.
- Machine-readable ODD taxonomy and constraints.
- Requirement-to-scenario-to-metric traceability.
- Parameter and combinatorial coverage, criticality search, falsification, minimization, and deduplication.
- Reusable scenario libraries organized by ODD, subsystem, risk, and observed failure mode.
- Explicit validity checks showing whether a simulated case remained inside the requested ODD and model envelopes.

**Complete when:** Campaign results report which ODD regions and safety requirements were covered, missed, invalid, or regressed—not only how many cases ran.

#### 6. Planning and prediction stage harness

**Add:**

- Tracked and predicted object contracts.
- Oracle and sensor-derived occupancy/costmap contracts.
- HD-map, route, traffic-rule, and ODD context.
- Behavior state, global path, local path, timed trajectory, and planner-health contracts.
- Candidate/reference/oracle/shadow/replay authority using the existing stage model.
- Modest reference A*, behavior FSM, spline/speed profile, and controller fixtures.
- Planning overlays, replay, metrics, and fault cases.

**Complete when:** Any planning stage can be replaced by a team module without new private transport, authority, logging, replay, or scoring machinery.

#### 7. Responsive traffic and physical environment

**Add:**

- Closed-loop vehicle behavior models with route choice, lane changes, yielding, aggressiveness, and reaction diversity.
- Pedestrian and cyclist actors with animation, intent, and interaction policies.
- Traffic-light phase logic, signs, right-of-way, construction, emergency actors, and temporary map changes.
- Physical rain, fog, spray, wind, wet/icy friction, visibility, surface reflectance, and sensor effects.
- Deterministic domain randomization with every selected variable recorded.

**Complete when:** Other actors react to ego behavior while all policies and environmental variables remain seed-reproducible and visible in run evidence.

### P1/P2: interoperability, fidelity, and scale

#### 8. Standards interoperability

Add conformance-tested import/export or adapters for:

- ASAM OpenDRIVE for static road networks.
- ASAM OpenCRG for detailed road surfaces.
- ASAM OpenSCENARIO DSL/XML for reusable abstract, logical, and concrete scenarios.
- ASAM OpenODD for machine-readable operational design domains.
- ASAM OSI GroundTruth, SensorView, SensorData, FeatureData, TrafficCommand, and TrafficUpdate.
- FMI model exchange, co-simulation, and scheduled execution for plants, controllers, and other dynamic models.
- rosbag2/MCAP for portable recorded data.

**Complete when:** Representative maps, scenarios, ODDs, sensor models, vehicle plants, and team functions move between cev-sim and external tools without semantic rewrites.

#### 9. Parallel campaigns and evidence storage

**Add:**

- Isolated headless workers and a resumable job scheduler.
- Seed/case sharding, retries, worker-loss recovery, quotas, prioritization, and capacity-aware placement.
- Local, NAS, and object-storage backends behind one evidence interface.
- Immutable artifact sets with indexing, retention, lineage, access control, and content-addressed deduplication.
- Queryable campaign dashboards and programmatic report/dataset export.
- Automatic git, container, dependency, model, map, calibration, and infrastructure provenance.

**Complete when:** Large campaigns survive worker loss and produce queryable, immutable evidence with complete software and model lineage.

#### 10. Calibrated sensor and plant fidelity

**Add:**

- Explicit fidelity tiers such as contract, functional, physics, sensor-calibrated, and HIL stimulus.
- Model validity envelopes and prohibited uses for each tier.
- Field-calibrated camera, LiDAR, IMU, GNSS, and odometry profiles.
- Radar, ultrasonic, and thermal models where team hardware requires them.
- Camera rolling shutter, exposure/ISP, blur, glare, and lens effects.
- LiDAR multi-return, reflectivity, beam divergence, motion distortion, and atmospheric behavior.
- Dynamic tire, suspension, steering, braking, powertrain, battery, mass/inertia, terrain, and contact models.
- Calibration datasets and automated model-error reports.

**Complete when:** Every model publishes a version, intended use, calibration dataset, validity envelope, and quantitative error report.

### P2: X-in-the-loop and governed safety evidence

#### 11. SIL/HIL/VIL execution

**Add:**

- Execution profiles that run the same scenario and criteria in model-, software-, hardware-, and vehicle-in-the-loop environments.
- Synchronized wall, simulation, sensor, and ECU clocks.
- Hard deadline monitoring and real-time-factor guarantees.
- CAN, automotive Ethernet, UDP, SOME/IP, DDS/ROS 2, and rest-bus adapters as required by the target architecture.
- Network, compute, sensor, actuator, and power fault injection.
- Target-ECU deployment descriptions, hardware inventory, safety interlocks, and time-correlation capture.

**Complete when:** The same acceptance case runs in SIL and HIL with production software unchanged and a documented timing and fidelity delta.

#### 12. Team governance and safety-case evidence

**Add:**

- Identity, RBAC, project boundaries, approvals, audit trail, and signed releases.
- Reviewed artifact promotion from development to accepted baselines.
- Requirement, ODD, scenario, metric, model, dataset, calibration, and result ownership.
- Data licensing, privacy, secrets isolation, retention, and reproducibility policy.
- Safety-case export linking claims, arguments, evidence, assumptions, and residual gaps.
- Fleet-log ingestion, event mining, reconstruction, counterfactual variation, and long-tail search.

**Complete when:** An auditor can trace an accepted result from safety requirement and ODD through scenario, models, software, execution platform, metrics, artifacts, and approvals.

---

## What each team needs from the simulator

| Team | Required simulator services |
| --- | --- |
| Perception | Measured and oracle sensor bundles; calibration and synchronized truth; tracking and occupancy contracts; calibrated faults; mAP/IoU/tracking metrics; COCO/KITTI/rosbag2/MCAP export |
| Localization | Calibrated IMU/GNSS/encoder faults; oracle truth; reference EKF; richer bias state; ATE/RPE/NEES/innovation scoring; geospatial edge cases; replay fixtures |
| Planning | HD-map/ODD/traffic semantics; tracked and predicted actors; occupancy/costmap; behavior/path/timed-trajectory contracts; modest references; rule/TTC/feasibility/progress metrics |
| Controls | Dynamic plant and actuator state; controller-neutral trajectory/state contracts; reference controllers/MPC fixture; system-identification workflow; tracking/stability/comfort metrics; HIL adapters |
| Platform / V&V | Headless workers; complete trace/replay; scenario/ODD coverage; standards adapters; CI gates; remote evidence store; scheduling, access control, audit lineage, and safety-case export |

---

## Dependency-ordered roadmap

The implementation-level contract, PR sequence, acceptance gates, and
Codex/Cursor handoff for authoritative headless execution live in the
[Headless Simulation Implementation Plan](headless-simulation-plan.md).

### Gate A — Reproducible verification spine

**Objective:** Turn the existing integration harness into an unattended, diagnosable test authority before broadening the autonomy stack.

Deliver:

1. Prove a real camera/LiDAR/IMU/GNSS → candidate → control → plant loop.
2. Extract the authoritative headless runner.
3. Complete bidirectional replay and cross-stage tracing.
4. Add deterministic transport faults and endpoint health.
5. Add perception, localization, and control metrics.
6. Gate the loop in CI with machine-readable and replayable artifacts.

**Exit criterion:** Perception, EKF, and controls regressions run unattended and are reproducible offline with stage-specific evidence.

### Gate B — Planning-stage completeness

**Objective:** Reuse the proven authority and evidence model for the missing middle of the whiteboard.

Deliver:

1. Tracked/predicted objects and occupancy/costmap.
2. Behavior, path, and timed-trajectory contracts.
3. Registered reference EKF, A*, behavior FSM, spline/speed profile, and controller fixtures.
4. Planning overlays, replay, shadow comparison, faults, and metrics.
5. Gym-style episode APIs after headless reset/step is stable.

**Exit criterion:** A team replaces any planning stage without new transport, authority, logging, replay, or scoring machinery.

### Gate C — World fidelity, standards, and team scale

**Objective:** Make scenarios portable, interactive, and operable as shared engineering infrastructure.

Deliver:

1. Responsive traffic, pedestrians, cyclists, traffic controls, adverse weather, and road friction.
2. OpenDRIVE/OpenCRG, OpenSCENARIO, OpenODD, OSI, FMI, and portable log adapters.
3. Parallel workers, scheduling/retry, NAS/object storage, lineage, dataset export, dashboards, and capacity reports.
4. Selectable sensor and plant fidelity tiers with validation envelopes.

**Exit criterion:** Reusable scenario libraries execute at scale across portable maps and models while producing governed evidence without silently changing fidelity.

### Gate D — X-in-the-loop and safety-case evidence

**Objective:** Support professional deployment qualification without claiming simulation alone proves safety.

Deliver:

1. SIL/HIL execution with production software, target compute, real networks, rest bus, and real-time monitoring.
2. ODD, requirement, criticality, coverage, model-validity, and signed-result traceability.
3. Fleet-log mining, scenario reconstruction, counterfactual variation, and long-tail search.
4. RBAC, approvals, audit trail, release promotion, data governance, and safety-case export.

**Exit criterion:** A reviewed result is traceable from safety requirement and ODD through scenario, models, execution platform, metrics, artifacts, and approval.

---

## Repository evidence

| Finding | Location |
| --- | --- |
| Fixed-step order and integer simulation clock | `app/simulation/SimulationEngine.js` |
| Run-manifest v9, controls, calibration, and schema closure | `app/simulation/RunManifest.js` |
| Autonomy contract catalog and producer/authority model | `app/autonomy/AutonomyContractCatalog.js` |
| Candidate perception/localization ingest | `app/autonomy/CandidateOutputRuntime.js` |
| Control authority, limits, delay, watchdog, and telemetry | `app/autonomy/ControlRuntime.js`, `app/autonomy/ControlCommandAdapter.js` |
| Camera and LiDAR measured/oracle products | `app/3d/devices/ManifestCamera.js`, `app/3d/devices/ManifestLidar3d.js` |
| IMU, GNSS, and wheel-odometry models | `app/3d/devices/ManifestImu.js`, `ManifestGnss.js`, `ManifestWheelOdometry.js` |
| Coordinate conversion, TF, and calibration | `app/autonomy/CoordinateFrames.js`, `app/simulation/TransformRuntime.js`, `app/autonomy/CalibrationBundle.js` |
| Kinematic bicycle limitation | `app/3d/vehicles/BigCar.js`, `app/3d/vehicles/ManifestVehicle.js` |
| Swept-AABB collision limitation | `app/physics/PhysicsEngine.js` |
| Scenario runtime and ego-centric metrics | `app/scenarios/ScenarioRuntime.js`, `app/scenarios/ScenarioMetrics.js` |
| Sequential browser and server-owned headless experiment queues | `app/experiments/ExperimentRunController.js`, `server/headless/HeadlessExperimentService.js` |
| Baseline comparison | `app/experiments/BaselineComparison.js` |
| SFLog provenance and partial replay | `app/logging/`, `app/replay/ReplayScene.js`, `app/logging/LogDataset.js` |
| CI currently runs lint and Node tests | `.github/workflows/ci.yml` |
| Package maturity | `package.json` (`cev-sim` version `0.1.0`) |

---

## External research and standards basis

Primary or first-party sources reviewed 2026-08-30. Vendor material is used as a capability benchmark, not as independent proof.

| Source | Relevance to cev-sim |
| --- | --- |
| [ASAM OpenSCENARIO DSL](https://www.asam.net/standards/detail/openscenario-dsl/) | Reusable abstract, logical, and concrete scenarios; parameter-space coverage; KPIs; platform-agnostic simulation and X-in-the-loop workflows |
| [ASAM OpenDRIVE](https://publications.pages.asam.net/standards/ASAM_OpenDRIVE/ASAM_OpenDRIVE_Specification/v1.9.0/specification/00_preface/00_introduction.html) | Exchangeable static road networks; OpenCRG complements detailed road surfaces |
| [ASAM OSI](https://www.asam.net/standards/detail/osi) | Standard GroundTruth, SensorView, SensorData, FeatureData, and traffic-model boundaries for distributed simulation |
| [ASAM OpenODD](https://www.asam.net/standards/detail/openodd/) | Machine-readable, measurable ODD conditions connected to scenario and coverage evaluation |
| [ISO 34502](https://www.iso.org/standard/78951.html) and [ISO 34503](https://www.iso.org/standard/78952.html) | Scenario-based safety evaluation and hierarchical ODD taxonomy |
| [Functional Mock-up Interface](https://fmi-standard.org/) | Portable dynamic models for model-, software-, and hardware-in-the-loop execution with importer-controlled time |
| [CARLA](https://carla.org/) and [ScenarioRunner](https://github.com/carla-simulator/scenario_runner) | Mature baseline for varied sensors, actors/weather, traffic management, OpenDRIVE/OpenSCENARIO, ROS bridges, and automated evaluation |
| [Autoware planning simulation](https://autowarefoundation.github.io/autoware-documentation/main/demos/planning-sim/) and [AWSIM](https://autowarefoundation.github.io/AWSIM/GettingStarted/QuickStartDemo/) | Component-level and end-to-end ROS 2 simulation with replaceable maps, vehicle/sensor kits, dummy objects, and traffic controls |
| [NVIDIA HIL closed-loop guidance](https://docs.nvidia.com/halos-outside-in/latest/testing/hil/index.html) | Production perception/safety software on target compute while a separate stimulus host supplies virtual sensors over a real network |
| [Applied Intuition cloud simulation](https://www.appliedintuition.com/blog/cost-efficient-simulation-in-the-cloud) | Large-scale scheduling, resilient workers, scenario libraries, lineage, and cloud/on-prem execution |
| [Waymo closed-loop simulation](https://waymo.com/blog/2026/08/10ailessons/) and [safety-case approach](https://waymo.com/research/building-a-credible-case-for-safety-waymos-appro/) | Open-loop replay is insufficient for interaction; closed-loop scale, automated critics, long-tail mining, and evidence-backed safety arguments are required |

---

## Guidance for future implementation

1. Build the verification spine before adding substantial planning or rendering breadth.
2. Extend shared registries, contracts, run manifests, authority routing, telemetry, replay, and validators rather than introducing scene-specific private paths.
3. Treat simulator references as replaceable fixtures using the same contracts as team modules.
4. Require each new endpoint to define type, units, frame, capture time, arrival time, cadence, validity, timeout, authority, fallback, health, and replay behavior.
5. Require each model to state its fidelity tier, calibration source, validity envelope, deterministic behavior, and prohibited uses.
6. Require each new scenario feature to expose deterministic parameters, ODD relevance, requirement links, coverage contribution, and result evidence.
7. Preserve oracle isolation. Candidate paths must never consume privileged truth accidentally.
8. Keep the Canvas and this document synchronized after material platform changes; this Markdown file remains the canonical agent reference.
