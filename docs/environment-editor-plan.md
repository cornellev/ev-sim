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

- Next milestone: **none — the ED-* program is complete**.
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
  Playwright/axe coverage, and retirement of the v4 opt-out), and **ED-04 —
  Road geometry** (versioned polyline/Bézier authoring, deterministic shared
  surfaces, topology commands, route v6, Scene/Map interaction, and guarded
  persistence/MCP writes), and **ED-05 — Lane authoring** (explicit ordered
  lanes with stable ids, per-lane directions and widths, per-boundary
  markings, the `RoadDisplay` cross-section diagram and `road-lane`
  sub-selection, asymmetric-aware turn-rule feasibility, route algorithm 7
  with lane-id anchors and proof invalidation, and MCP lane operations), and
  **ED-06 — Asset catalog** (the journaled server catalog and immutable model
  revisions, dependency-complete GLTF/GLB import, editor-only projected model
  instances, shared Scene/Map placement, read-only session preview tabs, and
  explicit atomic instance revision updates), and **ED-07 — Asset studio**
  (versioned asset definitions and assemblies, PBR materials and textures,
  deterministic collision/LiDAR proxies, isolated document history,
  journaled publication, immutable environment metric snapshots, world v3,
  route proof v8, swept-compound physics v2, and measured PBR composition),
  and **ED-08 — Creation and imports** (atomic Blank/Google/GLTF creation,
  `geoFrame@1` and Earth source v2, clipped provenance-preserving OSM drafts,
  Add/Replace import commands, explicit Roads-only/Whole-environment
  georegistration, environment-owned bounded Google tile sessions, and
  asset-backed GLTF `tile@2`), and **ED-09 — Acceptance** (`createObject` and
  overlay-only duplicate, windowed asset catalog, write-once source/metrics
  copies, CommandBus MCP apply, default-on chrome, and the acceptance
  Playwright/axe workflow).
  Existing environments retain their legacy behavior; schema v4 is the only
  writer.
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
- Last updated: **2026-09-15 — editor chrome padding**.

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
  direction, explicit lane ids and widths (`edge.lanes[]`, ED-05), and enabled
  proxies do; lane and border markings do not.
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
  groups compose the delta into their frame; `asset-instance` composes exact
  `T × Ry × S` records with positive local per-axis scale when selected alone.
  `road`/`intersection` are transformable and intersections are deletable.
- `ObjectOptions` subclasses must implement `getDefaults`, `getFields`,
  `normalize`, and `validate`; the base constructor rejects partial subclasses.
  Field descriptors are frozen `{ path: string[], label, control, units?, min?,
  max?, step?, options?, group?, advanced?, readOnly? }` with controls
  `number | text | toggle | enum | vector3 | color | asset-reference`.
  Validation returns `{ path, code, message, severity }` issues and never
  throws on bad input. In ED-01 option values are projected from the canonical
  legacy record (`options.fromLegacy`), never persisted in the overlay.
- Built-in types: `group`, `skybox`, `tile`, `road`, `intersection`,
  `building`, `builtin-prop`, and `asset-instance`. The five
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
-   `SceneProjector.applyChanges(changeSet)` is the only path from a document
  change to runtime meshes, registry entities, chunk membership, and LiDAR
  truth triangles; `EnvironmentLoader.apply` and Earth Import apply remain the
  load-time full rebuilds. Props move in place; buildings follow the cumulative
  delta on their existing mesh during a gesture and regenerate once on any
  non-transient change with triangles replaced only for that building. Road
  `updateGesture` frames skip `planRoadNetworkGeometry` and do not rematerialize:
  a uniform affine moves existing road/intersection roots in place; a
  node/knot/handle drag hides those roots and shows a straight width-strip.
  Any non-transient change rebuilds the local closure only (E1 = changed edges
  and edges incident to changed nodes; J1 = junctions at their endpoints that
  are or were rendered; E2 = E1 plus every edge incident to J1), keyed by id,
  with intersections outside J1 relinked to replaced `Road` objects and
  `replaceTriangles` scoped by source id. Insets are planned over the whole
  graph (`planRoadNetwork`); only the closure is materialized
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

### Road geometry v2 (ED-04)

- `roads.geometryVersion: 2` selects the new authoring contract. Its absence
  means legacy v1 and is never injected into an untouched legacy snapshot.
  Every v2 edge owns `geometry: { version: 1, kind, knots }`; endpoint knots
  have reserved ids `start` and `end` and resolve their positions only from
  topology nodes. Interior positions, edge-local stable ids, and array order
  are canonical authoring state. Polyline knots store no mode or handle.
  Cubic knots use `auto`, `aligned`, or `free`; automatic knots omit handles
  and manual handles are relative vectors. Metric roads contain resolved
  polyline/cubic controls without ids or modes, so a mode-only edit that
  preserves the curve preserves metric identity.
- `RoadGeometryPolicy` v1 fixes 1 cm chord deviation, 1 m maximum sample
  spacing, deterministic left-first de Casteljau subdivision, depth 20,
  16,384 samples per edge, XZ lateral normals, a four-offset polyline miter
  limit, and six-decimal metric canonicalization. Exhaustion, folds, unusable
  tangents, invalid junctions, and malformed topology are errors. The pure
  `app/roads/` compiler returns points, span parameters, tangents, cumulative
  XZ distance, boundaries, lane centerlines, indexed surfaces, bounds, and
  mouth fractions. Scene, Map, routes, off-road checks, world resources, and
  LiDAR consume that compiled result instead of resampling it.
- Degree-zero/one nodes have no patch; equal-width tangent-continuous
  degree-two roads join directly. Other degree-two/three/four nodes use a
  deterministic upward-wound convex hull of trimmed mouths at junction
  elevation. Insets are `clamp(0.75 × widest paved width, 2.5, 10)` capped at
  35% of each incident XZ length. Lane connectors are cubics constrained to
  the junction polygon. Cross-road same-elevation overlaps are structured
  conflicts and `strict` callers reject them.
- `roadCommands.js` owns create, convert, insert, remove, set-knot, split,
  detach, and connect. The first of these commands upgrades every legacy edge
  to an explicit polyline, retains ids and arm points, clears legacy arms, and
  sets geometry version 2 in the same transaction. Existing legacy move,
  width, elevation, delete, and MCP-add paths do not upgrade. Split replaces
  one edge with two and a shared derived topology node; detach clones one
  endpoint; connect rewires only the chosen endpoint and can split its target
  atomically. Road-subgraph duplicate clones selected endpoints once and does
  not clone external connections. All previews and commits run the same
  `CommandBus` document/compiler validation and rejected frames restore their
  starting capture.
