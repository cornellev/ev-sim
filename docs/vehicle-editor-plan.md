# Vehicle editor plan

This document records the vehicle-editor program decisions that are in force.
VEH-01 through VEH-04 are implemented. Later packages add the plan view,
URDF, and editor chrome.

## Status

- Implemented: **VEH-01** — version 3 contract, standard-axle checks, migration
  planning, and the vehicle document session.
- Implemented: **VEH-02** — canonical GLB ingestion and the shared vehicle
  model loader.
- Implemented: **VEH-03** — vehicle staging, publication transactions, and
  guarded migration.
- Implemented: **VEH-04** — placed-node measurement, wheel binding commands,
  bound-wheel rendering, and the assignment dialog.
- Not in this package: the 2D plan (VEH-05), URDF parsing (VEH-06), GitHub
  acquisition (VEH-07), and workspace chrome (VEH-08).
- Built-in projections stay version 2. `createDefaultVehicleManifest()` stays
  version 2. New blanks created through publication are version 3. The current
  editor still uploads a single legacy file; that path does not require a
  canonical closure.

## Decision log

### VEH-01a — version pin

`VEHICLE_MANIFEST_VERSION` remains 2. Version 1 still migrates to version 2
with the permissive actuator defaults. Version 3 round-trips its own fields.
`{ version: 2 }` on a version 3 source throws `VEHICLE_MANIFEST_DOWNGRADE`
instead of stripping fields. No normalizer option upgrades a document to
version 3. `createDefaultVehicleManifest()` forces version 2.

Built-in projections pass `{ version: 2 }`. Their resolved hashes stay:

- `big-car`: `4c39469acfa250f98dfee99560ea646619aa65230415b39c6c31b46368f161af`
- `igvc-car`: `da17fa26f3a1243264747cfd718098a6f253d076af83c6d47d1f15d84e9da300`
- `scenario-car`: `ce16fe842506c8a9949d21b8d4a84444d7b57148cd923a44305a55cb06992eb7`
- default blank vehicle: `d8c818fa23f12642a97d28e239410bbea42c8a043054796c2a28b3211911779d`

A stored version 3 document rejects a write whose body is not version 3.
The existing vehicle bundle hash for the portable-truck fixture remains
`9c093454c448845a3ade39417d175c3a89c0b11d217d368d197d57d60c0c50cd`.

Version 3 geometric scalars use `canonicalFiniteNumber` (six decimal places)
for placement, body bounds, wheel geometry, wheelbase, and maximum steering
angle. Actuator limits are not re-rounded. Generic math helpers are unchanged.

### VEH-01b — axles

Pair tolerance is `max(0.001 m, 0.001 × max(abs(a), abs(b)))`, applied to
normalized X, Y, radius, width, and mirrored Z. Steerability is exact.
`proposeStandardPair` reports a proposal and does not write it.
`validateStandardAxles` does not average geometry or replace wheelbase.
A complete front/rear layout with no unclassified wheels must already store
the derived wheelbase. Bindings and hidden-node overlap are checked only when
the caller supplies a node table; otherwise the result is
`vehicle.model.nodes-unverified`.

### VEH-01c — migration planner

`planVehicleMigration` returns the proposed manifest, asset operations,
diagnostics, changes, wheelbase acknowledgements, and a
`cev-sim.vehicle-pre-migration` snapshot. It does not write files, fetch
URLs, or encode GLB. `encodeModel` is injected; without it, a version 2 model
is `vehicle.migration.encoder-unavailable`. An external URL is
`require-local-package` until `localPackage` is set. Missing glTF dependencies
block the plan and leave `proposedManifest` null.

Unclassified migration keeps wheel positions and the authored wheelbase.
Standardizing a pair that is outside tolerance blocks the plan. BigCar's
pinned projection is not migrated in place. A copy that standardizes its
±0.75 m wheels acknowledges the wheelbase change from 1.2446 m to 1.5 m.
Yaw rate scales by `before / after` and turn radius by `after / before`,
matching `KinematicVehiclePlant`. The snapshot's asset map is sha256 hex and
is not part of the vehicle hash. Persisting that snapshot is VEH-03.

An already version 3 document plans an identity migration and does not
re-encode its model.

### VEH-01d — document session

