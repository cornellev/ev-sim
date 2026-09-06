# cev-sim frontier roadmap

**Purpose:** Build a continuous, persistent world for autonomy development,
interactive exploration, and progressively richer reinforcement learning.

**Last reviewed:** 2026-09-06.

**Audit scope:** Runtime HEAD `63f5b31`, the repository review and local checks
on 2026-09-06, and the working-tree visual-layer and deterministic branch-replay
plans. Planned modules and acceptance gates are not implemented capabilities.

**Status:** Strategy and proposed delivery horizons. This revision starts no
implementation PR, changes no runtime contract, and closes no acceptance gate.

## Executive recommendation

> Build a world where vehicles, robots, people, infrastructure, and environmental
> conditions interact, and where those interactions can be inspected, reproduced,
> and used for learning.

The first flagship is a **living Ithaca campus district**. It should contain
purposeful daily activity, reactive traffic and pedestrians, changing conditions,
useful robot missions, and reusable visual assets. Users should be able to explore
it on a consumer desktop and train policies against it on a workstation.

An entire world within a computer requires several levels of detail. Simulate
nearby physical interactions and sensors carefully, retain simpler individual
activity farther away, and represent regional demand beyond that. Geography,
identity, and consequences must persist across those representations.

Develop three coordinated programs:

1. **World simulation:** geography, reactive actors, environmental conditions,
   infrastructure, persistent state, and missions.
2. **Visual fidelity:** the `VIS-*` program for reusable appearance, persistent
   baking, portable assets, and consistent browser/headless camera execution.
3. **Learning and evidence:** progressive RL, scorecards, verified branching,
   scenario search, calibration, datasets, and retained evidence.

The evidence platform remains a substantial advantage. It supports a broader
product loop:

```text
build a world
  -> observe its activity
  -> train and evaluate an agent
  -> inspect an incident
  -> reproduce and intervene
  -> improve the world model or policy
  -> validate on untouched cases
```

The differentiating hypothesis is the combination of persistent consequences,
credible interactions, measured sensing, accessible authoring, and reproducible
learning. Claims of superiority require comparative evidence; feature names and
self-assigned innovation ratings do not establish it.

## Program authorities and present status

| Program | Authority | Present status and boundary |
| --- | --- | --- |
| Headless foundation | [Headless simulation plan](headless-simulation-plan.md) | PRs 1–12 are implemented. Hosted, soak, x64 NVIDIA, and Jetson ARM64 candidate evidence remains governed there. There is no implied PR 13. |
| Visual fidelity | [Visual Layer Implementation Plan](visual-layer-plan.md) | VIS-01 is unstarted; no VIS acceptance evidence is recorded. The audited plan supersedes the original linear ordering. Its suffixed PR dependencies and gates are authoritative. |
| Verified branching | [Deterministic Branch Replay Plan](deterministic-branch-replay-plan.md) | Contract review; implementation not started. Initial scope is newly recorded CPU headless runs and future-input edits/live stepping. Its contract approval gate remains in force. |
| Living-world and learning expansion | This document | Proposed capabilities and milestone outcomes. Each implementation workstream needs its own bounded contract, dependencies, owner, and acceptance gate. |

This roadmap coordinates those programs without duplicating or overriding their
implementation specifications. Dates below express planning horizons from program
start, not calendar commitments or permission to bypass predecessors. Capacity is
not fixed to a one-to-three-person team; work can proceed concurrently where the
contracts permit it.

The visual audit currently identifies five Blocker and twelve High findings. Its
corrected core comprises 25 PRs across the original 17 VIS workstream identifiers.
Material estimation/model integration and the GOOG/GS tracks are optional. A
roadmap edit does not resolve any of those implementation findings or the plan's
D01–D09 decision requirements.

## Re-analysis of the current project

### Implemented strengths and material gaps

