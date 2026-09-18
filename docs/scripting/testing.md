# Scripting Tests

Visual script runtime tests live in `tests/visual-script-runtime.test.js`. Type unification tests live in `tests/visual-script-types.test.js`. Browser port refresh is covered by `tests/ui/scripting-types.spec.js`. They run with:

```bash
npm test
```

The Node test command is:

```bash
node --experimental-default-type=module --test tests/*.test.js
```

## What To Test

Add or update tests when changing:

- Compile validation, including reachable-only concreteness and rejection of `generic` in artifact ports.
- Graph-wide generic unification: `connectUnitsDetailed`, atomic conflict rejection, disconnect/unbind, and restore from connections rather than cached `typeBindings`.
- Artifact schema fields and supported versions (`2` and `3`).
- Eager v2 versus lazy editor/v3 selector evaluation (`If`, `WeightedSelect`, `SignalLatch`). `AndBlock` / `OrBlock` always short-circuit, including on v2-versioned copies of new artifacts.
- Table-driven atomic scalar/logic execution in `tests/visual-script-blocks.test.js` (zeros, false, empty, invalid domains, cloned JSON, compiled ports).
- Table-driven conversion/string/JSON/array execution, cloned writes, out-of-range `found`/`changed`, and `deleteByPath`. Opaque `string` ↔ `road_id` / `texture_id` conversions trim and allow empty ids. Generic `To String` accepts any concrete `T` and emits `string`.
- Table-driven geometry Make/Split/arithmetic and route-helper execution, including zero vectors, extra-key drop, cloned vec/waypoint outputs, out-of-range `found`, Euclidean distance-to-end, and Route Tangent XZ→`vec2` packing (`{ x, y: z }`).
- Table-driven `control` temporal/PID execution, including first-tick zeros/false, multi-tick sequences, `dt` throw-before-mutate, cloned Previous values, BindingRuntime `resetRun` restoring artifact `runtimeState`, and catalog count 14.
- Table-driven texture arithmetic (zeros, empty arrays, swapped clamp bounds, invert `1-x`, cloned outputs, unequal-length and non-finite throws) plus `SampleTextureBlock` perfect-square rejection. Catalog `texture1d` placeable count 8; `ScaleBlock` remains registered but non-placeable.
- Simulator adapters against a real `SignalStore`: ego/legacy `vehicle.ego.*` fallback, missing steering, dual-source clock (blob `dt` vs kernel leafs), cloned scenario JSON. Catalog `simulator` placeable count 16 (includes Sample Road, Get Nearest Road, Spawn Prop, Scatter Features).
- Path-frame helpers and episode overlay lifecycle in `tests/path-frame.test.js` and `tests/episode-overlay.test.js`: right-of-travel lateral offset, nearest-road closest centerline, `worldHash` stability, physics `episode:*` colliders, CPU LiDAR hits, and kernel reset scatter without duplication.
- Repeat Program looping a compiled Spawn Prop child, and unconsumed Spawn Prop omitted from compiled `Q`, in `tests/visual-script-runtime.test.js`.
- BindingRuntime `episode-reset` fires start-phase on `resetRun` / Play, stop-phase on Stop. Stop-phase layout seeds increment across `prepareResolvedScripts`. Library-mode scripts receive `spawnProp` from the overlay host. Missing signal mappings leave Program Input defaults in place.
- Catalog uniqueness, placeability, and keyword search for `math` / `logic` / `strings` / `collections` / `conversions` / `geometry` / `control` / `mission` route-helper / `texture1d` / `simulator` entries.
- Editor `executeProgram()` memoization: shared diamonds run once per call, memos are shared across multiple OutputNodes, and a later call starts a new memo.
- Runtime cycles on live graphs (`Cycle detected at runtime while evaluating "<uuid>"`) plus `SignalStore` rollback of staged writes.
- Frozen `nodes[].ports` overlay during hydrate, including v2/early-v3 `written` / `ok` / `staged` versus current `then` ports.
- Effect sequencing: `Sequence` order, `Passthrough` reachability, unused lazy `WriteSignal` branches, and fail-closed restore of missing ports.
- Program input/output behavior, including `unit`, `actor_command`, `vec2`, `vec3`, `pose2d`, `pose3d`, `road_id`, and `texture_id`.
- Make/Split actor-command and vec/pose normalization, optional `actorId` / pose `order`, and `If<actor_command>`.
- Scenario resolution rejecting an `actor_command` program output mapped to route-controller `speed`/`steering`.
- Runtime state hydration or serialization.
- Imported compiled program behavior.
- Block registration behavior.
- Any shared `UnitBlock` or `ScriptManager` behavior.

## Registry Pattern

Tests import registry helpers from `ScriptManager.js`, including:

- `registerBlockType`
- `clearBlockTypeRegistryForTests`

Clear the registry between tests when block type names could leak between cases.

## Minimal Blocks

The existing tests define small in-file block classes such as constant, add, input, output, multi-output, and stateful blocks. Prefer that pattern for runtime behavior tests instead of depending on full UI units.

## Manual Checks

For UI-facing scripting changes, also run the app and verify:

- `Ctrl+A` or `Cmd+A` opens the block library, unless focus is inside an editable field.
- Category filters and keyword search find the expected placeable `UnitCatalog.meta.js` entries; deprecated composites remain absent.
- Wires connect between compatible types, including concrete-to-generic, and polymorphic ports refresh after connect/disconnect.
- Conflicting concrete types and typed setting changes are rejected without changing controls, bindings, or dropping existing wires.
- The validity badge updates after adding, connecting, deleting, or re-registering units.
- `Compile` downloads a JSON artifact (`version: 3`).
- `Run Compiled` logs a success or meaningful failure.
- `Import Compiled` creates a reusable compiled program unit.
- Two-finger trackpad scroll and mouse wheel zoom toward the cursor; they do not pan.
- Empty-canvas grab-drag, middle-mouse drag, and Space+left-drag pan without moving nodes.
- Dragging a node title and completing a wire still work at 50% and 200% zoom. Zoomed-in units stay sharp (not bitmap-scaled).
- Clicking a wire shows a chip with the exact resolved type (for example `float64` or `array[string]`, not only the base color). Escape or empty-canvas click dismisses it.
- `Fit` frames every node; Ctrl/Cmd+0 resets to 100%.
- Cmd/Ctrl+S still saves. Reloading an editable script restores `graph.viewport`.
