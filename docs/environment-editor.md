# Environment Editor

The environment editor is where you author the static world that simulations run in: roads, buildings, props, sky, and imported geography. It is a separate workspace from the simulation view, though both use the same Three.js scene stack.

Open it from the app menu (`Escape` → **Environment Editor**). The simulation workspace is the other 3D option in that same menu.

Since ED-03 the editor is one workspace: a top bar, a resizable hierarchy pane on the left, the scene (or map) view with its toolbar in the middle, a resizable inspector on the right, and an asset pane along the bottom. Pane sizes and collapsed states are editor preferences; the canvas and camera projection follow the scene pane, and pointer picking uses the canvas bounds.

## What you can do here

- Place and transform buildings, props, and other static objects in the 3D scene.
- Draw roads and intersections on a 2D map overlay.
- Import real-world terrain preview and road networks from geographic data.
- Bake environment visuals (lighting, splats, and related outputs) for runtime use.

Changes live in an `EnvironmentDocument`. Every edit is a `CommandBus` command or gesture (one undoable step each); the `SceneProjector` applies the resulting change set to the 3D runtime immediately, and autosave persists committed changes.

## Views and modes

`EditorState.editorMode` still has three values, but Scene and Map are now two views of the same document, selection, and toolset in the center pane; the hierarchy and inspector stay visible in both.

| Mode | ID | Purpose |
|------|----|---------|
| Scene view | `scene` | 3D editing: select, move, rotate, scale, and place objects. |
| Map view | `map` | Top-down 2D authoring for roads, intersections, buildings, and features, in the same center pane. |
| Earth Import | `earth-import` | Preview Google Photorealistic 3D Tiles and import OSM roads for a geographic area. Still a mode: the side and bottom panes hide and its own chrome covers the scene pane until ED-08 replaces it. |

Switch between Scene and Map with the toolbar's view toggle; open Earth Import from the top bar. `Escape` cancels a gesture, then a map draft, then leaves the active tool, then clears the selection; when nothing is left to cancel it falls through to the global workspace switcher.

## Document model

`EnvironmentDocument` is the canonical source of truth for authored content. It holds:

- **Roads** — nodes and edges (centerlines, optional elevation `y`, width, shoulders, lane count, bidirectional / one-way travel) plus sparse `turnRules`. Absence of `roads.geometryVersion` is legacy v1. Version 2 stores one `polyline` or piecewise `cubic-bezier` geometry record per edge with stable interior knot ids, automatic/aligned/free handles, and endpoint positions supplied only by shared topology nodes. Nodes are metric `{ x, y, z }` with missing `y` treated as `0`. The deterministic v1 geometry policy samples curves to 1 cm chord deviation and 1 m spacing, then compiles the road strip, shoulders, lanes, junction mouths, indexed surfaces, and bounds once for every consumer. Scenario routing and the kinematic vehicle plant remain planar (XZ distance and yaw); elevation remains in world, mesh, LiDAR, and persisted route geometry. Physical lane index `0` is the rightmost lane for edge start→end travel. Lanes are implicit or explicit (ED-05). Implicit edges derive lanes from `laneCount`/`width`/`bidirectional`/`direction`: even-lane two-way roads split lanes equally by direction, one-way roads use every lane in the configured direction, a one-lane two-way road is shared, and odd two-way counts greater than one are invalid. Explicit edges store `lanes[]` ordered rightmost first, each `{ id, direction: 1 | -1 | 0, width, markingLeft? }` with a stable per-edge id; two-forward/one-backward and any one-way count are legal, same-direction lanes must be adjacent, `0` (shared) is legal only for a single lane, and `width`/`laneCount`/`bidirectional`/`direction` are derived from the records (`edge.width` equals the sum of lane widths). The first lane command materializes lanes on that edge only; an explicit array equal to the derived default canonicalizes back to implicit, so untouched roads never change hash. Lane `{ id, direction, width }` is metric identity (it enters the road-network and world hashes); `markingLeft` and the road borders are appearance-only. Editing the Width option of an explicit-lane road scales its lanes proportionally; the lane count and travel directions are edited only through the lane diagram or lane commands. Scene and Map share one stroke/sub-drag controller and the same compiled boundaries.