| Area | Repository evidence | Consequence for the roadmap |
| --- | --- | --- |
| Shared execution | A fixed-step JavaScript kernel supports browser, direct CLI, isolated workers, and Python clients. | Preserve one simulator while extending its world and actor services. |
| Identity and provenance | Run, semantic, episode, trajectory, calibration, model, and evidence identities are available. | Extend lineage carefully; normalized hashes are not exact byte-integrity or complete replay-state proofs. |
| Logs and experiments | Logs catalog, SFLog, spatial snapshots, Replay, Analysis, managed runs, metrics, and baselines are implemented. | Connect inspection, learning, and regression workflows without another disconnected dashboard. |
| Metric world | WorldDescription normalizes roads, buildings, features, obstacle prisms, and drivable surfaces. Earth Import persists OSM roads and geographic metadata. | Add semantic lanes, sidewalks, crossings, destinations, terrain, and infrastructure. Google preview tiles are not a portable sensor-ready world. |
| Actor behavior | Keyframes and route-following controllers provide authored motion with limited negotiation. | Reactive actors and partial observability belong in the first horizon. |
| Physical behavior | Kinematic vehicle motion and swept-prism contacts support current cases. | Collision detection does not establish tire, suspension, traction, or impact-response fidelity. Introduce separately versioned, calibrated models. |
| Environmental conditions | Rendering and individual sensor configuration do not form one authoritative weather/surface/behavior system. | Create shared environmental causes with consistent physical, visual, and sensor effects. |
| Visual delivery | Existing rendering and bake seams precede the audited VIS asset, isolation, packaging, and correspondence contracts. | Implement the owned/synthetic-asset core before advertising portable photoreal camera support. |
| Camera execution | Pooled GPU sensors exist on supported supervised paths; the current managed-reference path rejects GPU/camera configurations. | VIS-15b's managed GPU bridge is a real dependency of managed photoreal experiments. A renderer alone is insufficient. |
| Persistence and scale | Local process isolation and resource controls exist; general regional state, multiscale behavior, and resumable world snapshots do not. | Build explicit regional and persistence contracts, then measure their limits. |
| Training | Gymnasium/SB3 clients and measured-state/perception profiles exist. | Establish end-to-end learning baselines and performance evidence; do not infer throughput leadership from batch support. |

### Replay and identity qualifications

SFLog checkpoints reconstruct selected recorded signals for inspection. They are
not executable snapshots of all simulator state. Ordinary runs also lack the
complete ordered execution journal and lossless proofs proposed by the branch
plan. Signal-age paths currently use wall time, and existing canonical projections
omit some state that can affect later execution.

Therefore distinguish recorded playback, action-tape reruns, verified input
branches, and future full-state restoration. Existing rounded trajectory hashes
are useful regression identities but do not prove exact state equality. Preserve
the established hashes and add the branch plan's separate verification contract.

The visual audit adds another qualification: nested scenario/environment locks
and derived profile hashes can carry visual authoring identity into episode
semantics. The desired separation of appearance from state-only behavior requires
VIS-12a's explicit versioned correction; it is not already guaranteed for every
current resolution path.

### Observed verification baseline

The 2026-09-06 review at runtime HEAD `63f5b31` observed:

- 39 focused kernel, world, scenario, route-follower, and hash tests passed.
- The complete Node suite passed 646 tests with two hardware-gated GPU skips
  when run with local socket access.
- The restricted-sandbox run had 18 failures associated with unavailable local
  socket/server operations; those failures disappeared with socket access.
- Lint reported zero errors and two warnings.

These are dated local observations, not continuously current CI status, VIS
acceptance, or the outstanding PR 12 hosted/hardware/soak evidence. This strategy
revision does not regenerate fixtures or advance a milestone's status.

### Changes from the previous strategy

- Bring reactive world behavior and useful physical fidelity into the first
  development horizon.
- Make visual fidelity an explicit concurrent program with its corrected
  dependencies, rather than a late generic digital-twin feature.
- Keep scorecards, branching, search, and evidence as services across the product.
- Replace unsupported competitive-gap claims and numerical innovation ratings
  with capabilities, experiments, and evidence requirements.
- Separate implemented functionality, local verification, release acceptance,
  and proposed research. Retire the earlier combined "Weeks 0–4 complete" label.

## Research basis and competitive direction

Primary project documentation and research were reviewed on 2026-09-06. Entries
below describe reported capabilities and our proposed response; they do not assert
that competitors lack every capability outside the description.

