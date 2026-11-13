# Zenoh and modular Protobuf implementation plan

This is the separate `ZPB-*` program. It replaces the external orchestrator with
schema-bound Zenoh transport in browser and headless runs. It is not headless
PR 13. Follow `AGENTS.md`: implement one numbered package in a fresh context,
with that package's exact gate. Read the headless roadmap, headless Protobuf
contract, run-manifest documentation, and architecture before runtime changes.

## Accepted decisions

- Author explicit JSON configuration. Infer neither sensor wiring nor frames,
  calibration, units, or control authority from a message name. An authoring
  script may produce configuration once; no script runs to forward each sample.
- Import local `.proto` files with their import closure, or a binary
  `FileDescriptorSet`. Support multiple isolated schema roots. Select a fully
  qualified message type per route; no global type registry or schema service.
- Add pinned GitHub sources in ZPB-02. Store a full commit SHA and file digests;
  checking online reports a candidate revision. Applying an update explicitly
  creates a new immutable interface. Cached resolved runs work offline and
  never follow a moving branch during execution.
- ZPB-02 accepts public GitHub repositories without credentials. Preview an
  update before adoption. Explicit acceptance may disable schema-invalid routes
  and bootstrap values while retaining their original definitions and repair
  diagnostics in authoring storage. Valid routes remain usable; disabled drafts
  never reactivate automatically. The immutable interface remains valid v1 JSON.
- Browser transport uses the official Zenoh TypeScript client's browser API
  through the router's remote API. Application code stays JavaScript. Headless
  transport uses a thin Rust/napi addon in the existing environment process.
  Keep Zenoh/router/native compatibility pinned to the existing 1.10.2 baseline;
  pin and verify the browser client and router plugin together in ZPB-05.
- Linux x64 and Jetson ARM64 consumers receive large immutable encoded payloads
  through Zenoh's own shared-memory support. Do not publish process pointers,
  custom `/dev/shm` paths, or a second image-reference protocol. Consumer-held
  references govern reclamation. Browser WebSockets still copy bytes.
- Initial native SHM threshold: 64 KiB; initial pool: 64 MiB per environment.
  Validate the aggregate budget against the existing 128 MiB limit. Require
  bounded queues, an explicit exhaustion policy, and lifetime evidence before
  enabling SHM. Preserve the existing Python tensor shared-memory protocol.
- Headless external-controller execution gets an explicit realtime mode.
  Gymnasium remains request-driven. Both use the authoritative JavaScript
  fixed-step kernel and the existing control validation and stale policies.
- Migrate the onboarding repository and its control ownership workflow, then
  delete orchestrator setup, clients, and `.msg` fallback transport. No final
  optional legacy orchestrator mode. No visual wiring canvas in this program.

## Interface contract established by ZPB-01

`app/interfaces/ProtobufInterface.js` defines this JSON document:

```json
{
  "kind": "cev-sim.protobuf-interface",
  "version": 1,
  "schemas": [
    { "id": "autonomy", "fingerprint": "<sha256>", "descriptorBase64": "<FileDescriptorSet>" }
  ],
  "routes": [
    {
      "id": "state", "schemaId": "autonomy",
      "messageType": "cev.onboarding.v1.StateUpdate",
      "direction": "publish", "key": "sim/{run_id}/state",
      "source": { "topicId": "vehicle-state" },
      "mapping": { "fields": [
        { "to": "header.time_ns", "from": "metadata.simTimeNs" },
        { "to": "state.speed_mps", "from": "value.speed", "scale": 1, "offset": 0 }
      ] }
    }
  ],
  "bootstrap": []
}
```

Each schema fingerprint is SHA-256 of its **exact descriptor bytes**. The
interface hash is SHA-256 of normalized canonical JSON. Schema, route, and
bootstrap arrays sort by ID; field assignments retain their authored order.
Normalization returns independent JSON values and never rewrites its input.
Source URLs, credentials, local paths, and update receipts belong to authoring
sidecars, not this immutable document.

