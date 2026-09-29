# Marketplace Trust Client

MKT-05 adds the server-side trust client used by the simulator. It is enabled
only when `CEV_SIM_MARKETPLACE_ENABLED=1` or `true`; the default remains off.
When disabled, `server/App.js` does not construct the service, mount
`/api/marketplace`, create marketplace storage, or make registry requests.

## Trust workflow

`POST /api/marketplace/sources/preview` accepts a canonical registry origin and
an optional write-only bearer credential. The backend fetches only
`/.well-known/cev-sim-marketplace` and the numbered bootstrap root declared by
that document. It rejects redirects, queries, fragments, userinfo, unexpected
paths, and origin changes. The response exposes the registry UUID, exact
SHA-256 root fingerprint, root version and expiry, authentication declaration,
and registry limits.

Adding a source repeats discovery and root verification. The submitted
`registryId` and `trustedRootFingerprint` must exactly match that second
preview. Source creation records trust but does not refresh. The source origin,
registry UUID, bootstrap fingerprint, source ID, and credential reference are
immutable; changing trust requires removing and adding the source again.

Root rotation never rewrites the pinned fingerprint. Refresh begins from the
original bootstrap root, or from a completely verified current cache, and
verifies each numbered root through the latest root with both old-root and
new-root authorization as required by TUF.

## Local storage

All client state is below `CEV_SIM_DATA_DIR/marketplace/`:

```text
sources.json
credentials/<credentialRef>.json
trust/<sourceId>/root.json
health/<sourceId>.json
cache/<sourceId>/current.json
cache/<sourceId>/snapshots/<snapshotId>/
  manifest.json
  roots/<version>.root.json
  metadata/{root,timestamp,snapshot,targets,catalog,items,publishers,releases,advisories}.json
  targets/catalog/catalog.json
  targets/items/<itemId>.json
  targets/publishers/<publisherId>.json
  targets/releases/<itemId>/<releaseVersion>.json
  targets/advisories/<advisoryId>.json
cache/<sourceId>/staging/<operationId>/
installed.json
ownership.json
policy.json
executable-provenance.json
plans/sha256/<planHash>.json
jobs/<jobId>/{snapshot.json,work/}
jobs/<jobId>/work/asset-packages/<preparationHash>/{preparation.json,generated/}
artifacts/sha256/<artifactSha256>
artifact-records/sha256/<artifactSha256>.json
quarantine/<quarantineId>/{artifact,record.json}
receipts/sha256/<receiptHash>.json
transactions/<transactionId>/{journal.json,writes/,completions/<operationId>.json}
```

Directories use mode `0700`; files use mode `0600`. Credential documents are
immutable and may contain a bounded bearer token, private CA bundle, and
optional client certificate/private key. The fixed-origin Node transport uses
that material directly for HTTPS/mTLS; it is never projected into source,
cache, policy, health, log, or browser responses. API responses replace the
internal `credentialRef` with `credentialConfigured`; logs, health, cache
manifests, and public errors never contain tokens, authorization headers,
registry response bodies, or nested causes.

`sources.json` is the revisioned visibility point for configured trust.
Credential and bootstrap-root files are durable before a new source becomes
visible. A credential update publishes a new immutable file, switches the
source reference atomically, and then removes the old file. Source removal
first removes the source from `sources.json`, then removes its trust,
credential, health, and cache state. Startup deletes unreferenced credentials,
orphan source state, and incomplete staging directories, while symlinks,
unexpected nodes, noncanonical documents, and trust mismatches fail closed.

## Refresh and offline reads

Refresh uses `tuf-js@6.0.0` with a fixed-origin fetcher and only the declared
TUF metadata and consistent-target paths. It verifies root history, timestamp,
snapshot, top-level targets, terminating catalog/item/publisher/release/advisory
delegations, canonical target bytes, exact delegated target sets, and every
catalog summary. It eagerly downloads the catalog and every referenced item,
publisher, release envelope, and advisory. A release payload is verified
against its TUF-authenticated publisher key before its catalog summary is
accepted. MKT-05 does not cache artifacts, previews, plugin
packages, vehicles, run packages, or other payload bytes.

The complete staged tree is fsynced and made owner-only before it is renamed to
an immutable snapshot. Replacing `current.json` is the only cache visibility
point. Any network, verification, storage, or publication failure leaves the
previous current snapshot visible.

Signed expiry is evaluated with one operation time and `expires <= now` is
expired. Health precedence is `disabled`, `untrusted`, `expired`, `offline`,
`stale`, then `ready`. A verified document already present in the current
snapshot remains readable after expiry with `fresh: false`. `requireFresh:
true` returns `METADATA_EXPIRED`; an absent item or release cannot be resolved
from expired metadata. There is no unsigned age threshold.

