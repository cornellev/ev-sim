# Deterministic Branch Replay Plan

## Status

- **Phase:** Contract review
- **Implementation:** Not started
- **Scope:** CPU headless policy and managed-reference recordings, CLI, REST,
  and the Replay workspace
- **Last reviewed:** 2026-09-06

Implementation must not begin until this contract is approved. This is a
separate maintenance workstream from the completed numbered headless roadmap;
it does not create a PR 13.

## Audit findings

The repository has two existing replay paths:

- SFLog playback reconstructs recorded telemetry for inspection.
- `cev-sim replay` reruns a policy action tape from reset.

Neither path supports branching from an executable checkpoint. SFLog
checkpoints contain selected signal values, omit heavy state, and cannot
restore every mutable simulator component. The first branch implementation
therefore reconstructs state by deterministic execution from reset.

Additional gaps found during the audit:

- Ordinary runs do not retain a complete ordered execution journal.
- Signal age and staleness currently use wall time, so time spent paused for a
  live intervention can affect scripts while simulation time is unchanged.
- Existing canonical state projections omit future-relevant state such as
  actuator queues, script RNG progression, and policy observation bookkeeping.
- Existing simulation hashes round finite numbers to six decimal places.
  Exact branch proof needs a separate lossless digest without changing those
  established hashes.
- Runtime provenance permits a missing Git hash. Exact replay needs a required
  executable-runtime fingerprint.

## Initial scope

Version 1 supports newly recorded CPU headless runs:

- Candidate-authority policy runs driven by normalized policy actions.
- Managed-reference runs using the existing deterministic reference or script
  controller.
- State sensors and deterministic CPU LiDAR.
- Recorded future-input edits and explicit-step live takeover.
- CLI execution, same-origin REST control, and Replay workspace integration.

The following are deferred:

- Browser-origin execution capture.
- GPU sensor runs.
- Realtime keyboard, joystick, or external-controller driving.
- Changes to the resolved world, scenario, scripts, sensors, profiles, seed,
  backends, episode limits, or control authority.
- Direct restoration of serialized kernel checkpoints.
- New public Python or gRPC branching APIs.
- Search, counterexample minimization, and distributed scheduling.

## Contracts and invariants

### Versioned signal time

Advance the run manifest to version 11 with a required
`clock.signalTimeProfile`:

- `simulation-v1` is the default for new manifests and is required for replay
  capture and branching.
- `legacy-wall-v1` preserves the behavior of migrated older documents.

Under `simulation-v1`, authoritative signal timestamps, age, and staleness
derive from integer simulation nanoseconds. Waiting between commands does not
advance the clock. Preserve the existing stale-threshold comparison.

Bindings, compiled scripts, scenario predicates, and assertions must use one
authoritative signal-access view. Logging state, wall durations, renderer
diagnostics, pacing data, and session identifiers remain available for
inspection but cannot affect authoritative execution.

### Portable replay evidence

Define these versioned, language-neutral JSON documents:

| Contract | Required content |
| --- | --- |
| `cev-sim.replay-recording` v1 | Exact bundle-byte digest, established semantic identities, complete episode specification, execution mode, runtime fingerprint, journal/proof chunk checksums, verified coverage, and final outcome. |
| Replay journal v1 | Ordered external input attempts, normalized policy actions, exact typed payloads, admission/application boundaries, and routing outcomes. |
| Replay proof v1 | Reset and completed-boundary digests, subsystem digests, established trajectory hashes, and policy observation/reward/terminal evidence. |
| `cev-sim.branch` v1 | Parent recording identity, fork boundary, expected proof, continuation mode, and supported future-input edits. |
| Branch result v1 | Parent and child identities, prefix verification, actual continuation journal identity, outcome, artifacts, and metric comparison. |

The journal records inputs that enter the simulator, including attempts later
rejected as stale or invalid when the attempt changes authoritative runtime
status. Requests rejected before admission do not enter the journal.

External ingress is distinct from internally generated sensor, script, and
reference-controller activity. Replay injects external ingress once; internal
activity executes normally and is verified. Producer identity and existing
input ordering are preserved.

Policy actions retain their exact Float32 bytes. Topic inputs use lossless
typed payload encoding. Integer counters and times are decimal strings at JSON
boundaries and are rejected before unsafe conversion.

### Verification and identity

Keep the existing `episodeHash` and `trajectoryHash` algorithms unchanged.
Add a domain-separated lossless replay digest with UTF-8 key ordering, explicit
type tags, exact finite-number representations, and exact binary payloads.

The replay verification projection covers:

- Kernel clock, module state, accepted inputs, and pending queues.
- Topic-router status and ordering state.
- Vehicle, physics, collision, and contact state.
- Requested, selected, applied, achieved, pending, and delayed controls.
- Script runtime state and RNG progression.
- Scenario triggers, active effects, outcomes, and metric accumulators.
- Sensor RNG, schedules, queued deliveries, latest measurements, and health
  counters that affect later execution.
- Transform and localization publisher state.
- Assertions and authoritative signals.
- Policy step, previous reward progress, observation generations, and terminal
  bookkeeping.

