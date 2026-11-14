# ZPB-08 work packages

The user approved this sequence on 2026-11-13. Complete ZPB-08 before starting
ZPB-09 deletion. A package marked in progress is not accepted implementation.

| Package | Files and methods | Data and resulting behavior | Status |
| --- | --- | --- | --- |
| 08.1 Native envelopes | `NativeTopicContracts.getNativeTopicContract`, `ProtobufMapping.compileMapping/applyInboundMetadata`, `ProtobufRouteRuntime.receive`, `protobufInputContractHash` | Add `cev.path@1`, opt-in `cev.control-command@2.leaseId`, bounded typed equality checks, exact uint64 sequence, authored run/frame/capture metadata, replay fencing | Implemented; focused tests pass |
| 08.2 Native consumers | `NativeTopicCatalog`, `ConfigPage`, `BindingsPage`, `BindingRuntime`, `SensorWiring`, `SensorInheritance` | Select explicit contract pairs, publish through the router, preserve native sensor outputs and metadata | Implemented; native selectors, bindings, sensor wiring, and graph metadata port verified |
| 08.3 Plugin ABIs | `PluginDocument`, `PluginRunSession`, `PluginTopicRuntime`, `PluginSensorContract`, `PluginSensorAdapter`, `SensorAdmission` | Explicit `topicAbi: 2` and `sensorAbi: 2`; preserve old package hashes; native points retain heavy/control restrictions | Implemented; native capture and managed/supervised plugin tests pass |
| 08.4 Scenario v2 | `ScenarioDocument`, `ScenarioRuntime.applyExternalTopic`, scenario UI, `SimulationKernel._applyQueuedInputs` | `external-topic` uses the shared `ControlRuntime`, preserving old scenario v1 normalization | Implemented; actor/deadline tests pass; historical v1 inspection retained |
| 08.5 Visualization | `CandidateOutputRuntime`, `AutonomyVisualizationModel`, `AutonomyOverlay`, `GoalPublisher`, `TransformRuntime`, `LocalizationTruthPublisher`, router log metadata | Direct native geometry; capture-time truth alignment; path rendering; exact sequence/frame metadata | Implemented; real browser native path verified |
| 08.6 Reviewed adoption | `NativeRunMigration.plan/validate/apply`, `StorageService`, `NativeGraphCompiler`, existing REST/MCP adoption endpoints | Capture the bounded graph/binding/scenario/plugin closure; explicitly repair ambiguous fields; compile children first; create immutable replacements; archive originals; CAS manifest last | Implemented; complete closure, source fences, archives, and CAS tested |
| 08.7 Ownership service | `ControlOwnershipService.acquire/bindRun/renew/release/status/expire`, `controlOwnershipRouter`, `ControlOwnershipGuard`, `ControlRuntime` | Bounded lease/target maps, hashed bearer credentials, actual-run binding, command guards before arrival/application, explicit loss and safe stop | Implemented; HTTP, credential, expiry, and watchdog tests pass |
| 08.8 Browser lease watch | `BrowserSimService`, `BrowserSimBridge`, `RunSessionController`, `TopicInputQueue`, `simcontrol` | Prepare paused, bind actual run ID, 250 ms leased watch, local watchdog, block automatic resume on loss; ordinary bridge remains 5 seconds | Implemented; real browser expiry and explicit sequence-1 rebind pass |
| 08.9 Supervised headless | `HeadlessSupervisor`, `HeadlessExternalSession`, worker IPC, `WorkerHandle`, `HeadlessExperimentService`, `headlessRouter` | Reuse existing isolated worker/resources/finalization; prepare paused; run-fenced ownership updates; local watchdog; explicit lifecycle endpoints | Implemented; installed Jetson motion, expiry, rebind, and log finalization pass |
| 08.10 Examples and upstream | `examples/interfaces/`, separate `auto-onboarding-fa26` checkout, upstream `autonomy.proto`, `runtime/sim.rs`, `runtime/node.rs`, `main.rs`, `simcontrol` | Command field 7 carries lease ID; direct native schema import/adoption; launcher maintains lease and immutable RunInfo; browser/headless selection; retain calibration and deadlines | Implemented; exact local upstream/SDK commits build and pass Rust tests on macOS and Jetson |
| 08.11 Installer | `install.sh`, pinned Zenoh installer/config, existing artifact helpers, `protobuf-probe.mjs` | Install the pinned router instead of onboarding orchestrator; independent native probes | Implemented; pinned router and verified installer run on macOS and Linux ARM64 |
| 08.12 Cutover and acceptance | `RunManifest`, execution gates, `App.js`, docs, fixtures, workflows | Writer/execution v13; historical inspection and explicit migration; disable automatic orchestrator activation; real installer-to-driving browser and Linux headless evidence | Implemented and accepted locally; v13/scenario-v2 cutover, native consumers, browser and installed Linux gates pass |

