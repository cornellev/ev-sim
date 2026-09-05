# cev-sim frontier roadmap

**Purpose:** A repository-accessible strategy for turning cev-sim into a
deterministic causal experimentation and evidence platform.

**Last reviewed:** 2026-09-02.

**Audit scope:** Repository HEAD `bd66690` plus the working-tree Logs catalog
and analysis changes present during the review.

---

## Executive recommendation

cev-sim should not compete primarily on rendering fidelity. Its strongest and
most defensible direction is a **deterministic causal evidence platform**:

1. Open a failed run and reconstruct exactly what happened.
2. Align candidate, reference, and oracle outputs at the failure.
3. Change one causal factor and replay the resulting future.
4. Search nearby scenarios for realistic variants of the failure.
5. Minimize the failure into a stable regression case.
6. Promote the case, metrics, logs, dependencies, and results as traceable
   evidence.

The product loop should become:

```text
failure
  -> branch
  -> search
  -> score
  -> minimize
  -> dataset
  -> baseline
  -> assurance evidence
```

Competing on raw photorealism would place the project against
capital-intensive platforms while underusing its existing advantages:

- One authoritative fixed-step JavaScript kernel across browser, direct CLI,
  process-isolated workers, Python Gym/SB3, and managed experiments.
- Resolved, semantic, episode, and trajectory identity hashes.
- Candidate, reference, oracle, replay, bypass, and active stage namespaces.
- SFLog recording, checkpoints, spatial queries, Replay, Analysis, and an
  in-flight Logs evidence library.
- Native scenario, experiment, baseline, headless, HTTP, and MCP workflows.
- Versioned CPU and GPU sensor backends with explicit capability validation.

Specialized external engines can provide neural rendering, richer physics, or
hardware execution. cev-sim should own run identity, branching, scoring,
counterexample minimization, and evidence promotion across those engines.

---

## Re-audit verdict

The platform is substantially stronger than the earlier gap analysis implied.
The shared headless kernel, process isolation, Python clients, CPU/GPU sensor
tiers, deterministic hashes, managed experiments, and release gates are
implemented. The in-flight Logs workspace turns SFLog into a usable evidence
library.

The central weakness is no longer a lack of isolated features. Logs, metrics,
scenarios, interventions, baselines, datasets, and assurance claims do not yet
form one closed learning loop.

| Area | Maturity | Current evidence | Strategic consequence |
| --- | --- | --- | --- |
| Deterministic execution | Strong | One fixed-step JavaScript kernel spans browser, direct CLI, UDS workers, Python Gym/SB3, and managed experiments. | Make replay and counterfactual claims the product wedge. |
| Identity and provenance | Strong | Resolved, semantic, episode, and trajectory hashes distinguish configuration, policy context, and realized motion. | Turn hashes into queryable evidence lineage instead of inspector-only metadata. |
| Logging and diagnosis | Good, in flight | SFLog checkpoints, spatial/autonomy snapshots, Replay, Analysis, and a working-tree Logs catalog are connected. | Add oracle scorecards, multi-run graphs, failure bookmarks, and run forking. |
| Scenario validation | Partial | Scenarios, assertions, sweeps, deterministic routes, experiments, scalar metrics, and baselines exist. | Add validity-aware search, coverage, minimization, and requirement traceability. |
| Dynamic world | Prototype | Authored actors and keyframes exist; the deterministic route follower does not negotiate with ego. | Introduce reactive actor policies before learned social agents. |
| Physical and sensor fidelity | Tiered | Kinematic plant, deterministic state sensors, CPU BVH LiDAR, and pooled WebGL2 sensors are versioned backends. | Quantify fidelity disagreement instead of promising one universal truth. |
| Scale and operations | Local | Process-isolated batches, soak/benchmark gates, managed FIFO runs, internal artifacts, and MCP automation are implemented. | Finish external hardware evidence before remote scheduling. |
| Professional assurance | Missing | No ODD/requirement graph, governed evidence promotion, OpenX spine, or SIL/HIL timing authority. | Build these on retained, hash-linked run evidence. |

### Current acceptance caveat

The audit run found 643 Node tests:

