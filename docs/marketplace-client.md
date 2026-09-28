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
  metadata/{root,timestamp,snapshot,targets,catalog,items,releases,advisories}.json
  targets/catalog/catalog.json
  targets/items/<itemId>.json
  targets/releases/<itemId>/<releaseVersion>.json
cache/<sourceId>/staging/<operationId>/
```

Directories use mode `0700`; files use mode `0600`. Credential documents are
immutable and contain only a bounded bearer token. API responses replace the
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
snapshot, top-level targets, terminating catalog/item/release/advisory
delegations, canonical target bytes, exact delegated target sets, and every
catalog summary. It eagerly downloads the catalog and every referenced item
and release document. MKT-05 does not cache artifacts, previews, plugin
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

## Read-only discovery

MKT-06 adds a read model over the currently visible verified snapshots. `GET
/api/marketplace/status` identifies the enabled workspace as `read-only` with
`canInstall: false`. `GET /api/marketplace/discover` accepts only `q`,
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
evaluate compatibility or infer installation membership.

`GET /api/marketplace/items/:sourceId/:itemId` returns the complete verified
item and selected release, exact tracks, releases, yanks, health, and an
ephemeral verification summary. That summary names the registry UUID, pinned
root fingerprint, verification time, root version, and authorized TUF
`releases` role/version/expiry/key IDs. These are registry distribution signer
details. `publisherId` is a declared publisher identifier; publisher DSSE does
not exist until MKT-13.

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
navigation. Discover, Installed, and Sources are explicit workspace tabs.
Descriptions and changelogs use pinned CommonMark rendering with raw HTML and
images suppressed; only HTTP(S) links are admitted and external links use
`noopener noreferrer`. Compatibility is presented only as declared
requirements. Every content action is disabled with an MKT-07 explanation,
and Installed states plainly that no marketplace ledger or receipt exists.

Source mutations use the current source revision. A conflict reloads current
state and requires review instead of replaying the mutation. Add Source
separates trust creation from refresh, displays the complete bootstrap
fingerprint and registry limits, and requires exact fingerprint entry. Bearer
tokens remain only in transient password-field component state and are cleared
on success, cancellation, or unmount.

## Operations

- Preview trust, then add the source with its exact registry UUID and root
  fingerprint.
- Call `POST /sources/:sourceId/refresh` explicitly. Startup never refreshes.
- Use optimistic `expectedRevision` values for add, update, remove, and
  refresh operations. A conflict returns HTTP 409 and `currentRevision`.
- Rotate credentials through `PATCH /sources/:sourceId`; omit `credential` to
  preserve it, send `null` to clear it, or send a bearer object to replace it.
- Remove and re-add a source to change its origin or trust identity.

Marketplace source, trust, health, credential, and cache documents are local
operational state. They do not enter `worldHash`, `resolvedHash`,
`simulationSemanticHash`, `episodeHash`, `trajectoryHash`, package hashes, or
run-package identity.