- `cev-sim.world-description` v1 remains byte-compatible for v1 roads. World
  description v2 contains canonical metric roads plus indexed `road-mesh` and
  junction surfaces and revalidates those surfaces from the road inputs.
  Routing dispatches v1 to algorithm 5 and v2 to algorithm 6. V6 uses XZ arc
  distance, binds the geometry-policy identity, tests the compiled paved union
  including shoulders, and rejects missing or invalid explicit anchors with
  `route.waypoint.anchor-missing` / `route.waypoint.anchor-invalid`; it never
  substitutes a nearest road. V3/v4 proofs remain immutable compatibility
  inputs, v5 remains fully validated for v1, and no old proof is current for a
  v2 environment.
- Environment writes declare request-only `supportedRoadGeometryVersions`.
  Full replacement of v2 without `[1, 2]`, malformed/unsupported geometry, or
  a v2 payload marked v1 fails before the write. The first v2 transition stores
  one `pre-road-geometry-v2` migration copy in the existing revision lane.
  Browser persistence and geometry-aware MCP calls declare `[1, 2]`;
  `environment_edit_road` maps its operation enum to the same command
  factories used by the editor.

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

**Contract (implemented):**

- `edge.lanes?: Array<{ id, direction: 1 | -1 | 0, width, markingLeft? }>`,
  ordered rightmost first (physical index 0). Absent → lanes derive from
  `laneCount`/`width`/`bidirectional`/`direction` exactly as before, keeping
  the literal historical arithmetic. Present → `width` equals the lane-width
  sum, `laneCount` equals the lane count, and `bidirectional`/`direction`
  follow the lane directions; same-direction lanes must be adjacent and `0`
  (shared) is legal only for a single lane. Validation codes are
  `road.lane.*` (`empty`, `id-invalid`, `direction-invalid`,
  `shared-requires-single`, `direction-interleaved`, `width-invalid`,
  `width-mismatch`, `count-mismatch`, `bidirectional-mismatch`,
  `direction-mismatch`, `marking-invalid`, `marking-outer-forbidden`,
  `version-required`) scoped to `roads.edges[i].lanes[k]…`.
- The first lane command materializes lanes on its edge only; a layout equal
  to the derived default canonicalizes back to implicit. `{ id, direction,
  width }` is metric (canonical road network, world description) only when
  explicit, so untouched roads keep their hashes; `markingLeft` and the
  borders are appearance-only.
- Commands: `road.set-lanes`, `road.insert-lane`, `road.remove-lane`,
  `road.set-lane`, `road.set-marking`, `road.set-turn-rule` (structured
  issues; refuses infeasible movements). `set-edge-options` scales explicit
  lanes proportionally on a Width change and rejects `laneCount`/direction
  changes (`road.lane.explicit-field-readonly`); `RoadOptions` hides those
  fields when lanes are explicit and reports layout problems as
  `option.lane-layout` field issues.
- Turn rules stay edge×edge. `app/roads/RoadJunctionValidation.js` assesses
  every incident pair (lane directions plus a lane-to-lane connector inside the
  compiled junction) for the matrix, `setTurnMovementAllowed`, pruning, and
  route v7; a movement without a connector is a validation **warning**.
- Route algorithm 7 for geometry-v2 roads: anchors, traversal steps, and
  subnodes carry stable lane ids; `hashWaypoints` binds `laneId` instead of
  the positional index when present (v5 hashes are byte-identical); a removed
  lane fails with `route.waypoint.lane-missing`; v6 proofs are stale
  (`route.verification.algorithm-invalid`).
- MCP `environment_edit_road` gains `set-options`, `set-lanes`,
  `insert-lane`, `remove-lane`, `set-lane`, `set-marking`, `set-turn-rule`;
  `environment_add_road` accepts `lanes`; `environment_validate` runs the road
  domain and junction checks.

**Merge gate:** asymmetric-lane tests, lane diagram interactions validated
identically to field edits, proof invalidation tests.

### ED-06 — Asset catalog

**Depends on:** ED-02.

Implemented by the pure `app/editor-assets/EditorAssetContract.js` contract.
`editor-assets/catalog.json` is
`cev-sim.editor-asset-catalog@1` with one non-negative `revision` concurrency
token, folders `{ id, name, parentId }`, and asset metadata `{ id, name,
folderId, tags, archived, latestRevision, thumbnails, createdAt, updatedAt }`.
`editor-assets/revisions/<assetId>/<revision>.json` is immutable
`cev-sim.editor-asset-revision@1` `{ assetId, revision, publicationId,
modelUseHash, createdAt }`. Source ids, media type, byte digest, and dependency
mapping remain authoritative in the VIS-04 use closure named by
`modelUseHash`; the catalog does not copy that graph.

`EditorAssetStore` serializes every mutation through one catalog lane. Every
write requires the catalog token and increments it once. Publication journals
the exact target records under `editor-assets/transactions/`, acquires
`editor-asset:<assetId>:revision:<revision>`, writes the immutable revision,
atomically replaces the catalog, then removes the journal. Recovery removes
unpublished state, adopts an exactly committed target, and retains roots while
failing ambiguous state. Thumbnail roots have separate owners. Archive never
releases model roots, and `publicationId` makes a committed retry idempotent.
Folder moves reject missing parents and cycles; nonempty folders cannot be
deleted.

The router mounted at `/api/storage/editor-assets` exposes catalog list,
capabilities, asset metadata, immutable revisions, thumbnails, reference
lookup, and folder CRUD. Static routes are registered before `/:assetId`.
Binary upload and validation stay under `/api/storage/visual-assets`.
Reference lookup scans saved schema-v4 environment documents and returns
environment revision plus matching object ids; no second index exists.
`StorageService` validates only newly introduced or changed pins before the
final environment write, so unrelated edits preserve old unavailable pins and
archived revisions remain readable.

`GltfImportPlan` accepts selected local records and one explicit entry path,
rejects network/absolute/traversing/ambiguous dependency paths, rewrites local
URIs and packed `bufferView` / `data:` images to `sha256:<digest>`, and
reconstructs GLB JSON without changing its BIN chunk. `AssetRepository.import()` uploads dependencies first, binds their use
hashes on the rewritten model, validates the complete closure, supports
`AbortSignal`, and cancels unfinished staging. `AssetModelLoader` revalidates
and verifies exact bytes before GLTF/KTX2 decode, caches one immutable resource
entry per model use, strips imported `userData`, and disposes after its final
lease. One `AssetPreviewRenderer` supplies read-only active-tab previews and
serialized 256 px thumbnails; derivative upload uses the model source lineage
and permission checks.

