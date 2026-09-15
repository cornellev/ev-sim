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
- Eager v2 versus lazy editor/v3 selector evaluation.
- Editor `executeProgram()` memoization: shared diamonds run once per call, memos are shared across multiple OutputNodes, and a later call starts a new memo.
- Runtime cycles on live graphs (`Cycle detected at runtime while evaluating "<uuid>"`) plus `SignalStore` rollback of staged writes.
- Frozen `nodes[].ports` overlay during hydrate, including v2/early-v3 `written` / `ok` / `staged` versus current `then` ports.
- Effect sequencing: `Sequence` order, `Passthrough` reachability, unused lazy `WriteSignal` branches, and fail-closed restore of missing ports.
- Program input/output behavior, including `unit`.
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
- Category filters and search find the expected `UnitCatalog.js` entries.
- Wires connect between compatible types, including concrete-to-generic, and polymorphic ports refresh after connect/disconnect.
- Conflicting concrete types through a generic component are rejected without dropping existing wires.
- The validity badge updates after adding, connecting, deleting, or re-registering units.
- `Compile` downloads a JSON artifact (`version: 3`).
- `Run Compiled` logs a success or meaningful failure.
- `Import Compiled` creates a reusable compiled program unit.
