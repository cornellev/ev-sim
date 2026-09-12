# Environment Editor

The environment editor is where you author the static world that simulations run in: roads, buildings, props, sky, and imported geography. It is a separate workspace from the simulation view, though both use the same Three.js scene stack.

Open it from the app menu (`Escape` → **Environment Editor**). The simulation workspace is the other 3D option in that same menu.

## What you can do here

- Place and transform buildings, props, and other static objects in the 3D scene.
- Draw roads and intersections on a 2D map overlay.
- Import real-world terrain preview and road networks from geographic data.
- Bake environment visuals (lighting, splats, and related outputs) for runtime use.

Changes live in an `EnvironmentDocument`. Every edit is a `CommandBus` command or gesture (one undoable step each); the `SceneProjector` applies the resulting change set to the 3D runtime immediately, and autosave persists committed changes.

## Editor modes

Within the environment editor, `EditorState` tracks three modes. Only one is active at a time.

| Mode | ID | Purpose |
|------|----|---------|
| Scene | `scene` | Default 3D editing: select, move, rotate, scale, and place objects. |
| Map | `map` | Top-down 2D authoring for roads, intersections, buildings, and features. |
| Earth Import | `earth-import` | Preview Google Photorealistic 3D Tiles and import OSM roads for a geographic area. |

Enter **Map** or **Earth Import** from the environment editor menu. Both swap in dedicated chrome and hide the standard scene-editing panels (hierarchy, inspector, chunk outlines).

Press `Escape` to leave overlay modes. Earth Import also uses `Escape` to cancel an active preview.

## Document model

`EnvironmentDocument` is the canonical source of truth for authored content. It holds:

- **Roads** — nodes and edges (centerlines, optional elevation `y`, width, lane count, bidirectional / one-way travel) plus sparse `turnRules`. Nodes are metric `{ x, y, z }` with missing `y` treated as `0`. Intersection arms inherit the junction node’s elevation so the junction stays a plateau while the trimmed road segment between arms can slope. Scenario routing and the kinematic vehicle plant remain planar (XZ costs and yaw); elevation is metric world / mesh / LiDAR geometry, not driving dynamics. Physical lane index `0` is the rightmost lane for edge start→end travel. Even-lane two-way roads split lanes equally by direction, one-way roads use every lane in the configured direction, and a one-lane two-way road is shared; odd two-way counts greater than one are invalid. Both maps render road boundaries, yellow opposing-flow dividers, white same-direction dividers, and detail-zoom one-way arrows. The map inspector can toggle two-way vs one-way, edit elevation, and edit the selected intersection’s movement matrix. Normal turns default allowed, intersection U-turns default prohibited, and dead-end reversals remain allowed. Roads, intersections, and endpoint handles move in XZ and Y in scene and map mode; connected roads stay connected because moves rewrite the shared node and recompute incident arms (`translateRoadNodes`).

Waypoint placement and dragging snap immediately to the nearest physical lane center without initiating map pan. A road anchor records `laneMode: "fixed"` plus `laneIndex`; its snapped longitudinal position and lane are semantic route input, while the raw pointer position is editor-only and removed by scenario normalization. Verification never moves a fixed waypoint across the divider: the lane participates in staged A* and therefore causes a legal detour or a lane-unreachable failure. Intersection and explicit centerline anchors use automatic lane selection and align to the selected lane connector. Each traversal proof records lane-entry and lane-exit subnodes at the shared road-arm boundaries. Intersection matrix changes store only non-default `{ nodeId, fromEdgeId, toEdgeId, allowed }` overrides, and changes to those overrides intentionally invalidate road/world hashes and route proofs.
- **Buildings** — footprint records used by the bake pipeline.
- **Features** — placed props (traffic lights, signs, etc.).
- **Earth metadata** — anchor, bounds, provider IDs, and import timestamps after a geographic import.
- **Objects (schema v4)** — the authoring overlay `document.objects`, one record per authored thing: `{ id, typeId, typeVersion, name, parentId, order, components }`. Records share ids with the legacy records they describe (`feature.id`, `buildingId`, edge `id`, junction node `id`); only `group`, the single `skybox`, and the single `tile` (from `earth`) exist without a legacy counterpart. Geometry never lives here — roads, buildings, features, and earth stay canonical, so the overlay is excluded from `worldHash` by construction. `components` holds `tags`, `locked`, and `editorHidden`; groups additionally hold `transform`, a world pivot frame `{ position, rotationY, scale }`. A group gesture bakes its world delta into every descendant's legacy record once and composes it into descendant group frames once, so the frame follows the group without becoming a second source of truth for child placement (legacy domains stay absolute and `worldHash` is untouched). `order` is sibling-relative and dense. Unknown component keys are preserved verbatim on records whose `typeId` is not registered, and such records are reported as `object.type.unsupported` rather than substituted. Object ids are the editor's selection identity and a different namespace from runtime registry ids (`road:<edgeId>`, `intersection:<nodeId>`, `building:<buildingId>`, `fusion:<featureId>`), which `app/3d/editor/selection/selectionIds.js` derives and never stores.

