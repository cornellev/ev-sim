# Driveable area packages

Paved areas for parking lots, practice yards, and open driving tests. The editor draws rectangles. Commands and APIs also accept a valid simple polygon. Driving, sensors, occupancy, and automated tests use the same pavement.

This is a separate `DRV-*` program. It is not a headless PR 13 and it is not an ED, VIS, or PLN milestone. Environment documents stay schema v4. A world description becomes version 5 only when it contains at least one area.

## Contracts

- `document.driveAreas` is optional. Each record is `{ id, y, footprint }`. `y` defaults to `0`. An empty domain is omitted. A rectangle gesture needs at least 2 m on each side. An explicit polygon has no side minimum.
- Polygons are concave and simple. Coordinates are finite, there are at least three distinct vertices, the area is nonzero, and edges do not cross, overlap, or meet in a T. Winding is normalized counter-clockwise. Holes and slopes are outside this release.
- Each area compiles to `{ id: "drive-area:<id>", sourceId, kind: "area-polygon", footprint, triangles, minY, maxY, bounds }`. `triangulateFootprint` produces the indices once. Meshes, LiDAR, occupancy, and start-pose checks consume those indices.
- Worlds that contain areas are description version 5. Validation keeps the existing road, asset-proxy, primitive, floor, and rigid-body checks and adds the area check. Versions 1–4 reject an `area-polygon` surface. A version 5 description with no areas is invalid.
- A world with no areas keeps its previous description version, bytes, and hashes. Removing the last area restores that description. `roadNetworkHash` describes roads only.
- Ground sampling checks roads and junctions first. Otherwise it uses the containing area with the lowest UTF-8 id. An area returns height `y`, pitch `0`, and an upward normal.
- Off-road is 1 when any ground-footprint corner is outside the combined road, junction, and area pavement. With no pavement the metric is `null`. Without a route, route progress and wrong-way are `null`.
- Areas stay pavement under obstacles. Buildings, features, asset proxies, and primitives still block through the existing collision and occupancy geometry.

## Packages

### DRV-01 — Author, persist, and compile

The document domain, commands, `drive-area@1` object type, rectangle gesture, map, and `SceneProjector` mesh are in place. Aware full-document writers send `supportedDriveAreaVersions: [1]`. An unaware full-document replacement over stored areas is HTTP 409. A capable writer may remove every area. MCP exposes `environment_add_drive_area` and `environment_remove_drive_area`.

### DRV-02 — Sampling and pavement metrics

The shared ground sampler reads authored areas in the browser and compiled surfaces in a headless world. Road results stay the same, including where a graded road overlaps an area. Scenario metrics use the pavement union. The road graph is built only when the world has road nodes and edges, and only rebuilt when the road hash changes.

### DRV-03 — Road-free episodes

`freeDrive: true` is omitted unless it is explicitly enabled. It requires one enabled ego and no routes. Resolution and admission require zero road nodes, zero road edges, and at least one area. `create-bundle --finish none` is the area-only path. Road worlds keep the verified route and the `cev-sim.free-drive.stop` trigger. The generated start is the first area's geometric centroid, its elevation, yaw 0, and zero speed. A pose in the notch, on an obstacle, or too small for the vehicle fails with no spawn search.

Python `load_world()` accepts that bundle: empty routes, route length 0, the manifest start, and `goal=None`. A routed bundle with a broken route is still rejected.

## Defaults left out

No vertex editor, polygon holes, slopes, spawn search, wandering traffic, new perception class, or new vehicle physics. The floor is unchanged. Script cloning of a drive area is not part of this release.

## Decision log

### 2026-11-07 — Drive Area Attachment

Object scripts can read a drive area through Drive Area Attachment. The block does not clone an area and does not change pavement, world description versions, or hashes.

### 2026-11-07 — Drive-area repair pass

Start clearance and routed-start selection use the shared, perimeter-ordered
vehicle footprint, including the bounding-box center. A contained obstacle is
rejected before export or reset. World v5 requires the road and primitive
policies implied by its geometry; removing a policy cannot disable validation.
Historical v1–v4 validation and valid world hashes are unchanged.

Browser area entities keep the `drive-area` kind and explicitly use the `road`
perception class. Regeneration restores the authored name and inherited editor
visibility and removes the old mesh from its actual chunk parent. Whole-world
georegistration migrates area vertices, normalizes winding, preserves elevation,
and checks area locks. Roads-only georegistration leaves areas unchanged.

The ground sampler caches prepared areas by authored content, including in-place
coordinate and elevation edits, and reuses immutable compiled surfaces directly.
Scenario metrics prepare area geometry during configuration rather than for each
corner observation. Cache counts are diagnostics and do not enter identity.

Regression acceptance includes contained and offset vehicle footprints,
hash-valid policy tampering, browser truth metadata, hidden-group edits,
chunk-mesh replacement, georegistration undo/redo, and compilation reuse.
The earlier control-sign/characterization compatibility blocker remains separate;
this repair does not change production steering or regenerate its pinned tape.

Verification for this repair pass:

- `npm run lint`: zero errors and the same three existing hook warnings.
  Lint on all changed JavaScript files passes.
- The final focused run passes 32 tests, including all seven repair regressions;
  another 21 planning-bundle and object-registry tests pass. The additional
  80-test sensor, hierarchy, control, environment, and world compatibility run
  passes. Python passes all 19 tests.
- The Chromium production-build regression passes: draw an area, hide it,
  change elevation, save, reload, and verify the elevation and hidden state.
- Browser-engine, direct, CLI, gRPC, and Python parity passes for state-only,
  CPU LiDAR, road geometry v2, and metric asset assemblies. A real Python
  area-only configure/launch/reset/step check returns the area centroid,
  `goal=None`, and a nonterminal transition.
- `npm test`: 2,560 passed, five failed, one cancelled, eight skipped. The
  known pinned steering-characterization mismatch remains. Isolated reruns
  pass the marketplace publication, marketplace startup, and visual-package
  streaming failures; the five-second unconsumed-export timeout and timeline
  subscriber-count assertion still fail. These unrelated storage and telemetry
  failures are not changed by this repair; the full repository gate stays red.

### 2026-11-07 — DRV-01 through DRV-03

Areas are an optional document domain on environment schema v4. World description v5 is selected only when at least one area exists, and an empty `driveAreas` array matches a document that omits the key. Rectangle authoring has a 2 m minimum; explicit simple polygons do not. Overlapping areas use the lowest UTF-8 source id for height and the union for off-road. Capable writers may delete the domain; unaware full-document writes may not. Area-only episodes are the `freeDrive` path. Road worlds that pass `--finish none` still keep a verified route. The automatic start is the first area centroid and fails closed. Observation vector length and the committed characterization fixtures stay unchanged.