## Discovery and coordinator status

MKT-06 adds a read model over the currently visible verified snapshots. MKT-07
changes `GET /api/marketplace/status` to `mode: coordinator`; `canInstall` is
true only when the configured adapter registry has a complete lifecycle.
MKT-08 activates the production plugin lifecycle, so normal enabled builds
return `canInstall: true` and plugin detail returns
`eligibility.lifecycleAvailable: true`. Vehicle, run-template, and run-package
adapters remain read-only until MKT-09. `GET /api/marketplace/discover` accepts only `q`,
`track`, `contentKind`, `sourceId`, `publisherId`, `license`, `offset`, and
`limit`. Stable is the default exact signed track; beta must be selected
explicitly. Search covers display name, summary, item ID, declared publisher
ID, categories, and tags. SPDX filtering is exact, and ordering is source
priority/source ID followed by display name/item ID/release version.

Each read reverifies the immutable snapshot from its pinned bootstrap trust
root. Missing snapshots remain visible as unavailable sources. A corrupted,
untrusted, or locally unrecoverable snapshot fails the complete read instead
of disappearing from results. Offline and expired verified entries remain
browsable with `fresh: false` and their source health. The read model does not
infer installation membership. Release detail now evaluates the selected
release against the live host profile and returns `eligibility` with lifecycle
availability, compatibility, ordered issues, and warnings.

`GET /api/marketplace/items/:sourceId/:itemId` returns the complete verified
item and selected release, exact tracks, releases, yanks, health, and an
ephemeral verification summary. That summary names the registry UUID, pinned
root fingerprint, verification time, root version, and authorized TUF
`releases` role/version/expiry/key IDs. These are registry distribution signer
details. `publisherId` is bound to the verified publisher target and the DSSE
signing key shown by release detail.

## MKT-13 policy, provenance, and updates

`MarketplacePolicyStore` retains, per registry UUID, the highest verified
timestamp/snapshot identity, immutable advisory bytes and hashes, effective
yanks/blocks/clears, publisher approvals, and local operator overrides. Policy
ingestion occurs before a refreshed cache pointer is published. Removing or
disabling a source removes neither rollback floors nor retained policy.

`MarketplaceExecutableProvenanceStore` maps each canonical plugin
`packageHash` to exact signed source/registry/publisher/release origins. Install
transactions record provenance before installed membership can become visible.
`MarketplaceExecutablePolicy` treats manual-only ownership as the explicit
local trust path; Marketplace provenance requires an approved publisher and no
effective block. Another source, manual co-ownership, restart, or source
removal cannot evade a canonical package block. Local allow overrides require
a reason and remain nonsemantic.

`MarketplaceUpdateModel` groups installed releases by exact
`sourceId + registryId + itemId`. Its candidate is the greater stable/beta
track release in that same verified identity and must be neither yanked nor
blocked. Preflight pins old receipt hashes and installed revision plus the
candidate snapshot and policy revision. Final planning reopens the old exact
artifact and hashes capability, executable, compatibility, rights, and mapping
deltas into the final plan. Commit revalidates every pin and adds the candidate
as a new direct owner through the normal journal; it never removes or rewrites
the old release, receipt, mapping, authoring record, lock, or active session.

Additional local routes expose `GET /updates`, `GET /advisories`,
`GET /policy`, revisioned publisher approvals and operator overrides, and
`POST /policy/packages/:packageHash/authorize` for loading boundaries.
`GET /policy/events` streams policy revisions. Open browser authoring sessions
reauthorize their loaded package hashes on each revision and raise the global,
accessible reload-required banner when a package becomes blocked; existing
evaluation is not forcibly unloaded, but further activation or reset is denied.

## Preview proxy

The browser never receives registry credentials or registry URLs for preview
fetching. The local backend first finds the requested digest in the verified
item's `previews` array, then permits only the exact configured-origin path
`/v1/blobs/sha256/<digest>`. Redirects, changed origins, arbitrary paths,
queries, fragments, and over-limit reads fail closed. Returned bytes must
match the signed media type, byte length, and SHA-256 descriptor and must pass
the raster preview inspector again. SVG, HTML, masquerading, malformed,
animated, multi-page, trailing-data, over-byte, and over-pixel inputs are not
served.

Successful preview responses use the exact media type and length, a quoted
digest ETag, `nosniff`, same-origin resource policy, and private immutable
caching. Conditional requests return 304. Preview bytes are not persisted by
MKT-06; offline catalog text remains available while the browser shows an
accessible preview placeholder.

## Browser workspace

