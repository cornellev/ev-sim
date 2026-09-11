# Environment Editor Implementation Plan

This document is the implementation authority for the `ED-*` environment
editor program: contracts, dependency order, independently mergeable PRs, and
acceptance evidence. Requirements below describe work to implement; they do
not assert that the current repository already satisfies them unless the
progress ledger says so.

This is a separate program from headless PRs 1–12 and from the `VIS-*`
visual-layer program. It is not a headless PR 13. Headless candidate evidence
and visual-layer release verdicts remain governed by their own plans.

Required reading before implementation:

- [Repository guidance](../AGENTS.md)
- [Environment editor](environment-editor.md)
- [Architecture](architecture.md)
- [Run manifests and identity](run-manifests.md)
- [Visual layer plan](visual-layer-plan.md) (identity rules the editor must not break)
- [Earth import policy](earth-import.md)

Update this document's progress, acceptance evidence, and decision log when an
ED PR changes a contract, hash, gate, or milestone status.

## Status

- Next milestone: **ED-02 — Commands and hierarchy**.
- Implemented: **ED-01 — Contracts** (object registry, options validation,
  schema-v4 adapters behind `CEV_SIM_ENVIRONMENT_SCHEMA_V4`, compatibility
  fixtures). Existing environments retain their legacy behavior; the default
  writer still emits schema v3.
- Program goal: one consistent interaction model across hierarchy, scene, map,
  inspector, and asset library, with a modular object system that adds a type
  through one definition, one options validator, and its metric/render
  adapters.
- Human decisions already taken: resizable fixed-arrangement panes; nested
  Group Objects whose transforms affect children; asset assembly, materials,
  and sensor editing in the editor while mesh modeling stays external; explicit
  asset revisions and explicit instance updates; curved roads and asymmetric
  lanes; connected roads stay connected when moved; Google tiles remain a live
  backdrop owned by the environment; imported GLTF models are visual-only until
  proxies are set up; LiDAR authoring supports generated meshes and editable
  primitives.
- Default implementation/review reasoning level: **Extra High**.
- Last updated: **2026-09-11 — ED-01 implemented**.

## Normative contracts

### Object records and the legacy overlay

- The persisted authoring record is
  `{ id, typeId, typeVersion, name, parentId, order, components }`, stored as
  an ordered array at `manifest.document.objects` with
  `manifest.document.objectGraphVersion: 1`. Nothing new lives at manifest
  level; `manifest.objects` is already the runtime registry cache.
- Records overlay the canonical legacy domains. A record shares its id with the
  record it describes: `feature.id` → `builtin-prop`, `buildingId` →
  `building`, road edge `id` → `road`, junction node `id` → `intersection`
  (a node is a junction when `kind === "intersection"` or it joins more than
  one edge), `"tile"` → the `earth` source, `"skybox"` → `manifest.sky`. Only
  `group`, the single `skybox`, and the single `tile` exist without a legacy
  counterpart. Geometry never lives in the overlay.
- Because `createWorldDescription` reads only the legacy domains, the overlay
  is excluded from `worldHash` by construction. Group names, hierarchy order,
  locks, and editor visibility do not affect metric identity. Geometry, lane
  direction, and enabled proxies do.
- Standard components are `tags: string[]`, `locked: boolean`, and
  `editorHidden: boolean`; groups additionally persist `transform`
  (position, yaw, uniform scale; identity until ED-02 attaches nested
  transforms). Registered types reject unknown component keys. Records whose
  `typeId` is not registered are preserved verbatim, reported as
  `object.type.unsupported`, and never substituted; simulation admission fails
  when required metric behavior is unavailable.
- Canonical order is `(order, id)`. Object ids are a separate namespace from
  runtime registry ids (`road:<edgeId>`, `fusion:…`).

### Object types, options, and validation