`VehicleDocumentSession` owns the baseline, draft generation, selection,
history, gestures, and staged-resource references. It does not use the
environment `CommandBus`. The React vehicle editor is unchanged and still
keeps its own undo stack until VEH-08.

Axle gestures preview against the gesture capture and commit one history
entry. Cancel writes nothing. `acknowledgeSave` installs the captured draft
as the baseline. An edit during that save leaves the newer draft dirty.
`failSave` keeps the draft and the staged-resource reference. Commands cover
migration apply, axle edits, wheel detach and reattach, body and sensor
edits, raw JSON replacement, model-binding clearance, and a reviewed URDF
patch. The URDF parser is not part of this package; the command applies a
patch and preserves sensors, identity, and actuator values the patch does
not supply.

Version 3 identity changes only through the existing `computeResolvedRunHash`.
The kinematic plant, protobuf contracts, and version 1/2 hashes are unchanged.

### VEH-02 — canonical GLB ingestion

`createVehicleModelImportPlan()` accepts `.glb`, `.gltf`, `.obj`, and `.stl`.
It rejects PLY, remote URLs, missing files, ambiguous paths, and package
escapes. A `.gltf` entry is encoded with `writeGlb()`; the output is a binary
GLB, not the source JSON renamed. Geometry buffers are packed into one BIN
chunk. Images are sibling files named `<sha256>.png`, `<sha256>.jpg`, or
`<sha256>.ktx2`, and those names are the GLB image URIs. The model file is
`<sha256>.glb`. Repeat imports of the same bytes are byte-identical.

Authored glTF node names and OBJ `o`/`g` names are kept. Missing names become
`part-0`, `part-1`, in node order. STL and unnamed OBJ nodes use that ordinal
sequence, so the entry filename is not part of the model identity. Editor-asset
import is unchanged: `.gltf` stays JSON, GLB BIN bytes stay as authored, and
OBJ/STL/PLY fallback names still come from the filename.

`encodeVehicleModelForMigration()` is the `encodeModel` hook. When it returns
`files`, the migration operation copies them through. Those bytes are not
hashed into the vehicle document or the pre-migration snapshot. Callers that
omit `encodeModel` still get `vehicle.migration.encoder-unavailable`.

`validateVehicleModelClosure()` checks the packed GLB with the same structural
limits as visual preflight, then checks sibling filenames, digests, texture
dimensions, and decoded size. Server preflight still requires `sha256:` URIs.

`VehicleModelLoader` serves `VehicleStudio` and `ManifestVehicle`. A version 3
content-addressed GLB is fetched with its declared sibling images and checked
before decode. Every other saved asset, including `/shell/shell.gltf`, remains
a single URL load. Draft bytes can be passed in memory; this package does not
create a stage or publish assets. A newer load for the same slot disposes the
older decode. Aborting the read returns no root. No vehicle, resolved,
semantic, or episode hash changes in this package.

### VEH-03 — staging and publication

Vehicle bytes for a new model are uploaded to `vehicle-stages/<stageId>/`,
outside `vehicles/` and `vehicle-assets/`. The server returns the digest,
size, and media type. Renew extends the one-hour lease. Abandon, expiry, and
a publication that fails before the manifest write leave a saved version 2
vehicle's manifest, asset directory, bundle hash, and resolved hash unchanged.
Stage ids, journals, receipts, and the pre-migration snapshot are not hashed.

`VehiclePublicationService.publishLocked()` is the write path for create,
save, import, duplicate, migration, and marketplace vehicle publication.
Callers that omit `operationId` still get one journaled write and are not
idempotent. A 64-hex `operationId` replays the stored receipt. A reuse of
that id for a different request is a conflict. The journal records the
intended revision and definition hash before the manifest write. A crash
before the manifest is durable deletes only files this operation introduced.
A crash after it finishes that same revision and does not write another.
Identity readers (`readVehicleSnapshot`, used by resolution, export,
duplicate, and marketplace capture) recover first. While a journal is still
before `manifest-published`, those readers omit the operation's introduced
names, so a version 2 manifest is not hashed together with a version 3
closure that has not committed.

Content-addressed members are not replaced with different bytes. Legacy
`model.glb` uploads still overwrite through the raw asset API. Deleting a
file named by a stored version 3 closure is rejected. Version 3 publication
runs canonical closure and axle checks when `model.asset` is
content-addressed, and for every migration. A version 3 document whose asset
is still a legacy file name skips the GLB structural check so the current
editor can save after its raw upload.