An `asset-instance@1` remains an object-graph-v1 record. Its `asset` component
is `{ assetId, revision, position:{x,y,z}, rotationY, scale:{x,y,z},
overrides:{} }`; revision is a positive integer, transforms are finite, local
scales are positive, and ED-06 rejects nonempty overrides. The type has an
object-backed transform binding for exact `T × Ry × S` changes. It supports
positive per-axis scale only when transformed alone; group and multi-selection
scale is uniform. Gesture capture includes object-backed leaves, duplicate
copies the component under a new `asset-*` id, and explicit update commands
check document version, before-values, locks, and same-asset revisions before
changing all selected targets atomically.

`assetInstancesProjector` is the only document-to-model path. It generation-
guards asynchronous loads, reuses a lease for transform-only changes, replaces
the lease on a revision change, and releases on delete, full load, mode switch,
or disposal. Registry ids are `asset:<objectId>` and entries are `editorOnly`.
They remain pickable in the editor but skip perception annotation, chunk
assignment/dirtiness, runtime manifest serialization, bake, measured sensors,
collision, LiDAR, and Simulation mode. Registry runtime notifications carry
`affectsPersistence:false`, so load status and bounds never cause autosave.

Scene clicks, HTML drops, and Map clicks share `AssetPlacementController` and
one pinned `{ kind:"catalog", assetId, revision }` payload. Map draws transient
runtime bounds (or a position marker), uses the existing screen-to-world path,
and commits a move gesture while preserving Y. The server-backed asset pane
provides folder CRUD, breadcrumbs, search, sorting, built-in/model and archive
filters, grid/list view, import/reimport, metadata, archive, and thumbnail
retry. Session-only `workspace.assetTabs` implement replacement and pinning;
only the active tab owns a preview lease and environment shortcuts are gated
to the Scene tab. The asset inspector shows pinned/latest/load state and runs
explicit selected-or-all revision updates. ED-07 part, material, proxy, and
asset-edit history remain out of scope.

**Merge gate:** the ten focused ED-06 suites cover contracts, store/API crash
recovery, import/loading, commands, projection/persistence, placement, and
workspace state; `tests/ui/environment-assets.spec.js` covers the complete
import/place/pin/update/archive/mode-switch workflow and accessibility.

### ED-07 — Asset studio

**Depends on:** ED-06.

The implemented authoring contract is `cev-sim.asset-definition@1`: stable
parts retain parent-local transforms and discriminated `group`, `model-node`,
or pinned `asset-reference` content. `cev-sim.editor-asset-revision@2` stores
the definition, flattened PBR appearance, compiled `metric@1`, `metricHash`,
and `geometryHash` while all v1 readers remain valid. `AssetCompiler` resolves
exact child revisions, applies root normalization once, uses portable
ancestry-namespaced proxy ids, and computes generated-proxy freshness from
geometry, transforms, normalization, generator version, parameters, and
included parts. The deterministic primitive policy is sphere 24 by 12 and
cylinder 24 with caps; `VoxelMeshSimplifier` canonicalizes indexed output.

`CommandBus` now delegates reconciliation, validation, gesture planning,
history application, and selection pruning to a document adapter. Each asset
tab owns one `AssetDocument`, command bus, selection store, history, saved
baseline, pending generation, and retained view state. The active tab supplies
the isolated Three.js scene, hierarchy, PBR material inspector, transform and
orbit controls, picking, metric overlays, dirty state, and Save/Discard/Cancel
close flow. Publication can be disabled with `CEV_SIM_ASSET_STUDIO=0`,
recompiled on the server, rejects enabled stale output, atomically roots the
compiled GLB plus sources/textures/child appearances, and leaves environment
pins unchanged.

Published v2 pins use `asset-instance@2` and copy their immutable metric record
into `document.assetMetrics@1`. World-description v3 compiles those records to
world-space `assetProxies`, route proof v8 binds `metricWorldHash` while
retaining base algorithm 5 or 7, and collision worlds select
`rapier3d-swept-compound-v2`. CPU LiDAR consumes only the LiDAR channel and the
shared swept-convex path consumes only collision compounds. PBR resolution
composes published appearance into visual-layer v1 after authoring locks, so
browser and admitted headless packages use the same source-bound bytes.

**Merge gate:** raw-contract, deterministic assembly/staleness, isolated
history, publication/recovery, metric snapshot, world v3/route v8,
swept-convex/LiDAR, measured PBR, browser workflow, accessibility, and
browser/direct/CLI/Unix/Python parity tests; workers never load editor modules
or infer geometry from preview meshes.

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
  tests/field-model.test.js tests/virtual-window.test.js \
  tests/editor-extension.test.js tests/environment-migration-copies.test.js
node --experimental-default-type=module --test \
  tests/road-geometry.test.js tests/road-network-geometry.test.js \
  tests/road-commands.test.js tests/road-routing-v6.test.js \
  tests/environment-road-geometry.test.js tests/road-geometry-integration.test.js
node --experimental-default-type=module --test \
  tests/road-lanes.test.js tests/road-lane-commands.test.js tests/road-turn-validation.test.js \
  tests/road-routing-v7.test.js tests/route-proof-invalidation.test.js \
  tests/road-lane-selection.test.js tests/road-lane-rendering.test.js tests/road-lane-mcp.test.js \
  tests/lane-aware-routing.test.js tests/scenario-routes.test.js tests/scenario-document.test.js
npm run lint
npm test
npm run test:ui -- tests/ui/environment-acceptance.spec.js
npm run test:a11y -- tests/ui/environment-acceptance.spec.js
npm run test:ui -- tests/ui/environment-editor.spec.js
npm run test:a11y -- tests/ui/environment-editor.spec.js
npm run test:ui -- tests/ui/environment-road-geometry.spec.js
npm run test:a11y -- tests/ui/environment-road-geometry.spec.js
npm run test:ui -- tests/ui/environment-road-lanes.spec.js
npm run test:a11y -- tests/ui/environment-road-lanes.spec.js
npm run test:parity
npm run dist:headless
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
- [x] ED-03 — Workspace and inspector. Shipped with the option write path,
  resizable pane workspace, inspector rewrite, windowed hierarchy, asset pane
  shell, and Playwright/axe coverage in `tests/ui/environment-editor.spec.js`
  plus the ED-03 node suites (`command-options`, `pane-layout`,
  `editor-workspace`, `field-model`, `virtual-window`). The ledger checkbox was
  left unset at ship time; ED-09 re-ran those node suites inside the 270/270
  focused block. The Playwright/axe spec was not re-run at close.
