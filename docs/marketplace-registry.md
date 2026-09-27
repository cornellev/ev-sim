# Offline marketplace registry

MKT-03 provides a single-host, filesystem-backed registry for offline
administration. It has no HTTP listener, authentication, TUF metadata,
installation behavior, or LAN access. MKT-04 owns the first loopback read API.

## Commands

The three entry points are equivalent and use the same parser:

```text
cev-sim-marketplace <command>
cev-mkt <command>
cev-sim mkt <command>
```

Initialize a registry, admit content, inspect it, and plan cleanup with:

```text
cev-mkt init --root /srv/cev-marketplace
cev-mkt validate artifact --content-kind plugin --file plugin.json
cev-mkt admit artifact --root /srv/cev-marketplace --content-kind plugin --file plugin.json
cev-mkt admit preview --root /srv/cev-marketplace --media-type image/png --file preview.png
cev-mkt admit item --root /srv/cev-marketplace --file item.json
cev-mkt admit release --root /srv/cev-marketplace --file release.json --track stable
cev-mkt list --root /srv/cev-marketplace --kind releases
cev-mkt verify --root /srv/cev-marketplace
cev-mkt gc --root /srv/cev-marketplace --dry-run --grace-hours 24
```

Commands write exactly one JSON result to stdout. Failures write one redacted
JSON record to stderr and use a nonzero exit code. Input files must be ordinary
regular files, not symlinks. `gc` requires the literal `--dry-run` flag and
never deletes CAS bytes in MKT-03.

## Layout

```text
registry.json
.writer-lock/owner.json
blobs/sha256/<digest>
blob-records/sha256/<digest>.json
targets/items/<itemId>/<itemHash>.json
targets/releases/<itemId>/<releaseVersion>/<releaseHash>.json
catalog/current.json
catalog/revisions/<revision>-<catalogHash>.json
transactions/<transactionId>/
staging/uploads/<operationId>/
```

Directories use mode `0700`; files use mode `0600`. Artifact and preview bytes
are immutable and addressed by their SHA-256 digest. Item and release targets
are immutable canonical marketplace JSON. `catalog/current.json` is the only
visibility point for item, release, and track changes. An empty registry begins
at catalog revision 1; blob admission does not change that revision.

Only plugin, vehicle, run-template, and run-package artifacts have MKT-03
adapters. Environment, asset-pack, and collection artifacts fail admission
until their versioned adapters exist. Preview admission accepts only exact,
single-frame PNG, JPEG, or WebP bytes up to 8 MiB and 64 megapixels.

## Writer ownership and recovery

An open registry command owns `.writer-lock` for its complete lifetime. The
owner record contains a PID, hostname, random token, and acquisition time. A
live owner is a conflict. A dead owner can be reclaimed only on the same host,
under a second exclusive recovery directory and after its token is rechecked.
Malformed or cross-host ownership is ambiguous and fails closed.

Catalog mutations stage all bytes and durably write a transaction journal.
They publish immutable targets, publish the revision snapshot, then atomically
replace `catalog/current.json`. On open, recovery uses the current catalog
hash:

- target hash: verify every destination and remove the completed journal;
- base hash: replay missing immutable writes and finish forward;
- any other hash or conflicting destination: stop with `RECOVERY_REQUIRED` and
  retain the evidence.

The service never overwrites or silently repairs corrupt CAS content.
Verification rehashes CAS bytes, reconstructs catalog summaries from canonical
targets, validates dependencies and previews, and reruns artifact inspection.

## Backup cautions

Stop all registry writers before taking or restoring a filesystem backup.
Copy the complete root as one unit; never restore `catalog/current.json`, CAS,
blob records, targets, or transactions independently. Preserve file modes,
the registry UUID, hard byte identity, and directory names. After restore, run
`cev-mkt verify --root DIR` before publishing or trusting the copy.

Do not delete a transaction directory to make recovery pass. Do not copy a
live `.writer-lock` to another host. If recovery reports an ambiguous owner,
an unexpected current-catalog hash, or a conflicting immutable destination,
preserve the root and investigate from a read-only copy.