## Accepted operational contract

- Ownership applies to onboarding. Generic external `control-command@1` and
  existing policy control remain supported by their native contracts.
- Lease lifetime is 750 ms, renewed explicitly every 250 ms. Bridge heartbeats,
  status reads, and command traffic do not renew a lease.
- Onboarding commands expire within 300 ms of simulation capture time.
  Observe cannot actuate. Drive-test is bounded to 0.1 m/s, 0.1 rad, and one
  simulation second.
- Rust publishes the same immutable RunInfo every 500 ms. Consumers expire
  RunInfo and node status after 1.2 seconds of wall time. RunInfo repetition
  keeps the same header so equality checks retain their existing meaning.
- Only the actual simulator run ID identifies a run on the wire. Lease IDs,
  bearer credentials, endpoints, and wall deadlines remain operational and
  do not enter run/episode semantic identity.
- The authorized upstream base is
  `cornellev/auto-onboarding-fa26@a2e2c39023e75774a271a0cd1b1781bd2444c7cd`,
  available at `/Users/jgrimminck/Coding/cev/freshmen-onboarding`. Work uses a
  separate writable checkout. Record the final upstream commit in acceptance
  evidence; do not invent a published simulator revision for its dependency.

## Verification record

`npm test -- --test-timeout=120000 --test-concurrency=4` passes 2,849 tests
with 16 existing skips. `npm run lint` has no errors and three existing React
hook warnings. The production build passes. The Python suite passes all 154
tests. Native parity passes state-only, CPU LiDAR, road geometry v2, and asset
assembly cases across browser, direct headless, CLI, gRPC, and Python. The quick
soak passes artifact/finalization, bounded queues/RSS, shared memory, and worker
cleanup. Current action-tape characterization passes; historical fixtures remain
unchanged. New straight/curve planner bundles use v13/scenario v2.

The final browser Rust drive uses actual run
`run-20261114T182617558Z-9c5ae2c7-4db8-470b-949c-71025ea9537b`.
The browser path/expiry/rebind check uses
`run-20261114T182735091Z-92a873f9-c894-4f32-8e40-4aa51a1cfcbe`:
three native path points render, expiry pauses, a new owner resumes explicitly
with sequence 1, and rebinding does not automatically resume.

The authorized Linux host is `cev@thor.tail4ccb95.ts.net` (Jetson ARM64).
The final checksum-verified installed npm package is
`d0c53fdff23d6c90d3117553cd4ac267eea9f3d1dffc49e3f26adea6f1183ad9`.
Its release manifest declares writer v13. The separately verified ARM64 native
addon is `7d201be1099ea0f1dbd37c335d53e73652244ff70403f9163b971e6e3bf33b95`
(N-API 8, Zenoh 1.10.2, glibc <= 2.31). Installed Rust/headless driving passes
with actual run `run-8540af97-2062-4ae2-9d31-c9ec243fefca`.
The local release has no paired native transport release records; the x64/ARM64
release gate remains intact and is separate ZPB-09 acceptance.

Upstream commit `071675cd26a285146872400fab1c97356dd07956` pins SDK commit
`fb1f0ef6ed54276332e137fee5ef59a96da1965e`. Both Rust builds use those exact git
revisions, including on the Jetson, without a Cargo patch override. Normal Rust
and HTTP privacy tests pass. Student algorithm acceptance remains ignored.
Both commits are local review artifacts, not published GitHub revisions; publish
the SDK before upstream Cargo users fetch its pin. See
[the interface examples](../examples/interfaces/README.md).

The installed headless live ownership check uses
`run-727093b8-cdda-4a50-b432-d3f80d3f4d1f` and finalizes
`log-20261114T184303Z-znskt4`: motion is observed, expiry freezes the step,
rebinding keeps the same run paused, sequence 1 works for the new owner, and
the verified SFLog imports with the actual run/resolved identity. Lifecycle and
lease IPC share one serialization chain; finalization waits for a stop
acknowledgement, and late ownership updates cannot replace terminal state.
Installed direct/supervised CLI motion and SIGINT cleanup pass. Native SHM
retention, mixed consumers, exhaustion, reset, required-SHM rejection, and
network fallback are tested separately from the onboarding connection, which
uses preferred SHM and reports network fallback on this router.

The installed Linux native integration suite passes all six tests, including
independent controller driving, installed CLI direct/supervised/SIGINT runs,
and the separate SHM/network failure checks. Temporary acceptance servers and
routers are stopped after verification; artifacts remain under the isolated
`/tmp/zpb08-acceptance` directory on the authorized host.