- `app/3d/editor/objects/` is the kernel-safe authoring core: no React,
  Three, DOM, browser globals, or `node:` imports; no imports of
  `WorldDescription.js`, `EnvironmentDocument.js`, `documentGeometry.js`, or
  the Three-bearing `city/` and `earth/` trees. A test greps the tree and
  spawn-imports `index.js` with poisoned globals.
- `ObjectTypeRegistry` keys definitions by `typeId@version`, freezes them, and
  rejects missing `typeId`/`version`/`label`/`options`, non-`ObjectOptions`
  options, missing methods (`create`, `getCapabilities`,
  `getTransformBinding`, `getDependencies`, `compileMetric`, `migrate`),
  invalid `catalog.layer`, invalid `legacy.domain`, and duplicates.
  `get(typeId)` resolves the latest version; `get(typeId, version)` is exact.
  `defineObjectType()` fills standard implementations so a type needs only the
  members that differ.
- `ObjectOptions` subclasses must implement `getDefaults`, `getFields`,
  `normalize`, and `validate`; the base constructor rejects partial subclasses.
  Field descriptors are frozen `{ path: string[], label, control, units?, min?,
  max?, step?, options?, group?, advanced?, readOnly? }` with controls
  `number | text | toggle | enum | vector3 | color | asset-reference`.
  Validation returns `{ path, code, message, severity }` issues and never
  throws on bad input. In ED-01 option values are projected from the canonical
  legacy record (`options.fromLegacy`), never persisted in the overlay.
- Built-in types: `group`, `skybox`, `tile`, `road`, `intersection`,
  `building`, `builtin-prop`, and the contract-only `asset-instance`. The five
  props are one `builtin-prop` type with an `assetId` option; the prop table in
  `types/builtinProp.js` is the single source for the placement catalog, the
  world compiler's feature geometry, editor collision radii, and LiDAR semantic
  labels. Kernel consumers import that frozen leaf table only, never the
  registry, so `worldHash` depends on static data rather than registration
  order.
- `validateObjectGraph(snapshot, registry, { sky })` returns `{ ok, issues }`
  where `ok` means no error-severity issue. Codes: `graph.version.unsupported`,
  `object.id.missing|duplicate`, `object.type.missing`,
  `object.type.unsupported` (warning), `object.type.version-unsupported`
  (warning), `object.name.invalid`, `object.order.invalid`,
  `object.order.duplicate` (warning), `object.parent.missing|self|cycle|not-group`,
  `object.components.invalid`, `object.options.invalid` (with `optionCode`),
  `object.legacy.missing|type-mismatch`, `object.legacy.uncovered` (warning),
  `object.skybox.multiple|id`, `object.tile.multiple|orphan`.
  `validateObjectRecords(candidates, legacyIndex, registry)` is the pure core
  for atomic multi-object changes: validate the whole candidate array, commit
  via `EnvironmentDocument.replaceObjectGraph` only when `ok`.
- `deriveObjectGraph` builds the complete overlay for a snapshot
  deterministically (skybox, tile, roads, intersections, buildings, props, each
  sorted by id). `reconcileObjectGraph` keeps every existing record (including
  groups and unknown types), adds records for uncovered legacy entities, and
  drops legacy-bound records whose counterpart vanished. It never touches
  geometry. The loader, MCP `loadDocument`/`saveDocument`, and the v4 writer
  reconcile; ED-02's CommandBus keeps overlays live in-session.

### Schema v4 and write policy

- Readers accept schema versions `2`, `3`, and `4`. v2/v3 read views never
  inject a graph ("implied, not injected"); `presentEnvironmentObjectGraph`
  derives one in memory. v4 read views structurally normalize `objects`.
- Writes produce v3 unless the server is started with
  `CEV_SIM_ENVIRONMENT_SCHEMA_V4=1` (`StorageService` option
  `environmentSchemaVersion: 4`; the constructor does not read the environment
  so tests stay deterministic). The default writer strips `objects` and
  `objectGraphVersion`, which is lossless in ED-01 because the overlay is fully
  derivable and no UI yet writes names, locks, or groups.