- 640 passed.
- One optimistic-revision queue race was intermittent.
- Two GPU cases were hardware-gated.
- Supervisor UDS tests can fail only in restricted sandbox environments while
  passing unrestricted.
- Hosted parity aggregation and dedicated x64 NVIDIA and Jetson ARM64 reports
  remain required external acceptance evidence.

These results characterize the state observed during the audit and should not
be treated as permanently current CI status.

---

## Strategic product flywheel

### 1. Observe

Capture candidate, reference, oracle, timing, health, resource, dependency, and
identity information in the same run.

### 2. Explain

Align stages, locate divergence, and isolate the smallest plausible causal
intervention.

### 3. Explore

Search realistic nearby worlds, actors, faults, sensor conditions, and policy
behaviors.

### 4. Prove

Minimize failures, promote regression packs, and refresh only the assurance
claims affected by changed dependencies.

---

## Competitive whitespace

| Reference | What it does well | Remaining whitespace | Recommended cev-sim move |
| --- | --- | --- | --- |
| CARLA / Bench2Drive | Rich sensor worlds and closed-loop skill benchmarks | High variance and limited native evidence lineage | Deliver reproducible skill-level regression with branchable evidence. |
| Waymax | Accelerated, data-driven multi-agent behavior research | No raw sensor-stack simulation | Join behavior-scale tests to measured sensor and stack contracts. |
| NVIDIA NuRec / OmniDreams | Neural reconstruction and action-conditioned photoreal worlds | Heavy infrastructure; model realism is not validation provenance | Use these as optional fidelity backends inside a deterministic evidence envelope. |
| Waabi World | AI-built digital twins and reactive closed-loop variation | Closed proprietary platform | Offer an inspectable, contract-first causal workflow teams can own. |
| Scenic / VerifAI | Probabilistic scenarios and formal falsification | Separate from day-to-day logs, replay, and module baselines | Close the loop from discovered counterexample to retained team evidence. |
| Foxglove / bag tooling | Strong log visualization and operational inspection | Does not rerun a deterministic world from a failure | Turn a log cursor into a controlled, scored counterfactual branch. |

The opportunity is not to duplicate every competitor. It is to connect
determinism, measured sensors, stage contracts, counterfactual search, and
evidence in one inspectable workflow.

---

## Innovation portfolio

Ratings use a five-point strategic scale:

- **Leverage:** fit with existing cev-sim primitives.
- **Differentiation:** meaningful whitespace relative to current platforms.
- **Feasibility:** achievability with the current architecture and a small team.

### 1. Causal Time-Travel Lab

**Horizon:** 0–3 months for an MVP  
**Lane:** Core product wedge  
**Ratings:** Leverage 5/5 · Differentiation 5/5 · Feasibility 4/5

Open a failed SFLog, jump to an event, replay deterministically to that point,
change one actor, stage output, sensor profile, or policy, and compare the
resulting futures.

Build:

- Persist policy and reference action tapes.
- Define versioned branch descriptors.
- Warm-replay from reset to the selected branch time.
- Retain parent and child hashes.
- Add parent/child trails, stage snapshots, and metric deltas.
- Begin with a bounded set of supported interventions.

Acceptance evidence:

- A branch with no intervention reproduces the parent trajectory hash within
  the declared determinism scope.
- The pre-branch state of an intervened run matches its parent.
- A one-variable intervention produces an attributable trace and metric delta.

Repository leverage:

```text
SimulationKernel
SimulationHashes
HeadlessRunner
SFLog checkpoints
LogDataset
SpatialLogViewer
```

### 2. Oracle-Grounded Stack Scorecards

**Horizon:** 0–3 months  
**Lane:** Verification  
**Ratings:** Leverage 5/5 · Differentiation 4/5 · Feasibility 5/5

Score perception, localization, planning, and control directly from
capture-time-aligned candidate and oracle signals already retained in SFLog.

Initial metrics:

- Detection IoU and matched-object precision/recall.
- Lane lateral and boundary error.
- ATE, RPE, and covariance consistency.
- Path clearance, collision margin, and time-to-collision.
- Control tracking, stability, and saturation.
- Comfort and jerk.
- Stage latency, freshness, and data availability.
- Range, occlusion, weather, speed, and scenario-family slices.

