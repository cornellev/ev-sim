# UI Events

The scripting UI uses browser `CustomEvent`s to coordinate React units, the line manager, and `ScriptManager`.

## Events

- `data-stored`: sent by `storeData(uuid, data)` so `Scripting.js` can call `manager.storeData(uuid, data)`.
- `reregister-unit`: sent by `reregister(uuid)` so dynamic backend ports are recalculated.
- `reconfigure-unit`: sent synchronously by `requestUnitReconfiguration(uuid, patch)`. `Scripting.js` calls `ScriptManager.reconfigureUnitDetailed()`, writes the result to `event.detail.result`, and commits React state only when graph-wide port unification succeeds.
- `position-unit`: sent after adding or importing a unit so `Unit` can move to the intended canvas position.
- `unit-position-preview`: sent by `Unit` while a node is being dragged so `LineManager` can remeasure wires without persisting the position.
- `unit-position-changed`: sent by `Unit` after a drag ends or an arrow-key nudge so `Scripting.js` can store world-space `position` and `LineManager` can remeasure wires.
- `canvas-viewport-changed`: sent by `ScriptCanvas` after pan/zoom so `LineManager` can remeasure screen-space wires. The camera lives in `graph.viewport` (`{ x, y, scale }`) and is editor-only.
- `delete-unit`: sent by a unit delete action and handled by both `Scripting.js` and `LineManager`.
- `delete-port-connections`: removes wires for specific ports, usually after dynamic output changes.

## Connection Flow

```mermaid
flowchart LR
  inputPort[Input Port Mouse Down] --> lineInProgress[Line In Progress]
  lineInProgress --> outputPort[Compatible Output Port]
  outputPort --> notifyConnection[notifyConnection]
  notifyConnection --> scriptManager[ScriptManager.connectUnitsDetailed]
```

`LineManager` starts wires from input ports and completes them on compatible output ports using decoded `data-encoded` types and `portsCompatible()`. When a wire is completed, it passes decoded port metadata back to `Scripting.js`, which calls `connectUnitsDetailed` and refreshes solved `portTypes` plus `connectionSnapshot`. Typed settings use `reconfigureUnitDetailed`; missing ports and generic/concrete conflicts restore configuration and bindings atomically without deleting existing wires. Compiled programs freeze resolved port types into artifact `nodes[].ports`.

## Port Metadata

Ports encode metadata as:

```text
uuid|label|type
```

The parser lives in `LineManager.js`. Avoid using `|` in generated port IDs or labels. `ProgramIO.js` already sanitizes generated port IDs by replacing `|` with `-`.

## Deletion

Deleting a unit should remove backend state and visible wires. Deleting a connection should call `ScriptManager.disconnectUnits(...)`.

Because deletion paths are easy to desynchronize, test graph validity after changing unit deletion, connection deletion, or dynamic port behavior.