- A v4 write reconciles the incoming graph against the legacy domains,
  validates it, and rejects error-severity issues atomically with HTTP `400`
  `ENVIRONMENT_OBJECT_GRAPH_INVALID` and an `issues` array. Nothing is written
  on rejection.
- Sticky v4: a stored v4 file is never rewritten as v3, even if the flag is
  cleared.
- The first v4 save over a v2/v3 file stores a write-once copy at
  `<dataDir>/environment-migrations/<id>.pre-v4.json`
  (`{ kind: "cev-sim.environment-pre-migration", version: 1, environmentId,
  fromSchemaVersion, toSchemaVersion, revision, migratedAt, manifest }`).
  The directory is separate because `environments/` is catalog-scanned and
  `environment-transactions/` is journal-scanned. Recovery is a manual restore
  of `manifest` in ED-01.
- Downgrade rejection: when the stored file is v4 with records and the
  incoming `document` is an object without an `objects` array, the write is an
  old client and fails with HTTP `409` `ENVIRONMENT_SCHEMA_DOWNGRADE`
  (`storedSchemaVersion`, `incomingSchemaVersion`, `currentRevision`). The
  guard keys on the objects array, not the declared version, because
  graph-aware browsers still declare `schemaVersion: 3` in ED-01. Writes that
  omit `document` (rename) reuse the stored document and pass.
- MCP `environment_add_object` rejects unregistered types with
  `ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED`; `environment_validate` returns
  geometric `conflicts` plus object-graph `issues`; `environment_get`
  summaries list registered `objectTypes`.

### Kernel safety and metric identity

- The revision-guarded `PUT`, `ENVIRONMENT_REVISION_CONFLICT`, and
  `ENVIRONMENT_UNGUARDED_WRITE` behavior are unchanged.
- `tests/fixtures/environment-editor/compatibility-baseline.v1.json` pins
  `worldHash`, `roadNetworkHash`, `lidarGeometryHash`, normalized feature
  transforms, and the placement catalog for the built-in IGVC template, the
  committed `yard` v2 and `city-grid` v3 environments, and the synthetic
  `all-props` environment. Regenerate with `npm run fixtures:environment-editor`;
  any delta is a metric-identity contract change reviewed as such.
- Historical immutable bundles keep their existing validators and geometry
  paths. A versioned world-description extension for curved surfaces, explicit
  lanes, and independent asset proxies arrives with ED-04/ED-05/ED-07 and must
  version route proofs; stale proofs require re-verification.

## Dependency and PR organization

Each PR runs its focused suites, then `npm run lint` and `npm test`. UI
milestones add Playwright and accessibility checks. Geometry and sensor
changes additionally run parity and characterization comparisons, with fixture
changes reviewed as contract changes. Partially implemented editor behavior
stays behind a development flag. Environments migrate on guarded save, retain
recoverable pre-migration revisions, and reject incompatible old-client writes
rather than dropping new fields.

### ED-01 — Contracts

**Depends on:** none.

Object registry, required options validation, schema-v4 adapters, and
compatibility fixtures: `ObjectTypeRegistry`, `ObjectOptions`, object records,
`deriveObjectGraph` / `reconcileObjectGraph` / `validateObjectGraph`, the
eight built-in type definitions, consolidation of the five duplicated prop
tables into `types/builtinProp.js`, `EnvironmentDocument.objects`,
`EnvironmentManifestPolicy` v4 read/write adapters with sticky v4 and the
downgrade guard, `StorageService` flag plumbing and pre-migration copies, loader
carry-and-reconcile, MCP validation, fixtures, and this document.

**Merge gate:** existing environments retain their legacy behavior; the
compatibility baseline and the headless characterization fixture show no
delta; `tests/object-registry.test.js`, `tests/object-graph.test.js`,
`tests/environment-v3.test.js`, and `tests/environment-v4.test.js` pass; a
test-only object type validates and round-trips through the v4 writer without
edits to persistence or MCP code; `npm run lint` and `npm test` pass.

