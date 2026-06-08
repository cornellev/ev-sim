# Authoring Units

A visual scripting unit has two halves: a React component for the canvas and a `UnitBlock` subclass for behavior.

## React Unit

Use `Unit` from `app/scripting/units/Unit.js`. The `_uuid` prop must be passed through because it is how the editor connects UI nodes to backend blocks.

```javascript
export function MyUnit({ _uuid }) {
    return (
        <Unit
            title="My Unit"
            hasOptions={true}
            _uuid={_uuid}
            inputs={[
                { label: "a", type: "float64" },
                { label: "b", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "float64" }
            ]}
        >
            {/* options UI */}
        </Unit>
    );
}
```

Port labels and types must match the backend block.

## Backend Block

Extend `UnitBlock` from `app/scripting/ScriptManager.js`.

```javascript
export class MyBlock extends UnitBlock {
    register() {
        this.registerInput("a", "float64");
        this.registerInput("b", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("a") && this.hasInput("b");
    }

    execute() {
        return new BlockOutput()
            .set("out", this.getInput("a") + this.getInput("b"));
    }
}
```

`register()` defines the port type map used by the editor and compiler. `valid()` decides whether the block can run. `execute()` returns a `BlockOutput`.

## State

Use `serializeState()` and `hydrateState()` for editor configuration that must be saved in compiled artifacts.

Use `storeData(_uuid, data)` from a React unit when the UI needs to send larger or structured option data to the backend block.

Use `serializeRuntimeState()` and `hydrateRuntimeState()` for state that changes across compiled runs, such as filters and accumulators.

## Dynamic Ports

When a unit option changes port types or labels, call `reregister(_uuid)` from the React component. The event reaches `Scripting.js`, which calls the backend block's `reregister()`.

If a dynamic port changes type, existing incompatible wires should be removed. `OutputNode` is a useful reference for this pattern.