The browser probes the enabled-only status route before exposing Marketplace
navigation. Discover, Updates, Installed, Security, and Sources are explicit
workspace tabs.
Descriptions and changelogs use pinned CommonMark rendering with raw HTML and
images suppressed; only HTTP(S) links are admitted and external links use
`noopener noreferrer`. Compatibility shows both declared requirements and the
backend eligibility verdict. Content actions remain disabled when the
production lifecycle is unavailable and name the owning MKT-08/09 boundary.
Eligible adapters use a two-stage dialog: immutable metadata/DAG/size review,
cancellable download/inspection progress, final rights/conflicts/mappings
review, and an explicit exact-plan commit. Commit and recovery cannot be
dismissed or cancelled. Installed shows exact release/source/registry/digest
identity, dependency locks, mappings, receipt history, status, and
membership-only removal. Plugin review names its package, runtime, and UI
hashes; CAS/library/owner actions; coexisting packages; required capabilities;
and the fact that no runtime grants are added. Update review shows the hashed
capability, executable, compatibility, rights, and mapping comparison. Yanked
exact installation requires explicit acknowledgement; blocked releases expose
no install control. Security retains advisories and approvals after source
removal. Plugin receipts render those
exact mapping fields instead of raw JSON.

Source mutations use the current source revision. A conflict reloads current
state and requires review instead of replaying the mutation. Add Source
separates trust creation from refresh, displays the complete bootstrap
fingerprint and registry limits, and requires exact fingerprint entry. Bearer
tokens remain only in transient password-field component state and are cleared
on success, cancellation, or unmount.

## Installation coordinator

The installation API is:

- `POST /install-plans`, then `POST /install-jobs`;
- `GET /install-jobs/:jobId` and revisioned `job` SSE events from
  `/install-jobs/:jobId/events`;
- explicit `/commit` and precommit `/cancel` job mutations;
- post-commit `POST /install-jobs/:jobId/resume`,
  `POST /install-jobs/:jobId/replan`, and paginated/status-filtered
  `GET /install-jobs/:jobId/operations`;
- `GET /installed`, sanitized private-owner projection
  `GET /installed-ownership`, `GET /receipts/:receiptHash`, and exact installed
  membership `DELETE`.

Preflights contain no creation timestamp in hashed bytes. They pin the source,
registry, trusted root, immutable snapshot, catalog revision/hash, root release,
complete dependency-first DAG, release hashes, artifact descriptors,
compatibility, capabilities, warnings, installed revision, and host-profile
hash. Jobs persist every revision before notification and use phases `queued`,
`download`, `verify`, `plan`, `awaiting-confirmation`, `commit`, `recover`,
`needs-attention`, `failed`, `cancelled`, and `complete`. Progress includes
`currentOperation`, `completedOperations`, and `totalOperations`. SSE event IDs
are job revisions and a reconnect receives the current persisted snapshot
first. A stream may close at `needs-attention`; Resume establishes a new stream.

Artifact bytes stream only from the exact configured-origin
`/v1/blobs/sha256/<digest>` path. Complete bounded digest or adapter failures
enter redacted quarantine; oversized or incomplete staging is deleted.
Verified CAS bytes may be reused offline. Downloaded but uninstalled bytes and
historical receipts remain for MKT-15 garbage collection.

The transaction journal fixes one install timestamp, exact receipt bytes, the
installed- and ownership-ledger base/target hashes, final plan, and complete ordered adapter
operation set before authoring starts. Each operation has a hash-derived ID and
a strict durable completion marker. Recovery skips it only after the adapter
verifies the current result. Receipt publication and dependency-first
idempotent operations precede atomic installed-ledger replacement. Job
completion precedes journal cleanup. Startup replays base or target states and
fails with `RECOVERY_REQUIRED` for every other ledger state. Live failures after
the journal is durable enter `needs-attention`; cancellation remains precommit
only.

## Collections and installation ownership

Collection preflight expands exact signed dependencies without opening the
collection artifact. Every graph node has a private disposition: `requested`
and `collection` nodes acquire installed ownership, while `artifact-only`
transitive nodes are downloaded, hashed, statically inspected, and retained in
cache without adapter planning, receipts, or installed membership. Final
planning opens the canonical collection artifact, requires its member set to
equal the signed dependencies exactly, and retains its ordered group labels for
review. Collection compatibility is non-executable; requested member
compatibility and lifecycle availability decide whether commit is possible.

`ownership.json` is an owner-only, canonical private document whose revision
always equals `installed.json`. `memberships` associates each exact installed
release with a direct owner and/or one or more exact collection owners;
`collections` records direct members and nullable group labels. Existing
installed ledgers migrate in place to direct ownership without rewriting public
installed state or receipts. `GET /installed` remains byte-contract compatible;
`GET /installed-ownership` exposes only this sanitized projection.

