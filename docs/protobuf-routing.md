# Generic Protobuf publication

The replacement is tracked in [the Zenoh/Protobuf roadmap](zenoh-protobuf-plan.md).
ZPB-01 provides the immutable interface contract and local schema loader;
ZPB-02 adds persistent imports and explicit pinned-source update previews.
ZPB-03 adds manifest v12 pins, self-contained run snapshots, and route admission.
The live transport described below remains the current path during migration.

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
in a v12 run manifest after publishing/importing an interface. The hash selects
immutable content, independently of mutable source records. Resolution embeds
the complete document and descriptor bytes at `resolved.protobufInterface`;
offline verification and package import need no source lookup.

Admission uses exact manifest topic IDs, direction, local field shapes, typed
constants, and frozen run/metadata paths. No named runtime adapters are available
in ZPB-03. Controls subscriptions require explicit external-controller selection
and a single candidate authority. Key binding checks actual run ID collisions.
Publish-only configuration changes full run identity; admitted subscription
contracts also change simulation and episode identity. See
[Run Manifests](run-manifests.md#pinned-protobuf-interfaces-zpb-03) for details.

Zenoh mode can be inspected/exported/imported, but preparation fails with
`UNSUPPORTED_CAPABILITY` until later transport packages are implemented. The
default is explicit disabled mode. Interface@1, bundle@1, package@1, and the
headless Protobuf protocol remain unchanged.

## Current browser transport

The existing browser Client now supports schema-bound publication/subscription:

```js
await client.bindProtobuf({ runId, fingerprint });
await client.subscribeProtobuf('reply', (value) => console.log(value));
await client.publishProtobuf('note', { title: 'hello', nonce: '18446744073709551615' });
await client.unsubscribeProtobuf('reply');
```

Register the descriptor set and explicit routes with orchestrator first. Values
use standard ProtoJSON. The browser sends versioned text frames on its existing
WebSocket; orchestrator validates them, encodes binary Protobuf, and publishes to
the route's Zenoh key. Reverse subscriptions deliver ProtoJSON values. Existing
binary `.msg` methods remain compatible. New text samples go only to subscribers.
A routing acknowledgement confirms acceptance, not physical command application.

Bindings require an exact descriptor fingerprint and run ID. Connection loss clears
the binding and subscriptions. A fresh run requires a new bind; there is no automatic
resume. Failed operations reject promises. Source timestamps/sequence identity belong
to message contracts; a route does not infer frames, units, or actuator safety.

Use decimal strings or BigInt for 64-bit integer fields. BigInt is converted to a
decimal string before sending. Non-finite JavaScript numbers are rejected. The
channel bounds outstanding requests and subscriptions; existing socket backpressure
limits still apply.

`--onboarding` on the combined installer includes orchestrator's Protobuf extra and
the checksum-pinned Zenoh 1.10.2 router. `--orchestrator-ref` selects its exact Git
revision. Modified existing orchestrator checkouts are preserved by refusing a
revision switch. Native Windows setup remains documented rather than automated.

For isolated services, set `NEXT_PUBLIC_ORCHESTRATOR_API` and
`NEXT_PUBLIC_ORCHESTRATOR_WS` before starting/building the browser application.
Defaults remain localhost ports 8090 and 8080. The generic client example is
`scripts/protobuf-probe.mjs`; orchestrator's integration runner pairs it with the
onboarding Rust probe through a real router. Visual field wiring is deferred.
