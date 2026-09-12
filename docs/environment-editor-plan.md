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

- Next milestone: **ED-04 — Road geometry**.
- Implemented: **ED-01 — Contracts** (object registry, options validation,
  schema-v4 adapters, compatibility fixtures), **ED-02 — Commands and
  hierarchy** (`SelectionStore`, `CommandBus` with transactions, gestures, and
  undo/redo, nested groups with baked transforms, transform bindings that plan
  document changes, the incremental `SceneProjector`,
  `EditorPresentationRegistry`, MCP routed through the same commands, and the
  schema-v4 default writer), and **ED-03 — Workspace and inspector** (the
  option write path `planOptions` / `setObjectOptions`, the sky as an
  undoable document scalar, the resizable pane workspace with the scene pane
  driving the renderer viewport, unified scene/map views, the icon toolbar,
  generic fields with mixed multi-selection values, the Skybox inspector,
  workspace-scoped shortcuts, the windowed hierarchy, the asset pane shell,
  Playwright/axe coverage, and retirement of the v4 opt-out). Existing
  environments retain their legacy behavior; schema v4 is the only writer.
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
- Last updated: **2026-09-11 — ED-03 implemented**.

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
  `editorHidden: boolean`; groups additionally persist `transform`, a world
  pivot frame (position, yaw, uniform scale). A group transform bakes the
  world delta into every non-group descendant's legacy record exactly once
  and composes it into every descendant group's frame exactly once; the frame
  is never re-applied to children, so legacy domains stay absolute and
  `worldHash` is unchanged. Registered types reject unknown component keys. Records whose
  `typeId` is not registered are preserved verbatim, reported as
  `object.type.unsupported`, and never substituted; simulation admission fails
  when required metric behavior is unavailable.
- Canonical order is `(order, id)`; `order` is sibling-relative and dense
  (reparent, group, ungroup, and duplicate renumber the affected siblings).
  Object ids are the editor's selection identity and a separate namespace from
  runtime registry ids (`road:<edgeId>`, `intersection:<nodeId>`,
  `building:<buildingId>`, `fusion:<featureId>`), which
  `app/3d/editor/selection/selectionIds.js` derives and never stores.

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
- A transform binding is `{ kind, read(legacy, context), plan(delta, context) }`.
  A `TransformDelta` is a world-space column-major 4×4 matrix
  (`objects/transformDelta.js`, kernel-safe). `plan()` returns plain
  `PlanStep`s (`move-node`, `set-feature-transform`, `set-building-footprint`,
  `set-object-component`) or structured `transform.*` issues
  (`not-transformable`, `locked`, `scale.unsupported`, `scale.non-uniform`,
  `rotation.unsupported`, `object.missing`) and never mutates. Props accept yaw
  and planar translation; buildings accept yaw, translation, and scale (height
  follows the Y scale); road edges and intersections translate their nodes;
  groups compose the delta into their frame; `asset-instance` is not
  transformable until ED-06. `road`/`intersection` are transformable and
  intersections are deletable.
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
  reconcile; the CommandBus keeps the overlay live in-session, so save-time
  reconcile is a no-op after any committed command.

### Commands, gestures, and history

- `app/3d/editor/commands/` is the single mutation path for tools, chrome, and
  MCP. It may import Three math and the document layer; it never imports
  React, DOM globals, scene adapters, the runtime registry, or `/city/`,
  `/earth/`, `/overlay/`, `/map/`, `/tools/`, `/projection/` (grep test in
  `tests/command-bus.test.js`). Ownership: `objects/` plans, `commands/`
  applies, `projection/` renders.
- `EnvironmentDocument` carries a monotonic `version`, `transaction(fn, meta)`,
  `replaceDomainRecords(domain, entries)`, `setScalar(name, value)`, and
  `index()`. Every notification delivers `(snapshot, event)` with
  `event = { version, transient, changeSet, source }`. Transient events
  describe in-progress gesture frames; persistence ignores them (and
  `source: "cancel"`) and the projector consumes them. Every
  `documentMutations` helper honors `{ notify: false }`.
