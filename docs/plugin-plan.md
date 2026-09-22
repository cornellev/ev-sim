# Simulator Plugin Roadmap

This document is the implementation authority for simulator plugins. The
`PLG-*` program is separate from the headless, visual-layer (`VIS-*`), and
environment-editor (`ED-*`) programs. A plugin milestone does not extend or
renumber any of those roadmaps.

The repository root `plugin.json` describes cev-sim's agent tooling plugin.
Simulator plugin packages have an independent `plugin.json` inside each
package directory and use the contracts below. Package authors should start
from [`docs/plugin-api.md`](plugin-api.md) rather than this roadmap.

## Status

| Milestone | Implementation | Verification | Merge status |
| --- | --- | --- | --- |
| PLG-01: foundation, isolated registries, verified packages | Complete in working tree | Verified | Unmerged |
| PLG-02: resolved selection and deterministic unit execution | Complete in working tree | Verified | Unmerged |
| PLG-03: systems and expanded simulator capabilities | Complete in working tree | Verified | Unmerged |
| PLG-04: editor/UI integration and distribution acceptance | Complete in working tree | Verified | Unmerged |
| PLG-05: custom range-image sensors and native packet products | Complete in working tree | Verified | Unmerged |
| PLG-06a: portable plugin files and classic PCAP artifacts | Complete in working tree | Verified | Unmerged |
| PLG-06b: supervisor-owned live UDP transport | Complete in working tree | Verified | Unmerged |
| PLG-07: custom sensor authoring and UI | Complete in working tree | Verified | Unmerged |

Only a merged change may be marked merged. A milestone is verified only when
all of its acceptance commands and evidence entries are present in this
document.

## Locked contracts

### Compatibility boundary

PLG-02 preserves run-manifest v11, run-bundle v1, visual-script artifact v3,
all Protobuf fields, plugin-free hashes, and fixed-step ordering. Manifest v11
admits an optional exact plugin selection. Effective selections resolve to a
portable package closure and activate `world-bound-plugins@1`; plugin-free
runs retain `world-bound@2` byte-for-byte. Older manifest versions reject
plugin fields. PLG-03 keeps those version numbers and identity algorithms. It
folds systems, topics, and overlay spawn into the existing `"scripts"` phase
instead of adding phase names.

### Resolved selection and identity

`manifest.plugins` is `{ enabled, artifacts }`; every artifact lock contains
`pluginId`, exact `expectedHash` (`packageHash`), and sorted granted
capabilities. Resolution emits sorted `resolved.plugins` records containing
`pluginId`, `version`, `packageHash`, `runtimeHash`, and capabilities; matching
`resolved.pluginPackages`; and `dependencyHashes.plugins`. Bundle verification
checks the exact manifest lock, package bytes, resolved record, dependency
record, canonical order, and every transitive artifact requirement.

The plugin semantic projection contains only sorted
`{ pluginId, version, runtimeHash, capabilities }` records. Package/UI-only
changes alter full bundle identity but retain simulation and episode identity;
runtime, grant, artifact, or plugin state changes are semantic. Plugin state,
RNG streams, committed plugin-owned signals, system snapshots, topic queues,
command sequences, and plugin-owned overlay records are included in canonical
state only for effective plugin runs. Overlay, queue, and system snapshots are
not part of the semantic hash.

Packages are trusted local JavaScript. Static import validation, exact-byte
verification, and capability-checked facades reduce accidental authority;
they are not a hostile-code sandbox. Registration is definition-only. Episode
state belongs to unit instances and prepared system instances.

### Package document

`app/plugin/PluginDocument.js` owns `cev-sim.plugin` API 1. A package has a
lowercase dotted ID, a SemVer version, a cev-sim engine range, runtime and
optional UI entries, required capabilities, fixed-port unit descriptors,
optional system descriptors, and optional editor assets. Unknown fields are
rejected. Plugin IDs under `cev` are reserved. Unit types and system IDs must
start with the package ID followed by a dot.

Unit ports use the concrete `ProgramTypes.js` vocabulary. Plugin API v1
excludes `generic`, dynamic port layouts, custom value types, and
program-level input/output roles. Settings target authored `state`; the
built-in `storedData` mechanism is not public. Systems validate as
`{ id, phase: "scripts", priority, stateVersion }`. Contribution is
`{ id, create }` and `create()` returns a synchronous instance with
`prepare`, `reset`, `onStep`, `getDeterministicState`,
`hydrateDeterministicState`, `finalize`, and `dispose`.

### Package resource and hashes

A portable package is `cev-sim.plugin-package` version 1 with sorted file
records containing a relative path, byte size, SHA-256, base64 encoding, and
the exact bytes. `plugin.json` bytes are authoritative and are parsed during
verification.

All aggregate hashes use SHA-256 over domain-separated JCS projections:

| Hash | Projection |
| --- | --- |
| `packageHash` | Domain/version plus every sorted `{ path, sizeBytes, sha256 }` record, including raw `plugin.json` |
| `runtimeHash` | Domain/version, the parsed manifest without `entry.ui` or `editor`, and the exact runtime-closure file records |
| `uiHash` | Domain/version, UI entry/editor metadata, and the union of UI-closure files and declared assets |

Records use UTF-8 byte ordering. A shared runtime/UI module belongs to both
closures. Manifest whitespace changes only `packageHash`; UI code and editor
assets change package/UI identity; runtime code, capabilities, defaults,
ports, and all other retained manifest fields change `runtimeHash`.
Enumeration order, installation location, timestamps, absolute paths,
library revisions, and generated Node package markers do not affect identity.

### Module graph

Acorn 8.15.0 parses every packaged `.js`/`.mjs` file as an ECMAScript module
at a fixed language level. Explicit relative imports and re-exports may use
contained parent traversal. Absolute paths, bare packages, URLs,
query/fragment suffixes, backslashes, encoded path tricks, root escapes,
missing or case-mismatched targets, duplicate/case-fold-colliding paths,
dynamic import, top-level await or async iteration, JSX, import attributes,
and unsupported formats are rejected. Runtime edges into the UI entry or
editor assets are rejected. Unused JavaScript receives the same validation.

### Registry and unit ABI

`BlockRegistry` privately owns its map. Snapshots are frozen copies with
`builtin` ownership or frozen `{ pluginId, version, runtimeHash }` ownership.
Built-in re-registration of the identical type/class/owner is idempotent;
all conflicting registration and every repeated plugin contribution fail.
Sealed registries reject changes. Seeded registries never share maps. The
legacy wrappers use a plugin-disabled default registry.

The registration API is frozen and contains exactly:

```text
pluginApi, plugin, capabilities, UnitBlock, BlockOutput, ports,
contributeUnit, contributeSystem, contributeSensorType, log
```

Capabilities are a frozen, sorted array. The public `UnitBlock` fixes its
ports after the synchronous registration hook. A host-owned adapter extends
the existing scripting block, owns one plugin instance per adapter instance,
validates JSON state and declared outputs, rejects thenables from synchronous
hooks, and revokes its private bridge after idempotent disposal. The bridge
looks up the adapter's current `getInput(label)` on every call so compiled
runtime connection hydration remains effective.

### Capability names and availability

API 1 reserves:

- `signals.read.vehicles`, `signals.read.devices`,
  `signals.read.simulation`, `signals.read.scenario`,
  `signals.read.mission`, `signals.read.objects`, and
  `signals.read.topics`
- `signals.write.debug`, `signals.write.mission`, and
  `scenario.flags.write`
