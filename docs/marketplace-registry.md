# Marketplace registry operations

The registry is a single-writer, filesystem-backed TUF 1.0.31 repository.
MKT-13 adds publisher-signed DSSE release targets, scoped bearer
authentication, HTTPS/mTLS hosting, authenticated writes, tracks, yanks,
advisories, and publisher compromise response. It remains separate from the
simulator and never installs or executes packages.

## Commands

The three entry points are equivalent and use the same parser:

```text
cev-sim-marketplace <command>
cev-mkt <command>
cev-sim mkt <command>
```

Initialize and administer a registry with:

```text
cev-mkt init --root /srv/cev-marketplace --offline-root-key /secure/cev-marketplace-root.pem
cev-mkt validate artifact --content-kind plugin --file plugin.json
cev-mkt admit artifact --root /srv/cev-marketplace --content-kind plugin --file plugin.json
cev-mkt validate artifact --content-kind collection --file collection.json
cev-mkt admit artifact --root /srv/cev-marketplace --content-kind collection --file collection.json
cev-mkt admit preview --root /srv/cev-marketplace --media-type image/png --file preview.png
cev-mkt admit item --root /srv/cev-marketplace --file item.json
cev-mkt key generate --private-key publisher.pem --public-key publisher-key.json
cev-mkt publisher register --root /srv/cev-marketplace --file publisher.json
cev-mkt sign release --file release.json --private-key publisher.pem --output release.dsse.json
cev-mkt admit release --root /srv/cev-marketplace --file release.dsse.json --track stable
cev-mkt token create --root /srv/cev-marketplace --subject publisher \
  --publisher-id com.example.publisher --namespace com.example --scope publish:blob,publish:item,publish:release,manage:track,manage:yank
cev-mkt publisher set-key-status --root /srv/cev-marketplace \
  --publisher-id com.example.publisher --key-id SHA256 --status retired
cev-mkt list --root /srv/cev-marketplace --kind releases
cev-mkt verify --root /srv/cev-marketplace
cev-mkt tuf refresh --root /srv/cev-marketplace
cev-mkt tuf rotate-root --root /srv/cev-marketplace \
  --current-root-key /secure/cev-marketplace-root.pem \
  --new-root-key /secure/cev-marketplace-root-next.pem
cev-mkt serve --root /srv/cev-marketplace --host 127.0.0.1 --port 8080
cev-mkt serve --root /srv/cev-marketplace --host 10.0.0.20 --port 8443 \
  --tls-key server-key.pem --tls-cert server-cert.pem --tls-ca private-ca.pem \
  --mtls --read-auth --writable
cev-mkt gc --root /srv/cev-marketplace --dry-run --grace-hours 24
```

`init` requires an explicit offline root-key path outside the registry root. It
creates an Ed25519 PKCS#8 key with mode `0600` when absent, or validates and
reuses an existing key. Symlinks, group/other permissions, non-Ed25519 keys,
and paths inside the registry are rejected. Re-running `init` is idempotent
only when the requested registry UUID and current root key agree. The command
does not upgrade or sign an old raw-release catalog. A new registry declares
`releaseAuthority: "publisher-dsse"`; an old catalog without this marker is
`UPGRADE_REQUIRED` and must be republished under a new registry UUID.

The DSSE payload type is
`application/vnd.cev-sim.marketplace-release+json`. The payload is the exact
canonical release bytes. Its artifact descriptor still binds exact artifact
SHA-256 and size. Only an active registered Ed25519 key may admit a new
envelope. Retired/revoked keys and public bytes remain available for historical
verification.

`tuf refresh` gives every online delegated role, snapshot, and timestamp a new
version and expiration. `tuf rotate-root` publishes an old/new overlap root,
switches top-level targets to the new key, then publishes a final new-only
root. Every numbered root is retained for sequential client updates.

Commands write exactly one JSON result to stdout. Failures write one redacted
JSON record to stderr and use a nonzero exit code. `serve` writes one startup
record, remains quiet, and closes cleanly on `SIGINT` or `SIGTERM`.

For a collection, admit every exact member release first. The canonical
`cev-sim.marketplace-collection@1` artifact contains only ordered
`{release, group?}` members; same-registry identity is structural because no
source or registry field is admitted. The collection release must repeat the
exact member set in `dependencies`, including item ID, version, and artifact
digest. Admission rejects missing members, extra members, version/digest
mismatches, unknown cross-registry fields, self-reference, and noncanonical or
over-JSON-limit bytes. Registry verification reopens the stored artifact and
reapplies the same set-equality and admitted-member checks before reporting the
catalog healthy. Normal catalog and TUF publication then makes the collection
snapshot-consistent with its members.

## Layout and key custody

```text
registry.json
.writer-lock/owner.json
auth/tokens.json
blobs/sha256/<digest>
blob-records/sha256/<digest>.json
targets/items/<itemId>/<itemHash>.json
targets/publishers/<publisherId>/<publisherHash>.json
targets/releases/<itemId>/<releaseVersion>/<releaseHash>.json
targets/advisories/<advisoryId>/<advisoryHash>.json
catalog/current.json
catalog/revisions/<revision>-<catalogHash>.json
transactions/<transactionId>/
staging/uploads/<operationId>/
tuf/
  metadata/<version>.root.json
  metadata/<version>.targets.json
  metadata/<version>.<catalog|items|publishers|releases|advisories>.json
  metadata/<version>.snapshot.json
  metadata/<version>.timestamp.json
  metadata/timestamp.json
  targets/catalog/<sha256>.catalog.json
  targets/items/<sha256>.<itemId>.json
  targets/publishers/<sha256>.<publisherId>.json
  targets/releases/<itemId>/<sha256>.<releaseVersion>.json
  keys/online/<catalog|items|publishers|releases|advisories|snapshot|timestamp>.pem
  transactions/<transactionId>/
```