The inspector's **Lanes** section (`RoadDisplay`) draws the cross-section looking start→end with the rightmost lane on the right and one editing row per lane (direction, width, interior marking, insert left/right, remove). Every control dispatches an ordinary road command (`road.set-lane`, `road.insert-lane`, `road.remove-lane`, `road.set-lanes`, `road.set-marking`) through the CommandBus, so validation, undo, autosave, and persistence match numeric field edits. Clicking a lane in the diagram, its row, or (once the road is selected) the Map selects a `road-lane` sub-object; Delete removes that lane and Mod+D duplicates it beside itself. The Map draws lane dividers with the authored or automatic marking style and one travel arrow per lane for one-way, explicit-lane, or selected roads. Intersection movements are still edge-to-edge; the matrix disables movements that no lane can make (with the reason) and shows the lane connector a feasible movement would use. `road.set-turn-rule` refuses infeasible movements with structured issues, lane edits prune overrides whose movement disappeared, and an allowed movement without a lane connector inside its junction is a validation warning, never a blocking error. Roads, intersections, endpoints, knots, and handles are editable; a connected node moves once for every incident road. Legacy arms are recomputed only for v1.

Waypoint placement and dragging snap immediately to the nearest physical lane center without initiating map pan. A road anchor records `laneMode: "fixed"` plus `laneIndex` and, on geometry-v2 roads, the stable `laneId`; its snapped longitudinal position and lane are semantic route input, while the raw pointer position is editor-only and removed by scenario normalization. Verification never moves a fixed waypoint across the divider: the lane participates in staged A* and therefore causes a legal detour or a lane-unreachable failure. V1 roads use route algorithm 5. V2 roads use algorithm 7 (ED-05; algorithm 6 proofs are stale and need one re-verification), normalized XZ arc fractions, the frozen geometry-policy identity, the compiled lane mouths/connectors, and lane ids on every anchor, traversal step, and subnode. A lane id wins over the positional index when both are present, and the waypoint hash binds the id, so inserting or removing neighbouring lanes never silently re-lanes a waypoint: a removed lane fails with `route.waypoint.lane-missing`, and a reversed lane forces a legal rebuild. Missing or invalid explicit anchors return `route.waypoint.anchor-missing` or `route.waypoint.anchor-invalid`; verification does not move them to a nearby road. Intersection matrix changes store only non-default `{ nodeId, fromEdgeId, toEdgeId, allowed }` overrides, and changes to those overrides intentionally invalidate road/world hashes and route proofs.
- **Buildings** — footprint records used by the bake pipeline.
- **Features** — placed props (traffic lights, signs, etc.).
- **Earth metadata** — anchor, bounds, provider IDs, and import timestamps after a geographic import.
- **Objects (schema v4)** — the authoring overlay `document.objects`, one record per authored thing: `{ id, typeId, typeVersion, name, parentId, order, components }`. Records share ids with the legacy records they describe (`feature.id`, `buildingId`, edge `id`, junction node `id`); only `group`, the single `skybox`, and the single `tile` (from `earth`) exist without a legacy counterpart. Geometry never lives here — roads, buildings, features, and earth stay canonical, so the overlay is excluded from `worldHash` by construction. `components` holds `tags`, `locked`, and `editorHidden`; groups additionally hold `transform`, a world pivot frame `{ position, rotationY, scale }`. A group gesture bakes its world delta into every descendant's legacy record once and composes it into descendant group frames once, so the frame follows the group without becoming a second source of truth for child placement (legacy domains stay absolute and `worldHash` is untouched). `order` is sibling-relative and dense. Unknown component keys are preserved verbatim on records whose `typeId` is not registered, and such records are reported as `object.type.unsupported` rather than substituted. Object ids are the editor's selection identity and a different namespace from runtime registry ids (`road:<edgeId>`, `intersection:<nodeId>`, `building:<buildingId>`, `fusion:<featureId>`), which `app/3d/editor/selection/selectionIds.js` derives and never stores.