Marketplace `publish-vehicle-asset` writes `vehicle-publication-intake/`,
which resolution does not hash. `publish-vehicle` promotes that intake and
writes the manifest in the same transaction.

`createBlankVehicleManifest()` is the version 3 blank. Its definition hash is
`54025fcb83fb359f6e60cb8c86c7107f717274b4d36afddf36e7c7767b05a47e`. The editor's
New action publishes that blank. `createDefaultVehicleManifest()` and the
pinned version 2 hash are unchanged. A committed migration writes
`vehicle-migrations/<id>.pre-v3.json` once, after the manifest is durable.
Superseded files stay in the asset directory, so the resolved hash then
includes both the new closure and those older files. There is no published
asset garbage collection.

### VEH-04a — placed-node measurement

`measurePlacedVehicleModel` reads POSITION vertices from the canonical GLB
BIN, including integer component types, normalized values, and byte stride.
Accessor min/max are not used. A sparse POSITION accessor fails with
`vehicle.wheel.bounds-unavailable`. Hidden nodes and the file name do not
change the measurement. Placement follows the same scale, XYZ Euler, and
bounding-box alignment as `applyModelPlacement`: each mesh's local bounds are
rotated and scaled, then unioned. Wheel bounds use every vertex of the node
and its descendants. Width is `size.z`. Radius is `max(size.x, size.y) / 2`.
`radialDelta` is `abs(size.x - size.y)`. Radial asymmetry beyond pair
tolerance is `vehicle.wheel.radial-asymmetry`.

### VEH-04b — binding commands and publication

`assignModelWheels`, `suppressSourceWheels`, and `applyPlacementChange` run
through `VehicleDocumentSession`. The editor keeps its own undo stack until
VEH-08 and commits the returned snapshot with one full-document update.
Assignment does not write unless `acceptAdjustments` is true. A fully bound
axle must reproduce the measured proposal after `canonicalFiniteNumber`. One
remaining bound wheel must stay within pair tolerance of its own node.
Suppression hides the selected nodes and adds unclassified wheels at
`generated-${nodeIndex}` using that node's center, radius, and width.
Existing standard axle wheels stay. Overlap with a remaining binding does
not write.

Placement of scale, rotation, offset, or bounding-box center and size writes
immediately when no wheel is bound, and clears the baked LiDAR zone while
keeping `lidarZone.params`. With bindings, an out-of-tolerance measurement
leaves the draft untouched. A within-tolerance change that moves the proposal
requires acceptance. An unchanged proposal with unchanged placement does not
write and does not clear the zone. Detach, reattach, model replacement, and
URDF geometry patches clear the baked zone in the same command.

Publication remeasures the canonical GLB when any wheel has
`visual.kind === "model-node"`. Version 2 and unbound version 3 skip that
measurement. A binding that is outside tolerance, or that does not reproduce
the measured proposal, is rejected and the stored manifest stays unchanged.

### VEH-04c — bound-wheel rendering

A version 3 lease carries the canonical `glbBytes`. `presentBoundWheels`
hides `hiddenNodeIndices`, parents each bound mesh to a pivot at the accepted
wheel center, and preserves that mesh's world matrix so the rest pose matches
the placed source. Unbound wheels stay cylinders. Steerable pivots still use
`rotation.y` from `displaySteeringAngle`. Legacy URL loads keep
`applyModelPlacement` and cylinders. A stale or aborted lease does not
present. While the model gizmo is dragging a bound vehicle, presentation is
suspended so the source meshes move with the body, then restored on commit.

### VEH-04d — assignment dialog

The wheels tab lists in-scene glTF nodes by the node's own name and path.
Roles are unassigned, front-left, front-right, rear-left, and rear-right.
Accept writes one `assignModelWheels` command for every in-tolerance pair.
An out-of-tolerance pair can correct the source, choose different parts, or
suppress those nodes. The control is disabled for version 2 and for a legacy
`model.glb`, because assignment needs a canonical closure. Focus returns to
the button that opened the dialog. A bound placement nudge previews in the
studio and asks for acceptance before the draft changes. The dialog
reports how far the stored axle geometry would move. An out-of-tolerance
nudge snaps the draft and the gizmo back. Model replacement clears previous
bindings and hidden indexes in that undo entry.