- `world.read`, `controls.reference`, `topics.subscribe`,
  `topics.publish`, `overlay.spawn`, and `sensors.sample.range-image`

Grant validation separately rejects unknown names, missing required grants,
and grants unavailable from the selected host. Browser and headless hosts
implement approved signal reads, plugin-owned debug and mission writes,
plugin-owned scenario flags, read-only world snapshots, scoped deterministic
RNG, reference controls, deterministic topics, and reset-only overlay spawn.
`overlay.spawn` is omitted from host availability when the render target is
headless and any backend kind is `4`. Pure computation and RNG need no grant.
Plugins must use the host RNG rather than ambient `Math.random()` for
deterministic behavior.

### Sensor ABI and host sampling

PLG-05 adds optional `plugin.json.sensorTypes`, the
`sensors.sample.range-image` capability, and synchronous
`contributeSensorType({ type, create })` registration. Existing package
documents keep `sensorTypes` absent, preserving their parsed form and hash
vectors. A declaration uses sensor ABI 1 and family `range-image`; it defines
a complete default `cev-sim.range-image-layout@1`, declarative settings,
PointCloud2 and/or native packet products, and an optional measured
range/incidence observation. Definitions live in a run-scoped
`SensorTypeRegistry`; executable factories publish transactionally with block
and system contributions.

The host owns geometry, capture pose, measurement noise/dropout, scheduling,
delivery, ROS encoding, native packet records, and resource limits. Plugins
receive a copied metric-v2 measured range image with semantic and instance
slots cleared. Their isolated instance implements `prepare`, `reset`,
`captureAt`, `getDeterministicState`, `hydrateDeterministicState`, `finalize`,
and `dispose`. Thenables, malformed products, queue overflow, and lifecycle
exceptions are structured reset-required infrastructure failures.

Authored channel and azimuth order is significant. Explicit layouts require
kind 3 `deterministic-cpu-bvh-lidar` version `2`, config hash
`70349dfde6494414249bbcf6e1befc13ce82b817a63eb01baac4f5402ce62c31`.
Version 1 and its uniform scan path remain unchanged. Enabled plugin sensors
also require portable LiDAR geometry and a prepared matching factory.

### Plugin sensor identity and transports

Runs with enabled plugin sensors contain conditional
`resolved.pluginSensors` (`cev-sim.plugin-sensors@1`) and
`dependencyHashes.pluginSensors`. Each UTF-8-sorted record binds sensor/type,
plugin/runtime identity, ABI/family, exact effective behavior hash, required
backend, and optional observation descriptor. Bundle verification rebuilds
the resource from verified package declarations and normalized sensors.
Queue sizes and `sensorTransports` are operational and excluded from
simulation semantics; scan, parameters, products, mount, latency, noise, and
observation mapping are semantic. Plugin-free and unit/system-only runs omit
the resource.

`manifest.sensorTransports`, when present, is the strict
`cev-sim.sensor-transports@1` document described in
[`sensor-packet-transports.md`](sensor-packet-transports.md). Bindings name an
admitted vendor-packet stream plus `pcap` or `udp` and an operator endpoint
ID. The saved document changes definition and full resolved identity and is
projected out of simulation, episode, and trajectory identity. Wrapper
addresses, PCAP filenames, MTU, and other host settings live in a separate
operator-owned `cev-sim.sensor-transport-host-config@1` document and never
enter those hashes.

PLG-06a implements classic Ethernet/IPv4/UDP PCAP capture. PLG-06b adds
supervisor-owned live IPv4 unicast UDP. Simulation workers continue to
produce immutable native packet batches and never import `node:dgram`,
create sockets, or receive endpoint addresses. Plugins never receive
sockets, host endpoints, artifact paths, or send operations.

### Portable plugin files

The existing `cev-sim.plugin-package@1` JSON resource is also a portable file.
`PluginStore.installFromFile(filePath)` and `installFromBytes(bytes)` verify
every member before CAS publication and update the library only after CAS
success. A library-write failure may leave the verified CAS object, but the
library revision and membership remain unchanged. Directory, byte, and file
installs of the same members produce identical package, runtime, UI, and
library hashes.

Portable-file ingestion limits are tooling limits, not immutable run-bundle
rules: 16 MiB outer JSON, 256 members, 8 MiB decoded total, 4 MiB per member,
and 240 UTF-8 bytes per member path. Previously valid embedded packages remain
valid. Verification never imports or executes package code.

Install sources include `{ kind: "file", path }` (absolute) and raw HTTP
`POST /api/storage/plugins/install-file` with
`application/vnd.cev-sim.plugin-package+json`. Standalone tooling is
`cev-sim-plugin pack --directory … --output …` and
`cev-sim-plugin verify --file …`.

### Storage and module sources

`PluginStore` publishes immutable CAS resources below
`plugins/cas/sha256/<packageHash>`, maintains a revisioned `library.json`,
uses operation-owned staging, and materializes verified Node closures below
`plugins/runtime/<runtimeHash>`. Installation never imports code. Library
removal preserves CAS bytes and immutable URLs.

The Node source imports a verified, runtime-only tree with a host-generated
`{ "type": "module" }` marker. The browser source imports the runtime entry
from the verified same-origin CAS route. Paths derive only from digests and
relative member paths. UI execution is a separate browser `importUi` path;
Node/headless never import UI modules.

### Authoring catalog and graph locks

The editor and MCP share a revisioned unit catalog: built-in
`UNIT_CATALOG_META` plus plugin units from the local library. Placing a plugin
unit stamps `graph.pluginLocks` as `{ pluginId, version, packageHash,
runtimeHash, types[] }`. One package per plugin ID per graph. Compiled
artifacts continue to emit `pluginRequirements` as `{ pluginId, version,
runtimeHash, types[] }` without `packageHash`. Missing packages render
placeholders and fail compile.

### UI ABI

Custom views load from `entry.ui` through `registerUi(uiApi)`. The frozen UI
API is `pluginApi`, `plugin`, `React`, `hooks`, `Unit`, `SettingsForm`,
`contributeUnitView`, `assetUrl`, `log`, and `diagnostics`. Integrity failures
are fatal. `registerUi` and render errors fall back to the generic settings
form without unloading the runtime package.

### Library control plane

HTTP `GET /api/storage/plugins/library`, `POST .../install`,
`POST .../install-file`, and `POST .../remove`, plus MCP `plugin_list` /
`plugin_get` / `plugin_install` / `plugin_remove`, manage library membership.
Directory and file installs require an absolute path. Removal preserves CAS
bytes. Config Scripts (Advanced) authors exact manifest locks and capability
grants.


## Milestones and acceptance gates

### PLG-01 — Foundation, isolated registries, and verified packages

Deliver the registry instance API and complete built-in registration; public
unit ABI and host adapters; strict package document and module-graph
verification; exact package/runtime/UI hashing; immutable storage and
revisioned library membership; transactional registration; injected Node and
browser module sources; verified read-only HTTP routes; and managed-run
rejection.

Acceptance requires:

- A fixed-port fixture registers and executes in isolated live,
  compiled-Runner, Node, and Chromium harnesses.
- Registration failure publishes no registry entries or metadata and retained
  callbacks are closed.
- Storage and integrity inspection execute no package code.
- Node and browser loading produce matching contribution descriptors/results,
  and the fixture UI entry is never evaluated.
- Package hash vectors are stable and runtime identity is independent of UI.
- Built-in catalogs, compilation, execution, plugin-free identity vectors,
  and action-tape characterization remain unchanged.