Object types live in the kernel-safe registry under `app/3d/editor/objects/` (`ObjectTypeRegistry`, `ObjectOptions`, `objectGraph`). A type supplies `options` (`getDefaults` / `getFields` / `normalize` / `validate` with `{ path, code, message, severity }` issues), capability flags, a transform binding (`read` the world placement, `plan(delta, context)` the document steps for a world-space delta or return `transform.*` issues), dependencies, `compileMetric`, and `migrate`. Props accept yaw and planar translation, buildings accept yaw, translation, and scale (height follows the Y scale), roads and intersections translate their nodes, groups compose the delta into their frame; anything else is rejected before any mutation. Built-ins: `group`, `skybox`, `tile`, `road`, `intersection`, `building`, `builtin-prop` (the five props as one type with an `assetId` option), and the contract-only `asset-instance`. `deriveObjectGraph` builds the overlay for a v2/v3 document, `reconcileObjectGraph` merges it with stored records (adds uncovered legacy entities, drops orphans, keeps groups and unknown types), and `validateObjectGraph` reports the issue taxonomy (`object.parent.cycle`, `object.legacy.missing`, `object.skybox.multiple`, …) without mutating anything.

The document supports `snapshot()` / `restoreSnapshot()` so preview flows (especially Earth Import) can stage changes and roll back safely. `snapshot()` emits `objectGraphVersion` and `objects` only when the overlay is non-empty and emits `roads.geometryVersion` only when explicitly authored, so untouched legacy snapshots remain byte-identical. Road gesture captures include edge geometry, `roadsAuthored`, and the nested version scalar.

### Commands, gestures, and history (ED-02)

`app/3d/editor/commands/` is the single mutation path. `CommandBus.execute(command)` runs a command inside one document transaction, keeps the in-session object overlay live (`reconcileLiveOverlay`: created legacy entities gain records, removed or demoted ones lose them), validates the object graph and road compiler, and either commits exactly one `ChangeSet` to history or restores the document byte-identically with structured issues. `roadCommands.js` supplies create, convert, insert/remove/set knot, split, detach, and connect. Its first geometry operation upgrades all legacy roads to explicit polylines in the same transaction; ordinary legacy edits do not upgrade. `undo()` / `redo()` apply the recorded before/after records wholesale (`document/ChangeSet.js`), which is total and idempotent. History is bounded (200 entries) and reset on a full load or Earth Import apply.

Gestures are the drag path: `beginGesture({ objectIds, sub })` captures the pristine records of the transform closure (selected records, group descendants, their road nodes and incident edges); every `updateGesture(cumulativeDelta)` restores that capture and re-applies the delta, so frames are idempotent whatever the pointer does; frames notify with `transient: true`; `commitGesture` publishes one non-transient change set (a no-op drag never enters history); `cancelGesture` (Escape, pointer cancel) restores the capture and never enters history. One gesture is active at a time; executing a command cancels it. Shared road nodes reached through several selected objects move exactly once. Locked objects, non-transformable types, non-uniform scale on groups or multi-selections, and scale on props reject the whole frame before anything moves.

`EnvironmentDocument` carries a monotonic `version`; every notification delivers `(snapshot, event)` with `{ version, transient, changeSet, source }`. Autosave ignores transient frames and cancels, and marks dirty only when committed document changes or the persisted editor state (layers, hidden ids, mode, map viewport) change; selection never dirties the environment.

Hierarchy, scene, map, and inspector share one `SelectionStore` (`app/3d/editor/selection/`): ordered object ids, a primary id, and an optional sub-object. Road sub-objects are `{ kind: "road-node", id }`, `{ kind: "road-knot", edgeId, knotId }`, and `{ kind: "road-handle", edgeId, knotId, side }`. Shift/Cmd/Ctrl toggle, Shift-click in the hierarchy selects a range, and mode switches keep the selection.