Acceptance evidence:

- Every score links to exact source signals and capture times.
- Missing, late, stale, or unsynchronized data is explicit.
- The same metric implementation runs online, offline, in experiments, and in
  baseline gates.

Repository leverage:

```text
AutonomyContractCatalog
CandidateOutputRuntime
LogDataset.autonomySnapshotAt
MetricReducers
BaselineComparison
```

### 3. Agent-Native Regression Analyst

**Horizon:** 0–3 months  
**Lane:** Developer experience  
**Ratings:** Leverage 5/5 · Differentiation 5/5 · Feasibility 5/5

Provide an MCP workflow that investigates a failure, selects evidence, forks a
run, executes a focused experiment, compares the baseline, and returns a
reproducible report.

Build:

- Add composite investigate, fork, and compare operations over existing narrow
  MCP tools.
- Keep every underlying call and artifact visible for auditability.
- Return exact case, log, manifest, branch, baseline, and dependency IDs.
- Generate focused follow-up experiments rather than unconstrained campaigns.

Acceptance evidence:

- A fresh agent can turn a failed case ID into a minimal reproducer and
  evidence-linked diagnosis without browser automation.
- Repeating the workflow produces the same branch and metric identities.

Repository leverage:

```text
MCP registrars
HeadlessExperimentService
LogService
ExperimentSuite
BaselineComparison
```

### 4. Validity-Aware Scenario Foundry

**Horizon:** 3–6 months  
**Lane:** Core product wedge  
**Ratings:** Leverage 4/5 · Differentiation 5/5 · Feasibility 3/5

Search for physically solvable, behaviorally plausible failures near the
autonomy boundary rather than impossible collisions that waste engineering
time.

Build:

- Typed static and dynamic parameter domains.
- Physical, road, temporal, and behavior-validity constraints.
- Risk, novelty, ODD coverage, and plausibility objectives.
- Adaptive random, Bayesian, evolutionary, and RL search adapters.
- Semantic failure signatures and clustering.
- Delta-debugging minimization.
- Retained search history and rejection reasons.

Acceptance evidence:

- Discovered cases pass validity checks.
- Failures represent distinct causal modes rather than parameter duplicates.
- Minimized failures remain reproducible and retain their causal mechanism.

Repository leverage:

```text
ScenarioDocument
ScenarioRuntime
Gym/SB3
experiment sweeps
assertions
route and safety metrics
```

### 5. Language-to-Scenario Compiler

**Horizon:** 3–6 months  
**Lane:** Authoring  
**Ratings:** Leverage 4/5 · Differentiation 4/5 · Feasibility 4/5

Convert a regulation, incident narrative, or test intent into a native
parameterized scenario through a generate, validate, execute, and repair loop.

Build:

- Ground generation in the native scenario schema and selected standards.
- Retrieve relevant regulations, road rules, schema examples, and unit
  definitions.
- Expose assumptions and unresolved choices.
- Compile with server validators and route verification.
- Feed structured diagnostics into iterative repair.
- Produce an experiment-ready parameter domain rather than one fixed scene.

Acceptance evidence:

- A held-out benchmark measures schema validity, route validity, semantic
  fidelity, execution success, and repair count.
- Generated scenarios retain source citations and assumptions.
- No scenario is accepted merely because its text appears plausible.

Repository leverage:

```text
MCP scenario tools
scenario validators
route verification
experiment matrices
Logs workspace
```

### 6. Autonomy Module Arena

**Horizon:** 3–6 months  
**Lane:** Team platform  
**Ratings:** Leverage 5/5 · Differentiation 4/5 · Feasibility 4/5

Run candidate modules or full stacks against identical inputs and rank safety,
quality, latency, compute, and robustness on a Pareto frontier.

Build:

- Stage-level fixture and replay inputs.
- Candidate/reference shadow comparisons.
- Module manifests and dependency identities.
- Resource and deadline telemetry.
- Promoted baselines and benchmark packs.
- One-click evidence comparison.
- Separate scorecards for perception, localization, planning, control, and
  full-stack behavior.

Acceptance evidence:

- A module upgrade is accepted or rejected from a retained case set.
- Dependency changes are explicit.
- Oracle data never leaks into candidate inputs.
- Failures link to replayable evidence.