Object types live in the kernel-safe registry under `app/3d/editor/objects/` (`ObjectTypeRegistry`, `ObjectOptions`, `objectGraph`). A type supplies `options` (`getDefaults` / `getFields` / `normalize` / `validate` with `{ path, code, message, severity }` issues), capability flags, a transform binding (`read` the world placement, `plan(delta, context)` the document steps for a world-space delta or return `transform.*` issues), dependencies, `compileMetric`, and `migrate`. Props accept yaw and planar translation, buildings accept yaw, translation, and scale (height follows the Y scale), roads and intersections translate their nodes, groups compose the delta into their frame; anything else is rejected before any mutation. Built-ins: `group`, `skybox`, `tile`, `road`, `intersection`, `building`, `builtin-prop` (the five props as one type with an `assetId` option), and the contract-only `asset-instance`. `deriveObjectGraph` builds the overlay for a v2/v3 document, `reconcileObjectGraph` merges it with stored records (adds uncovered legacy entities, drops orphans, keeps groups and unknown types), and `validateObjectGraph` reports the issue taxonomy (`object.parent.cycle`, `object.legacy.missing`, `object.skybox.multiple`, …) without mutating anything.

The document supports `snapshot()` / `restoreSnapshot()` so preview flows (especially Earth Import) can stage changes and roll back safely. `snapshot()` emits `objectGraphVersion` and `objects` only when the overlay is non-empty, so v2/v3 snapshots are byte-identical to before.

### Commands, gestures, and history (ED-02)