A publisher has one `source.topicId` or `source.bootstrapId`. A subscriber has
`target.topicId`. Each route selects its own schema and message type. Keys are
literal Zenoh keys or `{run_id}` templates, without wildcards. Duplicate keys
are rejected, including templates that collide when `run_id` is `run`.
Route admission in ZPB-03 must also reject actual collisions after expanding
the concrete run ID.

Mappings select either `fields` or `{ "adapter": "name", "config": {} }`.
Field assignments select `{to, from, scale?, offset?}` or `{to, value}`. Sources
start with `value`, `metadata`, or `run`; dotted paths contain safe identifiers.
Conversions target numeric scalars. Assignments cannot overlap, descend into a
map/repeated field, or contain executable expressions. Publisher destinations,
subscriber Protobuf sources, and publisher constants are schema-checked now.
Local topic paths and named adapters are admitted in ZPB-03/04 before execution.
Bootstrap records contain `{id, schemaId, messageType, value, repeatMs}`;
`repeatMs` defaults to zero, meaning once. A bootstrap publisher with no field
assignments sends that typed value directly in ZPB-04.

The loader accepts explicit **proto3** only. It rejects proto2, editions,
extensions, weak imports, groups, required fields, unsafe identifiers, duplicate
definitions, unresolved imports, import cycles, and invalid field/presence
metadata. Referenced types need a direct import or a public import re-export.
Approved bundled well-known files are `any`, `duration`, `empty`, `field_mask`,
`struct`, `timestamp`, and `wrappers` under `google/protobuf/`. These supply wire
types; codecs use field objects, not ProtoJSON's special timestamp/Any wrappers.

Limits: 16 schemas, 64 routes, 64 bootstrap records, 128 files per schema,
700,000 descriptor bytes per schema, 1 MiB per source file, 8 MiB per source
closure, 64 nesting levels, and 16 MiB per encoded payload/interface document.
ZPB-06 capability checks must compare admitted image sizes with the payload
limit; revise that limit explicitly if larger images are required.

The codec preserves source field spelling, returns decimal strings for 64-bit
integers, and returns owned `Uint8Array` bytes. Inputs may use exact integer
numbers, decimal strings, or BigInt. JSON documents use decimal strings rather
than BigInt. Reject unsafe integer numbers, out-of-range integers, coercions,
non-finite floats, sparse arrays, unknown input fields, and multiple oneof
members. Preserve absent versus explicitly supplied optional zero/false values.
Accept unknown numeric proto3 enum values and ignore unknown wire fields.

## Package sequence

| Package | Depends on | Deliverable | Status |
| --- | --- | --- | --- |
| ZPB-01 | — | Interface contract, descriptor codec, local source loader | Implemented and verified |
| ZPB-02 | 01 | Persistent imports and pinned GitHub updates | Implemented and verified |
| ZPB-03 | 01, 02 | Manifest v12 and immutable resolved interface resources | Implemented and verified |
| ZPB-04 | 03 | Shared mapping runtime and publication hook | Planned |
| ZPB-05 | 04 | Browser Zenoh lifecycle and file-based configuration | Planned |
| ZPB-06 | 04 | Native Zenoh addon and shared memory | Planned |
| ZPB-07 | 06 | Headless publication and realtime controller mode | Planned |
| ZPB-08 | 05, 07 | Onboarding and control ownership migration | Planned |
| ZPB-09 | 08 | Orchestrator deletion and release acceptance | Planned |

### ZPB-01 — interface and loader

Create `app/interfaces/ProtobufInterface.js` with
`normalizeProtobufInterface()`, `validateProtobufInterface()`, and
`hashProtobufInterface()`. Create `app/interfaces/ProtobufSchema.js` with
`loadDescriptorSet()`, `encodeMessage()`, and `decodeMessage()`.
Create `server/interfaces/ProtobufSourceLoader.js` with `loadProtoFiles()` and
`loadDescriptorFile()`, plus the directory's ES-module `package.json`.
Promote the already installed `protobufjs` to a direct pinned 7.6.6 dependency.