- A `ChangeSet` (`document/ChangeSet.js`) records, per domain (`roads.nodes`,
  `roads.edges`, `roads.turnRules`, `buildings`, `features`, `objects`) and per
  scalar (`earth`, `*Authored`, `chunkSize`), the complete before and after
  record keyed by id. `applyChangeSet(document, changeSet, "before" | "after")`
  is total and idempotent; undo and redo are exactly these calls.
- `translateRoadNodes` moves any road node in XZ (and optionally Y) regardless
  of degree or kind and rewrites the explicit arm points of incident edges;
  connected roads stay connected. `canMoveNode` gates only the map pen's
  snap/connect path.
- `CommandBus.execute(command)` runs `command.run(ctx)` inside one document
  transaction, reconciles the live overlay, validates the object graph with
  `validateObjectRecords`, and either commits exactly one change set to history
  or restores the document byte-identically and returns structured issues
  (`command.*`, `transform.*`, or `object.*` codes). `bus.transaction(label, fn)`
  groups several commands into one history entry and aborts atomically. History
  is bounded (200) and reset by `EnvironmentLoader.apply` and Earth Import apply.
- Gestures: `beginGesture({ objectIds, sub, label })` captures the pristine
  records of the transform closure (roots pruned to ancestors, groups expanded
  to descendants, legacy dependencies collected through `getDependencies` with
  `context.legacy`, incident edges included); each `updateGesture(delta)`
  restores that capture and re-applies the cumulative delta (idempotent) and
  notifies `transient: true` with a change set relative to the last frame;
  `commitGesture` publishes one non-transient change set (none for a no-op
  drag; a rejected last frame commits nothing); `cancelGesture` restores the
  capture and publishes `source: "cancel"`, never entering history. One gesture
  is active at a time; executing a command or undo cancels it first.
- Shared road nodes reached through several selected objects (an edge and its
  junction, two edges sharing a node) are planned exactly once. Locked objects,
  non-transformable types, non-uniform scale on groups or multi-selections, and
  scale on props reject the whole plan before any mutation.
- Reparent validates the complete candidate array before commit; cycles,
  self-parenting, missing or non-group parents, and non-groupable roots are
  rejected atomically; world placement is unchanged because no geometry or
  frame changes. Group creates a group at the first root's slot with its frame
  at the roots' centroid; ungroup releases children into the group's slot;
  duplicate copies props, buildings, and groups (new ids, `name copy`, placed
  after the source) and rejects roads, intersections, skybox, and tile until
  ED-04; delete cascades through descendants and rejects skybox, tile,
  asset-instance, unknown types, and locked records atomically.
- MCP mutations run the same commands through `EnvironmentCommandService`
  (`loadDocument` builds the service); `environment_move_road_node` moves
  junctions in XZ and keeps connected roads connected.

### Selection and projection

- Selection identity is object ids plus an optional sub-object
  `{ kind: "road-node", id }` for endpoint nodes without a record
  (`SelectionStore`: ordered ids, primary, modes `replace | add | toggle |
  remove`, `prune`, `suppress`). Registry entity ids are derived, never stored.
  Selection never marks the environment dirty; the persisted editor state is
  `EditorState.persistedSnapshot()` (layers, hidden ids, mode, map viewport,
  earth import).
- `SceneProjector.applyChanges(changeSet)` is the only path from a document
  change to runtime meshes, registry entities, chunk membership, and LiDAR
  truth triangles; `EnvironmentLoader.apply` and Earth Import apply remain the
  load-time full rebuilds. Props move in place; buildings follow the cumulative
  delta on their existing mesh during a gesture and regenerate once on any
  non-transient change with triangles replaced only for that building; roads
  rebuild the local closure only (E1 = changed edges and edges incident to
  changed nodes; J1 = junctions at their endpoints that are or were rendered;
  E2 = E1 plus every edge incident to J1), keyed by id, with intersections
  outside J1 relinked to replaced `Road` objects and `replaceTriangles` scoped
  by source id. Insets are planned over the whole graph
  (`planRoadNetwork`); only the closure is materialized
  (`materializeRoadNetwork`). Browser-only helpers (placement catalog,
  building generator) are injected by the loader so `Environment` and the
  projector load under node.
