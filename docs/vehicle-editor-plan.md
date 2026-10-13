# Vehicle editor plan

This document records the vehicle-editor program decisions that are in force.
VEH-01 is the first implemented package. Later packages add canonical GLB
encoding, staging, rendering, the plan view, URDF, and editor chrome.

## Status

- Implemented: **VEH-01** — version 3 contract, standard-axle checks, migration
  planning, and the vehicle document session.
- Not in this package: GLB encoding (VEH-02), staging and publication
  (VEH-03), bound-wheel rendering (VEH-04), the 2D plan (VEH-05), URDF parsing
  (VEH-06), GitHub acquisition (VEH-07), and workspace chrome (VEH-08).
- Blank vehicles and built-in projections stay version 2.

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
