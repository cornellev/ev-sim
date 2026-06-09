# Scripting Tests

Visual script runtime tests live in `tests/visual-script-runtime.test.js` and run with:

```bash
npm test
```

The test command is:

```bash
node --experimental-default-type=module --test tests/*.test.js
```

## What To Test

Add or update tests when changing:

- Compile validation.
- Artifact schema fields.
- Program input/output behavior.
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
- Wires connect only between matching types.
- The validity badge updates after adding, connecting, deleting, or re-registering units.
- `Compile` downloads a JSON artifact.
- `Run Compiled` logs a success or meaningful failure.
- `Import Compiled` creates a reusable compiled program unit.
