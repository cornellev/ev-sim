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
`ProtobufRouteRuntime`. The server supplies a
`cev-sim.zenoh-browser-host-config@1` endpoint at `/api/zenoh/browser-config`.
Without an explicit browser file it defaults to `ws://127.0.0.1:10000/`.
The official pinned `@eclipse-zenoh/zenoh-ts` SDK transports binary samples through
the router remote API. Route declarations and bounded subscription queues belong
to one run generation. Reset and reconnect close old declarations and clear queues.
Required-route failure remains visible; acceptance does not acknowledge actuator
application. Headless sessions use the Linux native addon and TCP host config;
CLI external runs and supervisors default to `tcp/127.0.0.1:7447`.

### Start with no router setup

Run `npm run dev` (or `npm start` after a production build). The server downloads
and verifies the pinned Zenoh 1.10.2 router on first use, then owns one router
child for its lifetime. Later starts use the verified cache. The router binds
loopback TCP `7447` for Rust/headless sessions and remote-API WebSocket `10000`
for the page. Sample bytes travel through the router; Node does not relay them.
The browser opens its own WebSocket after fetching the endpoint from the server.

In Run Configuration, select **Interface JSON** and import a reviewed mapped
interface such as `examples/interfaces/onboarding-lease.v2.json`. Save its
routes, enable **Zenoh for this run** and **External controller**, then save the
run. Importing raw `.proto` files still requires authoring and saving mappings;
the importer does not infer routes, frames, units or control authority.

The onboarding command@2 interface requires the existing control lease. The
launcher acquires and renews that lease every 250 ms, prepares the saved run
paused with its credentials, obtains the actual run ID, then explicitly resumes
it. See [browser-sim-api.md](browser-sim-api.md). The lease expires after 750 ms.
Starting the router alone does not grant control authority. Partial Rust stacks
send only their available products; missing commands use the existing stale
command stop rule and are not a router failure.

The shared cache is `~/.cache/cev-sim/zenoh` on macOS/Linux and
`%LOCALAPPDATA%\cev-sim\zenoh` on Windows (fallback:
`%USERPROFILE%\AppData\Local\cev-sim\zenoh`). It is independent of checkout and
working directory. A verified old `.onboarding/router` install can seed it.
Archives and installed executable/plugin bytes are checked. Missing files can
be repaired; checksum changes are refused. First use needs network access once.
`router.owner.json` and generated per-instance router configs live in that
shared cache, alongside version/platform/architecture-specific binaries.
Owner publication and stale recovery are exclusive. Recovery checks the
recorded ports even if a new start requests another TCP port. Acquisition is
bounded to 150 seconds, individual downloads to 120 seconds, and spawned-child
readiness to 10 seconds. Generated configs never read `.onboarding/router.json5`.

Native Windows x64 browser startup downloads the GNU `zenohd.exe` and matching
remote-API DLL, loads that DLL by absolute path, and disables router SHM.
macOS and Linux use the standalone remote-API bridge. Windows ARM64 has no
pinned artifact. Native headless Zenoh still requires Linux x64/ARM64 and its
verified addon; use WSL2 with server, router, and headless all inside WSL2.
Native Windows and WSL2 have separate ownership files. A mixed setup needs
explicit endpoints and a manually managed router. Windows release and live
acceptance are deferred.

`npm run dev`, `npm start`, and `cev-sim supervisor` acquire the listener for
their process lifetime. An external-realtime CLI run attaches to that listener,
or owns it only until its run exits. Stderr reports `starting`, `ready ... owner`,
`attached`, and `stopping`; CLI stdout stays JSON. An attached command cannot
stop the owner's child. Keep the server or supervisor running when the listener
must survive a short run. Policy runs, validate, replay, and Node/UI tests do
not acquire or download a router.

`CEV_SIM_ZENOH_ROUTER=off` opts out when a test or manually started router owns
the ports. An explicit browser file or TCP connect list with another endpoint
also skips automatic startup and keeps the supplied addresses. Invalid explicit
configuration is an error. Owner records store a stable machine id: Linux
`/etc/machine-id`, macOS `IOPlatformUUID`, or Windows `MachineGuid`. A DHCP
hostname change does not make a record ambiguous. Legacy records without a
machine id remain readable. A record from another machine is deleted only when
its recorded ports are closed; a listener on those ports is left in place.
Foreign listeners, changed process identities, and ambiguous owner files are
refused, and no alternate port is selected. When the parent is gone, a later
start may stop the recorded child if its PID, birth time, and executable path
all match the cache router. No other process is killed. The TCP override
`CEV_SIM_ZENOH_TCP_PORT` accepts 1–65535 except 10000. The Rust stack keeps
port 7447 unless its own `CEV_ZENOH_ENDPOINT` is set. Leave the default port
unless changing both sides.

There is no ownership transfer between a live parent and a new process. POSIX
shutdown sends the owned child SIGTERM, waits up to five seconds, then
escalates to SIGKILL. `SIGINT`, `SIGTERM`, and `SIGHUP` stay installed for the
server, supervisor, and external-realtime command, so a repeated interrupt
continues that shutdown instead of abandoning the child. Windows terminates
the owned child handle. Records are removed only after confirmed child exit.
If the child dies, browser sessions pause and retry; headless required
publication fails as infrastructure. Restart the owner and Rust sessions to
recover.

Values remain native until `ProtobufRouteRuntime` applies the admitted mapping and
encodes wire bytes. Capture metadata supplies frame, integer simulation time, and
sequence; values contain no ROS headers. Use decimal strings for exact uint64
fields. Sensor delivery requires synchronous bounded transport acceptance.

`./install.sh --onboarding` remains an optional POSIX prefetch; it writes no
endpoint files or environment settings. Windows can prefetch with
`node --experimental-default-type=module scripts/install-onboarding.mjs`.
Removed orchestrator flags are rejected. The independent
SDK probe is `scripts/protobuf-probe.mjs`; the real browser gate is
`npm run test:zenoh-browser`. Hardware release gates remain in
[Headless release](headless-release.md).

## Historical artifacts

Older interface@1 and ROS-shaped bundles remain inspectable through
`server/headless/RunBundleInspection.js`. Their frozen contracts live under
`server/interfaces/historical/`. Explicit reviewed native adoption creates new
native resources and preserves the originals. Production verification and browser
preparation reject older execution formats. There is no runtime legacy mode.
