# Headless release and CI gates

PR 12 completes the local headless roadmap with cross-platform parity,
performance and soak reports, hardware validation, and installable internal
artifacts. It does not publish to npm or PyPI and does not change simulation
semantics or versioned contracts.

## Developer gates

Run focused gates before the full repository checks:

```bash
npm run test:parity
npm run test:soak
npm run benchmark:headless
npm run dist:headless
npm run release:check
npm run lint
npm test
```

`test:parity` executes state-only and deterministic CPU-LiDAR cases through
the browser `SimulationEngine` adapter, direct headless session, CLI, UDS gRPC
supervisor, and Python client. Each case uses one resolved bundle and policy
action tape. Same-platform episode/trajectory hashes, tensor bytes, discrete
state, ordering, and final results must be exact. The generated
`cev-sim.headless.parity-report` v1 also contains a cross-platform semantic
projection with these tolerances:

| Value | Absolute tolerance | Relative tolerance |
| --- | ---: | ---: |
| Float64 kinematics/reward/task values | `1e-9` | `1e-9` |
| General Float32 sensors | `1e-6` | `1e-6` |
| CPU LiDAR range | `1e-4` | `1e-5 × expected distance` |
| CPU LiDAR incidence | `1e-4` | `0` |

LiDAR hit/semantic/instance identifiers and all other discrete values remain
exact. Rendered GPU output is validated only against the same declared
cev-sim/Chromium/ANGLE/GPU/driver stack; cross-GPU pixel equality is not a
release promise.

`test:soak` uses real UDS batches at 1, 8, 16, and 32 environments. It runs
five warm-up cycles and 25 measured reset/step/finalize cycles, verifies
artifact size/digests/readability, zero pending queues, worker exit, and no
shared-memory or staging residue. For each isolated environment process,
final-window RSS growth is bounded by `max(64 MiB, 10% of that process's
initial window)`; aggregate report fields sum the per-process allowances. A
separate one-environment UDS
probe in the same report verifies retained evaluation SFLogs, deterministically
sampled training SFLogs, discarded unsampled successful training SFLogs, and
failure-promoted training SFLogs.

`benchmark:headless` uses the same environment counts with action repeat one,
32 warm-up steps, 256 measured steps, and five repetitions. Its
`cev-sim.headless.benchmark-report` v1 records fixed steps/s, policy
transitions/s, reset and policy p50/p95/p99 latency, supervisor and worker CPU
microseconds, peak/steady RSS, heap, evaluation-SFLog throughput, teardown,
and queue cleanup. Supply `--baseline <file> --promote-baseline` to compare and
promote a runner-local baseline. The gate requires at least 80% throughput,
at most 150% p95 policy/reset latency, and RSS no greater than baseline plus
`max(64 MiB, 10%)`.

Quick local diagnostics are available as `npm run test:soak:quick` and
`npm run benchmark:headless:quick`; they are not release evidence.

## CI lanes

| Workflow | Trigger | Evidence |
| --- | --- | --- |
| `CI` hosted CPU | Pull requests and main pushes | Lint, complete Node tests, Next build, fixture and generated-Protobuf drift, Python unit matrix |
| `CI` cross-platform headless | Pull requests and main pushes | Ubuntu/macOS headless, CLI, CPU LiDAR, all-language parity, distribution build and clean-install smoke |
| `CI` parity aggregation | Pull requests and main pushes | macOS/Linux semantic projection comparison |
| `Headless nightly soak` | Tuesday/Friday 04:17 UTC and manual | Full reset/memory/process/log soak and 1/8/16/32 benchmark with runner baseline |
| `Headless rendered-sensor hardware` | Wednesday 05:43 UTC and manual | Dedicated x64 NVIDIA and Jetson ARM64 reports; rendered tests are capability-gated |
| `Internal headless candidate` | Manual on main | Complete gates plus coordinated npm/Python artifacts and checksums |

The public-repository self-hosted runners accept only default-branch scheduled
or manual jobs. They hold no release credentials and must be isolated from
sensitive networks. Pull-request workflows never target them. Nightly soak and
benchmark work uses `cev-sim-gpu-x64`; its promoted baseline cache is namespaced
by the physical runner name as well as OS and architecture.

## Evidence status

The 2026-08-31 local macOS ARM64 implementation run passed all-language parity,
the full 1/8/16/32 soak and benchmark, 592 Node tests, 42 Python tests, the
production build, package clean-install checks, generated-Protobuf checks, and
fixture stability. Two rendered-sensor tests were skipped because no production
Chromium GPU endpoint was configured for this task. The hosted macOS/Linux
aggregate and both dedicated hardware reports remain mandatory external
candidate evidence; the roadmap does not claim that they have run yet.

## Internal artifacts

`npm run dist:headless` stages a release-ready package without changing the
private browser application package. It emits:

```text
cev-sim-0.1.0.tgz
cev_sim-0.1.0-py3-none-any.whl
cev_sim-0.1.0.tar.gz
release-manifest.json
SHA256SUMS
```

The npm tarball contains the CLI, protocol, headless/logging/storage server
modules, required application modules, focused documentation, and license. It
excludes browser assets, tests, persisted data, and logs and must stay below
10 MiB. The Python wheel/sdist include generated Protobuf stubs and
`py.typed`; `twine check` runs during the build. `npm run dist:verify` performs
clean installation of the npm tarball, wheel, and sdist.

The manual candidate workflow uploads these files as one GitHub Actions
artifact for 90 days. Because the repository is public, the artifact is a
distribution boundary, not a confidentiality boundary. A teammate downloads
the artifact while signed into GitHub, verifies it, and installs one or both
packages:

```bash
npm run artifacts:install -- --dist /path/to/download --verify-only
npm run artifacts:install -- --dist /path/to/download --node-prefix "$PWD/.cev-sim"
npm run artifacts:install -- --dist /path/to/download --python-venv "$PWD/.venv"
```

The installed executable is `.cev-sim/node_modules/.bin/cev-sim`. A Python
environment can launch that explicit path with `SupervisorLaunch`.

Registry publication remains disabled. A future registry release should use
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/) with
GitHub OIDC and provenance, not long-lived tokens.

## Compatibility

| Component | Candidate version | Compatibility |
| --- | --- | --- |
| npm CLI/worker | `cev-sim@0.1.0` | Node `>=22.14`; Linux/macOS x64/ARM64 |
| Python adapter | `cev-sim==0.1.0` | Python `>=3.10,<3.14`; pure Python wheel and sdist |
| Headless protocol | `1.2` | Server accepts protocol `1.0`–`1.2`; protocol 1.1/TCP tensors remain inline |
| Run manifest / bundle | `9` / `1` | Unchanged by PR 12 |
| SFLog | `1` | Unchanged by PR 12 |

`release:check` enforces coordinated root package, plugin, MCP, Python project,
and Python runtime versions; the Apache-2.0 license; protocol 1.2; generated
stub presence; and byte-for-byte PR 1 characterization stability. With
`--dist`, it also verifies artifact sizes and SHA-256 records.
