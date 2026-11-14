# ZPB-09 work packages

Baseline: `2ed3c93`. The approved scope removes the production ROS/orchestrator
path, preserves historical metadata and reviewed native adoption, and accepts
local validation. Formal release, hosted, Jetson, and Linux SHM evidence are
deferred. Existing release artifact checks remain intact.

| Package | Deliverable | Status |
| --- | --- | --- |
| 09.1 | Historical inspection and adoption isolation | Complete |
| 09.2 | Native authoring and admission | Complete |
| 09.3 | Native controls and local consumers | Complete |
| 09.4 | Native sensor publication | Complete |
| 09.5 | Native capture and recording/preview | Complete |
| 09.6 | Transport and installer deletion | Complete |
| 09.7 | Runtime isolation and documentation | Complete |
| 09.8 | Local acceptance | Complete |

Packages are dependency-ordered. Focused checks precede lint and full JavaScript
verification. Packages 09.3–09.7 share the final full-suite gate. Immutable identity
fixtures and characterization tapes are not regenerated to accept changes.

## 09.1 — historical contracts

`server/interfaces/historical/{RunContracts,TopicCatalog,MsgShape,ProtobufBinding,
SensorTypes,PluginSensorType,SensorAdmission}.js` freeze the old normalization,
metadata, shape admission, and identity algorithms. They contain no runtime
transport. `server/headless/RunBundleInspection.js` selects historical integrity
verification; execution uses native `RunBundle.js::verifyRunBundle()`.
`verifyRunBundleIntegrityUsing()` injects historical route/sensor planners only
through that inspection entry point. `inspectRunPackageArchive()` injects the frozen byte verifier into archive inspection; worker/package admission imports only the native verifier. `server/interfaces/NativeRunMigration.js`
provides explicit reviewed adoption. `StorageService` loads frozen contracts for
old resolution/import/adoption and preserves old vehicle/plugin bundles.

Data: original bundle bytes, historical manifest/schema/catalog closures, native
adoption plans, immutable archive hashes, new native resource closures. Originals
are retained; execution does not select a legacy mode.

Evidence: migration/storage/route focus 36 passed; plugin focus 16 passed; lint
zero errors and three existing warnings; full suite 2,849 passed, 16 skipped.

## 09.2 — authoring and admission

`RunManifest.js::{createDefaultRunManifest,normalizeRunManifest}` write v13 only.
`NativeTopicCatalog.js` supplies native defaults and authority validation;
`NativeTopicContracts.js` remains the shape authority. `ProtobufRunBinding.js::
planProtobufRouteAdmission()` admits interface@2 against those shapes.
`SensorTypeRegistry.js`, `SensorWiring.js`, Config Topics, and plugin sensor UI
use exact `valueContract:{id,version}` bindings. Runtime plugin sensor factories
require sensor ABI 2; historical packages remain inspection inputs.

Data: v13 topic records, pinned native contract resources, interface@2 routes,
run/source binding maps, native sensor output declarations. No active `.msg`
registry or sensor `schema` field.

Evidence: authoring/migration focus 54 passed; regressions 191 passed; render
focus 13 passed; full suite 2,850 passed, 16 skipped; unchanged identity fixtures.

## 09.3 — controls and consumers

`ControlRuntime.ingestCommand()` is the managed actuator input. `SimulationKernel::
_applyQueuedInputs()`, `ScenarioRuntime.applyExternalTopic()`, and native route
inputs use SI command values with exact sequence strings. Requested/selected/
applied state, watchdogs, authority, disturbance expiry, and actuator limits stay
shared. `TopicContractRouter` validates native values and capture metadata;
`TransformRuntime`, `GoalPublisher`, and `LocalizationTruthPublisher` publish
native values. `CandidateOutputRuntime`, `AutonomyVisualizationModel`, bindings,
and execution profiles consume them. ROS units and stamped-command APIs are deleted.

Data: native command envelopes, producer/active signal paths, native poses,
transforms, odometry, boxes, lanes, and metadata. Only the characterization test
helper adapts historical taped commands into explicit native inputs.

Evidence: focused controls/goal/dataflow/scenario/contract checks 56 passed;
characterization and deterministic kernel replay match the committed tapes.

## 09.4 — sensor delivery

`SensorPublisher::{updateAsync,_deliverMessage,reset,dispose}` and
`deliverNativeSensorProduct()` retain bounded capture/delivery queues and owned
observations. Local telemetry, router delivery, and synchronous publication ports
receive the same native product. Invalid contracts and required plugin publication
failures remain visible. Opaque native packet routing is unchanged.

Data: queued capture frames, byte budgets, capture/delivery steps, sequence,
calibration/frame metadata, queue/drop/publication counters. Encoding worker/pool,
ROS encoded-frame caches, and codec ports are deleted. Historical encoding timing
counter fields remain inert to preserve deterministic characterization state.