### ED-02 — Commands and hierarchy

**Depends on:** ED-01.

Shared `SelectionStore` (primary selection plus optional sub-object
selection), `CommandBus` with transactions, gestures (`beginGesture` /
`updateGesture` / `commitGesture` / `cancelGesture`), undo/redo, nested groups
with world-preserving reparent and cycle rejection before commit, transform
bindings that plan document changes (`planTransform`), group transforms that
apply a world delta to shared road nodes exactly once, and incremental
`SceneProjector.applyChanges` synchronization so a drag does not rebuild the
world. `EditorPresentationRegistry` registers icons, inspector sections,
menu options, and optional custom displays per `typeId`. Existing MCP
mutations route through the same pure command and validation services. The
in-session overlay is kept live by commands instead of reconciled on write.

**Merge gate:** cross-panel changes agree immediately; interaction tests for
select, drag, cancel, undo, redo, duplicate, reparent, and reload; group tests
for nested transforms, preserved world placement, cycle rejection, shared road
nodes moved once, and atomic rejection of unsupported transforms.

### ED-03 — Workspace and inspector

**Depends on:** ED-02.

Resizable, collapsible panes in the fixed arrangement (232 px hierarchy,
304 px inspector, 208 px asset panel; sizes and collapsed states remembered as
editor preferences), unified scene/map views over the same document, selection,
and tools, the icon toolbar with tooltips, accessible names, keyboard focus,
and active states, editable generic fields (`NumberField`, `Vector3Field`,
`EnumField`, `AssetReferenceField`, `ToggleField`, `PropertySection`) rendered
from `getFields()`, mixed values during multi-selection, the Skybox inspector,
keyboard interactions (Q/W/E/R, F, Escape, Delete, undo/redo) scoped to the
workspace and never consuming typing in fields, a usable layout at 1280 × 720
with the desktop-size guard retained, and the default flip of the schema-v4
writer.

**Merge gate:** Playwright and accessibility checks for the main workflow at
1280 × 720; virtualized large hierarchies; canvas and camera projection resize
with the center pane and pointer coordinates use the canvas bounds.

### ED-04 — Road geometry

**Depends on:** ED-02.

Pure `RoadGeometry` module (`evaluate`, `sampleCenterline`,
`buildLaneCenterline`, `buildRoadSurface`, `projectPointToRoad`, `splitEdge`,
`validateGeometry`) with piecewise cubic Bézier authored curves and retained
polyline representations, a versioned deterministic sampling policy shared by
mesh generation, map rendering, routing, off-road checks, bounds, and LiDAR,
direct road manipulation in perspective and map views (draw, move complete
roads, junctions, endpoints, and curve handles; add/remove knots; split;
connect or detach), elevation, width, shoulders, and markings, and the
versioned world-description extension with route-proof invalidation.

**Merge gate:** rendered roads and measured geometry agree in browser and
headless; tests for curves, elevations, junction movement, detach/reconnect,
invalid geometry, and stale route anchors; curved-road accuracy independent of
zoom or LOD.

### ED-05 — Lane authoring

**Depends on:** ED-04.

Explicit ordered lanes with stable ids and directions (two-forward/one-backward,
arbitrary one-way counts, the shared single-lane case), the `RoadDisplay`
cross-section graphic dispatching ordinary commands through the same
validation path as numeric fields, markings, intersection turn validation, and
route-proof invalidation on lane removal or direction change (a waypoint is
never silently moved to a different lane).

**Merge gate:** asymmetric-lane tests, lane diagram interactions validated
identically to field edits, proof invalidation tests.

### ED-06 — Asset catalog

**Depends on:** ED-02.