- Runtime road identity is `road:<edgeId>` / `intersection:<nodeId>` /
  `road-node:<nodeId>`; `road:<index>` aliases exist only after a full load.
  Runtime hydration marks junction kinds sticky, so a junction reduced to one
  road keeps its intersection record without a runtime entity (ED-04 revisits
  topology).

### Presentation and shortcuts

- `EditorPresentationRegistry` (`app/3d/editor/presentation/`) maps a `typeId`
  to `{ icon, label, getMenuOptions(ctx, defaults), getInspectorSections(ctx,
  defaults), renderPreview }`. Unregistered types fall back to a
  capability-derived default (rename, frame, duplicate, group, ungroup,
  hide/show, lock/unlock, delete; object, transform, options, and unsupported
  sections). Hierarchy and inspector consume it exclusively; the hierarchy tree
  model (`hierarchyModel.js`) is pure. A new type appears in both by
  registration alone (`tests/editor-presentation.test.js`).
- Editor shortcuts (`Q`/`W`/`E`/`R` in the scene view, `Escape`, `Enter` for
  a road-pen draft, `Mod+Z`, `Shift+Mod+Z` / `Ctrl+Y`, `Mod+D`, `Delete` /
  `Backspace`, `Mod+G`, `Shift+Mod+G`, `F`) register through
  `ShortcutProvider` (`EditorCommandShortcuts`), never fire in editable
  fields, and consume the event only when something happened. Nothing editor-
  related registers on the raw `KeyManager`. `matchesShortcut` understands
  `Mod`, `Ctrl`, `Alt`, and `Shift` prefixes; bare letters never fire with
  Cmd/Ctrl/Alt held. `EditorToolController.handleEscape()` is the single
  Escape policy: cancel an active gesture, then a map draft, then leave the
  active tool, then clear the selection; it returns `false` when nothing was
  consumed so the global workspace switcher opens (the
  `__fusionEnvironmentEditorConsumesEscape` flag mirrors that state).
- Built-in inspector sections beyond the generic fields are pure descriptors
  in `presentation/builtinSections.js` (`turn-rules` for junctions,
  `road-endpoints` for edges, `sky-local-preview` for the Skybox) registered
  with the icons; the inspector maps `kind` to a component. Types may hide
  fields by mode: `getFields(context)` receives `{ record, value }` and
  `readObjectFieldValues` returns both `fields` (applicable) and `allFields`.
- There is no development flag. The editor preferences (all localStorage,
  never in the manifest) are `cev-sim.ui.environmentEditor.paneLayout`,
  `.viewOptions`, `.hierarchyExpanded`, and `.inspectorSections`.

### Option write path and the sky scalar (ED-03)

- `planOptions(record, value, context)` is a required type method
  (`REQUIRED_TYPE_METHODS`; `defineObjectType` supplies a default that
  rejects with `options.unsupported`). It returns `{ steps, issues, delta? }`:
  plain `PlanStep`s applied by `commands/planApply.js`, or a world
  `TransformDelta` that the command routes through `planTransform` so group
  descendants bake exactly once. Plan ops added in ED-03: `set-edge-options`
  (`updateRoadEdge`), `set-building-record` (`updateBuildingRecord`),
  `set-feature-record` (`updateFeatureRecord`; a type change re-tags
  `[oldType]` → `[newType]`), `set-earth-source` (merged into the `earth`
  scalar), `set-sky`. Per type: road → edge patch (direction cleared when
  two-way), intersection → `move-node` with the new `y`, building → height and
  texture, prop → asset id (`type`), placement, yaw, facing, tile → bounds
  (provider and anchor are `readOnly`), skybox → `set-sky`, group → frame
  delta, asset-instance → unsupported.
- `objectCommands.setObjectOptions({ objectId, patch })` accepts
  `[{ path, value }]` entries or a plain object (nested keys that name no
  descriptor still surface as `options.unknown-path`). Order: missing/locked
  record → descriptor lookup (`options.unknown-path`, `options.read-only`) →
  `validateFieldConstraints` on the raw candidate → `options.normalize` →
  `options.validate` → `planOptions` → apply. Issues keep their field `path`
  and `objectId`; a failure leaves the document byte-identical.
  `setObjectsOptions({ objectIds, patch })` applies one patch to several
  records in one `run()` and aborts on the first failure (one history entry,
  atomic). Both are in `EnvironmentCommandService.commandFactories`.