Repository leverage:

```text
TopicContractRouter
authority modes
run manifests
experiments
baselines
release reports
```

### 7. Failure-to-Dataset Flywheel

**Horizon:** 3–9 months  
**Lane:** ML platform  
**Ratings:** Leverage 4/5 · Differentiation 4/5 · Feasibility 3/5

Turn real or simulated failures into minimized scenario families, balanced
synthetic examples, curriculum packs, and post-training evaluation suites.

Build:

- Slice measured tensors and oracle labels from retained evidence.
- Generate nuisance-factor and causal-factor variations separately.
- Track source failure, branch, scenario-family, and dataset lineage.
- Export ML-ready shards.
- Prevent family leakage between training and evaluation sets.
- Measure whether retraining improves untouched holdout families.

Acceptance evidence:

- Every sample links to a source failure and scenario family.
- Dataset generation is reproducible from a versioned recipe.
- Improvements survive holdout scenarios that were not used for training.

Repository leverage:

```text
SFLog heavy tensors
oracle topics
branch descriptors
experiment suites
run bundles
```

### 8. Reactive Agent Society

**Horizon:** 6–12 months  
**Lane:** World behavior  
**Ratings:** Leverage 3/5 · Differentiation 4/5 · Feasibility 3/5

Model yielding, negotiation, hesitation, aggression, distraction, and partial
observability instead of replaying ghost trajectories.

Build:

- Begin with deterministic IDM/MOBIL and route policies.
- Add actor perception and reaction latency.
- Add configurable social and risk profiles.
- Learn behavior priors from logs without making them authoritative.
- Support pluggable learned agents.
- Score trajectory realism, interaction realism, and collision validity.
- Add Waymax/WOSAC import and evaluation adapters where useful.

Acceptance evidence:

- Actors react coherently when ego deviates from a logged path.
- Behavior matches held-out trajectory and interaction statistics.
- Policies remain seedable, versioned, and replayable.

Repository leverage:

```text
scenario actors
route follower
policy action contracts
Waymax/WOSAC adapters
```

### 9. Multi-Fidelity Trust Envelope

**Horizon:** 6–12 months  
**Lane:** Core product wedge  
**Ratings:** Leverage 5/5 · Differentiation 5/5 · Feasibility 2/5

Run the same case through deterministic CPU, rendered GPU, richer dynamics,
neural sensor, and later HIL profiles, then measure where stack decisions
disagree.

Build:

- Versioned fidelity manifests.
- Paired-run orchestration.
- State, sensor, perception, and decision correspondence metrics.
- Backend-specific uncertainty bands.
- Rules for escalating a case from cheap to expensive fidelity.
- Explicit validity domains for every backend.

Acceptance evidence:

- Teams know which conclusions are invariant across backends.
- Disagreement is localized to a backend, sensor, stage, or operating region.
- Higher fidelity is requested based on evidence rather than visual appeal.

Repository leverage:

```text
backend capability registry
episode hashes
CPU/GPU sensor twins
parity reports
benchmark reports
```

### 10. Continuous Assurance Evidence Graph

**Horizon:** 6–18 months  
**Lane:** Team platform  
**Ratings:** Leverage 5/5 · Differentiation 5/5 · Feasibility 3/5

Connect requirement, ODD feature, scenario family, run, metric, log, source
code, model, calibration, and promoted baseline. Expose missing, contradicted,
or stale evidence.

Build:

- Append-only lineage records.
- ODD and requirement identifiers.
- Claims, evidence, assumptions, and defeaters.
- Coverage and dependency queries.
- Signed baseline and evidence promotion.
- Retention and access policies.
- Export to external safety-case and lifecycle tools.

Acceptance evidence:

- A changed dependency invalidates only the affected claims.
- The platform identifies the smallest sufficient revalidation set.
- Every promoted claim resolves to retained, inspectable run evidence.

Repository leverage:

```text
run, episode, and trajectory hashes
Logs catalog
experiment results
baselines
git and model provenance
```

### 11. World Twin Forge

**Horizon:** 9–18 months  
**Lane:** World fidelity  
**Ratings:** Leverage 3/5 · Differentiation 4/5 · Feasibility 2/5