- [x] ED-04 — Road geometry. Local acceptance on 2026-09-12: the six focused
  suites passed 21/21; `npm run lint` completed with zero errors and the one
  pre-existing unused-disable warning in `app/client/Client.js`; `npm test`
  passed 1122/1126 with zero failures and four declared hardware skips
  (WebGL2 LiDAR, VIS-15a hardware PBR, protocol 1.2 GPU shared memory, and
  VIS-15b managed hardware PBR). The ED-04 Playwright workflow and its
  1280 × 720 axe run each passed. `npm run test:parity` passed state-only,
  CPU-LiDAR, and curved/elevated road-v2 cases across the browser adapter,
  direct runner, CLI, gRPC UDS, and Python client. `npm run dist:headless`
  produced the npm package and both Python distributions. Both fixture
  generators completed with zero legacy drift: headless characterization
  SHA-256 `60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f`
  and environment-editor compatibility SHA-256
  `fb68611743c6e13490d100dd420d3ff4a972bcc3eb278e04016f9b170405f82b`.
- [x] ED-05 — Lane authoring. Explicit per-edge lanes (`edge.lanes[]` with
  stable ids, directions, widths, interior markings) that derive from and
  canonicalize back to the legacy fields; `road.set-lanes` / `insert-lane` /
  `remove-lane` / `set-lane` / `set-marking` / `set-turn-rule`; the
  `RoadDisplay` cross-section section and `road-lane` sub-selection in the
  inspector, Map, and shortcuts; Map dividers/arrows/lane highlight and scene
  markings from the authored styles; asymmetric-aware junction feasibility
  (`RoadJunctionValidation`); route algorithm 7 with lane-id anchors and
  proof invalidation; MCP lane operations and road-domain validation. The
  ED-05 focused block passed 78/78 (`road-lanes`, `road-lane-commands`,
  `road-turn-validation`, `road-routing-v7`, `route-proof-invalidation`,
  `road-lane-selection`, `road-lane-rendering`, `road-lane-mcp`,
  `lane-aware-routing`, `scenario-routes`, `scenario-document`);
  `npm run lint` passed with 0 errors (one pre-existing unrelated warning);
  `npm test` passed 1162/1166 with 4 declared skips and 0 failures;
  `npm run test:ui` and `npm run test:a11y` passed for
  `tests/ui/environment-road-lanes.spec.js`. Fixture generators: headless
  characterization zero drift (SHA-256
  `60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f`,
  unchanged); environment-editor compatibility zero drift on the four prior
  cases plus the new `asymmetric-lanes-v2` case (SHA-256
  `6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`).
  Not run in this pass: `npm run test:parity`, `npm run dist:headless`, and
  the ED-03/ED-04 Playwright specs.
- [x] ED-06 — Asset catalog. Immutable catalog revisions over VIS-04 model-use
  closures; recoverable publication, folder/metadata APIs, reference scans,
  dependency-complete GLTF/GLB import, shared exact-byte loading and thumbnail
  rendering; command-backed pinned instances and atomic explicit updates;
  editor-only projection with nonpersistent runtime events; shared Scene/Map
  placement; server-backed library and read-only session preview tabs. The ten
  focused ED-06 suites passed 25/25; `npm run lint` passed with 0 errors and
  one pre-existing unrelated warning; `npm run build` passed; `npm test`
  passed 1191/1195 with four
  declared hardware skips and zero failures. The ED-06 Playwright workflow and
  its 1280 × 720 axe run each passed. Both fixture generators completed with
  zero drift: headless characterization SHA-256
  `60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f`
  and environment-editor compatibility SHA-256
  `6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`.
- [x] ED-07 — Asset studio: asset-definition v1 and revision v2 contracts;
  deterministic assemblies, primitives, proxy freshness, and flattened GLB
  publication; isolated tab documents/history and interactive projections;
  atomic metric snapshots in asset-instance v2 environments; world v3, route
  proof v8, swept-compound physics v2, CPU LiDAR, and measured PBR composition.
  The consolidated focused gate passed 62/62; `npm test` passed 1200/1204 with
  four declared hardware skips and zero failures; lint passed with zero errors
  and one pre-existing warning; production and headless distribution builds
  passed. The complete Playwright workflow and its 1280 x 720 axe dialog run
  each passed. Browser/direct/CLI/Unix/Python parity passed all four cases,
  including `asset-assembly-metric-v1`, and Python passed 68/68. The packaged
  PBR hardware fixture then executed 1/1 on Apple M1 Max ANGLE Metal with no
  skip. Both fixture generators produced zero legacy drift; action-tape,
  characterization, and environment-editor SHA-256 values remain
  `1ba8c8c40e1560ac044f4ca5384065ab83c93529d65b5672fee8dc5ed42a5ced`,
  `60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f`,
  and `6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`.
- [x] ED-08 — Creation and imports. Optional `geoFrame@1`, independently
  versioned Earth v2, guarded source writers, and road provenance; pure shared
  WGS84 east/up/south transforms with explicit undoable migration; clipped OSM
  import topology and deterministic lane drafts; staged Add/Replace/tiles-only
  commands; environment-owned Google sessions with AOI/cache/attribution and
  exclusion boundaries; GLTF `tile@2` through immutable asset bindings; and
  atomic three-source creation. Focused ED-08 coverage passed 61/61 and the
  affected registry/command compatibility coverage passed 65/65; the shared
  asset metric/PBR gate passed 29/29. `npm run lint` passed with zero errors and
  one pre-existing warning. `npm test` passed 1233/1237 with four declared
  hardware skips and zero failures; the production and headless distribution
  builds passed, and browser/direct/CLI/Unix/Python parity passed. The 1280 ×
  720 Playwright creation/import workflow and axe run passed. Both fixture
  generators produced zero drift; action-tape, characterization, and
  environment-editor compatibility SHA-256 values remain
  `1ba8c8c40e1560ac044f4ca5384065ab83c93529d65b5672fee8dc5ed42a5ced`,
  `60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f`,
  and `6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`.
- [ ] ED-09 — Acceptance. Audit and bounded-fix evidence (2026-09-13): the
  exact verification blocks passed 281/281 (core, including
  `editor-extension`, `environment-migration-copies`, and `virtual-window`),
  21/21 (ED-04 roads), and 78/78 (ED-05 lanes). `npm run lint` completed with
  zero errors and the one pre-existing unused-disable warning in
  `app/client/Client.js`. `npm test` reported 1,260 tests: 1,256 passed, four
  declared hardware/host checks skipped, and zero failures. `npm run
  test:parity` passed state-only, CPU-LiDAR, road-geometry-v2, and
  asset-assembly-metric-v1 across the browser adapter, direct runner, CLI,
  gRPC UDS, and Python client. `npm run dist:headless` produced the npm package
  and both Python distributions.

  The serial seven-spec production Playwright matrix used isolated temporary
  storage and completed 3/21 tests before it was stopped: both ED-09 acceptance
  tests and the ED-07 asset-studio workflow passed; 18 tests did not run. A
  separate targeted creation/import workflow passed 1/1. Targeted 1280 x 720
  axe coverage passed 3/3 for the populated acceptance workspace, open
  Earth-import/correction chrome, and creation dialog. The complete UI and axe
  matrix for acceptance, editor, road geometry, road lanes, assets, asset
  studio, and creation therefore remains the local acceptance blocker.

  Both fixture generators reproduced the committed bytes with zero drift; an
  in-memory comparison matched the exact serialized characterization (10,937
  bytes) and environment-editor baseline (8,276 bytes).
  Action-tape, characterization, and environment-editor compatibility SHA-256
  values remain
  `1ba8c8c40e1560ac044f4ca5384065ab83c93529d65b5672fee8dc5ed42a5ced`,
  `60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f`, and
  `6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`.