Use `loadProtoFiles(entryFiles, {includeDirs})` with selected files and explicit
include roots. Default roots are entry-file parent directories. Confine imports
to those roots; reject ambiguous names and symlink escapes. Preserve individual
filenames, dependencies, and public-import indexes, even for multiple files in
one package. Source compilation is deterministic for the pinned compiler, but
does not promise protoc-identical descriptor bytes. Import an existing binary
descriptor when an upstream fingerprint must match exactly.

Both loader methods return `{fingerprint, descriptorBase64, root}`. Persist the
first two fields with a schema ID; the reflection root is execution-only.
Codec methods take a resolved type from `root.lookupType(messageType)`.

Gate: `tests/protobuf-interface.test.js` covers the pinned onboarding descriptor,
both reference source packages, modular imports, optional presence, maps,
64-bit precision, bytes ownership, invalid schemas, and interface validation.
Run `tests/headless-contract.test.js`, lint, and the full JavaScript suite.
No runtime wiring, existing manifest/hash changes, generated headless binding
edits, or historical fixture regeneration in this package.

### ZPB-02 — imports, storage, and GitHub pins

Create `server/storage/ProtobufInterfaceStore.js` using the existing atomic
JSON/file-store conventions. Add `importSources()`, `importDescriptor()`,
`putImmutable()`, `getByHash()`, `list()`, `checkUpdate()`, and `applyUpdate()`.
Create `server/interfaces/GitHubProtobufSource.js` with `resolveCommit()` and
`fetchImportClosure()`; accept repository/file references, pin them to full
commit SHAs, enforce source bounds, and never execute repository code.
Reuse ZPB-01 compilation and validation.

Store immutable documents under `protobuf-interfaces/sha256/<hash>.json` and
mutable source records separately. Source records carry repository, requested
ref, resolved SHA, selected files, file digests, and check/update receipts.
Do not store tokens or silently swap cached data on failed downloads.
Add narrow methods to `server/storage/StorageService.js`, storage API routes in
`server/routes/storageApi.js`, MCP tools in a new
`server/mcp/protobufInterfaceTools.js`, and registration in
`server/mcp/createMcpRouter.js`. Reuse `storageGet()` and `storagePost()` in
`app/client/storageClient.js` for the browser calls.

Gate: local import, GitHub pinning, import closure, atomic failed update,
offline reuse, and immutable hash retrieval tests with mocked network responses.

ZPB-02 is implemented in five working packages:

1. Shared `loadProtoSources()` acquisition and content-addressed interface
   publication/retrieval. `loadProtoFiles()` adds execution-only `files`
   provenance while preserving its original descriptor bytes and result fields.
2. Filesystem/uploaded source and descriptor imports, revisioned source records,
   and explicit tracked routing repairs through `putImmutable()`.
3. `GitHubProtobufSource` reuses the existing public GitHub client and adds
   Protobuf-sized acquisition budgets. Shared responses are bounded while
   streaming, including responses without Content-Length.
4. `checkUpdate()` caches the exact candidate descriptor and diagnoses each
   invalid route/bootstrap record. `applyUpdate()` requires explicit invalidation
   acceptance and applies that cached candidate without network access.
5. Dedicated bounded storage HTTP routes, eight MCP tools, and narrow
   `StorageService` delegates. Browser callers reuse the existing storage client.

Immutable documents live at `protobuf-interfaces/sha256/<hash>.json`; authoring
records live at `protobuf-interfaces/sources/<sourceId>.json`. One source record
owns the interface pointer and its per-schema acquisition metadata. It retains
one pending check, the latest successful update receipt, and disabled drafts.
No raw source archive, credentials, or reflection root is persisted. The
source-record limit is 32 MiB; exceeding it fails without discarding drafts.

The dedicated HTTP parser admits at most 16 MiB of JSON; decoded source closures
remain limited to 8 MiB and each source file to 1 MiB. HTTP imports accept bytes
and GitHub references. MCP also accepts local filesystem references and can
publish a bounded interface JSON file without increasing the shared MCP parser.