`app/3d/editor/projection/SceneProjector.js` is the only path from a document change to runtime meshes, registry entities, chunk membership, and LiDAR truth triangles; `EnvironmentLoader.apply` and Earth Import apply remain the load-time full rebuilds (`syncRoadsFromDocument`). Props move in place. Buildings follow the cumulative delta on their existing mesh during a gesture and regenerate once on commit, undo, redo, or cancel with LiDAR triangles replaced only for that building. Roads rebuild the local closure only: the changed edges, the intersections at their endpoints, and those intersections' other incident edges (`computeRoadClosure`), keyed by id with untouched intersections relinked to replaced road objects and `replaceTriangles` scoped by source id. V2 buffers and truth triangles are materialized directly from the compiler's indexed vertices; paint uses polygon offset and does not move metric vertices. A version transition rebuilds roads once, and replaced GPU resources are disposed. Browser-only helpers (placement catalog, building generator) are injected by the loader (`browserProjectorRuntime.js`) so the projector and `Environment` load under node tests.

### Option edits and the sky scalar (ED-03)

Editing a field writes back through one command. `setObjectOptions({ objectId, patch })` (or `setObjectsOptions` for several records, atomic) reads the record's projected option value, applies the patch (`[{ path, value }]` entries or a plain object; unknown paths and `readOnly` fields are rejected with `options.unknown-path` / `options.read-only`), validates it against the descriptors and the type's `validate()`, and asks the type's `planOptions(record, value, context)` for plain plan steps (`set-edge-options`, `set-building-record`, `set-feature-record`, `set-earth-source`, `set-sky`, or `move-node`) or a world `delta` that routes through the transform planner (groups). Nothing mutates on a rejected edit and issues keep their field `path`. The environment sky is a document scalar (`document.sky`, mirrored into `EnvironmentSkyState` by the sky projector and kept current when legacy callers write the state directly), so Skybox edits are ordinary undoable commands; `snapshot()` carries `sky` only once seeded and `toManifest()` strips it, so the persisted location stays `manifest.sky` and `manifest.document` is unchanged. Sky is not part of `createWorldDescription`, so `worldHash` is untouched.

`EditorPresentationRegistry` (`app/3d/editor/presentation/`) maps a `typeId` to an icon, menu options, inspector sections, and an optional preview; hierarchy and inspector consume it exclusively, and unregistered types fall back to a capability-derived default that shows the record and an unsupported notice. Registering a presentation is all a new type needs to appear in both panels (`tests/editor-presentation.test.js` proves it with a test-only type). The hierarchy tree model (`hierarchyModel.js`: sibling order, inherited hidden state, search, drag-and-drop planning) is pure and tested without React.

## Persistence (server-side)

Environment edits are saved to the backend, not the browser. Loading and saving are deliberately separate:

- **`EnvironmentLoader`** fetches the selected manifest and applies it to the one runtime shared by Simulation and Environment Editor. IGVC starts from its native template meshes; legacy hydrated road data does not replace those roads. Roads are rebuilt only after a map/Earth Import edit marks them as authored. Schema v3 `revision`, `visualLayer`, and `evidence` fields are copied onto environment state. Metric geometry is rebuilt and registered first. Preview materialization then loads `{ descriptorHash, accessHash }` into a detached preview group using VIS-05b AOI/LOD residency. Visual failures do not fail metric load; the 3D chrome shows `idle/loading/ready/error` preview status with retry, including `VISUAL_PREVIEW_BUDGET_EXCEEDED`. Preview meshes are marked non-selectable and are excluded from object-registry membership, collision geometry, LiDAR truth, perception scans, and measured cameras. `worldHash` is unchanged. Legacy descriptor-only references stay non-materializable until an access hash is attached.
- **`EnvironmentPersistence`** watches committed document changes (never transient gesture frames or cancels), the registry, the persisted subset of editor state, and sky; selection never marks the environment dirty. It tracks edit generations separately from requests, retains the last acknowledged server revision, allows one `PUT` in flight, and builds queued saves from the latest `Environment.toManifest()` at send time. An edit made during a request stays dirty until its own captured draft is acknowledged. Geometry-aware writes include request-only `supportedRoadGeometryVersions: [1, 2]`; the server rejects a full replacement over v2 from an unaware writer, malformed versions, and v2 records tagged as v1. The first v2 write retains one `pre-road-geometry-v2` migration record. Explicit server `null` visual/evidence references are applied. Older revisions, other-environment responses, and stale promotion receipts are ignored. External MCP updates over a dirty or in-flight draft expose a conflict and keep the local edits.
- **On page unload / tab hide** it flushes through the same queue with `keepalive`. Autosave suspension blocks every save entry point, cancels timers and queued work, drains the current request, preserves unsaved edits, and explicitly saves them after resume. A strict promotion flush joining an autosave observes the shared failure.