- The sky is a document scalar: `CHANGE_SCALARS` includes `sky`,
  `EnvironmentDocument.sky` / `setSky()` hold the manifest-shaped config,
  `snapshot()` emits `sky` only once seeded (v2/v3 snapshots stay
  byte-identical), and `toManifest()` strips it so the persisted location stays
  `manifest.sky` and `manifest.document` is unchanged. `Environment` seeds the
  scalar from the sky state and keeps it current when legacy callers write the
  state directly (no history entry); the `sky` projector mirrors committed,
  undone, and redone scalar changes into `EnvironmentSkyState`, whose
  session-only fields (local preview, runtime status) never enter the
  document. `CommandBus.sky` resolves `document.sky` first. Sky is not read by
  `createWorldDescription`; `worldHash` is unchanged.
- `featuresProjector` re-places a prop when its `type` or `dir` changes and
  moves it in place otherwise.

### Workspace (ED-03)

- `editor/workspace/paneLayout.js` is the pure pane model: hierarchy 232 px
  (180–480), inspector 304 px (240–560), asset pane 208 px (120–480), 6 px
  splitters, 28 px collapsed rails, top bar 40 px, toolbar 36 px. `clampPaneLayout`
  keeps the scene pane at or above 480 × 240 px by shrinking the inspector,
  then the hierarchy, then the asset pane, and collapsing in that order when
  minimums are not enough. Layouts serialize as `{ version: 1, panes }`.
- The scene pane publishes its viewport-relative rectangle; `TotalScene`
  resolves the render viewport as embedded (Experiments) > workspace > window
  (`app/3d/viewportRect.js`) and sizes the renderer, camera, and sky manager
  from it (sky resizes are debounced during pane drags). Keys and the overlay
  stay live for the workspace viewport; only `embeddedViewport` disables
  them. The center cell is `pointer-events: none`, so picking and
  `TransformControls` keep receiving canvas-relative events;
  `isOverlayEvent` also treats portaled Radix surfaces as chrome. Enum and
  asset fields use native selects so no option list portals over the scene.
- Scene and Map are views: `EditorState.editorMode` (`scene` | `map`) selects
  the center content; hierarchy and inspector stay mounted. Earth Import
  remains a mode whose chrome overlays the scene pane while the other panes
  hide (ED-08 replaces it).
- View options (`transformSpace`, `transformSnap`, `sceneGridVisible`,
  `selectionBoundsVisible`, `chunkOutlinesVisible`) live on `EditorState`,
  are excluded from `persistedSnapshot()`, and are remembered as a preference.
  `TransformTool.sync()` applies axis space (local follows the primary's yaw
  for a single selection) and snapping; `SelectionVisualizer` honors the
  bounds toggle. Overlay toggles shipped: grid (scene working grid / map
  grid), chunks, selection bounds; LiDAR and collision arrive with ED-07.
- `EnvironmentPersistence.subscribe()` publishes `{ dirty, sending, conflict,
  revision }` for the save status.

### Schema v4 and write policy

- Readers accept schema versions `2`, `3`, and `4`. v2/v3 read views never
  inject a graph ("implied, not injected"); `presentEnvironmentObjectGraph`
  derives one in memory. v4 read views structurally normalize `objects`.
- Writes produce v4 by default since ED-02 (`StorageService` option
  `environmentSchemaVersion` defaults to `4`; `3` opts out, and the server maps
  `CEV_SIM_ENVIRONMENT_SCHEMA_V4=0` to `3` as a temporary escape hatch retired
  in ED-03; the constructor does not read the environment so tests stay
  deterministic). The v3 writer strips `objects` and `objectGraphVersion`,
  which is lossy once names, groups, locks, or hidden flags are authored.