- All focused suites, scripting/runtime/identity regressions, Playwright,
  `npm run lint`, and `npm test` pass.

PLG-01 does not propagate plugin selection into managed simulations, expose
production simulator services, execute systems or UI modules, or alter
versioned run/script contracts.

### PLG-02 — Resolved selection and deterministic unit execution

Add authoring selection and immutable resolution into run manifests/bundles;
lock selected package/runtime identities; add per-session registries and
loader lifetime; propagate selected registries through `ScriptManager`, graph
loading, compiler requirements, scenarios, direct execution, supervisor
workers, and browser/headless preparation. Add deterministic scoped RNG and a
nested effect journal for approved plugin-owned signal writes. Activate the
gated `world-bound-plugins@1` identity while retaining `world-bound@2` for
plugin-free runs. Propagate structured plugin preparation/execution failures
through workers and Python `canonical_detail_json`, with execution failures
requiring reset.

Acceptance requires browser/headless parity for a pure unit, deterministic
selection of one version per plugin ID, exact bundle integrity failures,
transactional effects and RNG replay, session isolation across simultaneous
runs, clean reset/disposal behavior, Python bundle pass-through, and unchanged
hashes and characterization for plugin-free runs. Run/proto contract changes
must be versioned additively and recorded in the headless roadmap as well as
here.

### PLG-03 — Systems and expanded simulator capabilities

Execute declared systems in the existing `"scripts"` phase with deterministic
priority and state versioning. Dispatch order is ascending `priority`, then
plugin id, then system id; package enumeration order must not leak. Implement
the separately gated `controls.reference`, `topics.subscribe`,
`topics.publish`, and `overlay.spawn` services. Reference commands use
REP-103 steering through `ControlRuntime.submitSiSpeedSteer` and remain
overwritable by a later scenario command. Topic callbacks observe without
running plugin code, drain at the scripts cutoff, defer callback publishes to
the next cutoff, and treat queue overflow as `PLUGIN_RESOURCE`. Overlay spawn
is reset-only, plugin-owned, and omitted from headless GPU availability.
Plugin-free canonical state still omits `plugins`.

Acceptance requires replay and browser/headless parity for systems, ordering
tests for multiple plugins, reset/state migration tests, capability-negative
tests for every expanded service, and failure before state mutation when a
backend cannot honor requirements.

### PLG-04 — Editor integration, UI packages, and distribution

Add package library management surfaces, explicit install/remove control-plane
operations, catalog/package selection, safe UI metadata and custom renderer
loading under the versioned UI ABI, production asset serving, MCP/Config
integration, Python-facing parity evidence, and clean-distribution packaging.

Acceptance requires editor authoring/round-trip tests, custom UI fallback and
failure isolation, install/remove authorization and audit evidence, Node and
Chromium distribution tests from a clean checkout, full managed browser and
headless parity, Python integration, and documentation for package authors and
operators.

### PLG-05 — Custom range-image sensors and native packet products

Add strict package declarations and transactional factories, the isolated
sensor registry, shared admission planning, explicit range-image layouts,
CPU LiDAR backend v2, shared browser/headless adapters, PointCloud2 and native
packet dispatch, measured-perception tensors, conditional exact identity, and
Python/backend propagation. Sensor hooks remain in the existing `sensors`
phase. The generic native packet sink records complete opaque UDP payloads;
external PCAP and UDP transports failed closed in PLG-05 (PCAP in PLG-06a,
live UDP in PLG-06b).

Acceptance requires nonuniform sampling and PointCloud2 direction coverage,
packet-only and measured-observation configurations, exact bundle export and
package-directory-independent import, deterministic reset/hydration,
concurrent package-version isolation, strict factory/grant/layout/product/
backend failures, structured async/overflow failures, unchanged legacy
characterization, browser and headless execution, Python integration, and a
clean headless distribution smoke. See [`plugin-sensors.md`](plugin-sensors.md)
for the package contract.

### PLG-06a — Portable plugin files and classic PCAP artifacts

Distribute `cev-sim.plugin-package@1` as a portable file and convert native
`CEVP` packets into deterministic classic-PCAP artifacts in direct,
supervised, managed, and browser-log export paths. Keep plugin package v1,
run-manifest v11, run-bundle v1, native packet v1, SFLog v1, and headless
protocol v1.4. Live UDP, worker-to-parent packet IPC, PLG-07 management UI,
new plugin privileges, and protobuf changes are out of scope.

Locked contracts:

- Portable install verifies every member, publishes CAS, then updates the
  library. Limits above apply only to file/directory ingestion and
  `cev-sim-plugin` tooling.
- Bundle verification is structural: sensor/product/stream references,
  duplicate binding keys, adapter names, and endpoint identifiers. It does
  not require a local adapter.
- Execution admission uses an app-neutral host descriptor
  `{ adapters, endpoints: [{ id, adapter, mtu, maxPayloadBytes }] }`. With
  `execution: true`, every binding’s adapter and endpoint must exist and each
  stream maximum must be at most `mtu - 28`. Browser hosts expose no adapters
  and therefore reject requested PCAP and UDP bindings. Direct unsupervised
  CLI rejects a UDP host section. Supervised `run --config` and managed
  execution admit UDP when `packetTransports.udp` is configured.
- Host configuration is operational and does not affect `resolvedHash`,
  `simulationHash`, `episodeHash`, or `trajectoryHash`.
- Classic PCAP is little-endian, microsecond-resolution, Ethernet link type 1.
  Each record is Ethernet + IPv4 + UDP + the unchanged native payload. Logical
  egress time is
  `BigInt(actualDeliveryStep) * BigInt(manifest.clock.stepNs) + BigInt(offsetNs)`;
  PCAP timestamps are that value `/ 1000n`, truncated toward zero.
- Host-bound packets sort by logical egress nanoseconds, then UTF-8 sensor,
  product, stream, sample, and packet indexes. Sink and queue state are not
  canonical simulator state.
- Missing adapter/endpoint or disabled artifacts map to
  `UNSUPPORTED_CAPABILITY`; queue overflow to `RESOURCE_LIMIT`; open, write,
  or finalize failure to `ARTIFACT_FAILURE`. These are never fabricated as
  Gymnasium termination or truncation. Abort leaves no published partial
  artifact.
- Published `sensor-transport-evidence.json` is
  `cev-sim.sensor-transport-evidence` version 1.

Acceptance requires identical hashes for directory/byte/file install; pack,
verify, and clean-dist consumption without executing package code; a bundle
that verifies on any machine and fails before readiness when its PCAP
endpoint is missing or undersized; byte-identical `CEVP` envelopes in browser
and headless; an independent PCAP decoder for framing, checksums, timestamps,
ordering, and payloads; identical PCAP bytes from direct, worker-supervised,
and managed runs; browser SFLog export equivalence; unchanged action-tape
characterization; and the focused plus full verification commands below.

PLG-06b implements supervisor-owned live IPv4 unicast UDP as a dedicated
sidecar child. Protocol 1.4, run-manifest v11, run-bundle v1, plugin/sensor
ABI 1, Protobuf field numbers, and semantic hashes stay unchanged.

### PLG-06b — Supervisor-owned UDP transport

Keep run-manifest v11, run-bundle v1, plugin/sensor ABI 1, headless protocol
1.4, Protobuf field numbers, and all semantic hashes unchanged.
`headless.proto` is unchanged. Live IPv4 unicast UDP executes in one lazy
supervisor-owned Node child. Workers emit immutable native packet batches
over `cev-sim.packet-request/response` IPC and never import `node:dgram` or
sidecar modules. PCAP remains worker-owned.