Turn fleet logs or imported locations into editable worlds where actors can be
removed, inserted, and re-simulated from novel trajectories.

Build:

- Adopt open NCore/NuRec or compatible Gaussian-splat services through an
  adapter.
- Preserve analytic collision, drivable-surface, and LiDAR twins.
- Retain reconstruction inputs, model versions, and quality metrics.
- Support actor removal, insertion, relighting, and novel viewpoints.
- Keep neural rendering outside authoritative geometry and truth contracts.

Acceptance evidence:

- Novel-view sensor output meets calibrated quality thresholds.
- Geometry, labels, and interventions remain inspectable.
- Stack conclusions include the neural backend's validity and uncertainty
  scope.

Repository leverage:

```text
Earth import
bake pipeline
world description
render-scene twin
external gRPC backend
```

### 12. Closed-Loop Reasoning Bench

**Horizon:** 9–18 months  
**Lane:** Research  
**Ratings:** Leverage 3/5 · Differentiation 5/5 · Feasibility 2/5

Evaluate whether VLM and end-to-end policies understand causal hazards, rules,
and recovery rather than merely imitating trajectories.

Build:

- Generate truth-grounded questions and counterfactuals at runtime.
- Evaluate hazard recognition, right-of-way reasoning, uncertainty, recovery,
  and causal attribution.
- Compare verbal reasoning, attention, actions, safety, and recovery.
- Prevent leakage of privileged truth into policy inputs.
- Couple reasoning scores to actual closed-loop outcomes.

Acceptance evidence:

- A model cannot score highly by explaining correctly while controlling
  unsafely.
- A model cannot score highly by driving correctly for demonstrably spurious
  reasons.
- Counterfactual answers agree with observed branch outcomes.

Repository leverage:

```text
oracle scene state
candidate outputs
scenario events
language interface
branch engine
```

---

## Short-term roadmap: first 12 weeks

The first milestone should demonstrate one complete workflow:

> Open a failed case, explain it with oracle-grounded metrics, fork one
> variable at an event, rerun headlessly, and retain a minimized reproducible
> counterexample with linked evidence.

Assumption: one to three engineers and no change to the JavaScript-authoritative
kernel invariant.

### Weeks 0–4: make evidence trustworthy and navigable

**Status: complete.** The Logs workspace is the evidence-library front door:
folder catalog, searchable provenance index, and deep links to Config /
Experiments / Replay / Analysis. Manifest v10 declares hash-locked candidate
models as evidence provenance. The optimistic-revision queue race is covered by
a deterministic quiescence test; revision conflicts dequeue and delete immutable
run-bundle sidecars without overwriting external paused revisions.

Deliverables:

1. Land and test the in-flight Logs workspace and folder catalog.
2. Complete hosted parity and x64 NVIDIA / Jetson PR 12 evidence.
3. Stabilize the optimistic-revision queue race.
4. Keep sandbox-only UDS restrictions classified separately from product
   failures.
5. Index the following fields in the Logs catalog:
   - Resolved hash.
   - Simulation semantic hash.
   - Episode hash.
   - Trajectory hash.
   - World hash.
   - Suite and case IDs.
   - Git commit.
   - Candidate model and calibration IDs.
6. Add deep links from a log to:
   - Its run manifest.
   - Experiment result and case.
   - Baseline.
   - Replay.
   - Analysis.

Exit gate:

> Every completed or failed managed case opens as one evidence record with
> provenance, artifacts, health, and source links.

### Weeks 5–8: ship oracle scorecards and failure triage

Deliverables:

1. Implement initial autonomy scorecards:
   - Detection IoU.
   - Lane lateral error.
   - ATE/RPE.
   - Covariance consistency.
   - Path clearance.
   - Control tracking error.
   - Comfort.
   - Stage latency and freshness.
2. Use capture-time alignment.
3. Treat missing, late, and stale data explicitly.
4. Add failure bookmarks to Replay.
5. Add A/B time pins and state/signal differences.
6. Add multi-log scalar overlays.
7. Preserve world-hash compatibility warnings.
8. Add one MCP `investigate_log` workflow that returns:
   - Event context.
   - Metric excursions.
   - Stage snapshots.
   - Exact artifact and dependency IDs.