Registry directories use mode `0700`; registry files and online private keys
use mode `0600`. Bearer tokens are returned once and only SHA-256 digests are
stored. Authentication compares a real or dummy digest with
`timingSafeEqual`, so an unknown token ID does not select a shortcut. The seven online keys are registry backup material. The offline
root key is deliberately external and must not be copied into a registry
backup. Back it up through a separate offline-key custody process.

TUF uses consistent snapshots, Ed25519 signatures, and threshold 1. Root and
top-level targets are offline-root signed. Catalog, item, release, advisory,
snapshot, and timestamp roles have separate online keys. Timestamp expires in
48 hours, snapshot in 14 days, delegated roles in 90 days, and root/top-level
targets in 365 days. Release targets are immutable canonical DSSE envelopes;
the delegated `publishers` targets authenticate signer history and the
`advisories` targets carry immutable warn/yank/block/clear records.

## Publication and recovery

`catalog/current.json` is the internal authoring visibility point. Public
readers never resolve aliases from it. They resolve through
`tuf/metadata/timestamp.json` to snapshot, top-level targets, and the
terminating delegated roles.

Catalog mutations first complete the MKT-03 catalog transaction while holding
the serialized writer queue. TUF publication then stages exact signed bytes in
`tuf/transactions/<transactionId>/`, durably records the base and target
timestamp identities plus every ordered write, publishes immutable targets and
versioned metadata, and atomically replaces `timestamp.json` last. Root
rotation stages the final root as a post-timestamp write in the same journal.

On open, catalog journals recover first and TUF journals recover second. A
journal is completed when the current timestamp matches its base and cleaned
when it matches its target. Any other timestamp, corrupt staged byte, missing
destination, conflicting immutable file, or incomplete journal fails closed
with `RECOVERY_REQUIRED`. Readers already running continue to see the previous
complete timestamp until the switch. `/readyz` remains unavailable while the
public catalog and `catalog/current.json` are unreconciled.

## HTTP API and transport

Loopback HTTP remains supported. A non-loopback bind requires TLS and read
authentication unless the operator supplies the explicit
`--unsafe-development-lan` override. Optional mTLS adds a client-certificate
transport check but never replaces bearer authorization. The server emits no
CORS headers and never returns bearer values.

```text
GET      /.well-known/cev-sim-marketplace
GET      /v1/catalog
GET      /v1/items/{itemId}
GET      /v1/items/{itemId}/releases/{releaseVersion}
GET      /v1/publishers/{publisherId}
GET      /v1/advisories/{advisoryId}
GET|HEAD /v1/blobs/sha256/{digest}
POST     /v1/artifacts/{contentKind}
PUT      /v1/items
PUT      /v1/releases
PUT      /v1/publishers
POST     /v1/publishers/{publisherId}/keys
PUT      /v1/publishers/{publisherId}/keys/{keyId}/status
POST     /v1/publishers/{publisherId}/keys/{keyId}/compromise
POST     /v1/tokens
DELETE   /v1/tokens/{tokenId}
PUT      /v1/items/{itemId}/tracks/{stable|beta}
PUT      /v1/items/{itemId}/yanks
PUT      /v1/advisories
GET      /tuf/metadata/{strict-filename}
GET      /tuf/targets/{strict-consistent-target-path}
GET      /healthz
GET      /readyz
```

All content has an exact content type and length, a strong SHA-256 ETag, and
`X-Content-Type-Options: nosniff`. Mutable aliases use `Cache-Control:
no-cache`; numbered metadata, consistent targets, and blobs use immutable
caching. The server emits no CORS headers. Raw request targets with queries,
fragments, percent encoding, backslashes, duplicate or dot segments, NULs, or
noncanonical identifiers are rejected.

Blob reads stream from a verified regular-file handle. They support one normal
or suffix byte range, `If-Range`, and `If-None-Match`. Multiple, malformed,
unsatisfiable, or greater-than-64-MiB ranges return `416` with
`Content-Range: bytes */<size>`. An unrestricted full `GET` is not subject to
the range ceiling.

`/healthz` reports only process health. `/readyz` verifies the stable published
timestamp chain, expirations, signatures, metadata hashes, canonical targets,
referenced CAS bytes, registry UUID, and internal/public catalog reconciliation.
The discovery document publishes the newest numbered bootstrap root and the
lowercase SHA-256 fingerprint of its exact served bytes.

## Backup cautions

Stop all registry writers before taking or restoring a filesystem backup.
Copy the complete registry root as one unit, including online keys, numbered
root history, immutable TUF files, and both journal trees. Exclude the external
offline root key and manage it separately. Never restore `timestamp.json`,
`catalog/current.json`, CAS, keys, targets, metadata, or transactions from
different backup points.

Preserve modes, registry UUID, exact bytes, and directory names. After restore,
run `cev-mkt verify --root DIR` before serving. Do not delete a transaction or
numbered root to make recovery pass. Preserve an ambiguous root and investigate
from a read-only copy.
