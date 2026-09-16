# Runtime State

Scripting blocks can store three different kinds of data. Keep them separate so compiled programs behave predictably.

## Editor State

Use `serializeState()` and `hydrateState()` for configuration that defines what the block is.

Examples:

- Selected operation.
- User-facing label.
- Program input/output type.
- Constant value.

Editor state is saved into the compiled artifact under each node's `state`.

## Stored Data

Use `storeData(_uuid, data)` from React UI when the UI needs to pass structured data to the backend block. The manager stores it by UUID, and the block can read it with `this.getStoredData()`.

Stored data is saved into the compiled artifact under each node's `storedData`.

## Runtime State

Use `serializeRuntimeState()` and `hydrateRuntimeState()` for values that change as the program runs.

Examples:

- Previous sample for a low-pass filter.
- Last output for a rate limiter.
- Seed or accumulator state.

Runtime state is saved into the compiled artifact under each node's `runtimeState`. `VisualScriptRunner` hydrates `state`, then `runtimeState`, then overlays cloned `node.ports` onto `unit.typeMap`. Frozen ports win over the current class `register()`. A successful run syncs the new state. A failed editor or compiled run restores every unit's pre-run runtime state before returning, alongside signal-transaction rollback. Imported compiled-program blocks expose and restore their nested runner state through the same contract.

Editor `ScriptManager.outputMemo` is a per-`executeProgram()` evaluation frame, not runtime state. It is recreated at the start of each call and is not serialized.

## Guidelines

- Do not put UI-only details in runtime state.
- Do not put changing runtime values in editor state.
- Keep runtime state JSON-serializable.
- Make `hydrateRuntimeState()` tolerate missing fields so older compiled artifacts can still load when practical.