Exit gate:

> The same metric definition produces identical results in offline Analysis,
> experiment reduction, and baseline comparison.

### Weeks 9–12: demonstrate deterministic counterfactuals

Deliverables:

1. Record or attach policy/reference action tapes to branchable runs.
2. Define a versioned branch descriptor containing:
   - Parent run and trajectory identity.
   - Branch time.
   - Intervention.
   - Child manifest.
   - Expected pre-branch hash.
3. Warm-replay from reset to the branch time.
4. Apply one supported intervention.
5. Overlay parent and child futures.
6. Emit a causal-delta report.
7. Add a small validity-aware parameter search over native scenarios.
8. Add deterministic counterexample minimization.

Exit gate:

> No-op branches reproduce their parent. Minimized failures remain valid,
> distinct, and deterministic across direct and supervisor paths.

### Critical dependency order

```text
green hardware evidence
  -> indexed run lineage and scorecards
  -> recorded actions and no-op replay proof
  -> single-variable branch
  -> validity-aware search and minimization
```

### Short-term scope discipline

- Keep the first branch engine reset-based: deterministically replay to the
  branch time. Arbitrary kernel-state serialization can wait until the workflow
  proves valuable.
- Start scenario search with native scalar parameters and deterministic actor
  policies. A learned world model is not necessary for the first causal demo.
- Make the Logs workspace the front door for evidence. Do not create a second
  counterfactual dashboard disconnected from Replay and Analysis.
- Keep initial metrics small, reusable, and source-traceable.
- Do not begin distributed scheduling during this milestone.

### Twelve-week success measures

| Measure | Target | Why it matters |
| --- | --- | --- |
| Reproduction | 100% no-op branch hash agreement in the declared scope | Establishes trust before novelty |
| Triage | Failed case to evidence-linked diagnosis in under ten minutes | Demonstrates direct developer value |
| Metric reuse | One implementation across offline, experiment, and CI paths | Prevents score drift |
| Counterexample quality | Valid, minimized, deterministic, and failure-clustered | Avoids adversarial junk |
| Evidence linkage | No orphaned failed case, log, baseline, or branch | Establishes the assurance foundation |

---

## Long-term roadmap

### 3–6 months: scenario intelligence

Deliverables:

- Validity-Aware Scenario Foundry v1.
- Language-to-scenario compile and repair loop.
- ODD feature taxonomy.
- Failure clustering and counterexample minimization.
- Autonomy Module Arena benchmark packs.
- Automated promotion of green baselines.
- Initial failure-to-dataset pipeline.

Dependencies:

- Stable branch format.
- Offline scorecards.
- Reliable managed runs.
- Retained and indexed evidence.

### 6–12 months: behavior and fidelity

Deliverables:

- Reactive traffic v1.
- Behavior-realism and interaction metrics.
- OpenDRIVE, OpenSCENARIO, and Scenic read adapters.
- Multi-fidelity paired runs.
- S3/NAS evidence backend.
- Resumable multi-worker campaigns.
- Expanded dataset generation with scenario-family holdouts.

Dependencies:

- Scenario coverage model.
- Versioned actor policy contract.
- Remote evidence lineage.
- Correspondence metrics between fidelity tiers.

### 12–18 months: digital twins and continuous assurance

Deliverables:

- NuRec or Gaussian-splat rendering adapter.
- Editable log-derived worlds.
- Analytic/neural scene correspondence validation.
- Evidence graph with stale-claim analysis.
- Signed benchmark and evidence promotion.
- Closed-loop reasoning benchmark.
- Selective revalidation based on dependency changes.

Dependencies:

- Retained artifacts.
- ODD and requirement model.
- Fidelity envelopes.
- Governed lineage and promotion.

### 18–24+ months: X-in-the-loop platform

Deliverables:

- Distributed scenario search.
- SIL and HIL execution profiles.
- Real-time clock and network fault models.
- ECU and rest-bus integration.
- Calibrated higher-order vehicle dynamics.
- Governed release evidence and access control.

Dependencies:

- Operational authentication and authorization.
- Remote scheduler and evidence store.
- Hardware timing characterization.
- Validated fidelity escalation rules.

---

## Target platform architecture

### Authoring plane

- Native scenarios and experiment suites.
- Language-to-scenario compiler.
- ODD and requirement model.
- Regulations and source traceability.
- OpenX and Scenic adapters.

### Execution plane

- Authoritative deterministic JavaScript kernel.
- Browser, direct, local-worker, remote-worker, and Python clients.
- CPU, GPU, richer-dynamics, neural-rendering, SIL, and HIL profiles.
- Explicit backend identities and validity domains.

### Intelligence plane

- Reactive actor policies.
- Validity-aware search.
- Counterexample clustering and minimization.
- Curriculum and dataset generation.
- Learned behavior priors and optional world models.

### Evidence plane

- SFLog and retained run artifacts.
- Reusable metric definitions.
- Parent/child branch graph.
- Experiment baselines.
- ODD and requirement coverage.
- Assurance claims and defeaters.
- Retention, access, and signed promotion.

The defensible moat is **backend-independent causal evidence**. A team should be
able to swap renderers, vehicle plants, learned traffic models, or physical
hardware without losing scenario identity, branch lineage, metric definitions,
or assurance history.

The enduring asset is the accumulated graph of reproducible failures and proven
fixes, not one renderer, map, or reference algorithm.

---

## Guardrails

| Avoid | Preferred move |
| --- | --- |
| Training an in-house world foundation model now | Integrate neural reconstruction or world models as optional backends after defining correspondence metrics. |
| Equating photorealism with validity | Require calibration data, an uncertainty scope, and decision-level comparison for every fidelity claim. |
| Distributing an unstable workload | Finish hardware acceptance, artifact lineage, resumability, and local concurrency first. |
| Generating impossible adversarial crashes | Search the physically solvable boundary and retain validity evidence with every counterexample. |
| Leaking oracle state into candidate policy inputs | Reserve oracle products for scoring, controlled fixtures, and explicit authority experiments. |
| Adding sensors without validation | Require timing, frames, calibration, faults, determinism scope, metrics, and replay for each backend. |
| Making simulator reference modules production algorithms | Keep references modest, deterministic, replaceable, and contract-conformant. |
| Treating one aggregate score as validation | Publish granular scenario-family, operating-region, and stage-level results. |

---

## Repository leverage

| Primitive | Repository seam | Roadmap leverage |
| --- | --- | --- |
| Shared deterministic kernel | `app/simulation/kernel/SimulationKernel.js` | Authoritative fixed-step lifecycle and canonical state |
| Hash chain | `app/simulation/kernel/SimulationHashes.js` | Semantic, episode, and trajectory identity |
| Portable runs | `server/headless/RunBundle.js` | Immutable world and sensor twins |
| Policy execution | `app/simulation/headless/HeadlessEpisode.js` | Gym reset/step, measured observations, and rewards |
| Process isolation | `server/headless/HeadlessSupervisor.js` | UDS batches and worker failure boundaries |
| Evidence format | `app/logging/SFLogCodec.js`, `app/logging/LogDataset.js` | Chunked logs, checkpoints, and lazy queries |
| Spatial diagnosis | `server/logging/spatialLogQueries.js` | Capture-aligned spatial and autonomy snapshots |
| Stage contracts | `app/autonomy/AutonomyContractCatalog.js` | Candidate, reference, oracle, replay, and active namespaces |
| Authority routing | `app/autonomy/TopicContractRouter.js` | One authoritative downstream producer |
| Experiment V&V | `app/experiments/ExperimentSuite.js`, `app/experiments/BaselineComparison.js` | Case expansion and regression gates |
| Agent control plane | `server/mcp/createMcpRouter.js` | Stateless orchestration across authoring and execution |
| Evidence library | `app/logging/LogCatalogDocument.js`, `app/logging/LogEvidenceDocument.js`, `app/logging/ui/` | Foldered Logs workspace, sidecar evidence index, and deep-link surface |

---

## External research basis

Sources were reviewed on 2026-09-02. First-party pages and primary research are
preferred where available.

### NVIDIA OmniDreams