These exports are verification inputs, not restore APIs.

Exact replay requires a runtime fingerprint covering the executable simulation
dependency closure, Node version, platform, architecture, relevant CPU
identity, and backend versions. Exact verification applies only within that
fingerprint. Cross-platform comparisons retain the established semantic
tolerances and are not classified as exact branch reproduction.

Recording and branch identity exclude timestamps, filesystem paths, logging
policy, resource limits, and execution-attempt identifiers. Each attempt still
gets a distinct operational ID. A live branch's final identity includes its
actual recorded continuation.

Branch annotations and progress reporting must never enter authoritative
signals or hashes.

### Fork boundary

A fork occurs after completed boundary `F` and before inputs for the next
step.

- Managed runs allow every completed fixed-step boundary.
- Policy runs allow reset and completed policy transitions only; an
  `actionRepeat` interval cannot be split.
- Replay selects a recorded boundary index and displays its exact step and
  simulation time. It must not derive a boundary from interpolated poses or
  rounded SFLog timestamps.
- Terminal and unverified boundaries are ineligible.

The branch worker reconstructs the parent from reset through `F` and verifies
every recorded proof before it accepts an intervention. It must not reset,
finalize, rebuild observations, or otherwise introduce an extra lifecycle
boundary at `F`.

Pending sensor deliveries, actuator delays, scripts, accumulated metrics,
reward history, episode bounds, and all other authoritative state continue
unchanged across the fork.

### Continuation modes

Recorded mode supports:

- Replacing policy actions after `F`.
- Inserting, replacing, or deleting declared external-topic events after `F`.
- Retaining all unedited future external inputs at their original boundaries.

Internally generated reference commands continue to execute normally.

Live mode discards the parent's future external inputs after `F`. Each accepted
submission advances exactly one policy transition or one managed fixed step.
Policy runs require an action. Managed runs accept declared topic inputs while
preserving reference authority. With no submission, simulation time remains
unchanged.

If recorded policy input ends before a terminal transition, finalize the child
as interrupted. Never invent neutral actions, extend bounds, or silently hold
an action.

## Smallest PR sequence

### BR-1 — Contract and characterization

Deliver:

- This reviewed plan and machine-readable schemas for replay recordings,
  journals, proofs, branch specifications, and branch results.
- Identity rules, timing migration, failure matrix, and acceptance fixtures.
- Documentation corrections distinguishing SFLog inspection checkpoints from
  executable simulator state.
- A decision-log entry in `docs/headless-simulation-plan.md` without extending
  the numbered roadmap.

Gate:

- Explicit contract-review approval.
- No production behavior changes.
- Focused schema tests, full tests, and lint pass.

### BR-2 — Versioned deterministic signal timing

Deliver:

- Run-manifest v11 and its migration rules.
- The shared simulation-clock signal-access contract.
- Separation of operational diagnostics from authoritative script inputs.
- Browser/headless parity and deterministic pause behavior.

Gate:

- Different wall delays cannot change managed outcomes.
- Legacy timing behavior remains available through `legacy-wall-v1`.
- Hash and characterization changes receive explicit contract review.
- Focused suites, `npm run lint`, and `npm test` pass.

### BR-3 — Replay capture and no-op proof

Deliver:

- Opt-in replay capture for direct policy and managed-reference runs.
- Runtime fingerprints, ordered input journals, lossless boundary proofs, and
  bounded chunk persistence.
- Replay eligibility inspection and a no-op verifier.
- Core artifacts and SFLog attachments sufficient for later branching.

Gate:

- Full no-op replay reproduces the parent trajectory hash, lossless proofs,
  policy observations, rewards, and terminal outcome.
- Direct and isolated-worker execution produce equivalent evidence.
- Missing, reordered, or corrupt journal/proof chunks fail verification.

### BR-4 — Branch execution and lifecycle APIs

Deliver:

- Recorded input edits and explicit-step live sessions.
- Independent branch-worker ownership, atomic output, and lineage.
- CLI verification/branch commands and same-origin REST preflight, create,
  status, advance, finalize, and cancel operations.
- Metric comparisons using existing metric definitions.

Gate:

- Prefix verification always completes before intervention.
- Parent and sibling branches remain isolated.
- Idempotency, cancellation, crash, timeout, resource-limit, and artifact
  failure tests pass without fabricated simulator transitions.

### BR-5 — Replay workflow and release gates

Deliver:

- Replay eligibility explanations and exact boundary selection.
- Recorded-edit and live-step controls.
- Progress, cancellation, parent/child navigation, trail overlays, and metric
  deltas through existing Replay and spatial-view components.
- CI, package, import/export, and operator documentation.

Gate:

- End-to-end recorded and live branches pass.
- Exported/imported evidence remains branchable.
- Installed CLI, browser UI, compatibility, parity, and branch-soak gates pass.

## Public interface changes

- Existing run entry points gain operational `replayCapture: true`; the CLI
  exposes `--record-replay`.
- Managed queue admission persists the replay-capture request.
- CLI adds replay verification and
  `branch --source <source> --spec <branch> --output <directory>`.