## Decision log

### 2026-09-15 — Editor chrome padding

Editor-chrome maintenance after the environment picker popup: dialog, picker,
workspace-switcher, and editor pane padding returned to the 4px spacing scale
(16px rails, 12px chrome inset, 10–12px control padding). Inspector text/enum
fields and reset/lane icon buttons use unlayered `.sf-input--compact` /
`.sf-icon-button--tight` (28px) so they match number fields instead of losing
to `.sf-input` / `.sf-icon-button`. Schema v4, `worldHash`, REST, CommandBus,
and fixture hashes are unchanged. This is not an ED milestone.

### 2026-09-15 — Bicycle pose drapes to paved elevation

The kinematic bicycle plant still integrates XZ distance and yaw. After each
step (and on reset) it samples the paved union for surface `y` and pitch so
the chassis follows draped or authored road elevation. Route proofs keep
`distanceMetric: "xz"`; the runtime follow polyline preserves vertex `y` but
measures progress in XZ so Pure Pursuit does not pick up slope length. IMU
specific force rotates world gravity into the vehicle body using pose
orientation. `worldHash`, route algorithm, `VEHICLE_PLANT_VERSION`, and the
flat action-tape characterization are unchanged. This is plant/follow-path
maintenance, not an ED milestone.

### 2026-09-15 — Scenario route proofs use the frozen world description

Route verification for persisted environment envelopes now compiles and hashes
the same six-decimal world description that scenario resolution rebuilds. The
authoring document can retain full-precision Bézier handles; those digits are
not route-proof identity. `verifyRoute` / `isRouteVerificationCurrent` freeze
`document.roads` envelopes through `createWorldDescription`, and
`verifyScenarioRoute` verifies against `createWorldResource(environment).description`.
Bare `{ environmentId, roads }` test graphs are unchanged. Schema v4,
`worldHash`, REST, and fixture hashes are unchanged. Geometry-v2 proofs that
were stored against the authoring envelope need one re-verification. This is
maintenance, not an ED milestone.

### 2026-09-15 — Loading screen waits for environment GLTFs

The 3D splash (`SceneLoadingScreen` / `sceneReady`) now stays up until catalog-backed
environment GLTFs are idle and one compiled frame has been submitted.
`assetInstancesProjector.whenIdle` settles every in-flight `load`; `EnvironmentLoader.apply`
overlaps that wait with visual-layer preview materialization; editor boot passes
`editorAssetsEnabled` so catalog instances start in the scene phase; Simulation still
loads only GLTF Tiles. `waitForEnvironmentGltfPresentation` then runs `renderer.compile`
and one `SimulationEngine.render()` before `setSceneReady(true)`. Incremental edits
stay fire-and-forget. Failed instance loads stay non-fatal. Schema v4, `worldHash`,
REST, and fixture hashes are unchanged. This is not an ED milestone.

### 2026-09-15 — Waypoint drag previews and live route verification

Scenario map waypoint drags now preview only an SVG marker transform, coalesced
to animation frames. The scenario, road graph, route proof, and static map layers
stay unchanged during movement. Release snaps once to the closest physical lane
segment (including off-road drops), preserves its elevation and stable anchor,
and commits one scenario edit; Escape, pointer cancellation, and lost capture
discard the preview. Click placement still requires a paved footprint. The lane
index and graph are reused until the environment changes, and proof freshness is
memoized across selection and drag state. This is editor behavior only, with no
world, route algorithm, or persisted schema change.

The Duffy follow-up also reproduced a stale Express process: the live verification
endpoint returned illegal-direction while a fresh process verified the identical
saved route. After the server reloaded, the live endpoint returned a v7 proof.
Development guidance now distinguishes browser hot reload from server/shared
module reloads. This is maintenance, not an ED milestone.

Verification: 45 focused tests and the full suite (1,320 passed, four skips),
lint with only the two existing warnings, and a passing browser
regression for Duffy HTTP verification, free drag, release snapping, stale
in-flight verification, cancellation, and unchanged static map DOM. The broader
scenario browser test passed its route checks but stopped at the existing zone
panel overlay; further Playwright runs were skipped at the user's request.

### 2026-09-14 — Route connector containment precision

Road-routing maintenance: geometry-v2 junction connector containment now uses
one metric canonicalization unit as a scale-aware boundary tolerance. This
prevents independently calculated mouth and trimmed-lane tangents from
rejecting a connector whose endpoint differs from the junction boundary only
below the six-decimal geometry policy's precision. The direction-classification
shadow graph also retains `roads.geometryVersion`, so removing direction
constraints no longer removes v2 connector feasibility at the same time and a
connector failure cannot masquerade as one-way travel. Road/world hashes,
route algorithm 7, schemas, and persisted environment bytes are unchanged;
routes that were previously false-negative failures can now produce their
ordinary canonical proof. A Duffy-shaped three-road regression pins the
straight-through reverse-lane traversal. This is not an ED milestone.

### 2026-09-14 — Map road-to-intersection connect

Editor-chrome maintenance: on geometry-v2 Map, dropping a free road endpoint
(or finishing a road-pen stroke) on an intersection rewires that end through
`road.connect-endpoint` / `road.create` with the existing node id. Grid snap
does not steal a diamond hit. A 250ms hover dwell highlights the intersection
(`EditorState.connectPreview`, session-only). GLTF Tile footprints paint and
pick under roads and honor `editorHidden`. Schema v4, `worldHash`, REST, and
fixture hashes are unchanged. This is not an ED milestone.

### 2026-09-14 — Snap road control points to GLB

Editor maintenance: selected roads/intersections can drape topology nodes and
interior knots onto the closest GLB surface (GLTF Tile or catalog instance)
on a vertical ray, plus a session offset. The command is
`road.drape-to-glb` (`drapeRoadControlPoints`); sampling is injected from
the scene (`sampleGlbElevation.js`) so CommandBus stays kernel-safe. Google
tiles, bake preview meshes, and road surfaces are excluded. Include
connected expands through shared nodes. Schema v4, REST, and untouched
environment fixture hashes are unchanged; draped `node.y` / knot Y is
metric and therefore changes `worldHash` of the edited environment. This is
not an ED milestone.

### 2026-09-14 — Road-drag gesture preview