The immutable file is published durably before the mutable source pointer is
replaced. Failures before pointer commit preserve the old pointer and receipts;
an unreferenced immutable file may remain after a failed pointer write. A lost
acknowledgement after commit is recoverable through `getSource()` and the update
receipt; retrying the same completed check is idempotent. This is one
StorageService-owned store per server process, not a multiprocess write protocol.

Preview validation uses ZPB-01 schema checks. Topic contracts and named adapters
still require ZPB-03/04 admission; a preview does not infer units or frames.

### ZPB-03 — resolved run snapshots

Edit `app/simulation/RunManifest.js` (`normalizeRunManifest()`,
`validateRunManifest()`, `computeResolvedRunHash()`) for manifest v12 with an
explicit interface selection and disabled/Zenoh mode. Edit
`server/storage/StorageService.js::resolveRunManifest()` to embed the complete
interface document and its content hash into resolved resources/dependencies.
Edit `server/headless/RunBundle.js::verifyRunBundleIntegrity()` and
`verifyRunBundle()` to verify v12 snapshots without consulting mutable storage.
Include interfaces in run-package export/import closure where those resources
are collected. Edit `docs/run-manifests.md` and `docs/architecture.md`.

Validate topic IDs, local source/target contracts, available adapters, concrete
run-key collisions, control authority, and backend capabilities. Keep physical
Zenoh endpoints, queue sizes, SHM limits, source provenance, and credentials in
host configuration. The immutable interface hash enters `resolvedHash`;
episode semantics include the admitted external-controller contract when that
mode is selected. Preserve old bundle integrity and characterization identities;
do not mechanically rewrite old fixtures to introduce v12.

Gate: stale/missing interface rejection, self-contained offline bundles,
tamper detection, package round trips, and explicit semantic/operational hash
tests. Existing v1–v11 bundle inspection retains its documented behavior.

ZPB-03 is implemented in six working packages:

1. **Manifest selection.** `RunManifest.js::normalizeRunManifest()` now writes
   v12 and delegates the strict `{mode, interfaceHash, externalController}`
   record to `ProtobufRunBinding.js::normalizeProtobufRunConfig()`. Missing
   configuration becomes disabled/null/false. Existing plugin/sensor-transport
   introduction gates stay at v11; old authoring migrates without changing
   received historical bundles.
2. **Resource and route admission.** `createProtobufInterfaceResource()` and
   `assertProtobufInterfaceResource()` verify normalized interface@1 documents
   and exact descriptor fingerprints. `planProtobufRouteAdmission()` creates
   isolated schema-root and topic Maps, checks native scalar/`.msg` field
   structures, constants, numeric conversions, metadata/frozen run paths,
   adapters, subscription ownership, and explicit candidate control authority.
   `TopicCodec.js::parseMsgDefinition()` reuses the existing parser without
   registration. `bindProtobufRunKeys()` returns a route-ID/key Map and rejects
   collisions after concrete run-ID expansion.
3. **Immutable storage resolution.** `StorageService.resolveRunManifest()`
   performs one immutable hash read and embeds `protobufInterface:{document,
   hash}` plus `dependencyHashes.protobufInterface` in its independent JSON
   snapshot. Missing or corrupt pins retain the `protobuf.interfaceHash` issue
   path. Source-pointer updates do not invalidate retained hashes.
4. **Bundle and package closure.** `RunBundle.js::verifyRunBundleIntegrity()`
   verifies v12 selections, pins, resources, and admission from embedded local
   schemas before checking outer hashes. `verifyRunBundle()` admits v12
   structure. `StorageService.importRunBundle()` republishes embedded immutable
   content before authoring persistence. Existing package collection/import
   automatically carries descriptors inside exact `bundle.json`; no new archive
   entries or mutable source records are needed.
5. **Identity projection.** `RunIdentity.js` admits the existing profiles for
   v12. `SimulationHashes.js::simulationSemanticProjection()` retains v11
   disabled/publish-only meaning, including projection of calibration's writer
   version. `protobufInputContractHash()` binds subscribed routes, used schema
   IDs/fingerprints, external-controller selection, and frozen run values mapped
   into inputs. Publication and host settings remain outside episode semantics.