The storage contract is environment schema v4 (schema v2, v3, and v4 all read; the ED-02 env-var opt-out was retired in ED-03, and only the test-only `StorageService` option `environmentSchemaVersion: 3` still exercises the v3 writer). v2 files load as revision `0` with implied null visual/evidence references; the first guarded save writes v3 revision `1`. Full replacement is `PUT /api/storage/environments/<id>` with `{ manifest, expectedRevision }`. Rename, duplicate, ID change, and delete require the same revision. Missing or stale revisions return HTTP `409` with `ENVIRONMENT_REVISION_CONFLICT` and `currentRevision`. Unguarded legacy bodies are rejected with `ENVIRONMENT_UNGUARDED_WRITE`. Catalog entries include `revision`. `clientRevision` is not a concurrency authority and is not written into v3 documents.

Schema v4 (ED-01) adds `document.objects` and `document.objectGraphVersion: 1`. Reads accept v2, v3, and v4; v2/v3 read views never inject a graph (`presentEnvironmentObjectGraph` derives one in memory). The writer emits v4 (`StorageService` option `environmentSchemaVersion` defaults to `4`; the test-only value `3` strips `objects`). Stripping is lossy once names, groups, locks, or hidden flags have been authored, which is why ED-02 flipped the default. A v4 write reconciles the incoming graph against the legacy domains, validates it, and rejects error-severity issues atomically with HTTP `400` `ENVIRONMENT_OBJECT_GRAPH_INVALID` and an `issues` array. The first v4 save over a v2/v3 file stores a write-once copy at `server/data/environment-migrations/<id>.pre-v4.json` (`cev-sim.environment-pre-migration` v1); recovery is a manual restore of `manifest`. Once a file is v4 it stays v4 even under the opt-out. A write whose `document` lacks an `objects` array over a stored v4 graph is an old client: when the stored graph carries authored data (groups, renames, parents, tags, locks, hidden flags, unknown types) it is rejected with HTTP `409` `ENVIRONMENT_SCHEMA_DOWNGRADE` instead of dropping the graph; when the graph is purely derived it is re-derived from the new geometry and the write passes (ED-02). Writes that omit `document` (rename) and graph-aware clients that still declare `schemaVersion: 3` pass. MCP `environment_add_object` rejects unregistered types with `ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED`.

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

## UI chrome (ED-03 workspace)

`EnvironmentEditorChrome` mounts `EditorWorkspace` (`app/3d/overlay/workspace/`) plus the Three-side overlays (selection handles and group union boxes, chunk outlines, the editor working grid, Earth bounds) and the workspace shortcuts.