Editor performance maintenance so moving a road in Scene or Map does not
recompile the whole graph on every pointer move. `updateGesture` still applies
the cumulative delta and notifies `transient: true`, but skips
`planRoadNetworkGeometry` / junction-connector validation. The roads projector
applies the gesture matrix to existing meshes when every node (and knot) of an
edge follows that delta; otherwise it hides the compiled surfaces and draws a
straight width-strip. Map SVG uses the v1-style strips and does not recapture
the satellite overlay while the gesture is live. Commit, undo, redo, and cancel
still compile and rematerialize the local closure once. Schema v4, `worldHash`,
REST, `CommandBus` history, and fixture hashes are unchanged
(`60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f` and
`6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`). This is
not an ED milestone.

### 2026-09-14 — Shared map canvas

Editor-chrome maintenance: Environment Editor Map, Scenario route/zone maps,
and Replay's spatial map now share one document snapshot helper
(`mapDocumentFrom`), one pan/zoom/fit kernel (`mapViewport.js`), and one SVG
host (`MapCanvas` + `MapSurfaceLayers`). Scenario maps keep v2
`geometryVersion` so compiled roads match the editor. CommandBus tools,
Satellite capture, and the live unsaved editor session stay editor-only.
Schema v4, `worldHash`, REST, and fixture hashes are unchanged. This is not
an ED milestone.

### 2026-09-14 — Map satellite overlay alignment

Editor-chrome maintenance: the Map satellite snapshot no longer calls
`renderer.setViewport` in CSS pixels (Three.js multiplies that by
`devicePixelRatio` and cropped the render target), and the bitmap is drawn
into a full-pane canvas that shares the SVG `viewBox` with `worldToScreen`.
Schema v4, `worldHash`, REST, and fixture hashes are unchanged. This is not
an ED milestone.

### 2026-09-14 — Map satellite overlay

Editor-chrome maintenance: Map can show an optional Satellite background, an
idle shadowless orthographic snapshot of the live Three.js scene composited
under the SVG tools. `SimulationEngine.sceneRenderEnabled` stays false; the
capture renders to an offscreen target and never uses measured-camera or bake
paths. Google Photorealistic 3D Tiles stay hidden in Map. Schema v4,
`worldHash`, REST, and fixture hashes are unchanged. This is not an ED
milestone.

### 2026-09-14 — Map asset footprints vs pane size

Editor-chrome maintenance: Map no longer hides GLTF Tile / asset footprints at
the constant 0.55 detail-zoom cutoff. Overview keeps a footprint while its
longest screen edge is at least 2% of the shorter map-pane side
(`MAP_FOOTPRINT_MIN_VIEWPORT_FRACTION`); point-like instances still follow
detail zoom; a selected footprint always remains. Schema v4, `worldHash`, REST,
and fixture hashes are unchanged. This is not an ED milestone.

### 2026-09-14 — Map pending-drag, chrome isolation, and WebGL suspend

Editor-chrome maintenance for Map view with a loaded GLB. Select-tool object
hits stay pending until a 4px pointer move (`PAN_DRAG_THRESHOLD`); the gesture
`start` is the pointer-down world point so a click does not teleport an asset
origin to the cursor. Workspace and toolbar React subscribers filter on
`editorChromeKey` so pan/zoom/draft/cursor updates do not rebuild Radix
tooltips. Map mode sets `SimulationEngine.sceneRenderEnabled` false so the
hidden Three.js canvas does not draw the GLB every frame. Schema v4,
`worldHash`, REST, and fixture hashes are unchanged. This is not an ED
milestone.

### 2026-09-14 — Scene leases apply published appearance textures

Editor-asset display maintenance so a GLTF Tile or catalog instance shows its
JPEG/PNG/KTX2 maps in the world scene, placement ghost, and catalog thumbnail.
`AssetModelLoader.acquireRevision` applies `revision.appearance` per material
onto the compiled mesh lease; compiled appearance GLB bytes, `compiledAppearanceUse`
identity, schema v4, `worldHash`, and fixture hashes are unchanged
(`60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f` and
`6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`). This is
not an ED milestone. Asset Studio still authors from source `modelUseHash`.

### 2026-09-14 — Environment picker popup

Editor-chrome maintenance: the top-bar environment control is a two-pane
`DialogSurface` picker instead of an anchored dropdown. Single-click inspects;
a native double-click or **Open environment** loads. Catalog summaries add a
derived `sourceKind` (`blank` | `google` | `gltf`) for picker icons. It is not
persisted on the manifest, does not enter `worldHash`, and does not change
schema v4, REST routes, or `CommandBus` history. This is not an ED milestone
and does not change fixture hashes
(`60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f` and
`6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`).

### 2026-09-14 — Unpack packed GLB textures at import

Editor-catalog maintenance so a typical `.glb` can be imported and then saved
from Asset Studio. `GltfImportPlan` extracts `bufferView` and `data:` images
onto the existing `sha256:` dependency graph, leaves the BIN chunk unchanged,
and does not relax `decodeAssetAppearanceGeometry`. Schema v4, `worldHash`,
and fixture hashes are unchanged
(`60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f` and
`6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`). This is
not an ED milestone. Assets imported before this unpack still need reimport.

### 2026-09-14 — Catalog folder drag-and-drop and asset Move to

Editor-chrome maintenance so model assets and folders can be refiled from the
asset pane. Schema v4, `worldHash`, catalog JSON, REST routes, `CommandBus`
history, and fixture hashes are unchanged
(`60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f` and
`6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`). This is
not an ED milestone.

Assets move with the existing `AssetRepository.update` →
`EditorAssetStore.updateMetadata` `folderId` write. Folders keep using
`updateFolder` `parentId`; cycle rejection stays in catalog validation. The
pane adds `application/x-cev-editor-catalog` drag data next to the unchanged
scene/studio placement MIME. Unfiled models is the unfiled/top-level drop
target; All assets, Built-ins, New folder, and the catalog grid are not.
Asset **Move to** replaces the Edit-metadata folder-id prompt.

### 2026-09-13 — Editor interaction and performance maintenance

Editor-only repair of Map gesture rendering, Asset Studio projection, catalog
folder/asset interaction, and the `G` grid shortcut. Schema v4, storage APIs,
`worldHash`, asset-definition formats, `AssetChangeSet` v1, and `CommandBus`
history semantics are unchanged. This is not an ED milestone and does not
change fixture hashes (`60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f`
and `6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`).

Map mode RAF-coalesces transient `EnvironmentDocument` snapshots so the Map
SVG can follow the pointer without flushing React on every event. Geometry
compile (`planRoadNetworkGeometry`) does not run while the pointer is held;
commit and cancel still apply immediately, and autosave still ignores
transient and cancel events.

