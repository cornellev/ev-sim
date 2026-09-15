# Types And Ports

Visual scripting port types are strings. The editor uses them to decide whether ports can connect and which wire color to show.

## Type Colors

Base type colors live in `app/scripting/Constants.js`.

Current base types:

- `float64`
- `int32`
- `string`
- `boolean`
- `array`
- `custom`
- `tex1d`
- `generic` (editor-only wire color; not a program I/O type)

For bracketed types, such as `array[float64]`, the UI can fall back to the base type color. `generic` is listed in `Constants.TYPES` for unbound polymorphic ports. It is **not** in `ProgramTypes.SUPPORTED_TYPES` and must never appear in compiled artifacts.

## Program I/O Types

`app/scripting/units/program/ProgramIO.js` defines the types exposed by Program Input and OutputNode configuration.

Current supported program I/O types:

- `float64`
- `int32`
- `boolean`
- `string`
- `tex1d`
- `array[float64]`
- `array[int32]`
- `array[boolean]`
- `array[string]`
- `custom[string]`

## Port Matching

`app/scripting/types/PortTypes.js` defines `portsCompatible(a, b)`: either side may be editor-only `generic`, otherwise the strings must match exactly (`float64` ≠ `int32`). `LineManager` uses that check on the full `data-encoded` type, not CSS class names.

Polymorphic blocks declare `static typeScheme = { variables: { T: { inputs: [...], outputs: [...] } } }`. Graph-wide unification in `app/scripting/types/unifyGraph.js` unions connected generic variables, propagates every concrete constraint across the component, and rejects a candidate wire when two distinct concrete types would meet. Existing wires are never deleted to make a new wire fit.

Derived bindings live on `unit.typeBindings` (for example `{ T: "float64" }`) and are cached on editor graph nodes as `typeBindings`. On restore, connections are the authority and bindings are recomputed.

`ScriptManager.connectUnitsDetailed(...)` returns `{ ok, error }` and is the mutation API. `connectUnits(...)` remains the boolean wrapper. `disconnectUnits()` recomputes bindings; an unconstrained component returns to `generic`.

The compiler snapshots **resolved** `nodes[].ports` into compiled v3 artifacts. Only reachable nodes must be fully concrete. Frozen v2 artifacts remain runnable; their ports override later class registration. Artifact `nodes[].ports`, `transitions[].type`, and program interfaces may never contain `generic`.

React units that participate in inference receive solved `portTypes` from `Scripting.js` after connect, disconnect, load, and reregister. Legacy stored `type` fields on If / latch / default / log may round-trip but do not constrain inference.

React units and backend blocks must use the same labels and types:

```javascript
// React unit
outputs={[{ label: "out", type: "float64" }]}

// UnitBlock
this.registerOutput("out", "float64");
```

If a port has a separate display label and internal id, pass both from the React unit. `Unit` encodes `id` into the connection metadata and only uses `label` for display:

```javascript
outputs={[{ id: "input", label: "speed", type: "float64" }]}
```

The backend block must register the stable id:

```javascript
this.registerOutput("input", "float64");
```

Program Input uses this pattern. Its visible external label defaults to `input`, then `input_2`, and so on, while its internal output port remains `input` so compilation and existing wires do not depend on generated unit IDs.

## Dynamic Ports

When a block changes its port type map, call `reregister(_uuid)` from the UI. This dispatches `reregister-unit`, and `Scripting.js` calls the matching backend block's `reregister()`.

When changing a port type would invalidate existing wires, remove those wires through the `delete-port-connections` event or another explicit disconnect path.