- A v4 write reconciles the incoming graph against the legacy domains,
  validates it, and rejects error-severity issues atomically with HTTP `400`
  `ENVIRONMENT_OBJECT_GRAPH_INVALID` and an `issues` array. Nothing is written
  on rejection.
- Sticky v4: a stored v4 file is never rewritten as v3, even under the opt-out.
- The first v4 save over a v2/v3 file stores a write-once copy at
  `<dataDir>/environment-migrations/<id>.pre-v4.json`
  (`{ kind: "cev-sim.environment-pre-migration", version: 1, environmentId,
  fromSchemaVersion, toSchemaVersion, revision, migratedAt, manifest }`).
  The directory is separate because `environments/` is catalog-scanned and
  `environment-transactions/` is journal-scanned. Recovery is a manual restore
  of `manifest` in ED-01.
- Downgrade rejection: when the stored file is v4 with records, the incoming
  `document` is an object without an `objects` array, and the stored overlay
  carries authored data (`objectGraphHasAuthoredData`: groups, unknown types,
  renames, parents, tags, locks, hidden flags, group frames), the write is an
  old client and fails with HTTP `409` `ENVIRONMENT_SCHEMA_DOWNGRADE`
  (`storedSchemaVersion`, `incomingSchemaVersion`, `currentRevision`). A purely
  derived overlay loses nothing and is re-derived instead (ED-02). The guard
  keys on the objects array, not the declared version, because graph-aware
  browsers still declare `schemaVersion: 3`. Writes that omit `document`
  (rename) reuse the stored document and pass.
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
nodes moved once, and atomic rejection of unsupported transforms. Delivered as
five slices: ED-02a document core (`version`, transactions, `ChangeSet`,
`translateRoadNodes`, `transformDelta`, `binding.plan()`), ED-02b commands
(`CommandBus`, gestures, planner, object and legacy commands, live overlay,
`SelectionStore`, `EnvironmentCommandService`, MCP), ED-02c projection
(`SceneProjector`, `planRoadNetwork`/`materializeRoadNetwork`, tool and map
rewiring, persistence subscription), ED-02d presentation
(`EditorPresentationRegistry`, hierarchy tree, inspector, shortcuts), ED-02e
the schema-v4 default and documentation.

### ED-03 — Workspace and inspector

**Depends on:** ED-02. Delivered as five slices: ED-03a option write path
(`planOptions`, `setObjectOptions`, sky scalar, projector touch-ups), ED-03b
workspace shell (pane model, splitters, viewport publication, unified views,
toolbar, top bar, shortcut scoping), ED-03c generic fields and the inspector
rewrite (field model, controls, built-in sections, retirement of the map
inspector and sky flyout), ED-03d windowed hierarchy and asset pane shell,
ED-03e opt-out retirement, Playwright/axe coverage, and documentation.

Resizable, collapsible panes in the fixed arrangement (232 px hierarchy,
304 px inspector, 208 px asset panel; sizes and collapsed states remembered as
editor preferences), unified scene/map views over the same document, selection,
and tools, the icon toolbar with tooltips, accessible names, keyboard focus,
and active states, editable generic fields (`NumberField`, `Vector3Field`,
`EnumField`, `AssetReferenceField`, `ToggleField`, `PropertySection`) rendered
from `getFields()`, mixed values during multi-selection, the Skybox inspector,
keyboard interactions (Q/W/E/R, F, Escape, Delete, undo/redo) scoped to the
workspace and never consuming typing in fields, a usable layout at 1280 × 720
with the desktop-size guard retained, and retirement of the
`CEV_SIM_ENVIRONMENT_SCHEMA_V4=0` opt-out.

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
  tests/object-registry.test.js tests/object-graph.test.js tests/mcp-tools.test.js \
  tests/document-changeset.test.js tests/command-bus.test.js tests/command-groups.test.js \
  tests/scene-projector.test.js tests/editor-interactions.test.js \
  tests/editor-presentation.test.js tests/road-elevation.test.js \
  tests/ui-interactions.test.js tests/ui-conventions.test.js \
  tests/command-options.test.js tests/pane-layout.test.js tests/editor-workspace.test.js \
  tests/field-model.test.js tests/virtual-window.test.js