Locked contracts:

- `cev-sim.sensor-transport-host-config@1` is additive: `pcap` and `udp` are
  independently optional, and at least one must exist. PCAP-only documents
  remain byte/shape compatible. UDP destinations are IPv4 unicast literals;
  source may be `0.0.0.0`. Ports are `[1, 65535]`. MTU defaults to 1500 and
  stays `[576, 65535]`. Endpoint IDs are unique across PCAP and UDP.
- UDP queue capacity is `min(udp.maxQueueBytesPerEnvironment,
  ResourceLimits.maxQueueBytes)`. Omitted pacing is `burst`. `packet-offset`
  requires an explicit nonnegative `latenessBudgetNs` and a manifest clock of
  `pacing: "realtime", speed: 1`. Configured UDP endpoints are host
  permissions, not plugin grants.
- Host descriptors advertise UDP as `{ id, adapter: "udp", mtu,
  maxPayloadBytes }`. Workers receive only the PCAP projection needed for
  local writers, that app-neutral combined descriptor, and a packet-bridge
  identity. Destination/source addresses never enter the kernel or plugin
  APIs.
- The sidecar binds exclusive IPv4 sockets, reuses one socket per shared
  source address/port, validates and reserves a whole batch before the first
  send, and transmits in logical-egress/identity order. Overflow sends
  nothing. A mid-batch error is uncertain; the sidecar never retries. Burst
  submits immediately. Packet-offset anchors after artifact staging and
  socket readiness, at
  `anchor + actualDeliveryStep * stepNs + offsetNs`. Lateness is measured at
  socket submission. Callback success is OS socket acceptance only.
- Sidecar death, bind failure, queue overflow, lateness, and evidence I/O
  map to `WORKER_CRASHED`, `UNSUPPORTED_CAPABILITY`, `RESOURCE_LIMIT`, and
  `ARTIFACT_FAILURE`. Those codes are never fabricated as Gymnasium
  transitions. `ARTIFACT_FAILURE` is reset-required. Evidence adds an
  optional `udp` section and `sensor-udp-timing.ndjson` only when UDP ran.
  PCAP-only `sensor-transport-evidence.json` stays exactly the PCAP shape.

Acceptance requires loopback datagram recovery, byte-identical PCAP/UDP
payload sequences, fake-clock packet-offset coverage, burst stress, sidecar
crash/reset without orphans, direct/browser rejection, supervised and
managed success, Python `CevSimEnvironmentError`/`requires_reset` mapping,
unchanged semantic hashes, Config UDP authoring, and worker/plugin import
graphs with no socket or sidecar modules.

### PLG-07 — Custom sensor authoring and UI

Author custom range-image sensors in Config and the Vehicle Editor without
changing run-manifest v11, run-bundle v1, plugin API/UI API 1, vehicle
manifest v2, vehicle-bundle v1, or Protobuf. Vehicle-mounted custom sensors
are authoring templates and previews; only `manifest.sensorRig.sensors`
execute. Vehicle bundles embed exact locked plugin packages for portable
import. Installed packages populate creation choices; exact CAS locks remain
readable after library removal.

Locked contracts:

- `GET /api/storage/plugins/sensors` is revisioned and built from
  `verifyPluginPackage()` documents. It never executes runtime or UI modules.
- UI API 1 adds `uiApi.contributeSensorView({ type, Component })`. `Component`
  receives frozen `{ context, sensor, descriptor, fields, diagnostics, onChange }`.
  `onChange({ path, value })` may edit only declared scan-layout, parameter,
  product, and output paths and validates before committing.
- Optional vehicle `pluginLocks` are `{ pluginId, version, packageHash,
  runtimeHash, sensorTypes[] }`, UTF-8 sorted, unique by `pluginId`, and
  omitted when empty. Locks pin authoring provenance and grant no capabilities.
- Plugin vehicle templates normalize to
  `{ rateHz, scanLayout, parameters, products }` with product defaults false.
- Vehicle-bundle v1 may include optional sorted `pluginPackages`. Legacy
  bundles without the field retain their hash projection.
- One package per plugin ID. Adding a type from another package version fails
  visibly. Removing a sensor does not remove a run plugin selection.
- Integrity failures are fatal. `registerUi` and component-render errors fall
  back to `PluginSensorSettingsForm`.
- Simulation identity projects locked vehicles as
  `{ pluginId, version, runtimeHash, sensorTypes }` and drops `packageHash`.
  Unlocked vehicles retain prior projections byte-for-byte.

Acceptance requires catalog/lock/storage/hash Node tests, Config and Vehicle
browser authoring, throwing-view fallback, portable/headless execution without
evaluating `app/plugin/browser`, and unchanged action-tape characterization.

## PLG-01 evidence ledger

| Gate | Evidence | Result / limitation |
| --- | --- | --- |
| Baseline identity | `visual-script-catalog`, `visual-identity`, and `headless-contract` before implementation | 21/22 passed; only the v11 golden helper comparison failed |
| Hermetic v11 resolution | Temporary `StorageService` seeded with exact fixture manifest, historical environment bytes, and binding envelope | Golden comparison repaired without changing committed fixture bytes |
| Action-tape characterization | Existing in-memory regeneration and committed comparison | Passed; committed characterization was not regenerated |
| Plugin focused Node suites | `node --experimental-default-type=module --test tests/plugin-*.test.js` | 20/20 passed on 2026-09-19; includes fixed hash vectors, state/output types, cache corruption, capability-before-import, and failed index publication |
| Targeted lint | ESLint over plugin implementation, fixtures, and focused suites | Passed on 2026-09-19 |
| Browser module source and build | `npx playwright test tests/ui/plugin-module-source.spec.js` using the production build/server | 1/1 Chromium test passed on 2026-09-19; relative runtime import and connected unit result matched Node, throwing UI entry was not evaluated |
| Regression matrix | `node --experimental-default-type=module --test tests/visual-script-*.test.js tests/visual-identity.test.js tests/headless-contract.test.js tests/run-manifest.test.js tests/simulation-hashes.test.js tests/storage-api.test.js tests/storage-service.test.js` | 170/170 passed on 2026-09-19 |
| Repository lint | `npm run lint` | Passed with zero errors on 2026-09-19; two pre-existing warnings remain in `MapSurface.js` and `Client.js` |
| Full tests | `npm test` with loopback access required by existing HTTP/supervisor suites | 1,506 passed, 0 failed, 4 existing skips on 2026-09-19 |

Fixture coverage includes a fixed-port scale unit with a parent-relative
shared helper, a throwing UI entry, hash/edit variants constructed from exact
bytes, transactional registration failures, asynchronous hooks, descriptor
mismatches, unavailable systems, hostile temporary paths, and symlinks. The
foundation deliberately has no production simulator capabilities and cannot
admit plugins to managed runs.

The fixed fixture vectors are `packageHash`
`f9e2255bed1adcdadbe7a3fa9cb75ee6644fc791c07acd9734bd4d43f8ea52d9`,
`runtimeHash`
`f29ebbc784e41f926b0aba3a8de763262be2b0e8181b63031dc4b7a9107657c7`,
and `uiHash`
`aae5470e2dbb18c3a70cd222d70aa83063fbda998b7636c8b84652ae0400823d`.
The full-suite loopback run was necessary because sandboxed local listening
causes the existing HTTP tests to fail with `EPERM`; the elevated acceptance
run completed without failures.

## PLG-02 evidence ledger