- Live CLI continuation uses JSONL input.
- REST operations live under `/api/replay/branches` and accept catalog IDs or
  validated artifact references, never caller-selected server paths.
- Advance requests contain a request sequence and expected boundary. Exact
  retries return the recorded response; stale or conflicting requests fail
  without advancing.
- Branch workers use existing supervisor capacity and one process per
  environment.
- Protobuf v1 and protocol 1.2 remain unchanged. Python receives compatibility
  coverage for v11 bundle transport but no branch-specific RPC API.

## Migration policy

- Never rewrite archived SFLogs, resolved bundles, results, or baselines.
- Existing v10 bundles remain verifiable in their original form and retain
  legacy timing behavior.
- Older authoring documents normalize to manifest v11 with
  `legacy-wall-v1`. Moving to `simulation-v1` is explicit and produces newly
  resolved semantic, episode, and trajectory identities.
- Existing workers reject v11 instead of silently ignoring its timing field.
- Legacy logs and tapes remain inspectable through existing replay paths but
  cannot become verified branch inputs through inferred backfill. Re-record
  them under the new contract.
- Keep SFLog v1 and run-bundle v1. Store replay evidence through additive
  chunked attachments and sidecar lineage.
- Preserve existing hash algorithms. The lossless replay digest is additive.
- Fixture deltas are reviewed contract changes, never mechanical updates.

## Persistence policy

Replay capture begins at reset and writes bounded, checksum-protected chunks
independently of telemetry sampling. Replay evidence is required when capture
is requested: a dropped journal entry or evidence-write failure fails that
operation.

Completed branch artifacts contain the effective journal from reset so a child
can be branched again without loading every ancestor. Parent identities remain
lineage references.

Logging policy still controls SFLog retention. Standalone replay evidence is a
core artifact. Publish completed output directories atomically. A browser
branch becomes successful only after log import and lineage registration.

Persist operation status and request identity. After a server restart, mark
active branches interrupted; do not automatically resume an uncertain
execution. Completed children remain executable if parent files are later
removed, while parent navigation reports that lineage evidence is unavailable.

## Failure boundaries

| Failure | Required behavior |
| --- | --- |
| Invalid schema, edit, authority, fork boundary, or backend | Reject before advancing; preserve an already valid live session. |
| Missing/corrupt evidence or runtime-fingerprint mismatch | Reject before prefix execution. |
| Prefix divergence | Stop at the first mismatch and report boundary, subsystem, expected digest, and actual digest. Accept no intervention. |
| Runtime determinism violation | Abort verification; never report a successful branch or ordinary scenario failure. |
| Semantic terminal transition | Preserve existing termination, truncation, reward, and result rules. |
| Worker crash, timeout, OOM, queue overflow, or uncertain IPC | Fail the attempt, terminate its worker, require a fresh attempt, and return no fabricated transition. |
| Lost client response | Retrieve acknowledged status or retry idempotently; never redispatch an uncertain action blindly. |
| User finalization before terminal | Finalize as interrupted and retain verified coverage. |
| Cancel, idle expiry, or shutdown | Release worker and staging resources and retain operational status. |

Live sessions use a five-minute idle timeout in addition to existing episode
and resource ceilings.

## Acceptance tests

1. No-op branches at reset, middle, and final nonterminal boundaries reproduce
   parent proofs and outcomes for policy action repeats of one and greater than
   one, managed-reference execution, noisy state sensors, and CPU LiDAR.
2. Forks preserve queued actuator commands, delayed sensor delivery, RNG
   progression, fired triggers, persistent script state, assertion history,
   metric accumulators, and observation `is_new` bookkeeping.
3. Different wall delays, upload latency, pacing, and logging policy produce
   identical authoritative identities and replay proofs.
4. An intervention matches its parent exactly through `F`, changes only the
   declared future input, and preserves control authority.
5. Input tests cover same-boundary ordering, multiple topics, rejected/stale
   commands, typed payloads, duplicate requests, malformed inputs, and queue
   exhaustion without duplicating internal inputs.
6. Integrity tests detect sub-six-decimal numeric changes, altered bundle
   bytes, missing/reordered chunks, runtime/backend mismatches, unsupported
   versions, and corrupt fork expectations.
7. Failure tests cover parent/sibling isolation, repeated fresh-process runs,
   cancellation during prefix and continuation, worker death, disk/import
   failure, restart reconciliation, and absence of orphan processes or false
   terminal transitions.
8. UI tests cover eligibility explanations, boundary snapping, recorded edits,
   explicit live stepping, reconnect/retry, branch-of-branch, imported
   evidence, parent/child overlays, differing horizons, and `null` metrics.
9. Every PR runs focused tests, `npm run lint`, and `npm test`. Before release,
   also run Python compatibility/protocol checks, macOS/Linux parity, a branch
   soak, and clean-install distribution verification.

The existing PR 12 hosted, soak, x64 NVIDIA, and Jetson ARM64 evidence remains
a separate candidate-acceptance obligation and is not satisfied by this plan.