Evidence: native publication, queue limits, payload retention, reset release,
packet bursts, strict failures, and sensor schedule tests.

## 09.5 — captures and logs

`NativeSensorProducts.js::buildNative*()` and `LidarProducts.js::buildLidarCapture()`
construct measured values directly. Browser devices and headless CPU/GPU/state
managers share them. The LiDAR hit iterator preserves its existing measurement
math and one noise/dropout pass. `SensorMessages.js` is deleted.
`DeviceTelemetrySignals`, `SensorProductPanel`, and `RecordingController` use
native products. `SFLogBatchEncoder.addUpdate()` retains packed arrays as base64
JSON markers inside an additive native-product envelope; record decoding restores
exact bytes and each update's metadata without changing SFLog v1. Python
`clip/messages.py::decode_camera_payload()` decodes native camera records only.

Data: owned Float32 point arrays, Uint8 image bytes, native intrinsics, per-capture
metadata, and `{__sflogNativeProduct:1,value,metadata}` records. Historical ROS logs
retain metadata/scalar inspection; their sensor preview is unavailable.

Evidence: native SFLog byte/metadata and malformed-input checks; Cosmos integration
9 passed with 2 existing optional skips; Python clip tests 29 passed, with all 155
Python tests passing in the final suite.

## 09.6 — infrastructure deletion

`ClientManager::{setup,preflight,reconnect,activateRoutes,publishProtobuf,closeRun}`
own native sessions only. Scene/runtime client callbacks and topic-client ports
are removed. Delete `ensureOrchestrator`, `Client`, `ProtobufChannel`, `TopicCodec`,
ROS encode workers, fallback `public/messages/`, and the demo ROS costmap publisher.
`install.sh` retains native onboarding and rejects retired flags; distribution
packaging drops the encoding worker entry. New run provenance has no orchestrator
catalog field.

Data: native run generation, transport status, required route declarations,
subscription sets, and synchronous publication acceptance.

Evidence: installer regressions, native lifecycle tests, packaging tests, and
`bash -n install.sh`.

## 09.7 — isolation and documentation

`tests/native-runtime-isolation.test.js` follows imports/re-exports/literal dynamic
imports with the installed Acorn parser from browser, Config, and headless roots.
It includes the server worker, runner, and external-session roots and rejects frozen inspection or retired runtime modules and retired endpoint
configuration. `tests/ui/zenoh-browser.spec.js` records and rejects requests to old
HTTP/WS ports, `.msg` assets, and old schema/publication endpoints. Protocol-only tests
are removed; behavioral sensor/control/recording tests use native values.
Integration, architecture, run-manifest, plugin, SFLog, and release docs describe
the current boundary and the explicitly deferred hardware evidence. Binding and
experiment UI describe native topics and external control.

Data: AST import graph, visited-file set, per-page retired request list.
Evidence: both import/deletion guards pass; real browser request guard is part of 09.8.

## 09.8 — local acceptance

Run lint/full JavaScript, focused headless/CLI/native gates, characterization,
parity, quick soak, Python, generated-Protobuf drift, and native Rust checks.
The production webpack build also enables native SDK WASM and corrects Next’s inline-asset generator. `Number.js` uses its existing ES-module Unit import. Turbopack cannot bind its build-worker port in this environment; `npm run build -- --webpack` passes. Browser acceptance uses the existing Metal renderer on macOS and an ES-module UI-test boundary. Schema authoring calls the browser fetch function with its correct receiver. UI checks use the current radio controls and a supported narrow desktop viewport.

Build the local macOS addon and exercise an independent native controller through
the pinned router. Run the real browser SDK/route/recovery gate and native browser
simulation. Record zero pending queues and clean reset/close behavior. Do not claim
Linux SHM, hosted, Jetson, full soak, or formal release acceptance from these results.

Current evidence: lint zero errors and three existing warnings; Python 155 passed;
all-language parity passed; quick soak passed; generated Protobuf check passed;
native Rust checks passed. The independent controller/headless router test passed,
including motion, reset, router-loss failure, and queue cleanup; its three Linux
CLI variants are explicitly skipped on macOS. Final JavaScript suite: 2,817 passed,
16 skipped, zero failures. Production webpack build passed. Real browser gate:
three passed, covering desktop/narrow desktop schema import, native control and
measured wheel data, binary isolation, reconnect fencing, resumed run identity,
worker teardown, and zero outbound entries/bytes after close. The final production
build and all three browser checks passed again after the UI/metadata fixes. The
corrected controller fixture uses `wheel_link` as its
mount and `odom` as its output frame; a focused regression asserts both sensor
capture frames resolve. Browser/native focused regressions: 68 passed.

Acceptance is complete for the approved local scope. No dependency locks,
generated Protobuf bindings, committed identity fixtures, or characterization
tapes changed. Formal release, hosted, Jetson, Linux-only CLI/SHM, and full soak
evidence remain deferred.