| Reference | Relevant capability or result | Proposed cev-sim response |
| --- | --- | --- |
| [CARLA](https://carla.org/) and its [NuRec integration](https://carla.org/2025/09/16/release-0.9.16/) | Actor/sensor control, traffic, environmental variation, and an existing neural-rendering integration. | Treat basic traffic and configurable visual sensing as competitive requirements; differentiate through the complete world/learning workflow. |
| [SUMO](https://eclipse.dev/sumo/docs/) and [mesoscopic traffic](https://eclipse.dev/sumo/docs/Simulation/Meso.html) | Demand generation, transit, pedestrians, logistics, and different traffic granularities. | Give a world origins, destinations, schedules, and network effects; evaluate coarse activity against detailed cases. |
| [MetaUrban](https://github.com/metadriverse/metaurban) and [SimWorld](https://arxiv.org/abs/2512.01078) | Urban micromobility, diverse embodied agents, and extended physical/social tasks. | Build shared-space and delivery missions spanning vehicles, people, and ground robots. |
| [Scenario Dreamer](https://github.com/princeton-computational-imaging/scenario-dreamer) and [Infinigen](https://infinigen.cs.princeton.edu/) | Generated driving environments and procedural assets/scenes. | Generate structured, editable world descriptions and useful variation; validate topology and semantics before execution. |
| [GPUDrive](https://github.com/Emerge-Lab/gpudrive) and [Waymax](https://github.com/waymo-research/waymax) | Accelerator-oriented behavior simulation; Waymax represents actors as boxes rather than raw sensor outputs. | Benchmark equivalent workloads, including complete training loops; distinguish behavior throughput from rendered sensor workloads. |
| [Project Chrono](https://api.chrono.projectchrono.org/vehicle_overview.html) and [BeamNG.tech](https://www.beamng.tech/) | Detailed vehicle/tire/terrain and deformation modeling. | Use specialist models and measurements to define and check specific physical fidelity targets. |
| [WOSAC](https://waymo.com/research/the-waymo-open-sim-agents-challenge/) and [planning/causality evaluation](https://arxiv.org/abs/2508.01922) | Interaction-realism evaluation; research finds weaknesses under controlled interventions despite strong unperturbed realism scores. | Evaluate reactions to changed ego behavior, occlusion, and delayed information as well as trajectory distributions. |
| [Scenic](https://docs.scenic-lang.org/en/latest/) and [ScenePilot](https://arxiv.org/abs/2605.21168) | Constrained scene distributions, reactive behavior, and physically feasible critical-scenario search. | Generate valid scenario families and search plausible failure boundaries with retained rejection reasons. |
| [DT-Drive](https://olek-osikowicz.github.io/assets/pdf/2026/pennada2026dtdrive.pdf) | Deterministic record/modify/replay and ADS comparison research. | Treat replay as a developed research area; demonstrate complete state verification and reactive continuation where supported. |
| [Chat2Scenic](https://arxiv.org/abs/2607.14387) | Retrieval-grounded, iterative scenario compilation and evaluation. | Ground language authoring in native contracts; measure semantic and execution success, not just fluent output. |
| [AlpaSim](https://github.com/NVlabs/alpasim) and [NuRec](https://developer.nvidia.com/omniverse/nurec) | Modular closed-loop AV simulation and neural reconstruction/rendering services. | Integrate optional appearance services through versioned interfaces after the core portable visual path works. |
| [SimReady](https://docs.omniverse.nvidia.com/simready/latest/index.html) | Assets carrying semantic, physical, and nonvisual sensor properties. | Keep asset meaning, material assumptions, and visual/truth correspondence explicit. |

Adopt concepts, formats, metrics, and compatible assets selectively. Data/model
licensing, supported runtimes, and integration cost must be checked for a selected
adapter. These references do not authorize a second simulator kernel or make an
external service a requirement for the core campus experience.

## Innovation portfolio

### 1. Daily activity and persistent consequences

Give actors reasons to exist: attending classes, commuting, boarding buses,
making deliveries, parking, charging, and returning home. Derive movement from
activity schedules and destinations, beginning with deterministic state machines.

Retain meaningful changes: a blocked curb lane, an occupied charger, a moved
barrier, a closed path, or a disabled vehicle. Activity continues to respond to
those changes through the world's rules. In the first horizon, persistence means
continuity within an episode; durable complete-state restoration comes later.

**Demonstration:** a stopped delivery vehicle causes cyclists to merge, buses to
queue, and pedestrians to choose another crossing. Removing the blockage changes
the resulting delays and interactions.

**Evidence:** stable identities and schedules, valid occupancy, plausible flows,
reproducible consequences, and no unexplained teleportation or discarded actors.

### 2. Actors with limited information and inspectable intent

Model visibility, occlusion, reaction delay, attention, goals, preferred speeds,
and bounded risk profiles. Add yielding, merging, crossing, hesitation, and
recovery policies before introducing learned replacements.

A pedestrian behind a bus should act on available observations. A driver should
respond to observable behavior and road rules. Later learned policies must be
versioned, replayable within their declared scope, and tested when ego deviates
from recorded behavior. Language models may help author behavior or perform
slower deliberation; they are not required in every actor's fixed-step loop.

Expose actor observations, intended maneuvers, and decision reasons in the
inspector. This diagnostic view is privileged and stays outside candidate inputs.

**Evidence:** controlled ego interventions, reaction timing, occlusion tests,
held-out interaction statistics, and explicit model limitations.

### 3. Environmental conditions with connected effects

Create shared authoritative fields for illumination, visibility, surface wetness,
and grip. Extend later to snow, ice, loose material, standing water, sensor
contamination, and component temperature where the mission warrants them.

A single rain event should affect surface state, braking, appearance, visibility,
and actor behavior through documented models. Version physical parameters and
validate the supported range. Distinguish supplied/measured physical properties
from generated appearance; a plausible texture does not establish friction.

**Demonstration:** changing rainfall alters braking margin and camera performance
while exposing which modeled mechanisms caused the change.

**Evidence:** model-specific calibration, consistent timing across consumers,
physical sanity checks, and measured effects on closed-loop decisions. Full fluid,
weather, or material simulation is not a prerequisite for the first useful model.

### 4. Simulation detail that follows influence

Use three representations:

1. Detailed physical interaction and sensing around controlled agents.
2. Simplified individual routes, intentions, queues, and motion farther away.
3. Regional demand, travel times, and scheduled arrivals beyond that.

Activation follows controlled agents, sensor reach, and potential interaction,
including dependencies such as queues propagating across an intersection. It is
independent of the human viewport. Preserve destinations, identities, accumulated
state, and occupancy when representations change; support the union of relevant
regions for multiple controlled agents.

Simulation-detail rules are versioned semantic choices. Visual LOD policies are
separately versioned by the rendering provider. Asset residency and machine load
are operational: apply backpressure or fail explicitly when a required workload
cannot fit, without silently changing either policy.

**Evidence:** continuous handoffs, bounded memory, reproducible activation, and
comparisons with fully detailed reference cases for travel time, queues, and
interaction outcomes. Fidelity changes need not produce identical trajectories.

### 5. A compiler for usable worlds

Extend geographic authoring into reproducible world packs: import available
geography, construct lanes/sidewalks/crossings/curb ramps/access restrictions, add
terrain and destinations, and populate compatible buildings, vegetation, parked
vehicles, signs, and street furniture.

Retain source provenance and distinguish measured, inferred, and authored detail.
Validate route connectivity, clearances, accessibility, and actor spawn locations.
Generate analytic geometry and navigation consistently, then bind reusable visual
assets through the VIS contract. Core worlds use owned/synthetic or otherwise
permitted inputs independently of Google or neural services.

Language authoring produces validated native descriptions and parameter domains,
with assumptions and diagnostics. Generated repairs are revalidated before use.

**Evidence:** deterministic generation, valid topology, semantic intent checks,
editable outputs, stable asset bindings, and training/evaluation world separation.

### 6. Reusable appearance and progressive sensor realism

Adopt the audited VIS program as a first-class product workstream. The useful
first result is owned GLB/KTX2/PBR appearance and an explicit no-model captured
appearance path that can be saved, reloaded, packaged, and rendered in both
execution environments.

Preserve captured radiance as declared unlit appearance; do not relabel it as
intrinsic PBR base color and light it again. Deterministic atlas construction
works from fixed captures or supplied channels. Material inference and model
services are optional enrichment with exact input/output provenance and declared
nondeterminism.

Add incremental reuse, bounded asset residency, independent truth products,
complete calibration, and visual/truth correspondence. The implementation must
cover operational package admission, managed GPU execution, and installed
renderer/decoder assets as well as browser previews.

**Evidence:** the complete author/import → preview → no-model bake → promote →
reload → package → browser/headless capture → validated experiment workflow.

### 7. Missions and progressive reinforcement learning

Develop missions that require sustained competence: delivery through crowds,
energy-aware routing and charging, recovery from a closure or sensor outage,
vehicle-to-robot handoffs, and cooperation under infrastructure disruption.
Score safety, completion, delay, energy, comfort, recovery, and disruption to
others separately. Add resource constraints as mission semantics explicitly;
process memory limits remain infrastructure safeguards.

Use measured-state training first, LiDAR evaluation/training next, then camera
plus LiDAR workloads. Shared tasks and holdouts make comparisons useful, but
changed observation spaces require new encoders, retraining, or distillation.
Do not imply that a state policy automatically operates on images.

Optimize batched inference, resets, scene reuse, capture, tensor transport, and
artifact policy within the authoritative architecture. Later multi-agent APIs
have explicit agent lifecycle and action/observation contracts. A world remains
one isolated environment process, not one process per background actor.

**Evidence:** reproducible learning baselines, complete throughput measurements,
held-out family/location performance, and no oracle leakage into measured inputs.

### 8. Investigation, valid interventions, and regression learning

Retain the previous roadmap's scorecards, module comparisons, agent-native
investigation, scenario search, minimization, datasets, and evidence graph.
Connect them through existing Logs, Replay, Analysis, Experiments, and MCP.

Begin verified branching with the BR plan's eligible CPU recordings and
future-input changes. Compare weather, world, or actor-configuration variants
from reset until a separate contract supports those interventions. GPU branching,
browser-origin recording, and complete checkpoint restoration are later work.
A fixed action-tape comparison and a policy rerun answer different questions;
label them explicitly and restore or reconstruct policy state when required.

Search physically feasible and behaviorally plausible failures, retain rejection
reasons, cluster causal mechanisms, and minimize cases without losing validity.
Datasets retain source-family lineage and prevent training/evaluation leakage.

**Evidence:** exact eligible prefixes, verified continuations, reusable online/
offline metrics, valid minimized failures, and improvements on untouched holdouts.

### 9. Calibration and useful uncertainty

Compare physical models, sensors, appearance providers, and learned actors using
measurements and matched cases. Track where a fidelity change alters perception,
planning, or control, and identify which real measurement would best reduce the
uncertainty. Data collection and calibration are dependencies, not presumed
assets already available to the project.

Publish validity ranges, disagreement, missing coverage, and model limitations.
Use held-out real observations and controlled test cases; attractive pictures or
one aggregate driving score cannot establish physical or behavioral accuracy.

An eventual evidence graph connects requirements, operating conditions, model/
code/calibration versions, cases, metrics, and retained artifacts. It supports
selective revalidation and external assurance workflows without claiming that
simulation alone certifies real-world safety.

## Visual-program integration and critical dependencies

The current [VIS dependency and PR organization](visual-layer-plan.md#dependency-and-pr-organization)
supersedes the initial numeric sequence. This summary does not replace the exact
predecessors listed for each suffixed PR.

| Delivery stage | VIS work | Integration condition |
| --- | --- | --- |
| Contracts and corrected identity | VIS-01, VIS-12a, VIS-02, VIS-03, VIS-04, VIS-16a | Versioned projection/migration precedes visual authoring; source policy, revisions, asset lifecycle, and evidence admission are designed early. |
| Isolated preview and bounded residency | VIS-06a before VIS-05a; then VIS-05b | Calibration and measured-scene isolation precede materialization; preview edits cannot contaminate resolved cameras. |
| Persistent no-model baking | VIS-06b, VIS-07, VIS-08, VIS-09, VIS-10a | Aligned capture, frozen inputs, server revision transactions, bounded residency, and incremental/full-rebuild equivalence. |
| Portable visual execution inputs | VIS-12b, VIS-13a, VIS-13b | Complete selected-asset resolution, strict package verification, and actual CLI/Python/supervisor admission. An archive alone is not executable support. |
| Measured cameras and managed execution | VIS-14, VIS-15a, VIS-15b, VIS-15c, VIS-16b | Browser/headless calibration, separate truth products, managed GPU bridge, installed runtime closure, and accepted correspondence evaluation. |
| Fidelity experiments and release | VIS-17a, VIS-17b, VIS-17c | Unique fidelity case identities, matched comparisons, retained evidence, and executed candidate-specific hardware/soak gates. |
| Optional enrichment | VIS-10b, VIS-11, GOOG-01–04, GS-01–03 | No dependency from these tracks into the owned/synthetic-asset core release. Follow their source, capability, and validation gates. |

Important boundaries:

- Preserve the existing `worldHash` contract, including legacy identity/style
  fields. It is not retroactively a geometry-only hash. New visual references
  do not enter it; a future metric-world change requires its own migration.
- Within the corrected identity profile, presentation-only changes preserve
  state/LiDAR/analytic-camera episode semantics after required authoring locks
  are refreshed. Selected PBR pixel-affecting changes alter `renderScene.hash`
  and the applicable semantic/episode identities.
- Keep normalized identities separate from exact bundle, asset, manifest, and
  archive digests. Do not apply new projections to historical immutable bytes.
- Preview, resolved appearance, analytic truth, and frozen bake inputs have
  separate ownership. PBR meshes and imported metadata cannot register truth.
- Real asset preparation and provider/product validation precede capture. An
  unsupported product cannot be omitted or replaced silently.
- Managed photoreal admission requires applicable correspondence evidence.
  Diagnostic capture can generate that evidence without masquerading as an
  accepted experiment. Reports bind evaluation inputs without hash cycles.
- Appearance streaming cannot substitute for behavioral world streaming. Both
  require their own reproducible policies and independent performance evidence.
- Coordinate BR and VIS identity/version changes before implementation so
  timing profiles, lossless evidence, migration dispatch, and artifact formats
  coexist. Do not independently allocate conflicting schema versions.

The initial camera-training core requires no Google approval, splats, model
service, or Python baking service. Preserve the VIS plan's default source policy;
Google-specific operations remain conditional on that plan's agreement gates.

## Short-term roadmap: first 90 days

The first complete demonstration is:

> A campus district has daily activity, reactive traffic and pedestrians, changing
> conditions, persistent baked appearance, and a robot completing a delivery.
> Users can inspect an incident, compare controlled variants, and run the same
> task family headlessly.

The horizons overlap to permit independent work. None authorize merging an
unfinished dependency or enabling a capability before its gate passes. The first
90 days target a complete campus slice and visual foundations; the full audited
25-PR VIS core is a larger program with a provisional 3–6 month horizon.

| Horizon | World and learning deliverables | Visual deliverables | Exit evidence |
| --- | --- | --- | --- |
| Weeks 1–2: truth, contracts, and budgets | Record the baseline, candidate-evidence gaps, campus content specification, and hardware/workload profiles. Prepare world/actor/environment/mission contracts. Start BR contract/timing work only through its own gate. | VIS-01 and early VIS-12a identity/migration, followed by eligible VIS-02/03 work; start independent VIS-04 and VIS-16a contracts. | Current versus proposed capabilities are explicit. Versions, ownership, migration expectations, and numeric benchmark profiles are recorded. |
| Weeks 2–5: usable campus and isolated appearance | Curate roughly 1 km² with connected routes, sidewalks, crossings, destinations, bus stops, schedules, and functional traffic controls. | Complete eligible foundation work; VIS-06a isolation/calibration precedes VIS-05a materialization; start VIS-05b residency. | Valid world connectivity and actor spawns; seeded activity; reusable owned assets; preview changes cannot alter resolved measured input. |
| Weeks 4–8: credible interaction and persistent baking | Car following, yielding, pedestrian crossings, cyclist interaction, occlusion/reaction delay, and an opt-in traction-aware model with initial visibility/wetness effects. | VIS-06b aligned capture, VIS-07 frozen bake/provider-job records, and VIS-08 atomic promotion after revisions and residency gates. | Canonical interactions respond to ego; physical effects pass scoped checks; bake → save → reload works without a model service or stale/partial promotion. |
| Weeks 6–10: missions and portable inputs | Delivery tasks, scheduled arrivals, bus interactions, closures, persistent episode blockage state, recovery, and actor/event inspection. | Start eligible VIS-12b resolution and VIS-13a/b packaging/admission; incremental VIS-09 work follows persistent bake gates. | A 30-minute simulated session retains coherent state. Packages detect corruption and missing dependencies; execution is advertised only for available providers. |
| Weeks 8–12: training and investigation | Measured-state training baseline, LiDAR evaluation, common scorecards, paired variants, and initial verified CPU replay/branches when BR gates pass. | Finish available foundation gates and measure residency/load costs. Keep analytic measured cameras until the appropriate VIS capture gates pass; managed PBR additionally needs VIS-15b/16b. | Retained training/evaluation artifacts, valid supported branches, portable visual inputs, and a consumer campus demonstration with measured performance. |

### First benchmark pack

| Family | Interaction to model | Evaluation focus |
| --- | --- | --- |
| Bus-stop occlusion | A stopped bus hides a pedestrian approaching a crossing. | Visibility, reaction timing, yielding, and safe recovery. |
| Blocked curb lane | A delivery stop causes cyclists to merge and traffic to queue. | Negotiation, clearance, queue propagation, and disruption to others. |
| Wet braking | Surface wetness and visibility change during a route. | Braking margin, sensing quality, and consistency of modeled causes. |
| Construction detour | A path closes and access differs from the agent's prior map. | Replanning, accessibility, rule compliance, and completion. |
| Interrupted delivery | A blocked route or declared sensor outage interrupts a mission. | Recovery, delay, resource use, and eventual task completion. |

Use 100 deterministic evaluation seeds per family. Keep training seeds and
scenario families separate, and reserve unseen combinations and locations for
holdout evaluation. Count unique mechanisms and report failures by family rather
than relying on one aggregate score.

World-condition edits initially run as matched variants from reset. Eligible
input branches retain the BR proof requirements; a weather change is not silently
introduced into the BR v1 input-only contract.

### Hardware and performance targets

The following are design envelopes and proposed targets, not purchasing advice or
measured support claims:

| Profile | Initial budget envelope | Workload and measurement |
| --- | --- | --- |
| Consumer exploration | One desktop-class GPU with approximately 12–16 GiB VRAM and 32 GiB system RAM; lower laptop settings remain optional. | Target 1080p at 30 FPS with 100 mobile actors while sustaining the explicitly configured simulation rate. Declare render settings and sensor workload separately. |
| Workstation training | Approximately 24–48 GiB GPU memory and 128 GiB system RAM, with actual tested platform/driver recorded. | Start measured-state 1/8/16/32-environment benchmarks, then explicitly sized LiDAR and camera workloads. Record complete training performance and memory. |

Before accepting the relevant scale milestone, lock the actual reference machine
and numeric workload/budget profile. Include geometry and texture sizes, actor
mix, behavior rates, fixed-step configuration, camera resolution/rate, LiDAR
sampling, warm/cold preparation, p95 capture/policy latency, reset time, total
CPU/GPU memory, bake duration, and cancellation/recovery costs. VIS-05b's G-SCALE
profile remains authoritative for visual residency acceptance.

Report environment transitions/s, agent transitions/s, simulated seconds per wall
second, render FPS, and learner throughput as distinct measures. Include policy
inference/optimization, observation transport, and artifact costs in end-to-end
training claims. Missed targets trigger profiling and explicit scope decisions;
resource pressure must not silently remove actors, lower semantic fidelity, or
skip requested sensor products.

## Long-term roadmap

| Horizon | World and learning program | Visual and evidence program | Exit demonstration |
| --- | --- | --- | --- |
| 3–6 months | Reliable district activity, richer intersections/accessibility, differential-drive robots, calibrated planar dynamics, energy/charging, faults, recovery, and valid scenario search. | Complete eligible VIS-09/10a and VIS-12b–17c core gates, including installed admission, managed GPU execution, correspondence, and fidelity case identity. Material estimation/model integration remains optional. | A full simulated campus day; author/import → bake → reload → package → browser/headless capture → validated managed experiment with actual hardware evidence. |
| 6–12 months | Persistent regional worlds, geographic streaming, background demand, deterministic detail transitions, full resumable snapshots, procedural districts, and explicit multi-agent learning interfaces. | Extend visual residency/invalidation to regions; add dataset curricula, learned actor candidates, broader scorecards, and declared OpenX/Scenic import subsets. | Agents cross districts without lost identity or state. Compare traffic and outcomes against detailed reference cases; publish bounded performance and holdout generalization. |
| 12–24 months | Calibrated real-location twins, richer physical/sensor effects, component degradation, radar where justified, and selected indoor/outdoor missions. | Optional neural/splat appearance through compatible providers, real-measurement calibration, matched fidelity evaluation, reasoning benchmarks, and selective revalidation. | Real-versus-simulated measurement and policy-transfer reports include unsupported conditions and disagreement. Appearance remains registered to analytic truth. |
| 24–36 months | Regional fleets, transit, charging, logistics, maintenance, demand shifts, and compound disruptions. | Separately scoped distributed campaigns and hardware integration, with their own operational/timing contracts and evidence. | Extended missions across a persistent region; bounded local computation, reliable resume, and reproducible incident extraction. |
| 36+ months | Validated additions such as industrial sites, off-road terrain, aerial logistics, or selected environmental systems. | Domain-specific sensing, physical calibration, interoperable assets, and benchmark packs. | Each domain adds useful interactions and meets its own fidelity, learning, and computational acceptance criteria. |

A long-term demonstration is a campus power outage during bad weather. Signals
change state, charging becomes unavailable, traffic redistributes, deliveries
adapt, and robots recover. Each consequence follows a modeled dependency and can
be investigated in retained evidence. Build individual mechanisms first, then
validate their composition; a dramatic scripted scene is not evidence of a
coherent world.

## Interface direction and compatibility

- Preserve JavaScript authority, integer simulation time, browser/headless phase
  ordering, measured observations, and one process per environment. Python owns
  learning clients and tensors; optional numerical/rendering services do not
  become another authoritative simulation kernel.
- Add versioned world-region, actor-policy, infrastructure, environmental-field,
  physical-material, and mission contracts in their respective workstreams.
  Actor policies consume declared observations and produce intentions or controls;
  their lifecycle and state needed for replay are part of the contract.
- Share entity identities across navigation, collision, visual bindings, and
  sensor labels while preserving their different authoritative representations.
  Keep operational residency separate from semantic simulation/render policies.
- Preserve existing observation/reward profiles and action meanings. New
  modalities, embodiments, and multi-agent capabilities use explicit profiles or
  APIs rather than silently changing the current Gym interface.
- Implement the VIS environment references, corrected semantic projection,
  independent byte digests, package admission, provider selection, source policy,
  and complete product validation according to its detailed authority.
- Implement BR recordings, journals, lossless proofs, timing migration, and
  continuation boundaries according to its detailed authority. Full resumable
  snapshots later include RNG, pending sensors/controls, scripts, missions,
  regional activity, metrics, and policy bookkeeping; SFLog inspection snapshots
  cannot substitute for them.
- Use [OpenDRIVE](https://www.asam.net/standards/detail/opendrive/) and a declared
  [OpenSCENARIO XML](https://www.asam.net/standards/detail/openscenario-xml/) subset
  as incremental interchange targets. Keep DSL support and richer adapters
  explicit; reject unsupported semantics instead of claiming broad compliance.
- Preserve historical artifacts and working legacy execution paths. Coordinate
  version dispatch, migration vectors, source-world rebinding, and JS/Python
  compatibility before any new contract lands.
- Remote scheduling, authentication, registry distribution, and alternative
  accelerated execution architectures are separate future programs. They are
  not additions to current headless maintenance or VIS implementation scope.

## Acceptance and delivery governance

| Dimension | Required evidence |
| --- | --- |
| Reproducibility | Repeated runs within the declared build/backend scope; lossless proofs for exact eligible branches; tolerance-based comparisons where exact equality is not promised. |
| Behavioral credibility | Responses to ego intervention, occlusion, delayed information, and interaction changes; held-out trajectory/interaction statistics and explicit limitations. |
| Physical validity | Scoped braking, turning, surface-response, sensor timing/noise, and calibration checks against independent expectations or measurements. |
| Appearance/truth consistency | Calibration, silhouettes, depth residuals, label alignment, missing coverage, and dynamic occlusion; photometric scores alone cannot establish correctness. |
| Persistence | No duplicated/lost actors, destinations, queued effects, or mission state during detail transitions, restores, resets, and interrupted execution. |
| Learning value | Reproducible baselines, independent holdouts, separated training/evaluation families, and no privileged data leaking into measured observations. |
| Performance | Named hardware/workload profiles, bounded total memory and queues, complete training throughput, and cold/warm preparation and recovery costs. |
| Failure integrity | Worker, renderer, storage, timeout, and resource faults remain infrastructure errors; no fabricated Gym transitions or silently degraded products. |
| Asset/evidence integrity | Exact byte/closure verification, source-policy enforcement, atomic promotion, durable reference lifecycle, applicable correspondence reports, and complete installed runtime assets. |

For implementation PRs, run focused suites first, then:

```text
npm run lint
npm test
```

Run headless, parity, CLI/protocol, Python, UI, soak, packaging, and hardware gates
as required by the active workstream. Compare kernel/world/vehicle/sensor/control/
script/scenario/reward/physics behavior with the committed action-tape
characterization. Fixture deltas are reviewed simulator-contract changes, not
mechanical updates. Neither mocks nor skipped hardware tests establish an enabled
platform's support.

Maintain a record for every milestone with:

- A concrete outcome, accountable owner, and dependency list.
- Implementation status separately from feature activation and acceptance status.
- Schema/profile/provider versions, migration decisions, and reviewed fixture
  changes.
- Commit/PR and gate evidence, actual hardware/workload, and unresolved limits.
- Data/asset/model prerequisites and explicit optional dependencies.

No owners or completion dates are fabricated in this strategy. Assign them when
staffing each workstream. Track scientific/modeling uncertainty alongside
engineering delivery, especially learned actors, multiscale fidelity, physical
calibration, and transfer between observation profiles.

## Strategy decision log

### 2026-09-06 — Reorient toward an integrated living autonomy world

Replace the evidence-only product recommendation with three coordinated world,
visual, and learning/evidence programs. Select an Ithaca campus district as the
first flagship, consumer exploration plus workstation training as the hardware
strategy, and progressive measured-state → LiDAR → camera learning as the default.
Use dependency-based planning horizons without assuming a fixed small team.

Bring reactive actors, useful physical/environmental coupling, and visual assets
forward. Preserve scorecards, module comparisons, investigation, branching,
scenario search, minimization, datasets, and eventual assurance as supporting
capabilities across the product.

Incorporate the audited visual-layer plan, including early versioned identity,
isolation before materialization, bounded residency, transactional baking,
executable packages, the managed GPU bridge, installed runtime closure, and
correspondence/fidelity evidence. Supersede the earlier summary that placed
VIS-12 after preview visuals or made VIS-11 a camera prerequisite. The core needs
no Google assets, splats, or model service.

Record the dated local baseline and distinguish proposed features from completed
work. This revision changes strategy documentation only. Headless milestone
status, VIS/BR contract decisions and gates, runtime code, schemas, hashes, and
characterization fixtures are unchanged.