| Gate | Evidence | Result / limitation |
| --- | --- | --- |
| Selection, requirements, effects, RNG, identity | `node --experimental-default-type=module --test tests/plugin-run-session.test.js tests/plugin-admission.test.js` | 7/7 passed on 2026-09-20; covers exact locks/closure, transitive compiler requirements, atomic rollback, deterministic reset replay, UI-only edits, direct kernel and supervisor-worker execution, canonical bundle transport, and structured reset-required failures |
| Plugin focused Node suites | `node --experimental-default-type=module --test tests/plugin-*.test.js` | 24/24 passed on 2026-09-20 |
| Identity/runtime regression matrix | `visual-identity`, `run-manifest`, `simulation-kernel`, `headless-runtime`, `headless-runner`, and resolved-script security suites | 65/65 passed on 2026-09-20 |
| Browser source and production build | `npx playwright test tests/ui/plugin-module-source.spec.js`; `npm run build` | 1/1 Chromium test passed and the optimized Next.js build completed on 2026-09-20 |
| Python bundle/client and generated contract | `python/.venv/bin/python -m pytest python/tests/test_bundle.py python/tests/test_client.py -q`; `npm run lint:python`; `npm run proto:python` | 26/26 passed; Ruff and generated-Protobuf checks passed on 2026-09-20 |
| Repository lint | `npm run lint` | Passed with zero errors on 2026-09-20; one pre-existing `MapSurface.js` warning remains |
| Full tests and characterization | `npm test` with loopback access; `npm run fixtures:headless` | 1,510 passed, 0 failed, and 4 existing skips on 2026-09-20; regenerated action-tape characterization is unchanged |

## PLG-03 evidence ledger

| Gate | Evidence | Result / limitation |
| --- | --- | --- |
| Systems, capabilities, kernel fold-in | `node --experimental-default-type=module --test tests/plugin-systems.test.js tests/plugin-capabilities.test.js tests/plugin-run-session.test.js tests/plugin-loader.test.js tests/plugin-admission.test.js` | 23/23 passed on 2026-09-20; covers install-order-independent dispatch, failed-hook rollback, reset soak, missing required grants, headless GPU overlay deny, reset-only spawn, REP-103 reference overwrite by scenario, topic overflow, control-topic rejection, kernel scripts-phase execution, and structured system failure details |
| Plugin focused Node suites | `node --experimental-default-type=module --test tests/plugin-*.test.js` | 36/36 passed on 2026-09-20 |
| Identity/runtime regression matrix | `visual-identity`, `run-manifest`, `simulation-kernel`, `headless-runtime`, `headless-runner`, and resolved-script security suites | 43/43 passed on 2026-09-20 |
| Browser source | `npx playwright test tests/ui/plugin-module-source.spec.js` | 1/1 Chromium test passed on 2026-09-20; UI entry still unevaluated |
| Python bundle/client and generated contract | `python/.venv/bin/python -m pytest python/tests/test_bundle.py python/tests/test_client.py -q`; `npm run lint:python`; `npm run proto:python` | 26/26 passed; Ruff and generated-Protobuf checks passed on 2026-09-20 |
| Repository lint | `npm run lint` | Passed with zero errors on 2026-09-20; one pre-existing `MapSurface.js` warning remains |
| Full tests and characterization | `npm test` with loopback access; `npm run fixtures:headless` | 1,522 passed, 0 failed, and 4 existing skips on 2026-09-20; regenerated action-tape characterization is unchanged |

## PLG-04 evidence ledger

| Gate | Evidence | Result / limitation |
| --- | --- | --- |
| Authoring, catalog, scaffold, and library | `node --experimental-default-type=module --test tests/plugin-*.test.js` | 46/46 passed on 2026-09-20; covers graph `pluginLocks`, revisioned catalogs, lock conflicts, placeholders, HTTP/MCP library install-remove, scaffold/example verify, and portable plugin bundle closure |
| Playwright production UI | `npx playwright test tests/ui/plugin-authoring.spec.js tests/ui/plugin-config.spec.js tests/ui/plugin-module-source.spec.js tests/ui/plugin-ui.spec.js --workers=1`; `npm run build` | 4/4 Chromium tests passed on 2026-09-20 against the production server; custom `registerUi` view, throwing UI fallback, CAS asset 200, tampered UI 400 then restored, Config Advanced lock/diagnostics, and runtime import without evaluating UI |
| MCP/HTTP control plane | `tests/mcp-tools.test.js` `tests/plugin-api-routes.test.js` | 21/21 passed on 2026-09-20; `plugin_install` stamps `graph.pluginLocks`, library GET/install/remove publishes audit events, and `plugin_remove` keeps CAS bytes so locked lint still compiles |
| Identity/runtime regression matrix | `visual-identity`, `run-manifest`, `simulation-kernel`, `headless-runtime`, `headless-runner`, and resolved-script security suites | 43/43 passed on 2026-09-20 |
| Python bundle/client and generated contract | `python/.venv/bin/python -m pytest python/tests/test_bundle.py python/tests/test_client.py -q`; `npm run lint:python`; `npm run proto:python` | 26/26 passed; Ruff and generated-Protobuf checks passed on 2026-09-20. No Python plugin install API. |
| Repository lint | `npm run lint` | Passed with zero errors on 2026-09-20; one pre-existing `MapSurface.js` warning remains |
| Full tests and characterization | `npm test` with loopback access; `npm run fixtures:headless` | 1,533 passed, 0 failed, and 4 existing skips on 2026-09-20; regenerated action-tape characterization is unchanged |
| Plugin-free soak | `npm run test:soak:quick` | Passed on 2026-09-20; soak remains plugin-free and does not change PR-12 obligations |
| Clean distribution | `npm run dist:headless && npm run dist:verify` | Passed on 2026-09-20; npm tarball depends on `acorn` 8.15.0 and `semver` 7.7.3, ships `docs/plugin-plan.md` and `docs/plugin-api.md`, omits `app/plugin/browser`, plugin-free smoke stays byte-compatible, and the installed CLI completes an `acme.example` portable bundle smoke without `uiHash` in provenance |

## PLG-05 evidence ledger

Acceptance ran on 2026-09-20 from base commit
`b7c4a1f6c7edc02ac9fc514bcf809a51ea142e1d` on macOS arm64, Node
22.14.0. The implementation working-tree digest before this evidence-only
ledger update was
`f3a15194c0e10afabddb9a1c715e41189298fa6b1cbc4cf901c9b88cd9bd88ca`.