`app/3d/editor/commands/` is the single mutation path. `CommandBus.execute(command)` runs a command inside one document transaction, keeps the in-session object overlay live (`reconcileLiveOverlay`: created legacy entities gain records, removed or demoted ones lose them), validates the object graph, and either commits exactly one `ChangeSet` to history or restores the document byte-identically with structured issues. `bus.transaction(label, fn)` groups several commands into one history entry (the map's road pen uses it). `undo()` / `redo()` apply the recorded before/after records wholesale (`document/ChangeSet.js`), which is total and idempotent. History is bounded (200 entries) and reset on a full load or Earth Import apply.

Gestures are the drag path: `beginGesture({ objectIds, sub })` captures the pristine records of the transform closure (selected records, group descendants, their road nodes and incident edges); every `updateGesture(cumulativeDelta)` restores that capture and re-applies the delta, so frames are idempotent whatever the pointer does; frames notify with `transient: true`; `commitGesture` publishes one non-transient change set (a no-op drag never enters history); `cancelGesture` (Escape, pointer cancel) restores the capture and never enters history. One gesture is active at a time; executing a command cancels it. Shared road nodes reached through several selected objects move exactly once. Locked objects, non-transformable types, non-uniform scale on groups or multi-selections, and scale on props reject the whole frame before anything moves.

`EnvironmentDocument` carries a monotonic `version`; every notification delivers `(snapshot, event)` with `{ version, transient, changeSet, source }`. Autosave ignores transient frames and cancels, and marks dirty only when committed document changes or the persisted editor state (layers, hidden ids, mode, map viewport) change; selection never dirties the environment.

Hierarchy, scene, map, and inspector share one `SelectionStore` (`app/3d/editor/selection/`): ordered object ids, a primary id, and an optional sub-object `{ kind: "road-node", id }` for endpoint nodes that have no record. Shift/Cmd/Ctrl toggle, Shift-click in the hierarchy selects a range, and mode switches keep the selection.

`app/3d/editor/projection/SceneProjector.js` is the only path from a document change to runtime meshes, registry entities, chunk membership, and LiDAR truth triangles; `EnvironmentLoader.apply` and Earth Import apply remain the load-time full rebuilds (`syncRoadsFromDocument`). Props move in place. Buildings follow the cumulative delta on their existing mesh during a gesture and regenerate once on commit, undo, redo, or cancel with LiDAR triangles replaced only for that building. Roads rebuild the local closure only: the changed edges, the intersections at their endpoints, and those intersections' other incident edges (`computeRoadClosure`), keyed by id with untouched intersections relinked to replaced `Road` objects and `replaceTriangles` scoped by source id. Browser-only helpers (placement catalog, building generator) are injected by the loader (`browserProjectorRuntime.js`) so the projector and `Environment` load under node tests.

`EditorPresentationRegistry` (`app/3d/editor/presentation/`) maps a `typeId` to an icon, menu options, inspector sections, and an optional preview; hierarchy and inspector consume it exclusively, and unregistered types fall back to a capability-derived default that shows the record and an unsupported notice. Registering a presentation is all a new type needs to appear in both panels (`tests/editor-presentation.test.js` proves it with a test-only type). The hierarchy tree model (`hierarchyModel.js`: sibling order, inherited hidden state, search, drag-and-drop planning) is pure and tested without React.

## Persistence (server-side)

Environment edits are saved to the backend, not the browser. Loading and saving are deliberately separate:

- **`EnvironmentLoader`** fetches the selected manifest and applies it to the one runtime shared by Simulation and Environment Editor. IGVC starts from its native template meshes; legacy hydrated road data does not replace those roads. Roads are rebuilt only after a map/Earth Import edit marks them as authored. Schema v3 `revision`, `visualLayer`, and `evidence` fields are copied onto environment state. Metric geometry is rebuilt and registered first. Preview materialization then loads `{ descriptorHash, accessHash }` into a detached preview group using VIS-05b AOI/LOD residency. Visual failures do not fail metric load; the 3D chrome shows `idle/loading/ready/error` preview status with retry, including `VISUAL_PREVIEW_BUDGET_EXCEEDED`. Preview meshes are marked non-selectable and are excluded from object-registry membership, collision geometry, LiDAR truth, perception scans, and measured cameras. `worldHash` is unchanged. Legacy descriptor-only references stay non-materializable until an access hash is attached.
- **`EnvironmentPersistence`** watches committed document changes (never transient gesture frames or cancels), the registry, the persisted subset of editor state, and sky; selection never marks the environment dirty. It tracks edit generations separately from requests, retains the last acknowledged server revision, allows one `PUT` in flight, and builds queued saves from the latest `Environment.toManifest()` at send time. An edit made during a request stays dirty until its own captured draft is acknowledged. Explicit server `null` visual/evidence references are applied. Older revisions, other-environment responses, and stale promotion receipts are ignored. External MCP updates over a dirty or in-flight draft expose a conflict and keep the local edits.
- **On page unload / tab hide** it flushes through the same queue with `keepalive`. Autosave suspension blocks every save entry point, cancels timers and queued work, drains the current request, preserves unsaved edits, and explicitly saves them after resume. A strict promotion flush joining an autosave observes the shared failure.

The storage contract is environment schema v4 by default since ED-02 (schema v2, v3, and v4 all read; `CEV_SIM_ENVIRONMENT_SCHEMA_V4=0` writes v3 for hosts that must stay on the old schema until the opt-out is retired in ED-03). v2 files load as revision `0` with implied null visual/evidence references; the first guarded save writes v3 revision `1`. Full replacement is `PUT /api/storage/environments/<id>` with `{ manifest, expectedRevision }`. Rename, duplicate, ID change, and delete require the same revision. Missing or stale revisions return HTTP `409` with `ENVIRONMENT_REVISION_CONFLICT` and `currentRevision`. Unguarded legacy bodies are rejected with `ENVIRONMENT_UNGUARDED_WRITE`. Catalog entries include `revision`. `clientRevision` is not a concurrency authority and is not written into v3 documents.

Schema v4 (ED-01) adds `document.objects` and `document.objectGraphVersion: 1`. Reads accept v2, v3, and v4; v2/v3 read views never inject a graph (`presentEnvironmentObjectGraph` derives one in memory). The default writer emits v4 (`StorageService` option `environmentSchemaVersion` defaults to `4`; `3` or `CEV_SIM_ENVIRONMENT_SCHEMA_V4=0` opts out and strips `objects`). Stripping is lossy once names, groups, locks, or hidden flags have been authored, which is why ED-02 flipped the default. A v4 write reconciles the incoming graph against the legacy domains, validates it, and rejects error-severity issues atomically with HTTP `400` `ENVIRONMENT_OBJECT_GRAPH_INVALID` and an `issues` array. The first v4 save over a v2/v3 file stores a write-once copy at `server/data/environment-migrations/<id>.pre-v4.json` (`cev-sim.environment-pre-migration` v1); recovery is a manual restore of `manifest`. Once a file is v4 it stays v4 even under the opt-out. A write whose `document` lacks an `objects` array over a stored v4 graph is an old client: when the stored graph carries authored data (groups, renames, parents, tags, locks, hidden flags, unknown types) it is rejected with HTTP `409` `ENVIRONMENT_SCHEMA_DOWNGRADE` instead of dropping the graph; when the graph is purely derived it is re-derived from the new geometry and the write passes (ED-02). Writes that omit `document` (rename) and graph-aware clients that still declare `schemaVersion: 3` pass. MCP `environment_add_object` rejects unregistered types with `ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED`.

Display-name rename keeps visual and evidence references when `worldHash` is unchanged, including both descriptor and access hashes. Duplicating an environment, changing its ID, or importing onto a conflicting ID rebinds the descriptor to the destination world, creates a corresponding access sidecar with the same use selections, reuses compatible asset digests, and clears correspondence evidence. Missing or incompatible descriptors fail before the environment mutation. An older client that writes the same descriptor without `accessHash` preserves the existing sidecar; replacing the descriptor without a matching access hash is rejected.

The environment switcher in both 3D workspaces selects, creates, duplicates, renames, and deletes environments using the acknowledged revision. Selection is shared between Simulation and Editor and stored in server settings. The saved payload is `Environment.toManifest()` at `server/data/environments/<id>.json`. See [development.md](development.md) for the storage backend.

Validated visual-asset bytes live in the VIS-04 CAS under `server/data/visual-assets/`. Browser access is `VisualAssetClient` at `/api/storage/visual-assets` and `VisualLayerClient` at `/api/storage/visual-layers`. Public asset identities are source-bound use hashes, not filesystem paths or digest-only content URLs. Every content/closure/materialization path requires current version-2 validation; old or missing evidence is refreshed from immutable bytes without changing asset/use identity. Embedded and digest-backed glTF images, extension use, graph bounds, and decoded memory are checked before loaders. Published assets cannot be deleted; only abandoned staging and expired reservations are cleaned. Uploads fail closed unless an operator configures owned-source grants in `visual-source-registry.json` (or `CEV_SIM_VISUAL_SOURCE_REGISTRY`). Generated bake outputs additionally require `CEV_SIM_BAKE_OUTPUT_SOURCE_IDS`. Spark and splat construction are initialized only when an explicitly started legacy bake selects the splat path. VIS-12b can resolve an enabled `pbr-mesh@1` run from these local immutable records for export and inspection; VIS-13a can transfer those bytes as a verified `cev-sim.run-package@1` archive, and VIS-13b can admit it to a same-host Unix supervisor. VIS-14 browser simulation materializes the exact resolved records into a separate run-owned appearance scene and rechecks measured-capture rights on every lease. It never reuses the live editor scene or preview metadata as truth. Headless PBR rendering and automatic published-asset GC remain later work.

Run-manifest `renderRecipe` authoring is intentionally independent of editor
preview sky, light, visibility, and bake state. The optional
`cev-sim.pbr-render-recipe@1` field freezes selected measured appearance,
including background/IBL, lighting/color/rasterization policy, actor visual
overrides, and asset-use references. An older client update that omits the
field preserves an existing recipe; explicit `null` resets it. JSON bundle
import never installs visual bytes. Rename/duplicate/conflicting-import rebinds
retain the established descriptor rules, invalidate correspondence evidence,
and fail explicitly if the destination lacks required descriptor, access, use,
or CAS dependencies. VIS-13a package import can install those visual bytes after
strict archive verification. VIS-13b package admission is operational, while
PBR execution is browser-only in VIS-14; headless, Python, supervisor, and
managed execution remain unavailable until their later renderer milestones.

Gizmo drags are gestures: the document holds the draft during the drag and one change set is committed on release, so building footprints, heights, prop positions, and headings persist exactly what the mesh shows. Reload therefore reconstructs the edited location rather than the original runtime mesh.

## UI chrome

`EnvironmentEditorChrome` mounts the editor overlay stack:

- **Scene mode** — `EnvironmentEditorMenu`, the hierarchy tree (nested groups, search, multi-selection, inline rename, hide/lock toggles, drag-and-drop reparenting with an insertion indicator, right-click menu from the presentation registry, undo/redo), the inspector (presentation sections for the primary record, multi-selection count, tools, focus, hide, delete; editable group frame fields behind the `cev-sim.ui.environmentEditor.groupFrameFields` preference until ED-03's generic fields), selection handles for every selected leaf plus a union box per group, chunk outlines, bake progress, and a non-blocking visual-preview diagnostic for missing descriptor/access/assets, denied rights, material mismatch, and decoder failures.
- **Map mode** — `MapModeChrome` with `MapSurface`, road pen, building rect, and feature placement tools.
- **Earth Import mode** — `EarthImportModeChrome` with anchor/bounds fields, preview/apply controls, and layer toggles.

`EditorToolController` disables standard scene tools while map or earth-import modes are active.

Keyboard: `Q`/`W`/`E`/`R` select tools; `Escape` cancels an active gesture, then leaves the tool, then clears the selection; `Mod+Z` / `Shift+Mod+Z` (or `Ctrl+Y`) undo and redo; `Mod+D` duplicates; `Delete`/`Backspace` deletes; `Mod+G` / `Shift+Mod+G` group and ungroup; `F` frames the selection. Editor shortcuts register through `ShortcutProvider` (`EditorCommandShortcuts`), never fire inside editable fields, and consume the event only when the command succeeds. `Mod` is Cmd on macOS and Ctrl elsewhere; bare letters never fire while Cmd/Ctrl/Alt is held.

## Chunks

Large environments are indexed in a chunk grid (`ChunkIndex`, `ChunkManager`). Objects are assigned to one or more chunks based on footprint bounds. Spatial radius/bounds queries support bake planning and visual residency. Semantic dirtiness is a typed mutation log (`insert`, `delete`, `move`, `material`, `visibility`, `entity-id`) with `semanticGeneration`; `loaded` / `prefetch` / `eviction` are operational only and never authorize bake reuse. Diagnostic `dirty` flags are not dependency keys. Building records used by bake planning are replaced from the canonical document (`syncBakeBuildingsFromDocument`), not appended. Chunk outlines can be toggled in scene mode to see how content is partitioned for baking and streaming.

Default chunk size is 20 meters. It is stored on the document and can differ per environment.

## Baking

The bake harness (`BakeProgressOverlay`, modules under `app/3d/environment/visualization/`) renders environment visuals into textures and related outputs. Baking runs as a simulation module while active.

VIS-06a adds an explicit `calibrated-projection@1` bake adapter. It requires
an owned `bake-snapshot` scene, snapshots its generation, camera pose,
calibration, and integer-nanosecond capture time, applies the shared asymmetric
K projection, and normalizes corrected readbacks to top-left rows. The default
`legacy-fov@1` bake path and existing vector/buffer conventions remain
unchanged. VIS-06b adds the opt-in asynchronous `captureAlignedProducts()`
path. It requires the owned `bake-snapshot`, explicit descriptor bindings,
source-use hashes, and an abort signal. Beauty and every visual G-buffer see
the same visible surfaces and OPAQUE/MASK alpha tests; no target visibility
filter, forced hidden-object visibility, or road-material boost is applied.
Target/building/tag masks are derived from the frontmost object-ID product so
other surfaces remain occluders. Oracle products require a separate
`analytic-truth` handle and explicit truth bindings. VIS-07 adds an in-memory
bake-job catalog: serializable `BakeRunConfig`, frozen `bake-snapshot` scenes,
UTF-8-stable planning, VIS-06b aligned capture, and local
`captured-appearance@1` with no model network. Version-1 jobs use
`BakeHarness.runVersion1Job()`. Press `b` runs the VIS-08/VIS-09 atomic no-model
path: flush acknowledged autosaves (`detachStaleVisual: true`), reserve a bake
generation, reuse unchanged capture units from a trusted bake-reuse manifest,
capture only invalidated aligned beauty/world-position/geometric-normal/
confidence/validity products, write deterministic per-chunk atlas PNG/GLB pages
(or explicit projected captured-radiance), commit the descriptor/access closure
(or a revision-free no-op), replace the durable bake-reuse root, and
rematerialize preview without rebuilding metric
truth. `createLegacyCompatibleBakeRunConfig` and
`?legacyBake=1` still reach `BakeHarness.start()`, which may health-check the
bake server; that path cannot promote through VIS-08. `capturePasses()` and
`captureFrame()` remain legacy defaults. VIS-10b owns optional material
estimation; VIS-17b owns the evidence catalog UI.

VIS-10b intrinsic construction is API/config opt-in only; the editor has no new
controls. A caller selects `cev-sim.bake-construction@2` and supplies a complete
job-bound `cev-sim.bake-material-proposal-set@1` plus typed proposal buffers.
Each of base color, normal, roughness, metalness, emissive, and occlusion may
override its ordered `sourcePriority`; the normalized default is `supplied`,
then `inferred`. Missing, stale, malformed, over-budget, or incomplete evidence
fails the bake before upload rather than reverting to captured beauty. Selecting
`intrinsic-material-model@1` is API/config opt-in only and requires pinned model,
algorithm, and weights identity plus construction v2 `intrinsic-pbr-proposed`.
The editor has no new model controls. The default persistent bake remains
model-free `captured-appearance@1`. Successful promotion records
the proposal hash in artifact-set v3 and the durable receipt while leaving the
environment schema, correspondence evidence, and runtime capability adverts
unchanged.

Promotion, recovery, reads, and later environment mutations share one
environment transaction lane. Exact target revision plus the complete manifest
proves publication; ambiguous/corrupt journals retain protective roots and
fail. Cancellation that loses to commit adopts the receipt. A failed preview
reload keeps the committed receipt and reports a reload error for
materialization-only retry. Legacy model uploads cannot emit completion or
success unless every request returns `true`.

Press `b` in the environment editor to start or stop a bake run when a harness is configured. See the bake tests under `tests/bake-*.test.js` for expected behavior around determinism, splats, and render bundles.

## How it connects to the rest of the app

```mermaid
flowchart TB
  page["app/page.js"] -->|"THREE_D_MODES.ENVIRONMENT"| scene["app/3d/Scene.js"]
  scene --> setup["setupEnvironmentRuntime()"]
  setup --> env["Environment"]
  setup --> earth["EarthImportController + EarthTilesManager"]
  env --> doc["EnvironmentDocument"]
  env --> editor["EditorState"]
  chrome["EnvironmentEditorChrome"] --> editor
  chrome --> doc
  sim["SimulationEngine"] -->|"each frame"| tiles["EarthTilesManager.update()"]
```

- `app/page.js` passes `mode={THREE_D_MODES.ENVIRONMENT}` to `TotalScene`.
- `setupEnvironmentRuntime()` creates the `Environment`, wires `EditorToolController`, and registers earth-import services on `Data`.
- `SimulationEngine` calls `earthTilesManager.update()` each frame so streamed tiles stay in sync with the camera (only while tiles are loaded).

## Tests

| File | What it covers |
|------|----------------|
| `tests/editor-core.test.js` | Chunks, typed mutations vs residency, editor state, environment registry |
| `tests/editor-map-mode.test.js` | Map mode transitions, road pen, document hydration |
| `tests/document-changeset.test.js` | ED-02 change sets (diff/apply/merge/invert), document transactions and versioning, `translateRoadNodes`, uniform `notify:false` |
| `tests/command-bus.test.js` | ED-02 CommandBus execute/undo/redo, atomic failures, transactions, gesture lifecycle, SelectionStore, id mapping, commands/ import safety |
| `tests/command-groups.test.js` | ED-02 group transforms (shared nodes moved once, nested frames), reparent, ungroup, duplicate, delete cascade, atomic rejection of unsupported transforms |
| `tests/scene-projector.test.js` | ED-02 incremental projection: props in place, building gestures, road local closure, removals, hidden/locked, error isolation |
| `tests/editor-interactions.test.js` | ED-02 select, gizmo drag, Escape cancel, undo/redo, sub-object and group drags, duplicate/reparent/reload, map gestures and road pen |
| `tests/editor-presentation.test.js` | ED-02 presentation registry, hierarchy tree model, drop planning, and the test-only-type extension demonstration |
| `tests/object-registry.test.js` | ED-01 object-type registry, `ObjectOptions` contracts, field descriptors, built-in prop table consolidation, kernel-safety of `app/3d/editor/objects/` |
| `tests/object-graph.test.js` | ED-01 overlay derivation, reconciliation, transform bindings, the `object-graph-cases.v1.json` validation matrix, `worldHash` invariance |
| `tests/environment-v4.test.js` | ED-01 compatibility baseline, v2/v3/v4 read and write policy, flagged v4 upgrade and pre-migration copy, downgrade rejection, MCP round-trip |
| `tests/earth-import-mode.test.js` | Earth import config, geospatial math, providers, isolation |
| `tests/bake-*.test.js` | Bake pipeline, incremental reuse, and promotion |

Run everything with `npm test`.

## Related docs

- [Environment Editor Implementation Plan](environment-editor-plan.md) — the `ED-*` program: object registry, schema-v4 overlay, unified workspace, roads, assets, and imports.
- [Visual Layer Implementation Plan](visual-layer-plan.md) — truth-first photoreal baking, hashed visual assets, and optional Google/3DGS tracks.
- [Earth Import](earth-import.md) — geographic preview, road import, API keys, and troubleshooting.
- [Simulation](simulation.md) — how the simulation workspace differs from environment authoring.
- [Assets](assets.md) — external data policy (scenarios, models, API keys).

## Source layout

```
app/3d/editor/              EditorState, tools, chunks, document model (+ ChangeSet)
app/3d/editor/objects/      Kernel-safe object-type registry, options, object graph, transform deltas (schema v4)
app/3d/editor/commands/     CommandBus, gestures, transform planning, object and legacy commands, headless service (MCP)
app/3d/editor/selection/    SelectionStore and object-id ↔ registry-id mapping
app/3d/editor/projection/   SceneProjector and domain projectors (roads local closure, buildings, features, objects)
app/3d/editor/presentation/ EditorPresentationRegistry and the pure hierarchy tree model
app/3d/environment/         Environment container and visualization
app/3d/overlay/             React chrome (menus, inspectors, map/earth modes)
app/3d/earth/               Earth Import implementation
app/3d/skybox/              Procedural sky (preserved during earth import)
```