Server-backed catalog over the validated asset storage separating catalog
metadata, immutable asset revisions, and scene instances (pinned revision,
transform, explicit overrides). Catalog APIs under
`/api/storage/editor-assets` with revision guards; file bytes continue through
the visual-asset upload and validation APIs. `AssetRepository.list / import /
publishRevision / getReferences / archive` and `AssetInstantiation.create /
planRevisionUpdate`. Library with folders, breadcrumbs, search, sorting, type
filters, grid/list views, drag-and-drop placement previews, GLB/GLTF import
with required local dependencies and actionable errors, and explicit instance
updates for selected instances or all instances in the current environment.

**Merge gate:** tests for dependent GLTF files, revision pinning, update
conflicts, folder moves, archived references, and placement.

### ED-07 — Asset studio

**Depends on:** ED-06.

Center asset tab with an isolated preview scene and camera, child-part
hierarchy and shared inspector, model units, orientation, pivot, material, and
child-transform editing, assembly creation, collision and LiDAR overlays,
independent undo history and a dirty-tab indicator. Sensor proxies reuse the
voxel simplification foundation for generated LiDAR meshes, support included
part selection and editable box/sphere/cylinder zones, persist generated output
with parameters, source revision, and stable semantic labels, mark proxies
stale on part geometry changes, and compile enabled proxies into immutable
metric world data used by browser and headless execution. Collision uses
independently configured compound box/convex proxies with deterministic
swept-AABB/convex checks beside the legacy prism path.

**Merge gate:** stale-proxy, assembly, and independent-history tests;
browser/headless parity for compiled proxies; workers never load the editor or
infer geometry from preview meshes.

### ED-08 — Creation and imports

**Depends on:** ED-04, ED-06.

Three-source creation dialog (Blank, Google Earth, GLTF), `RoadImportService`
with segment-by-segment clipping to the selected boundary that preserves
boundary intersections, OSM ids, genuine junctions, and bridge/tunnel/layer
distinctions before simplification, one explicit geospatial transform for
tiles, roads, bounds, and editor coordinates with the Mercator/reorientation
mismatch corrected and applied to existing environments only as an explicit
undoable migration, and environment-owned `TileProvider` sessions
(`createSession`, `update`, `setVisible`, `getAttributions`, `dispose`)
disposed on environment/source removal or workspace teardown rather than on
Apply, camera movement, or tab changes. Google meshes stay outside collision,
LiDAR, baking, measured cameras, and asset exports; GOOG capability gates and
attribution/cache requirements are preserved.

**Merge gate:** import tests for crossing and re-entering polylines, exact
clipping, grade-separated roads, failed fetches, cancellation, georegistration,
and reload; tile tests for synthetic LOD transitions, camera changes, pane
resizing, retries, memory pressure, attribution, and sensor/export isolation.

### ED-09 — Acceptance

**Depends on:** ED-03, ED-05, ED-07, ED-08.

Complete workflow tests, the extension demonstration (a test-only object type
with a custom field and metric geometry added without editing hierarchy,
inspector, placement, or persistence implementations), accessibility, large-
scene checks, persistence tests (edits during autosave, revision conflicts,
failed saves, external MCP changes, migration round-trips), documentation, and
default activation of the new editor.

**Merge gate:** every required test category in this plan passes; the editor
documentation and the headless/visual decision logs are updated where their
contracts, identities, or gates changed.

### Verification commands and evidence format

```text
node --experimental-default-type=module --test \
  tests/editor-core.test.js tests/editor-map-mode.test.js \
  tests/environment-v3.test.js tests/environment-v4.test.js \
  tests/environment-persistence.test.js tests/environment-loader.test.js \
  tests/document-geometry.test.js tests/authoring-mode.test.js \
  tests/storage-service.test.js tests/storage-events.test.js \
  tests/object-registry.test.js tests/object-graph.test.js tests/mcp-tools.test.js
npm run lint
npm test
npm run fixtures:headless && git diff --exit-code -- tests/fixtures/headless/characterization.v1.json
npm run fixtures:environment-editor && git diff --exit-code -- tests/fixtures/environment-editor/compatibility-baseline.v1.json
```