| Gate | Exact command / evidence | Result / limitation |
| --- | --- | --- |
| Declarations, admission, identity, products | `node --experimental-default-type=module --test tests/plugin-sensors.test.js` plus the final full suite | Passed; strict legacy omission, grants/layouts/products/factories/shapes/backends/package closures, exact `pluginSensors`, UI/transport/queue projections, authenticated packet bytes, packet-only tensors, async/overflow errors, concurrent versions, direct runner, managed execution, reset replay, hydration, and 32 reset cycles |
| CPU sampling compatibility | `node --experimental-default-type=module --test tests/lidar-cpu.test.js`; final full suite | Passed; authored 3×4 order and channel azimuth corrections, actor-local parent exclusion/motion, deterministic labels/no-hit values, and the committed browser GLSL reference tolerance |
| Supervisor path | `node --experimental-default-type=module --test --test-name-pattern="PLG-05 supervisor" tests/headless-supervisor.test.js` with local Unix-socket access | 1/1 passed; a process-isolated worker imported the embedded package, exposed the measured tensor, stepped, terminated, and finalized successfully |
| Production browser | `npx playwright test tests/ui/plugin-module-source.spec.js --workers=1` | 2/2 Chromium tests passed against the production server; the verified sensor ESM registered and executed its isolated factory and the existing runtime/UI isolation test remained green |
| Python and generated contract | `npm run test:python`; `npm run lint:python`; `npm run proto:python` | 69/69 passed; Ruff and generated-Protobuf checks passed. Python preserves and negotiates the locked CPU-v2 selection without interpreting scan physics; no Protobuf change |
| Characterization | `npm run fixtures:headless`; `git diff --exit-code -- tests/fixtures/headless/characterization.v1.json` | Passed with no committed fixture delta |
| Repository lint and full Node suite | `npm run lint`; `node --experimental-default-type=module --test --test-reporter=dot tests/*.test.js`; `git diff --check` | 1,546 passed, 0 failed, 4 existing skips; ESLint had zero errors and one pre-existing `MapSurface.js` warning; diff check passed |
| Production build | `npm run build` | Optimized Next.js build, TypeScript check, and static generation passed |
| Clean distribution | `npm run dist:headless`; `npm run dist:verify` | Passed; installed npm tarball executed plugin-free, unit-plugin, and embedded range-image sensor CLI smokes without browser UI imports; wheel and sdist imported. Artifact digests are recorded in `dist/headless/release-manifest.json` and `SHA256SUMS` |

At PLG-05 close, PCAP and UDP remained unavailable by design. Requested
`sensorTransports` bindings failed before readiness; their adapters and host
permissions belong to PLG-06a/PLG-06b. PLG-05 does not change the outstanding
headless PR-12 hosted, soak, x64 NVIDIA, or Jetson evidence obligations.

## PLG-06a evidence ledger

Acceptance ran on 2026-09-20 from base commit
`f18e41284005a76fa3f0ff1771f6bd72560261f2` on macOS arm64, Node 22.14.0.

| Gate | Exact command / evidence | Result / limitation |
| --- | --- | --- |
| Portable file install | `node --experimental-default-type=module --test tests/plugin-store.test.js tests/plugin-package-cli.test.js` | Passed; directory/byte/file installs share package, runtime, UI, and library hashes; malformed/truncated/oversize/symlink input fails; library-write interruption leaves verified CAS unpublished; `cev-sim-plugin pack/verify` never loads runtime modules |
| Control plane | `tests/plugin-api-routes.test.js` `tests/mcp-tools.test.js` | Passed; `{kind:"file"}` install, raw `POST /api/storage/plugins/install-file`, and MCP `plugin_install` return the same membership/audit metadata as directory installs |
| Structural vs execution admission | `node --experimental-default-type=module --test tests/plugin-sensors.test.js tests/simulation-hashes.test.js` | Passed; bundles verify without a local adapter; execution requires PCAP adapter/endpoint and `maxPayloadBytes <= mtu - 28`; host wrapper changes preserve simulation/episode/trajectory identity; manifest bindings change definition/full identity only |
| Independent PCAP decoder | `node --experimental-default-type=module --test tests/sensor-pcap.test.js` | Passed without importing `PcapEncoder.js`; classic v2.4 Ethernet/IPv4/UDP framing, checksums, timestamps, two-stream shared artifact, MTU rejection, and queue overflow |
| Direct / CLI / abort | `tests/headless-runner.test.js` `tests/headless-cli.test.js` | Passed; identical PCAP bytes across direct reruns; disabled artifacts and missing host are `UNSUPPORTED_CAPABILITY`; drain failure is `ARTIFACT_FAILURE` with no published output; abort leaves no destination; `--sensor-transport-config` is mutually exclusive with `--config` |
| Supervisor and managed | `tests/headless-supervisor.test.js` `tests/headless-experiment.test.js` with local Unix-socket access | Passed; worker-supervised PCAP bytes match the direct runner for the same bundle and host config; two sequential managed runs with reference authority produce identical PCAP bytes |
| Browser-log export | `tests/telemetry-logging.test.js`; `npx playwright test tests/ui/logs.spec.js --grep "pcap export" --workers=1` | Passed; evaluation SFLog export matches live `sensors.pcap` payloads and timestamps via `LogService` and `POST /api/logs/:id/pcap-export`; production-server empty recordings fail closed (400) without a partial file. No PLG-07 UI |
| Plugin focused Node suites | `node --experimental-default-type=module --test tests/plugin-*.test.js` | 60/60 passed on 2026-09-20 |
| Python and generated contract | `npm run test:python`; `npm run lint:python`; `npm run proto:python` | 69/69 passed; Ruff and generated-Protobuf checks passed. No Python API or Protobuf shape change; Gymnasium/SB3 checkers still auto-reset after finalize |
| Characterization | `npm run fixtures:headless`; `git diff --exit-code -- tests/fixtures/headless/characterization.v1.json` | Passed with no committed fixture delta |
| Repository lint and full Node suite | `npm run lint`; `node --experimental-default-type=module --test tests/*.test.js`; `git diff --check` | 1,558 passed, 0 failed, 4 existing skips; ESLint had zero errors and one pre-existing `MapSurface.js` warning; whitespace check passed |
| Production build | `npm run build` | Optimized Next.js build, TypeScript check, and static generation passed |
| Clean distribution | `npm run dist:headless`; `npm run dist:verify` | Passed; installed tarball exposes `cev-sim` and `cev-sim-plugin`, packs/verifies a copied fixture without loading runtime code, consumes the external package file, and writes `sensors.pcap`. Artifact digests: npm `ea0a6a7d52ce65ccf51fdf5f19acecfa0a74b224c3f0a2ec2b6fbe85c63d9aab`, wheel `f27397510f3ebf641ea1e89ea380cbe825cc721cc53470070d3edfd0a6f7263f`, sdist `6656e47a1557a485a29369669ca2ea6a30fd261d24b32eaf8d7048ab368e485f` |

At PLG-06a close, live UDP remained unavailable and was rejected; PLG-06b
later added supervisor-owned UDP. PLG-06a does not change the outstanding
headless PR-12 hosted, soak, x64 NVIDIA, or Jetson evidence obligations and
is not a headless PR 13.

## PLG-07 evidence ledger

Acceptance ran on 2026-09-21 on macOS arm64, Node 22.14.0.

| Gate | Exact command / evidence | Result / limitation |
| --- | --- | --- |
| Catalog, locks, storage, hashes | `node --experimental-default-type=module --test tests/plugin-sensor-authoring.test.js tests/vehicle-manifest.test.js tests/simulation-hashes.test.js tests/plugin-sensors.test.js` | 34/34 passed; catalog revision/order without module execution, vehicle-lock normalize/conflict/reconcile/legacy omission, Config/Vehicle patches, missing package/wrong runtime hash/undeclared type/missing grant, vehicle save/duplicate/export/import with embedded packages, CAS after library removal, UI-only vs runtime identity, and plugin-free vehicle projections |
| Plugin focused Node suites | `node --experimental-default-type=module --test tests/plugin-*.test.js` | 69/69 passed |
| Browser authoring | `npx playwright test tests/ui/plugin-sensor-authoring.spec.js tests/ui/plugin-config.spec.js tests/ui/plugin-ui.spec.js tests/ui/plugin-module-source.spec.js --workers=1` | 7/7 Chromium tests passed against the production server; Config create/grant/edit/save/reload/validate, Vehicle add/edit/save/reload, throwing-view generic fallback, missing-package diagnostics, custom unit UI, and runtime import without evaluating UI |
| Characterization | `npm run fixtures:headless`; `git diff --exit-code -- tests/fixtures/headless/characterization.v1.json` | Passed with no committed fixture delta |
| Repository lint and full Node suite | `npm run lint`; `npm test`; `git diff --check` | 1,567 passed, 0 failed, 4 existing skips; ESLint had zero errors and one pre-existing `MapSurface.js` warning; whitespace check passed |
| Production build | `npm run build` | Optimized Next.js build, TypeScript check, and static generation passed |
| Clean distribution | `npm run dist:headless`; `npm run dist:verify` | Passed; installed tarball omits `app/plugin/browser`. Artifact digests: npm `134066330eadab2002112a1ceb61157a22f22a44ae5fc3641266631ed86804ea`, wheel `b50891d9dbeaa1528df80d6a83953dd7c64d50ca5a14fcebcd0dd34251d4edae`, sdist `bc943539e1421a34483dfee6495d991d9a926967b9f212f72cf9bc083635bb11` |