6. **Execution gates and cross-language checks.** Browser controller/engine and
   shared-kernel preparation reject Zenoh before replacing or preparing state.
   Python `load_bundle()` admits v12/JCS, verifies interface@1's existing JSON
   hash and exact descriptor digests, and preserves received bytes. New disabled,
   publication, and controls snapshot/hash vectors cover v12 without rewriting
   historical evidence. Routing, architecture, run-manifest, Python, and bundle
   support documentation describe the gate.

The accepted v12 selection is hash-only; source IDs never select execution
content. No runtime adapters are available yet. All subscribed inputs are
semantic, including script-visible inputs without actuator routing. A fields
mapping may read frozen `run.*` snapshot values and later `run.runId`; it cannot
read resolved/semantic hashes. Mapping an otherwise operational frozen value
into an input makes that value semantic. `run.runId` stays execution identity.
Concrete key binding is ready for the later transport lifecycle; ZPB-03 rejects
Zenoh execution universally until those transports exist.

### ZPB-04 — mapping and a shared publication hook

Create `app/interfaces/ProtobufMapping.js` with `compileMapping()` and
`applyMapping()`. Create `app/interfaces/ProtobufRouteRuntime.js` with
`configure()`, `publishTopic()`, `acceptInbound()`, `reset()`, and `dispose()`.
Add a small named adapter registry in `app/interfaces/ProtobufAdapters.js` for
the actual onboarding state/lidar/control shapes and documented CEV SI/frame
conversions. Use existing calibration and vehicle dimensions. No dynamic imports
from an interface document and no general scripting language.

Reuse `app/simulation/TopicContractRouter.js::routeOutbound()` and
`routeInbound()` and `app/simulation/TopicInputQueue.js`; add the transport
publication hook at the existing
`app/simulation/sensors/SensorPublisher.js::_deliverMessage()` delivery boundary.
Expose that hook through `app/simulation/kernel/SimulationRuntimeContext.js`
and `app/simulation/headless/HeadlessRuntimeContext.js`. Do not capture sensors
again or use telemetry retention as the transport queue.

Gate: browser/headless mapping parity, bootstrap scheduling in integer
simulation time, unchanged delivery ordering and characterization, invalid
samples rejected before publication, and bounded inbound admission. Distinguish
transport acceptance from command application.

### ZPB-05 — browser transport and authoring surface

Create `app/client/ZenohBrowserTransport.js` with `connect()`, `publish()`,
`subscribe()`, `unsubscribe()`, and `close()`. Pin the official browser client
and compatible router remote-API plugin. Edit
`app/3d/managers/ClientManager.js::setup()`, `preflight()`, and `dispose()` and
`app/simulation/RunSessionController.js::prepare()`, `reset()`, and `_stop()`
to configure the resolved interface, establish subscriptions before starting,
and clear bindings on loss/reset/stop. Verify required routes in preflight.

Create `app/config/ProtobufInterfacePanel.js` with file import, a GitHub source
field, explicit update application, route JSON editing, and useful validation
errors. Mount it through `app/config/SimpleRunWorkspace.js` and the existing
shared `app/config/runConfigSession.js`; retain simple/advanced mode conventions.
No visual wiring canvas. The old path may exist only while migration gates
are incomplete and must be deleted by ZPB-09.

Gate: real router binary round trip, isolated concurrent run IDs, reconnect
without stale bindings, required-route startup failure, bootstrap lifetime,
browser backpressure, and focused Playwright authoring/lifecycle checks.

### ZPB-06 — native transport and SHM

Create `native/zenoh-transport/Cargo.toml`, `src/lib.rs`, and its napi package
entry. Expose `openSession()`, `publish()`, `subscribe()`, `unsubscribe()`,
`close()`, and bounded transport diagnostics. Create
`server/sensor-transports/ZenohNativeTransport.js` as the Node-facing adapter
and `ZenohTransportConfig.js` for host admission. Pin the Rust SDK, lockfile,
and Linux x64/ARM64 artifact hashes; extend the headless artifact builder,
installer, and verifier in `scripts/` using the existing artifact conventions.