- Source: [NVIDIA OmniDreams: Real-Time Generative World Model for Closed-Loop Autonomous Vehicle Simulation](https://research.nvidia.com/publication/2026-06_nvidia-omnidreams-real-time-generative-world-model-closed-loop-autonomous)
- Signal: Real-time, action-conditioned generative video for closed-loop AV
  simulation, trained from 21,000 hours of driving data.
- Implication: Do not build a foundation model now. Define an external backend
  seam and evaluate causal consistency and decision-level correspondence.

### NVIDIA NuRec

- Source: [Neural Reconstruction and 3D Gaussian Splatting](https://developer.nvidia.com/omniverse/nurec)
- Signal: Open NCore input, Gaussian-splat reconstruction, OpenUSD packages,
  and gRPC rendering integration.
- Implication: An external World Twin adapter is more credible than an
  in-house neural renderer.

### Waabi World

- Source: [How Waabi World works](https://waabi.ai/insights/how-waabi-world-works)
- Signal: AI-built digital twins with editable actors and reactive closed-loop
  sensor simulation.
- Implication: Match the editable counterfactual workflow through transparent
  contracts and evidence rather than attempting to reproduce a proprietary
  stack.

### Waymax

- Source: [waymo-research/waymax](https://github.com/waymo-research/waymax/)
- Signal: JAX-accelerated, data-driven multi-agent simulation, intelligent
  agents, RL adapters, and closed-loop metrics.
- Implication: Adopt behavior metrics and actor interfaces without splitting
  the authoritative sensor-capable kernel.

### Bench2Drive and Safe2Drive

- Source: [Bench2Drive](https://thinklab-sjtu.github.io/Bench2Drive/)
- Signal: Short scenario-specific routes expose distinct abilities and safety
  cases better than one noisy aggregate route score.
- Implication: Publish granular capability packs and paired artifacts rather
  than one simulator-wide score.

### Scenic and VerifAI

- Source: [VerifAI documentation](https://verifai.readthedocs.io/en/latest/index.html)
- Signal: Probabilistic scene specification, hard/soft constraints,
  temporal-logic falsification, and counterexample analysis.
- Implication: Add typed distributions and falsification behind the native
  scenario model, then support external adapters.

### ScenePilot and DYNASTO

- Source: [ScenePilot: Controllable Boundary-Driven Critical Scenario Generation](https://arxiv.org/html/2605.21168v1)
- Signal: Critical-scenario research increasingly targets valid, physically
  solvable boundary cases and distinct failure modes.
- Implication: Validity, plausibility, novelty, and minimization must be
  first-class search objectives.

### DT-Drive and CounterScene

- Source: [DT-Drive: Deterministic Replay-Based Testing and Debugging](https://olek-osikowicz.github.io/assets/pdf/2026/pennada2026dtdrive.pdf)
- Signal: Deterministic record-modify-replay and minimal causal interventions
  support fair ADS comparison and debugging.
- Implication: Counterfactual time travel is the strongest near-term
  differentiation for cev-sim.

### Chat2Scenic and ARISE

- Source: [Chat2Scenic](https://arxiv.org/html/2607.14387)
- Signal: Language-to-scenario systems improve through retrieval grounding and
  iterative compile, execute, diagnose, and repair loops.
- Implication: Measure execution and semantic validity. Do not ship one-shot
  free-form scenario generation.

### ISO/TS 5083 and continuous assurance

- Source: [ISO/TS 5083 overview](https://www.horiba-mira.com/iso-ts-5083-has-landed-a-milestone-for-safe-automated-driving/)
- Signal: ADS safety arguments increasingly require traceable verification
  evidence and lifecycle maintenance.
- Implication: The existing hash chain can become a practical evidence graph
  and selective revalidation engine.

---

## Immediate decision

The recommended next program is not a broad fidelity expansion. It is a
12-week causal-evidence vertical:

```text
Logs evidence library
  -> oracle-grounded scorecards
  -> failure bookmarks and investigation
  -> deterministic no-op branch
  -> one-variable counterfactual
  -> validity-aware search
  -> minimized regression evidence
```

If this loop proves useful, subsequent investment in reactive traffic, neural
world twins, distributed execution, and HIL will compound its value instead of
creating additional untraceable complexity.