Asset Studio projection classifies change sets and updates transforms,
visibility, materials, normalization, and metric overlays in place. Session
`compile()` and dirty stringify are cached; `setResolvedChild` /
`removeResolvedChild` invalidate compilation. Numeric fields commit one history
entry on Enter/blur. The parts tree scrolls itself and highlights the picked
part.

Catalog model cards select on click and open on double-click/Enter. Folder
create uses `Untitled folder` names without `prompt()`. Rename, move, and
delete live on folder context menus and inline rename. `G` toggles
`EditorGridOverlay` in Scene and Map only.

### 2026-09-13 — Audit and bounded fixes for ED-09 acceptance

The environment editor is the default authoring workspace. Creation, Earth
import, and georegistration no longer sit behind `NEXT_PUBLIC_CEV_SIM_ED08`.
`EDITOR_MODES.EARTH_IMPORT` is not a live view: Scene and Map remain the only
persistent views, and Earth-import chrome keys off workspace-local dialog and
preview state. `CEV_SIM_ASSET_STUDIO=0` remains the operational publication
kill switch.

Registered overlay types enter the document through `createObject`. Missing
types fail with `object.type.unsupported` and are never substituted.
Overlay-only (`legacy: null`) records duplicate through the generic capability
intersection, and `overlayMetricsProjector` may register editor-only metric
entities that never enter `createWorldDescription`. The demonstration type
`test.marker` lives only under `tests/helpers/`.

The audit fixed one high-severity persistence race: a local command arriving
while external apply was suspended could pass the initial dirty check and then
be overwritten by the remote loader. `EnvironmentPersistence` now distinguishes
prepare and apply phases, rejects edits that arrive during suspension, ignores
only loader-owned restore notifications during the apply phase, and resumes
autosave after success, rejection, or exceptions. Recovery tests also establish
that pre-editor-source and pre-asset-metrics envelopes retain the exact original
manifest and revision, survive restart, remain write-once under concurrent
guarded writes, and prevent live replacement if a backup write fails.

Medium-severity fixes cover stale overlay-metric entities after reload or type
replacement, record-dependent `groupable` creation checks, duplicate-menu and
command disagreement for unsupported descendants, competing Earth-import and
editor Escape handlers, the import settings panel collapsing at 1280 x 720,
and grid virtualization using a 64 px list pitch despite multiple columns and
taller grid items. `SceneProjector` now owns overlay sync/reset/disposal;
creation and duplication share the capability predicate; import chrome owns a
capture-phase Escape sequence; its embedded map has a compact layout; and the
catalog maps measured row pitch and column count back to item slices through
`computeItemWindow`.

Overlay metric notifications and chunk assignment prove
`affectsPersistence: false`, `editorOnly: true`, and `kind: "overlay-metric"`
for registration and every removal path. Complete world descriptions and LiDAR
resources remain identical across the v1/v2/v3 fixtures after marker edits.
`test.marker` has no production import or registration. Unsupported creation
and mixed duplicate requests remain atomic and add no history entry.

The adjacent `StorageService.getEditorAssetCapabilities` source-policy review
found no defect. Upload sources still require the persistent-cache,
machine-interpretation, and retention operations through valid, unrevoked
ancestry; expired, future, revoked-ancestor, missing-ancestor, and empty-registry
cases are excluded while the response remains `{assetStudio,limits,sources}`.
An isolated process and both publication HTTP routes prove that
`CEV_SIM_ASSET_STUDIO=0` disables studio-v2 publication without changing the
catalog revision or retained asset roots.

Schema v4 remains the only writer. World-description dispatch, route-proof
dispatch, run-bundle and Protobuf versions, and the characterization /
environment-editor fixture hashes are unchanged:
`60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f` and
`6ca2ece3d5266822a2ceabba72e5f7dd9514789e76757e86f6aedd2730ab9a6a`.
ED-09 remains open because the full seven-spec UI and accessibility matrix did
not complete. The partial production run passed three tests and left 18 unrun;
the targeted creation workflow and three targeted axe cases passed.

### 2026-09-13 — Implement ED-08 creation and imports

New geographic authoring uses one optional `geoFrame@1` with
`wgs84-local-tangent` projection and east/up/south axes. Earth source v2 stores
bounds, quality, road provider/filter, layers, and timestamp but obtains its
sole origin from that frame. Unversioned Earth records remain byte-compatible
and unchanged on load. Legacy Mercator content moves only through the explicit
Roads-only or Whole-environment planner and one expected-version command; the
complete result is validated before commit and the first adoption retains a
write-once pre-georegistration manifest.

OSM ingestion is a pure detached pipeline. It clips every WGS84 segment before
simplification, preserves exact boundary/source identity and grade tags,
connects only genuine shared OSM references, compiles geometry-v2 knots and
legal lane records, and reports ambiguous or unsupported topology instead of
dismissing it. Preview never mutates the active document. Add namespaces the
draft without connecting it to existing roads; Replace swaps nodes, edges, and
turn rules together; tiles-only leaves roads untouched. The selected source
and road result commit through one CommandBus entry and stale or empty replace
attempts fail before mutation.

Google sessions are browser-owned by `EnvironmentTileHost`, reconciled through
`SceneProjector`, and transferred from preview on Apply. They retain identity
across ordinary view/workspace changes, use the current display camera and
drawing buffer, prune disjoint hierarchy subtrees, preserve ancestor coverage
under persisted cache limits, and surface viewport attribution and diagnostics.
Google geometry remains outside selection, placement, collision, LiDAR, bake,
measured cameras, asset assemblies, and packages. GLTF Tiles are `tile@2`
records over the centralized immutable asset binding; asset revision and object
type versions remain distinct.

Creation sends one complete `initialManifest` for Blank, Google, or GLTF and
storage commits revision 1 under the existing environment lock. The active
environment switches only after success and the proposed ID stays fixed across
reconciliation/retry. Full-document writers must declare
`supportedEditorSourceVersions: [1]`; HTTP 409 prevents lossy source downgrades.
Readers and writer downgrade protection are always active. Schema v4,
world-description dispatch, route-proof dispatch, headless protocol, and
historical fixture hashes remain unchanged. The authoring chrome stayed behind
`NEXT_PUBLIC_CEV_SIM_ED08=1` until ED-09.

### 2026-09-13 — Implement ED-07 asset studio

Asset authoring and environment use are separate immutable operations. Asset
revisions advance to v2 only when the server has re-resolved exact source uses
and child pins, verified derivative rights, recompiled appearance and metric
products, and acquired every protective root. Browser-generated arrays and
hashes are comparison inputs, never publication authority. The publication id
binds the canonical payload, so an exact retry is idempotent and a changed
retry fails.