Allocate large payloads from Zenoh's SHM provider, write once, publish the
immutable owned buffer, and recycle only after its last reference is released.
Define drop/block/fail behavior at the bounded queue boundary; required control
publication must fail visibly. Report allocation, copies, drops, and pool usage.
Use network payloads when local SHM negotiation is unavailable under the admitted
policy; an explicitly required SHM backend must fail capability validation.

Gate: native binary round trip, both Linux architectures, consumer retention
across later frames, pool exhaustion, crash/close cleanup, repeated resets,
mixed local/remote consumers, and measured copy/memory behavior on Jetson.
Do not advertise end-to-end zero copy merely because Zenoh uses SHM: JavaScript
Protobuf encoding and GPU readback may still copy.

### ZPB-07 — headless execution and external controls

Edit `server/headless/HeadlessSession.js`, `HeadlessWorker.js`,
`HeadlessRunner.js`, `ManagedHeadlessSession.js`, and capability validation to
own the native session inside each environment process. Add explicit realtime
external-controller CLI/config selection in `bin/cev-sim.js` and the runner.
Publish the same resolved routes as browser runs. Admit commands into
`TopicInputQueue`, then the existing `app/autonomy/ControlRuntime.js` and
`ControlCommandAdapter.js` at fixed-step boundaries.

Preserve run/sequence identity, simulation-time validity, next-step application,
single authority, calibrated speed/steering conversion, stale stop/hold/fallback
policy, and reset cleanup. Wall time only paces and detects infrastructure
failure. Do not turn transport failure into a fabricated Gym truncation or let
two controllers advance one environment. Keep the Gym request/response path.

Gate: browser/headless publication parity, actual external-controller driving,
stale/wrong-run/duplicate commands, pause/reset/stop, transport failure, and
existing Gym/Python regression tests. Compare the committed action tape.

### ZPB-08 — onboarding and ownership migration

Add `examples/interfaces/onboarding.protobuf-interface.json` and a small
`cev-interfaces` example using the immutable import format. Update
`scripts/protobuf-probe.mjs`, onboarding documentation, and `install.sh`
onboarding setup to install/configure the pinned router rather than orchestrator.
In `cornellev/auto-onboarding-fa26`, migrate setup, probes, node registration,
availability/run-info publication, and command ownership to the same Zenoh keys
and Protobuf definitions. Keep upstream calibration and command deadlines.

Create an in-process control-ownership module under `server/interfaces/` only
for the ownership operations currently required by onboarding. Use explicit
acquire/renew/release and bounded expiry, and wire it into browser and headless
admission. Do not introduce another coordinating daemon. Record the upstream
commit used by integration evidence; external repository writes need their own
authorized checkout.

Gate: installer-to-driving browser and headless onboarding smoke tests,
ownership conflicts and expiry, run-info/node-status lifetime, and independent
consumers using the pinned schemas without a running orchestrator.

### ZPB-09 — delete the old path and accept the release

Remove `server/ensureOrchestrator.js` and its startup/shutdown calls in
`server/App.js`. Delete orchestrator-specific client/channel/codec code in
`app/client/Client.js`, `ProtobufChannel.js`, and `TopicCodec.js` after all
callers move; keep any still-used local contract logic at its existing layer.
Remove orchestration `.msg` sync/fallbacks in `ClientManager`, obsolete
`public/messages/` assets, installer flags/checkout/venv logic, environment
variables, tests for the deleted protocol, and stale documentation references.
Search all callers before deleting. Update `docs/protobuf-routing.md`,
`docs/architecture.md`, and the release/artifact workflow documentation.

Gate: clean install with no orchestrator, no live code references to its HTTP/WS
APIs, actual browser/headless/Jetson round trips, SHM soak/cleanup, onboarding,
and required lint/full/headless/parity/CLI/Python suites. Record hardware and
hosted evidence separately from unit results. Do not mark missing hardware
evidence as passed.

