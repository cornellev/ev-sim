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

For bracketed types, such as `array[float64]`, the UI can fall back to the base type color.

## Program I/O Types

`app/scripting/units/program/ProgramIO.js` defines the types exposed by Program Input, Program Output, and OutputNode configuration.

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

A connection is valid only when output type and input type are exactly equal. `Compiler.js` also validates this before emitting an artifact.

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