- **Layout** — a CSS grid inside `#overlay`: top bar (40 px), hierarchy pane (232 px), scene pane, inspector pane (304 px), asset pane (208 px). `paneLayout.js` (pure) clamps sizes so the scene pane never drops below 480 × 240 px (the inspector shrinks first, then the hierarchy, then the asset pane; each collapses to a 28 px rail when minimums are not enough), and the layout persists under `cev-sim.ui.environmentEditor.paneLayout`. Splitters are `role="separator"` controls (drag, Arrow ±8 px, Shift ±32 px, Home/End, Enter toggles, double-click resets). The scene pane publishes its rectangle to `TotalScene`, which sizes the renderer, camera, and sky manager from it (`viewportRect.js`); the canvas sits beneath the `pointer-events: none` center cell so picking and gizmos keep receiving pointer events with canvas-relative coordinates.
- **Top bar** — environment switcher, View menu (pane visibility), Earth import, Atmosphere (selects the Skybox), bake start/stop, and the save status (`EnvironmentPersistence.subscribe()` → saved / unsaved / saving / conflict).
- **Toolbar** — `toolbarModel.js` (pure) builds the groups for the current view; the React toolbar renders `IconButton`s (tooltip, `aria-label`, `aria-pressed`) with roving Arrow-key focus. Scene view: Select/Move/Rotate/Scale/Road Pen, world/local axes, snap, Scene/Map view, grid/chunks/bounds overlays, layers, undo/redo/frame. Map view: select/pan/intersection/road pen/building rectangle, map snap, grid. Scene and Map road pens feed `RoadAuthoringController`; Enter, double-click, or an existing-node connection commits the whole stroke as one road and Escape drops the session-only `EditorState.roadDraft`. View options (`transformSpace`, `transformSnap`, `sceneGridVisible`, `selectionBoundsVisible`, `chunkOutlinesVisible`) are session state remembered under `cev-sim.ui.environmentEditor.viewOptions`, never in the manifest. LiDAR and collision overlays arrive with ED-07's proxies.
- **Hierarchy** — a windowed tree (`virtualWindow.js`: only the visible rows plus overscan render, so thousands of objects stay responsive) with `aria-level`/`aria-posinset`/`aria-setsize`, roving focus (`aria-activedescendant`), Arrow/Home/End navigation, Left/Right collapse and expand, Enter renames, Space toggles selection, Shift-range and Cmd/Ctrl-toggle selection, search, inline rename, hide/lock, drag-and-drop reparenting, and the presentation registry's context menu. Collapsed groups persist under `cev-sim.ui.environmentEditor.hierarchyExpanded`.
- **Inspector** — sections from `EditorPresentationRegistry.getInspectorSections`; option fields render from `ObjectOptions.getFields()` through the generic controls in `app/3d/overlay/fields/` (`NumberField` with typed drafts, Arrow stepping, and label scrubbing; `Vector3Field`; `EnumField`, `ToggleField`, `TextField`, `ColorField`, `AssetReferenceField`; collapsible `PropertySection`s remembered per section). Every edit is `setObjectOptions` (or `setObjectsOptions` for a multi-selection of one type, which shows mixed values and applies one patch atomically); rejected edits keep the draft and show the issue inline at its field path without touching the document. Built-in extra sections come from `builtinSections.js`: the intersection turn-rule matrix, road endpoint elevations, v2 `ROAD_GEOMETRY` controls (shape conversion, knot coordinates/mode, insert/remove, split, detach, and connect), and the Skybox runtime/local-preview block. Advanced descriptors show behind the shared Advanced switch. The Skybox is edited here; its authored values are the document's `sky` scalar and undo/redo like any other edit.
- **Asset pane** — the built-in prop catalog in a folder/grid shell (click arms placement in the active view). ED-06 replaces the contents with the server-backed catalog.
- **Earth Import mode** — `EarthImportModeChrome` with anchor/bounds fields, preview/apply controls, and layer toggles, overlaying the scene pane while the other panes hide.