Record in the ledger: focused-suite pass counts, `npm run lint` result,
`npm test` totals with declared skips, and both fixture drift results.

## Progress and acceptance ledger

- [x] ED-01 — Contracts. Local acceptance evidence (2026-09-11): focused ED
  suites 162/162 passed (`editor-core`, `editor-map-mode`, `environment-v3`, `environment-v4`, `environment-persistence`, `environment-loader`, `document-geometry`, `authoring-mode`, `storage-service`, `storage-events`, `object-registry`, `object-graph`, `mcp-tools`; the pre-ED-01 baseline was 97 across the first ten); `npm run lint` zero errors, one pre-existing warning in `app/client/Client.js`; `npm test`
  1017/1021 passed with four declared hardware/host skips and zero failures; `npm run fixtures:headless` no delta;
  `npm run fixtures:environment-editor` no delta; `npm run dist:headless` and
  `PYTHON=python3.12 npm run dist:verify` ok (the kernel bundle now reaches
  `app/3d/editor/objects/types/builtinProp.js`; the local default `python3`
  is 3.14 and outside the wheel's declared range, unrelated to ED-01).
- [ ] ED-02 — Commands and hierarchy.
- [ ] ED-03 — Workspace and inspector.
- [ ] ED-04 — Road geometry.
- [ ] ED-05 — Lane authoring.
- [ ] ED-06 — Asset catalog.
- [ ] ED-07 — Asset studio.
- [ ] ED-08 — Creation and imports.
- [ ] ED-09 — Acceptance.

## Decision log

### 2026-09-11 — Record the ED program

The environment editor becomes a separate `ED-*` program with nine
dependency-ordered PRs. It is not a headless PR 13 and does not reopen the
visual-layer release verdict. The program keeps JavaScript/ESM, the existing
React, Three.js, Radix, styling tokens, and Tabler icons, the
revision-guarded environment `PUT`, and the `worldHash` / visual-identity
rules from the headless and visual plans. Legacy geometry domains remain
canonical until a milestone explicitly versions the world description.

### 2026-09-11 — Implement ED-01 contracts

The authoring object graph is a document-level overlay at
`manifest.document.objects` keyed by legacy record ids, not a replacement for
`roads`/`buildings`/`features`/`earth`; `manifest.objects` was already the
runtime registry cache. The five props register as one `builtin-prop` type with
an `assetId` option, and `types/builtinProp.js` becomes the frozen leaf table
behind the placement catalog, world-description feature geometry, editor
collision radii, and LiDAR semantic labels. Kernel modules import that leaf
only, never the registry, so metric identity depends on static data rather
than registration order. The compatibility baseline (built-in IGVC, `yard` v2,
`city-grid` v3, `all-props` v3) was generated before the tables moved and is
unchanged after; the headless characterization fixture shows no delta.

Schema v4 is read everywhere and written only when the server opts in through
`CEV_SIM_ENVIRONMENT_SCHEMA_V4=1`. The default writer strips the overlay
(lossless in ED-01 because the graph is fully derivable), a stored v4 file
never downgrades, the first v4 save keeps a write-once pre-migration copy in
the dedicated `environment-migrations/` directory, and a write whose
`document` lacks an `objects` array over a stored graph is rejected with
`ENVIRONMENT_SCHEMA_DOWNGRADE` rather than dropping data. The guard keys on
the objects array because the browser still declares `schemaVersion: 3`.
`EnvironmentDocument.snapshot()` emits the overlay only when non-empty so v2/v3
snapshots are byte-identical; `EnvironmentLoader.apply` carries the stored
overlay past the world-description round-trip and reconciles it. Unknown
object types are preserved and reported as unsupported; there is no fallback
substitution. `serializeEnvironmentManifestV3` remains as an alias of the
version-aware writer so existing callers and tests keep compiling.