Environment schema v4 remains the writer. A v2 pin uses `asset-instance@2` and
atomically carries one `document.assetMetrics@1` definition keyed by
`{assetId, revision}`; the snapshot is pruned only after its final pin is gone.
The first adoption retains a write-once pre-metrics copy. World v3 exists only
when an enabled product is present, and its `metricWorldHash` excludes revision
numbers, names, materials, locks, editor visibility, and proxy provenance.
Route proof v8 binds this metric identity and explicitly records base algorithm
5 or 7. Collision worlds pin `rapier3d-swept-compound-v2`; legacy worlds retain
the prior world, route, physics, and LiDAR identities byte-for-byte.

Published appearance is ordinary visual-layer v1 input. Resolution composes it
only for enabled `pbr-mesh@1` cameras after the existing environment and source
locks pass, and packages the complete use closure. Analytic cameras, state-only
runs, and LiDAR-only runs do not acquire appearance. Studio scene objects,
unsaved edits, selection, camera, and overlay state never enter prepared-run
resources. The authoring endpoint is active by default after the complete gate;
`CEV_SIM_ASSET_STUDIO=0` remains the explicit operational disable switch.

The local hardware record used Chromium 151 with WebGL2 on the Apple M1 Max
ANGLE Metal renderer. PBR preparation took 99.0 ms, the cold capture 831.3 ms,
and the warm capture 35.4 ms; the packaged static transfer was 59,577 bytes and
each capture transferred 280 bytes. Cleanup released the prepared environment,
scene bytes, queued work, and busy context. This executes ED-07's packaged PBR
case but does not satisfy the separate PR-12 x64 NVIDIA/Jetson evidence or any
open VIS target-specific acceptance gate.

### 2026-09-13 — Implement ED-06 asset catalog

The editor catalog is an authoring index over existing source-bound VIS-04 use
records. An immutable model revision stores only its asset id, revision,
publication id, model-use hash, and creation time. It never copies source
grants, media identity, byte digests, or dependency mappings. All catalog and
folder writes use one catalog revision token. Model and thumbnail roots are
owned per asset revision, publication is journaled, and archive changes only
catalog visibility. This keeps retries recoverable and old pinned references
readable.

Instances stay in schema v4's object graph as `asset-instance@1` records. Their
revision is explicit and never follows `latestRevision`; catalog refresh only
reports that an update is available. Placement pins a revision at its start,
and the inspector updates selected or all matching current-environment
instances through one guarded command. ED-06 overrides remain empty, and the
asset preview tab is a read-only session surface with no separate undo state.
Parts, materials, proxies, and asset editing remain ED-07.

Loaded model trees are editor appearance. They register under
`asset:<objectId>` so editor picking works, but `editorOnly` skips truth,
chunks, serialized runtime manifests, bake, LiDAR, collision, measured camera
resources, and Simulation mode. Registry load/bounds changes are explicitly
nonpersistent; document commands are the only asset-instance autosave source.
Consequently asset-only changes can alter the authored environment and resolved
bundle integrity hashes while leaving `worldHash`, `roadNetworkHash`,
`lidarGeometryHash`, measured render resources, simulation semantic hash, and
episode hash unchanged. Schema v4, object-graph v1, world-description versions,
and all headless/VIS acceptance gates are unchanged.

### 2026-09-12 — Implement ED-05 lane authoring

Four decisions were taken with the human before implementation: lanes carry
individual widths (the road width is their sum, and a Width edit scales them
proportionally); intersection turn rules stay edge-to-edge but validation
becomes lane-direction-aware and geometric; geometry-v2 roads move to route
algorithm 7 with stable lane ids on anchors and proofs (v6 proofs are stale,
mirroring v5→v6); and lanes materialize per edge on the first lane edit rather
than document-wide.

Lanes are implicit or explicit. `RoadLaneModel` keeps the literal historical
expressions for implicit edges, so `laneCenterRightOffset`, dividers, the
road strip, `roadNetworkHash`, `worldHash`, and v5 proofs are byte-identical
for every existing environment (the compatibility baseline regenerated with
zero drift on the four prior cases and one new `asymmetric-lanes-v2` case).
An explicit array equal to the derived default canonicalizes back to implicit,
which is what lets a road return to its prior hash after a temporary edit.
Lane `{ id, direction, width }` is metric because anchors and proofs reference
lane ids like edge and node ids; interior markings live on the lane
(`markingLeft`, forbidden on the leftmost lane) and, like the borders, stay
outside every hash. Same-direction lanes must be adjacent; the shared lane is
`direction: 0` and legal only alone.

`RoadOptions.validate` now applies the lane-layout rules, so an illegal
layout is a field-level issue in the inspector instead of a late bus
rejection; the derived `laneCount`/`bidirectional`/`direction` fields hide
once lanes are explicit and the edge mutation refuses to change them. The
`RoadDisplay` section is a pure descriptor plus a React cross-section with one
accessible control row per lane; every control is an ordinary road command,
and `road-lane` is a new selection sub-kind (no transform target). Junction
feasibility (`RoadJunctionValidation`) is a warning in document validation so
a lane edit can never lock a document, but `road.set-turn-rule` and route v7
treat a movement without a lane connector as illegal so the matrix and
routing agree. Runtime hydration deliberately ignores runtime lane records
because it only runs for v1 documents. Border markings remain in the Options
section rather than moving into the diagram, and `createRoad` keeps its
`null` border defaults, both to avoid churning persisted fixtures.

### 2026-09-12 — Implement ED-04 road geometry

ED-04 versions the road domain rather than altering legacy interpretation.
`roads.geometryVersion` is the only authoring dispatcher: absence is v1 and
explicit `2` requires geometry on every edge. The first geometry command owns
migration so loading, moving, resizing, deleting, and legacy MCP road creation
cannot change old documents or hashes. The migration is one undoable
transaction and storage retains one pre-migration document through the normal
revision-guarded write lane. Old writers must declare road-version support
before replacing v2 content.

Sampling policy and topology live in Three/DOM/Node-free `app/roads` modules.
The compiled plan is the only road metric used by indexed browser meshes,
portable LiDAR, analytic render primitives, Map boundaries, route v6, paved
union checks, and bounds. The world v2 resource stores resolved curve controls,
not editor ids or modes, and validation recompiles the surfaces. This keeps
appearance-only markings and editor handles outside measured geometry while
making the indexed source/triangle identities portable. The incremental road
projector keeps ED-02's E1/J1/E2 closure; a version transition performs one
full rebuild and replacement disposes its GPU resources.

Route algorithm 6 uses normalized XZ arc distance because the vehicle plant
remains planar while road vertices retain elevation. It binds the road-policy
identity and refuses broken explicit anchors. Algorithms 3/4 remain immutable
compatibility inputs and algorithm 5 remains the complete v1 proof contract.
The existing lane-count and direction model is unchanged; asymmetric lane
authoring remains ED-05.

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