Keyboard: `Q`/`W`/`E`/`R` select tools (scene view); `Escape` cancels an active gesture, then a shared road draft, then leaves the tool, then clears the selection, then falls through to the workspace switcher; `Enter` finishes a road-pen draft; `Mod+Z` / `Shift+Mod+Z` (or `Ctrl+Y`) undo and redo; `Mod+D` duplicates; `Delete`/`Backspace` removes a selected interior knot or deletes the selected road/object; `Mod+G` / `Shift+Mod+G` group and ungroup; `F` frames the selection. All editor shortcuts register through `ShortcutProvider` (`EditorCommandShortcuts`), never fire inside editable fields, and consume the event only when something happened. `Mod` is Cmd on macOS and Ctrl elsewhere; bare letters never fire while Cmd/Ctrl/Alt is held.

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
| `tests/editor-presentation.test.js` | ED-02 presentation registry, hierarchy tree model, drop planning, the test-only-type extension demonstration, and the ED-03 built-in section providers |
| `tests/command-options.test.js` | ED-03 `setObjectOptions` / `setObjectsOptions` for every built-in type, `planOptions`, atomic rejection with field paths, the `sky` scalar and its runtime mirror, feature re-placement on asset/facing changes |
| `tests/pane-layout.test.js` | ED-03 pane layout model (defaults, clamping, resize/step/toggle, persistence) and the render viewport resolver |
| `tests/editor-workspace.test.js` | ED-03 toolbar model per view, toolbar actions, editor view options |
| `tests/field-model.test.js` | ED-03 field formatting/parsing/stepping/scrubbing, grouping, mixed values, issue mapping |
| `tests/virtual-window.test.js` | ED-03 hierarchy windowing and tree keyboard navigation |
| `tests/ui/environment-editor.spec.js` | ED-03 Playwright: panes, canvas tracking the scene pane, splitters, shortcut scoping, map view, inspector edits with undo and inline validation, autosave persistence, mixed values, large hierarchy windowing, asset pane, axe scan |
| `tests/road-geometry.test.js` / `tests/road-network-geometry.test.js` | ED-04 record resolution, exact curve operations, sampling limits, surfaces, junctions, connectors, conflicts, and cache reuse |
| `tests/road-commands.test.js` / `tests/environment-road-geometry.test.js` | ED-04 migration, topology commands, guarded gestures/history, versioned snapshots and storage/MCP admission |
| `tests/road-routing-v6.test.js` / `tests/road-geometry-integration.test.js` | ED-04 XZ route v6, anchors/off-road union, and indexed world/browser/LiDAR agreement |
| `tests/ui/environment-road-geometry.spec.js` | ED-04 Scene/Map stroke, inspector, shortcuts, undo/redo, reload persistence, and axe scan at 1280 × 720 |
| `tests/road-lanes.test.js` | ED-05 lane record contract: derived-vs-explicit parity, canonicalization, every validation code, metric projection, hash and world-resource invariants |
| `tests/road-lane-commands.test.js` / `tests/road-turn-validation.test.js` | ED-05 lane commands (materialize, insert/remove/set, markings, Width scaling, read-only derived fields, split/duplicate/locks) and asymmetric-aware turn-rule feasibility, pruning, and structured issues |
| `tests/road-routing-v7.test.js` / `tests/route-proof-invalidation.test.js` | ED-05 route algorithm 7 (lane ids, v6 staleness, v5 byte-identity), lane-missing / direction-flip / insert invalidation, scenario anchor normalization |
| `tests/road-lane-selection.test.js` / `tests/road-lane-rendering.test.js` / `tests/road-lane-mcp.test.js` | ED-05 `road-display` descriptor, `road-lane` sub-selection and map lane picking, scene markings and runtime lane records, MCP lane/marking/turn-rule operations and validation |
| `tests/ui/environment-road-lanes.spec.js` | ED-05 Playwright: lane diagram insert/reverse/width edits with validation, Map dividers and arrows, undo/redo, Delete on a lane, reload persistence, and axe scan with a lane selected |
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
app/roads/                  Pure versioned road records, policy, curve/surface compiler, junction planning
app/3d/editor/objects/      Kernel-safe object-type registry, options, object graph, transform deltas (schema v4)
app/3d/editor/commands/     CommandBus, gestures, transform planning, object and legacy commands, headless service (MCP)
app/3d/editor/selection/    SelectionStore and object-id ↔ registry-id mapping
app/3d/editor/projection/   SceneProjector and domain projectors (roads local closure, buildings, features, objects)
app/3d/editor/presentation/ EditorPresentationRegistry, hierarchy tree model, field model, windowing, built-in sections
app/3d/editor/workspace/    Pane layout and toolbar models (pure)
app/3d/environment/         Environment container and visualization
app/3d/overlay/             React chrome (workspace panes, toolbar, inspector, fields, map/earth modes)
app/3d/overlay/workspace/   EditorWorkspace, panes, splitter, toolbar, top bar, asset pane, working grid
app/3d/overlay/fields/      Generic field controls rendered from ObjectOptions.getFields()
app/3d/overlay/inspector/   Built-in inspector sections (turn rules, road endpoints, sky preview)
app/3d/earth/               Earth Import implementation
app/3d/skybox/              Procedural sky (preserved during earth import)
```