npm run lint
npm test
npm run test:ui -- tests/ui/environment-editor.spec.js
npm run test:a11y -- tests/ui/environment-editor.spec.js
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
- [x] ED-02 — Commands and hierarchy. Local acceptance evidence (2026-09-11):
  focused ED suites 231/231 passed across the 22 files in the verification
  block (the ED-01 baseline was 162 across 13); `npm run lint` zero errors, one
  pre-existing warning in `app/client/Client.js`; `npm test` 1068/1072 passed
  with four declared hardware/host skips and zero failures; `npm run
  fixtures:headless` no delta; `npm run fixtures:environment-editor` no delta
  (`worldHash`, `roadNetworkHash`, and `lidarGeometryHash` unchanged with group
  transforms baked into legacy records); `npm run dist:headless` ok (the kernel
  bundle now also reaches `app/3d/editor/objects/transformDelta.js`). Merge-gate
  coverage: select/drag/cancel/undo/redo/duplicate/reparent/reload in
  `tests/editor-interactions.test.js`; nested transforms, preserved world
  placement, cycle rejection, shared nodes moved once, and atomic rejection in
  `tests/command-groups.test.js`; the drag-does-not-rebuild-the-world check in
  `tests/scene-projector.test.js`; the extension demonstration in
  `tests/editor-presentation.test.js`. Playwright/accessibility checks arrive
  with ED-03's workspace.
- [ ] ED-03 — Workspace and inspector.
- [ ] ED-04 — Road geometry.
- [ ] ED-05 — Lane authoring.
- [ ] ED-06 — Asset catalog.
- [ ] ED-07 — Asset studio.
- [ ] ED-08 — Creation and imports.
- [ ] ED-09 — Acceptance.

## Decision log

### 2026-09-11 — Implement ED-03 workspace and inspector

Two decisions were taken with the human before implementation. Skybox edits
go through the CommandBus: the sky became a document scalar mirrored into
`EnvironmentSkyState` rather than a direct write to the runtime state, so sky
edits are validated, undoable, and visible to persistence like every other
field; the persisted location stays `manifest.sky`, `snapshot()` carries the
scalar only once seeded and `toManifest()` strips it, so `manifest.document`
and every v2/v3 snapshot comparison are unchanged (a failed command restores
through `snapshot()`, which is why the scalar lives in the public snapshot
rather than a private diff view). Overlay toggles ship only for content that
renders today (grid, chunks, selection bounds); LiDAR and collision toggles
arrive with ED-07's proxies instead of as disabled placeholders.

The option write path is a type contract, not inspector logic: `planOptions`
joined the required type methods with a rejecting default, so a new type
gains editable fields by returning plan steps (or a world delta) and the
inspector, MCP, and tests never branch on `typeId`. Patches accept either
`[{ path, value }]` entries or nested objects, and validation runs on the raw
candidate before `normalize()` so out-of-range input is reported instead of
silently clamped.

Layout facts that shaped the shell: `TotalScene`'s existing `embeddedViewport`
disables keyboard handling and hides the overlay, so the workspace publishes a
separate scene-pane rectangle resolved with embedded > workspace > window
precedence; the center grid cell is `pointer-events: none` so the canvas
beneath keeps receiving canvas-relative pointer events; `isOverlayEvent`
treats portaled Radix surfaces as chrome and enum fields use native selects
because the pick tool listens on `window`. No dependency was added: the pane
splitter, the windowed hierarchy, and the field controls are hand-rolled on
the existing kit. The React Compiler memoizes render-time derivations by
reference, and commands mutate records in place, so the inspector reads the
document/registry/presentation version counters inside its derivation to
force recomputation. Q/W/E/R and Escape moved from the raw `KeyManager` to
`ShortcutProvider` so they never fire while typing; `handleEscape()` returns
`false` when nothing was consumed so the global workspace switcher still
opens. The `ShortcutProvider` treats any mounted `role="listbox"` as an open
overlay, so persistent panes must not use that role (the asset grid is a
button group). Scene/Map became two views of one document with hierarchy and
inspector always mounted; Earth Import stays a mode until ED-08. The
`CEV_SIM_ENVIRONMENT_SCHEMA_V4=0` opt-out and the `groupFrameFields`
preference were retired; `environmentSchemaVersion: 3` remains a test-only
`StorageService` option and a test greps `app/` and `server/` for the env var.

