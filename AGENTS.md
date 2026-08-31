# Repository Agent Guidance

These instructions apply to the entire repository and are intended for Cursor,
Codex, and human contributors.

## Headless simulation roadmap

Before changing simulation, worker, sensor, artifact, or Python integration
code, read:

1. [`docs/headless-simulation-plan.md`](docs/headless-simulation-plan.md)
2. [`proto/cev_sim/headless/v1/headless.proto`](proto/cev_sim/headless/v1/headless.proto)
3. [`docs/run-manifests.md`](docs/run-manifests.md)
4. [`docs/architecture.md`](docs/architecture.md)

PR 1 establishes the contract and characterization baseline. PRs 2–12 are
implemented. The roadmap implementation is complete; candidate acceptance now
requires the PR 12 hosted, soak, x64 NVIDIA, and Jetson ARM64 workflow evidence
recorded in the roadmap. Do not infer a PR 13 or pull distributed scheduling,
TLS/authentication, native WebGPU, or registry publication into maintenance.

Update the progress and decision log in
`docs/headless-simulation-plan.md` whenever a roadmap PR changes a contract,
hash, acceptance criterion, or milestone status.

## Architectural invariants

- JavaScript remains the single authoritative simulator implementation.
  Python is a Gymnasium/SB3 client, not another simulation kernel.
- Browser and headless execution must share fixed-step ordering, reset
  semantics, controls, scenarios, assertions, and state-sensor contracts.
- Shared kernel modules must import and run without `window`, `document`,
  `navigator`, RAF, React, DOM canvas, or WebGL.
- Simulation time uses integer nanoseconds. Wall time is for pacing,
  diagnostics, and watchdogs only.
- Workers accept immutable resolved `cev-sim.run-bundle` documents. Authoring
  and resolution stay in the existing MCP/REST control plane.
- Episode-semantic inputs determine `episodeHash`; resource limits and logging
  policy do not. Backend identity is semantic.
- One OS process isolates each environment. Infrastructure failures are not
  fabricated as Gymnasium truncation transitions.
- Unsupported sensor backends fail during capability validation. Never
  silently omit or substitute requested sensor products.
- State-only observations contain measured IMU/GNSS/wheel odometry and task
  signals, not oracle pose or perception leakage.

## Contract and fixtures

- Treat `proto/cev_sim/headless/v1/headless.proto` as the language-neutral
  source of truth. Preserve field numbers and use additive changes within v1.
- Keep generated bindings isolated and reproducible; do not hand-edit them.
- `tests/fixtures/headless/action-tape.v1.json` is the canonical PR 1 input.
  `characterization.v1.json` is generated from the current production
  `SimulationEngine`.
- Regenerate it with `npm run fixtures:headless`. Any fixture delta must be
  reviewed as a simulator-contract change, not accepted mechanically.

## Required verification

For every roadmap PR:

```text
npm run lint
npm test
```

Run focused suites first. Add and run headless, parity, protocol, CLI, soak,
and Python checks as their milestones introduce them. Changes to kernel,
world, vehicle, sensor, control, script, scenario, reward, or physics behavior
must be compared against the committed action-tape characterization.

## Codex/Sol reasoning level

- Default to Extra High for roadmap implementation and review.
- Use Ultra, when available, for PRs 2, 4, 7, and 11 and their integration
  reviews. If Ultra is unavailable, use Extra High and split work into smaller
  sessions.
- Use High only for bounded mechanical work after design is fixed, such as
  generated bindings, documentation, isolated option plumbing, or test
  fixture migration.
- Start a fresh context for each numbered PR and provide that PR's exact gate.
  Do not ask one context to implement the full roadmap.

## Repository conventions

- Preserve the current JavaScript/ES module style; do not introduce a
  TypeScript migration as part of headless work.
- Prefer small dependency-ordered changes and retain existing browser behavior
  unless the active milestone explicitly changes a versioned contract.
- Do not commit generated logs, local scenarios, model assets, credentials, or
  machine-specific benchmark output.