Commit processes dependency-first release groups. Each member's frozen adapter
operations and completion markers precede its immutable receipt; the collection
verification operation and receipt follow all requested members. Ownership is
published next and `installed.json` remains the final visibility point. Removing
an exact route removes only a direct owner. A collection losing its final owner
removes its member edges recursively; entries with another direct or collection
owner remain installed. Removal never deletes receipts, cached artifacts,
plugin CAS/runtime bytes, authoring records, or visual roots.

## Asset-package lifecycle

`asset-pack` details expose independent eligibility decisions. Downloadable
covers verified metadata/cache state and the declared 8 GiB ceiling. Importable
is `requires-inspection` until strict archive, closure, rights, and mapping
planning succeeds. Executable is always `not-applicable`; host execution
compatibility never blocks authoring-content download or import. `canInstall`
remains the compatibility projection for existing clients.

`POST /api/storage/editor-assets/packages/export` accepts exact
`{roots:[{assetId,revision}]}` and streams deterministic
`cev-sim.asset-package@1` USTAR. Export takes one serialized editor-store
snapshot, traverses pinned child/generated-proxy revisions and all visual-use
dependencies, verifies export rights and bytes, and emits no success response
until closure validation completes.

Import final plans show requested roots, asset/use/blob counts, source-to-local
revision mappings, required upload/derivative rights, conflicts,
`preparationHash`, and the ordered operation count. Sparse selected source
revisions map contiguously to `1..N`; local IDs start at
`<sourceId>-mkt-<12 hex>` and extend four digest characters on occupied,
nonidentical history. Prepared v2 output rewrites child and generated-proxy
pins, compiles child-first, and records local content, model-use, metric, and
geometry hashes in the frozen receipt mapping shape.

Visual uses publish dependency-first, followed by editor revisions in asset-DAG
order. Rights are rechecked for every affected operation. Resume verifies
completion markers and roots; Replan uses cached artifact/preparation state and
never rolls back completed authoring. Removing installed membership does not
delete imported editor revisions, visual uses, blobs, or roots.

## Plugin lifecycle and ownership

The MKT-08 client registry uses `createPluginLifecycleAdapter()` for `plugin`
and retains read-only adapters for vehicle, run-template, and run-package.
`server/App.js` injects the same `StorageService.plugins` instance used by the
HTTP/MCP plugin control plane; ownership migration finishes before Marketplace
transaction recovery starts. Registry admission continues using the separate
read-only registry adapter, including the same static release/manifest checks.

Planning snapshots the private plugin-library revision and records exact
plugin/package/runtime/UI identity, one deterministic Marketplace owner,
coexisting package hashes, CAS/library/owner add-or-reuse decisions, required
manifest capabilities, and an empty `grantsAdded` array. Commit reopens,
rehashes, reparses, and compares the artifact with that frozen plan before
publishing verified plugin CAS and ownership. It never calls a plugin loader,
runtime module source, or browser UI import path.

`plugins/library.json` version 2 tracks a manual flag and sorted Marketplace
owners per exact package. Version-1 entries migrate atomically to manual
ownership without changing the revision. Every real ownership mutation bumps
the revision even when public membership is unchanged. Removing a Marketplace
installation removes only its exact owner; manual and independent Marketplace
owners remain. The last owner hides the package from the public library but
does not remove plugin CAS, runtime materializations, Marketplace artifacts,
receipts, or dependencies.

Removal journals carry an optional immutable `adapterRemovals` record. The
installed ledger target is published first and the plugin owner is removed
second. Recovery therefore handles both a crash before owner removal and a
crash after idempotent owner removal. The receipt contains all owner identity
needed for removal, so removal continues to work after its source and verified
metadata cache have been deleted.

## Operations

- Preview trust, then add the source with its exact registry UUID and root
  fingerprint.
- Call `POST /sources/:sourceId/refresh` explicitly. Startup never refreshes.
- Use optimistic `expectedRevision` values for add, update, remove, and
  refresh operations. A conflict returns HTTP 409 and `currentRevision`.
- Rotate credentials through `PATCH /sources/:sourceId`; omit `credential` to
  preserve it, send `null` to clear it, or send a bearer object to replace it.
- Remove and re-add a source to change its origin or trust identity.
- A source with a nonterminal installation job cannot be removed.
- Cancel only before commit. Use Resume or Replan for `needs-attention`; do not
  delete transaction state manually.

Marketplace source, trust, health, credential, cache, installation, receipt,
artifact-record, quarantine, job, and transaction documents are local
operational state. They do not enter `worldHash`, `resolvedHash`,
`simulationSemanticHash`, `episodeHash`, `trajectoryHash`, package hashes, or
run-package identity.