GPU explicit layouts, package-defined ROS schemas, marketplace behavior, and
plugin-owned transport remain out of scope. Live UDP is implemented in
PLG-06b. PLG-07 does not change the outstanding headless PR-12 hosted, soak,
x64 NVIDIA, or Jetson evidence obligations and is not a headless PR 13.

## PLG-06b evidence ledger

Acceptance ran on 2026-09-21 from base commit
`d38bb17fd17e66021bfb4b7b1d6c6983d7981e42` on macOS 15.6 arm64, Node 22.14.0.
Protocol 1.4 and `headless.proto` are unchanged. PLG-06b does not close or
change the outstanding PR-12 hosted, soak, NVIDIA x64, or Jetson ARM64 gates.

| Group | Gate | Exact command / evidence | Result / limitation |
| --- | --- | --- | --- |
| Transport correctness | Loopback, PCAP parity, fake-clock, burst | `node --experimental-default-type=module --test tests/sensor-udp.test.js tests/sensor-pcap.test.js tests/plugin-sensors.test.js` | 28/28 passed. Loopback recovered datagram boundaries and per-stream order; combined PCAP+UDP runs matched extracted payload bytes; fake-clock covered packet-offset targets, equal-offset order, pause, lateness, generation reset, and cancel; burst covered atomic overflow, 64 generations, cancel, and drain. `HeadlessWorker`, `app/simulation`, and `app/plugin` import graphs cannot reach `node:dgram` or sidecar modules. Direct `--sensor-transport-config` and in-process managed sessions reject UDP; `run --config` and `runManagedExperiment` send loopback datagrams. |
| Lifecycle / failure | Supervisor, managed, runner, CLI | `node --experimental-default-type=module --test tests/headless-supervisor.test.js tests/headless-experiment.test.js tests/headless-runner.test.js tests/headless-cli.test.js` | 48/48 passed. Sidecar crash marks registered UDP environments reset-required without automatic resend; missing endpoint, bind conflict, and packet-offset clock mismatches fail before readiness; PCAP-only evidence omits `udp`; owner close leaves no orphan child. |
| Host / client admission | Python mapping and Config UDP authoring | `python3 -m pytest python/tests/test_client.py python/tests/test_integration.py -q`; `npx playwright test tests/ui/plugin-sensor-authoring.spec.js --workers=1` | 24/24 Python focused tests passed; full `python/tests` was 69/69. `ERROR_CODE_ARTIFACT_FAILURE` is in `_REQUIRES_RESET_CODES` and maps to `CevSimEnvironmentError` / `requires_reset`. Playwright 4/4 passed, including Config add/save/reload/remove of UDP bindings. |
| Identity / distribution | Characterization, lint, soak, dist | `npm run fixtures:headless`; `git diff --exit-code -- tests/fixtures/headless/characterization.v1.json`; `npm run lint`; `npm test`; `npm run test:python`; `npm run lint:python`; `npm run proto:python`; `npm run build`; `npm run test:soak:quick`; `npm run dist:headless`; `npm run dist:verify`; `git diff --check` | Characterization unchanged. ESLint 0 errors, one pre-existing `MapSurface.js` warning. Node 1,582 passed, 0 failed, 4 existing skips. Python 69/69; Ruff and generated-Protobuf checks passed. Production Next.js build passed. Quick soak passed (`protocol` 1.4). Dist verify passed, including installed-worker/plugin `node:dgram` exclusion. Whitespace check passed. Artifact digests: npm `6b51acaa1d30650b703bea584b265bb7f5290e9f60e10c293af069497ddf4b27`, wheel `736545a3b617474d35c44b5e818c651da4deb27a52ac2067647ee3c1ed606def`, sdist `d7e2d2515dd3e066d2b8fb8d710e0800b16daff0f6814dc05b5064f8e4bc80e2` |

## Decision log

- **2026-09-21 — Helios scan IPC flow control.** A full Helios `submit-batch`
  exceeds Node's 16 KiB IPC high-water mark, so `child.send()` returns false
  while the message remains queued. `UdpTransportSidecarOwner.dispatch` now
  waits for the sidecar response instead of failing that connected send.
  Packet responses are revived with their sidecar code, so queue overflow and
  lateness stay `RESOURCE_LIMIT`. Protocol 1.4, `headless.proto`, semantic
  hashes, and the PLG-06b acceptance gates are unchanged. Prior UDP tests used
  tiny payloads and did not cross the mark.

- **2026-09-21 — PLG-06b acceptance completed.** Supervisor-owned live IPv4
  unicast UDP passed focused transport, lifecycle, Python/Config admission,
  characterization, lint, full Node, soak, production-build, and
  clean-distribution gates. Protocol 1.4 and `headless.proto` are unchanged.
  PLG-06b is verified but remains unmerged. It is not headless PR 13 and does
  not change outstanding PR-12 hosted, soak, NVIDIA x64, or Jetson ARM64
  gates.

- **2026-09-20 — PLG-06b supervisor-owned UDP.** Live IPv4 unicast UDP is a
  supervisor-owned sidecar child. Workers keep producing immutable native
  packets and never import `node:dgram` or receive endpoint addresses. PCAP
  stays worker-owned. Host config v1 is additive. Protocol 1.4,
  `headless.proto`, run-manifest v11, run-bundle v1, and semantic hashes are
  unchanged. Direct `--sensor-transport-config` and browser execution reject
  UDP; `run --config` and managed execution admit it. This is not headless
  PR 13 and does not change outstanding PR-12 gates.

- **2026-09-21 — PLG-07 acceptance completed.** Catalog/lock/storage/hash Node
  tests, Config and Vehicle browser authoring, throwing-view fallback,
  portable/headless distribution without `app/plugin/browser`, and unchanged
  action-tape characterization passed. Scripts plugin locks stay visible
  outside Advanced so stamped range-image grants can be inspected and
  repaired. PLG-07 is verified but remains unmerged. Live UDP was still
  deferred to PLG-06b at that close.

- **2026-09-20 — PLG-07 custom sensor authoring.** Config and Vehicle Editor
  consume a revisioned sensor catalog plus exact CAS locks. Vehicle
  `pluginLocks` pin authoring provenance without granting capabilities.
  Vehicle custom sensors are templates/previews; only `sensorRig` executes.
  Vehicle bundles embed exact packages without library membership.
  Simulation identity drops `packageHash` from locked vehicles only. This is
  not headless PR 13 and does not alter plugin-free hashes.

- **2026-09-20 — PLG-06a acceptance completed.** Portable plugin files and
  classic PCAP artifacts passed focused, full Node, Python, characterization,
  production-build, Playwright fail-closed export, and clean-distribution
  gates. PLG-06a is verified but remains unmerged. Live UDP was still
  deferred until after PLG-07.