## Progress and decision log

- 2026-11-12: Accepted the nine dependency-ordered packages and the decisions
  above. ZPB-01 creates an additive contract and loader only. Existing runtime
  transports, manifest v11, headless Protobuf v1, and fixture identities remain
  authoritative until their own package gates admit changes.
- 2026-11-12: Implemented ZPB-01 with pinned reference fixtures and trust-boundary
  tests. The pinned protobufjs extension requires local corrections for optional
  metadata, maps, packed defaults, and false boolean map keys; generated bindings
  and dependency source files are not edited. Focused interface and headless
  contract checks pass.
- 2026-11-12: ZPB-01 verification completed. `npm run lint`: zero errors and
  three existing React-hook warnings. `npm test -- --test-concurrency=4`:
  2,723 passed, nine skipped, zero failures. The full suite required an approved
  rerun outside the sandbox because existing integration tests bind localhost
  sockets. Final byte-budget guards were also checked with the focused interface
  and headless-contract suite (17 passed) and clean lint on the new modules.

- 2026-11-12: Implemented the five ZPB-02 working packages, including public-only
  GitHub imports, explicit previews, partial adoption, retained disabled drafts,
  bounded HTTP/MCP surfaces, and offline candidate application. The immutable
  interface v1 shape, existing run-manifest v11, headless protocol, and
  characterization identities are unchanged. Focused tests initially hit the
  sandbox's localhost EPERM restriction; the approved rerun passed 43 checks.
  Expanded focused checks passed 45 tests; the broader storage/MCP/GitHub
  regression run passed 99. `npm run lint` completed with zero errors and the
  same three existing React-hook warnings. The approved full
  `npm test -- --test-concurrency=4` run passed 2,745 tests with nine skipped and
  zero failures (2,754 total). No committed fixtures were regenerated; current
  characterization replay and historical checksum checks passed. Network
  acquisition evidence is mocked; no live GitHub or router/hardware evidence is
  claimed for this storage-only milestone.

- 2026-11-12: Implemented the six ZPB-03 working packages. Manifest v12 is the
  default writer with disabled/null/false Protobuf selection; enabled selections
  pin immutable interface@1 content rather than source records. Resolved snapshots
  and JSON/run-package imports carry complete descriptors offline. Route admission
  checks local/wire fields, frozen metadata/run sources, explicit candidate control
  ownership, and concrete key collisions. Production adapters remain unavailable.
  Zenoh preparation fails visibly before browser replacement or kernel side effects;
  no SDK, transport, native SHM, UI, or headless protocol edits are included.
- 2026-11-12: ZPB-03 hash review preserves the v11 identity profiles and
  disabled/publish-only simulation/episode meaning. Calibration's manifest-writer
  version is projected to v11 in that semantic domain; its actual v12 envelope
  remains in full resolved identity. Subscription contracts and frozen values
  mapped into inputs are semantic. New v12 snapshot/identity vectors were reviewed;
  historical fixtures and characterization tapes were not rewritten.
- 2026-11-12: ZPB-03 verification completed. Focused interface/admission/snapshot
  checks passed 28 tests; compatibility regression checks passed 138 with two
  existing skips. `npm run lint` passed with zero errors and the same three React
  hook warnings. The full `npm test -- --test-concurrency=4` run passed 2,761 tests,
  nine skipped, zero failures (2,770 total). Python passed all 151 tests, including
  13 new v12 loader/package checks and real supervisor/Gym/SB3 integration; Ruff
  passed for the changed Python files. Browser/direct/CLI/gRPC/Python parity passed
  all four cases (state, CPU LiDAR, road geometry v2, and asset metric v1).
  Socket-bound suites required approved execution outside the sandbox. Current
  characterization replay, dynamic/contact tapes, and historical identity/checksum
  tests passed. No live Zenoh router, transport, or hardware acceptance is claimed
  for this snapshot milestone.

Next fresh context: **ZPB-04**, using its mapping/publication gate above.