### 2026-09-11 — Record the ED program

The environment editor becomes a separate `ED-*` program with nine
dependency-ordered PRs. It is not a headless PR 13 and does not reopen the
visual-layer release verdict. The program keeps JavaScript/ESM, the existing
React, Three.js, Radix, styling tokens, and Tabler icons, the
revision-guarded environment `PUT`, and the `worldHash` / visual-identity
rules from the headless and visual plans. Legacy geometry domains remain
canonical until a milestone explicitly versions the world description.

### 2026-09-11 — Implement ED-02 commands and hierarchy

Three decisions were taken with the human before implementation. Group
transforms bake into children: the group `transform` component is a world
pivot frame, a group gesture applies the world delta once to every non-group
descendant's legacy record and composes it once into every descendant group's
frame, and legacy domains stay absolute, so `createWorldDescription`,
`worldHash`, and the compatibility baseline are untouched (persisting
parent-relative transforms would have required versioning the world
description inside ED-02). Roads rebuild only their local closure (changed
edges, the intersections at their endpoints, and those intersections' other
incident edges) with insets planned over the whole graph; per-edge geometry
waits for ED-04's `RoadGeometry`. Schema v4 became the default writer in ED-02
rather than ED-03 because the overlay stops being derivable the moment a group,
rename, lock, or hidden flag is authored; `CEV_SIM_ENVIRONMENT_SCHEMA_V4=0` is
a temporary opt-out retired in ED-03, and AGENTS.md was updated accordingly.

Layering: `objects/` plans (bindings return plain `PlanStep`s from a
kernel-safe `TransformDelta`), `commands/` applies (the only mutation path,
grep-tested against React, DOM, scene adapters, and the registry), and
`projection/` renders (`SceneProjector` is the only path from a change set to
runtime meshes, registry, chunks, and LiDAR truth). `ChangeSet` lives in
`document/` so the document can diff its own transactions without importing
the command layer. Undo and redo are whole-record before/after replacement,
which makes the non-idempotent footprint transform safe. Gesture frames restore
the pristine capture and re-apply the cumulative delta, so a drag is one
history entry whatever the pointer does; frames are `transient` and persistence
ignores them and cancels. `order` is sibling-relative and dense. MCP mutations
run the same commands and `environment_move_road_node` moves junctions in XZ.
Duplicate covers props, buildings, and groups until ED-04 owns road topology.

The old-client downgrade guard was refined: a graph-unaware write over a stored
v4 overlay is rejected only when the overlay carries authored data
(`objectGraphHasAuthoredData`); a purely derived overlay is re-derived from the
new geometry, so visual-reference, duplicate, rename, and import flows that
never touch the overlay keep working after the default flip. For the same
reason the run-bundle import identity (`environmentImportHash`) now ignores
`document.objects` and `objectGraphVersion` alongside `schemaVersion`,
`visualLayer`, and `evidence`, so a v2/v3 bundle environment re-resolves
against its stored v4 twin instead of importing a conflicting copy (the VIS-12a
legacy import test would otherwise change `roadNetworkHash` through the
suffixed environment id). Runtime hydration
marks junction kinds sticky, so a junction reduced to one road keeps its
intersection record without a runtime entity; ED-04 revisits topology.

The placement catalog and building generator are browser-only (bundler
aliases, DOM texture loading), so the projector receives them by injection
(`browserProjectorRuntime.js` from the loader); `Environment`, the bus, and the
projector load under node and the interaction suites drive a real
`TransformControls` against a stub DOM element. React panels cannot be
imported by node, so the presentation registry and the hierarchy tree model
are pure and tested directly; the extension demonstration registers a
test-only `test.marker` type with a custom icon and inspector section and
shows it nested in the hierarchy tree without editing hierarchy or inspector
code. The only development flag is the localStorage preference
`cev-sim.ui.environmentEditor.groupFrameFields`.

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