- **2026-09-20 — PLG-06a portable files and classic PCAP.** The existing
  package resource is the portable file. Ingestion limits do not version or
  invalidate embedded run-bundle packages. PCAP host configuration is
  operational and is not a headless PR 13, protobuf, or identity change.
  Live UDP remained unavailable until PLG-06b, which followed PLG-07.
- **2026-09-20 — Custom sensors use sensor ABI 1 inside plugin API 1.**
  `sensorTypes` stays absent for legacy packages. Exact declarations and
  synchronous `contributeSensorType` factories publish transactionally with
  units and systems; runtime instances are per sensor and per run.
- **2026-09-20 — Explicit scan layouts select CPU LiDAR backend v2.** Authored
  channel/azimuth order and channel correction are semantic. Backend v1 keeps
  its uniform path and prior hash; no GPU explicit-layout claim is made.
- **2026-09-20 — Native packets are a host product, not plugin transport
  authority.** Plugins return copied complete UDP payloads. The host owns the
  authenticated envelope, queue, timestamps, recording, and future external
  adapters. PCAP/UDP bindings are recognized and rejected as unavailable in
  PLG-05.
- **2026-09-20 — PLG-05 acceptance completed.** Browser, direct, CLI,
  supervisor, managed, Python, distribution, lifecycle soak, and legacy
  characterization gates passed. PLG-05 is verified but remains unmerged and
  is not headless PR 13.

- **2026-09-20 — Express owns `/api/scripting`.** `GET /units` and `POST /compile` load the revisioned plugin catalog and exact `graph.pluginLocks` from `StorageService`. The Next route files remain 410 stubs so `next build` does not serve a second implementation.
- **2026-09-20 — UI ABI is separate from runtime ABI.** `createRegistrationApi()` stays UI-free. Browser `registerUi` receives host React, `Unit`, and `SettingsForm`. Integrity failures are fatal; `registerUi` and render errors fall back to generic settings. Node/headless never call `importUi`.
- **2026-09-20 — Editor locks carry `packageHash`.** `graph.pluginLocks` pin `{ pluginId, version, packageHash, runtimeHash, types[] }`. Compiled `pluginRequirements` remain `{ pluginId, version, runtimeHash, types[] }` without `packageHash`. One package per plugin ID per graph. Open graphs keep locked CAS bytes when library membership is removed.
- **2026-09-20 — Headless dist verifies plugins with Acorn and SemVer.** The CLI tarball lists `acorn` and `semver` because `PluginPackage` and `PluginDocument` import them. Provenance includes `plugins: [{ pluginId, version, packageHash, runtimeHash }]` only for effective plugin runs and never `uiHash`.
- **2026-09-20 — PLG-04 acceptance completed.** Revisioned catalogs, custom UI isolation, MCP/HTTP/Config library management, scaffold/docs/example, clean-install plugin bundle smoke, and plugin-free characterization all passed. Hosted/NVIDIA/Jetson/PR-12 soak evidence is unchanged and out of scope. PLG-04 is verified but remains unmerged.
- **2026-09-20 — PLG-03 stays in the scripts phase.** Topic callbacks and
  system `onStep()` fold into the existing `"scripts"` cutoff after
  `BindingRuntime.update`. No new `lastStepPhases` names. Scenario may
  overwrite a plugin reference command because `"scenario-before-motion"`
  already follows scripts and uses the same `producer: "reference"` path.
  Plugin steering is REP-103.
- **2026-09-20 — Honor overlay.spawn only where the backend can materialize
  it.** Browser and headless CPU/physics keep the grant. Headless GPU
  (backend kind `4`) strips `overlay.spawn` from host availability so
  preparation fails closed before `clearRun()`. Overlay records never enter
  `worldHash`.
- **2026-09-20 — Overflow is fatal.** Plugin topic queues are bounded at 1024.
  Overflow, heavy subscriptions, and control-topic publish/subscribe fail
  with `PLUGIN_RESOURCE` or `PLUGIN_FEATURE_UNAVAILABLE` and require reset.
- **2026-09-20 — PLG-03 acceptance completed.** Systems dispatch independently
  of package order, expanded capabilities fail closed, overlay spawn is
  reset-only and omitted for headless GPU, plugin-free characterization is
  unchanged, and this milestone is not headless PR 13. PLG-03 is verified but
  remains unmerged.
- **2026-09-20 — PLG-02 admits deterministic units as one contract.** The
  approved PLG-02 scope includes exact managed selection, transitive artifact
  requirements, per-run registries, plugin-owned transactional writes,
  deterministic RNG, `world-bound-plugins@1`, supervisor/Python propagation,
  and canonical plugin state. Systems, controls, topics, overlay spawning, and
  custom plugin UI remain later milestones.
- **2026-09-20 — Keep existing version numbers.** The optional fields are
  additive within run-manifest v11, run-bundle v1, visual-script artifact v3,
  and Protobuf v1. Effective plugin runs select a new explicit identity
  profile; plugin-free documents retain their prior projections and bytes.
- **2026-09-20 — Bind behavior to runtime identity.** `packageHash` admits and
  transports exact bytes, while semantic identity uses `runtimeHash` plus
  grants. This lets a UI-only package edit change full bundle provenance
  without changing replay or episode identity.
- **2026-09-20 — Fail a plugin graph atomically.** Plugin writes and RNG share
  the graph evaluation boundary with `SignalStore` and unit runtime state.
  Execution errors invalidate the active step and require reset; the
  supervisor reports structured plugin fields through existing error detail
  bytes rather than adding a Protobuf error enum.
- **2026-09-20 — PLG-02 acceptance completed.** Exact selection and portable
  closure checks, transitive artifact requirements, transactional execution,
  reset replay, managed headless propagation, browser loading, Python
  pass-through, production build, and the complete repository suite passed.
  Plugin-free characterization remains unchanged. PLG-02 is verified but
  remains unmerged.

- **2026-09-19 — PLG names are independent.** Use `PLG-01` through `PLG-04`;
  “PLRG-01” in early planning material means `PLG-01`. Do not treat the work
  as headless PR 13, a VIS milestone, or an ED milestone.
- **2026-09-19 — Preserve current versioned contracts.** PLG-01 introduces no
  plugin field into managed manifests, bundles, Protobuf, or visual-script
  artifacts. Reserved fields fail before normalization or execution.
- **2026-09-19 — Isolate registration.** The default built-in registry remains
  plugin-disabled. Each host publishes a candidate registry and metadata only
  after complete synchronous validation.
- **2026-09-19 — Hash exact bytes and semantic projections separately.** Raw
  package membership determines `packageHash`; parsed runtime and UI
  projections determine their respective identities.
- **2026-09-19 — Keep import validation structural.** Acorn parses every
  packaged module. Regex import discovery and package-authored Node metadata
  are not trusted.
- **2026-09-19 — Keep PLG-01 capability-free in production.** Reserved names
  are stable vocabulary, not evidence that a service is wired.
- **2026-09-19 — Preserve immutable content after removal.** Removing library
  membership does not delete CAS bytes or invalidate digest URLs; garbage
  collection and multi-process writers remain deferred.
- **2026-09-19 — PLG-01 acceptance completed.** Node and Chromium loaded the
  same fixed-port fixture through verified sources, plugin-free regressions and
  characterization stayed unchanged, lint had no errors, and the complete
  repository suite passed. PLG-01 is verified but remains unmerged.
