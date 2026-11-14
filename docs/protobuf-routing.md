# Zenoh / Protobuf integration

Production runs use run-manifest v13, interface@2, and native `cev.*` topic contracts. Browser and headless sessions publish binary Protobuf through Zenoh directly. No orchestrator or ROS schema registration is required. See [mapping](zenoh-protobuf-mapping.md) and [native transport](zenoh-native-transport.md).

## Persistent interface authoring

The following routes are available under `/api/storage/protobuf-interfaces`:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/` | List immutable interface and imported-source summaries |
| POST | `/` | Publish `{document, sourceId?, expectedRevision?}` |
| GET | `/sha256/:hash` | Retrieve and verify immutable interface content |
| GET | `/sources/:id` | Retrieve source pins, pending preview, and disabled drafts |
| POST | `/import-sources` | Import uploaded proto3 files or a public GitHub closure |
| POST | `/import-descriptor` | Import exact binary FileDescriptorSet bytes |
| POST | `/sources/:id/check-update` | Cache and report a proposed schema revision |
| POST | `/sources/:id/apply-update` | Explicitly adopt the exact cached preview |

Source imports accept `{sourceId, schemaId, source, baseHash?, expectedRevision?,
routes?, bootstrap?}`. A new interface defaults to empty routes/bootstrap.
`baseHash` attaches source provenance to a matching existing schema; additional
schema imports into an existing source record require its current revision.

An uploaded source is `{kind:"uploaded-proto", entryFiles:["sample.proto"],
includeDirs:[], files:[{path:"sample.proto", bytesBase64:"..."}]}`. A GitHub source
is `{kind:"github", url:"https://github.com/owner/repo", ref:"main",
entryFiles:["proto/sample.proto"], includeDirs:["proto"]}`. Repository URLs may
omit `ref` to select the current default branch; the resulting branch name and
full commit SHA are recorded explicitly. File URLs select their embedded ref
and default entry path; an explicit `ref` override uses a repository URL.
Only public repositories are admitted; credentials, redirects, and repository
execution are rejected. Descriptors use
`source:{kind:"descriptor", descriptorBase64:"..."}` on the descriptor endpoint.

Browser callers use the existing storage client:

```js
const imported = await storagePost("protobuf-interfaces/import-sources", input);
const preview = await storagePost(
    `protobuf-interfaces/sources/${input.sourceId}/check-update`,
    { schemaId: input.schemaId, expectedRevision: imported.source.revision },
);
// Show preview.invalidatedRoutes and preview.invalidatedBootstrap before adoption.
const adopted = await storagePost(
    `protobuf-interfaces/sources/${input.sourceId}/apply-update`,
    { checkId: preview.checkId, expectedRevision: preview.revision,
      acceptInvalidations: true },
);
```

`check-update` changes authoring revision and the pending receipt, not the active
interface hash. GitHub checks follow the saved requested ref once; local uploads
require replacement source bytes in the check request. Application performs no
network lookup. It requires `acceptInvalidations:true` when the preview contains
broken definitions. Valid routes remain in the immutable document; broken routes
and bootstrap values remain in authoring storage with diagnostics. Routes that
depend on an invalid bootstrap are also disabled. A tracked POST with a repaired,
valid document clears corresponding disabled IDs while preserving source-bound
schema fingerprints. Schema replacement uses check/apply, not tracked POST.

Missing resources return 404. Stale or missing revisions return 409 with
`PROTOBUF_REVISION_CONFLICT` and `currentRevision`; unaccepted invalidations return
409 with `PROTOBUF_INVALIDATION_ACCEPTANCE_REQUIRED` and per-record issues.
The dedicated parser allows 16 MiB JSON; decoded files/closures and descriptors
retain ZPB-01 limits. Immutable reads and cached update application work offline.
Failed downloads do not replace pins or cached descriptors. Immutable files may
remain unreferenced after a failed source-pointer write; old hashes are retained.

MCP provides `protobuf_interface_list`, `get`, `get_source`, `put`,
`import_sources`, `import_descriptor`, `check_update`, and `apply_update` (each
with the `protobuf_interface_` prefix). MCP imports additionally accept
`{kind:"local-proto", entryFiles:["/absolute/sample.proto"], includeDirs:[]}`
or `{kind:"descriptor", filePath:"/absolute/schema.binpb"}`. `put` accepts
`filePath` instead of an inline document for large JSON files. HTTP callers upload
bytes rather than supplying server filesystem paths.

## Resolved interface selection

Save `protobuf:{mode:"zenoh", interfaceHash:"<sha256>", externalController:false}`
in a v13 run manifest after publishing an interface@2 resource. Resolution embeds
the exact document and descriptor bytes at `resolved.protobufInterface` and binds
`nativeTopicContracts`. Offline bundle inspection and import need no source lookup.

`planProtobufRouteAdmission()` validates topic IDs, native value contracts,
direction, typed mappings, frozen values, and concrete key collisions. Controls
subscriptions require explicit external-controller selection and candidate authority.
Publish-only interfaces affect full resolved identity; subscribed contracts also
bind simulation and episode identity. See [Run manifests](run-manifests.md).

## Runtime connections

The browser uses `ClientManager`, `ZenohBrowserTransport`, and
`ProtobufRouteRuntime`. The server supplies an operator-owned
`cev-sim.zenoh-browser-host-config@1` endpoint through the existing storage API.
The official pinned `@eclipse-zenoh/zenoh-ts` SDK transports binary samples through
the router remote API. Route declarations and bounded subscription queues belong
to one run generation. Reset and reconnect close old declarations and clear queues.
Required-route failure remains visible; acceptance does not acknowledge actuator
application. Headless sessions use the native addon and explicit TCP host config.

Values remain native until `ProtobufRouteRuntime` applies the admitted mapping and
encodes wire bytes. Capture metadata supplies frame, integer simulation time, and
sequence; values contain no ROS headers. Use decimal strings for exact uint64
fields. Sensor delivery requires synchronous bounded transport acceptance.

`./install.sh --onboarding` installs the checksum-pinned Zenoh router and native
transport prerequisites. Removed orchestrator flags are rejected. The independent
SDK probe is `scripts/protobuf-probe.mjs`; the real browser gate is
`npm run test:zenoh-browser`. Hardware release gates remain in
[Headless release](headless-release.md).

## Historical artifacts

Older interface@1 and ROS-shaped bundles remain inspectable through
`server/headless/RunBundleInspection.js`. Their frozen contracts live under
`server/interfaces/historical/`. Explicit reviewed native adoption creates new
native resources and preserves the originals. Production verification and browser
preparation reject older execution formats. There is no runtime legacy mode.
