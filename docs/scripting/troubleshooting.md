# Scripting Troubleshooting

## Unknown Block Type

Error example:

```text
Unknown block type "MyBlock". Register it before compiling.
```

Add the block class to `app/scripting/registerBuiltInBlocks.js`. If the block appears in the block library, also confirm its `UnitCatalog.js` entry references the same backend class.

## Missing Port

The React unit and `UnitBlock.register()` probably disagree about a port label or type. Check both sides.

## Type Mismatch

Connections require exact type equality. For example, `float64` and `int32` do not connect unless a conversion block is used.

## Duplicate Program Labels

Program input labels must be unique among inputs. Program output labels must be unique among outputs. The default OutputNode sidebar also validates duplicate output labels.

## Cycle Detected

Compiled visual scripts are evaluated backward from final states and currently reject cycles. Break feedback loops into explicit stateful blocks if you need memory.

## Block Is Visible But Does Not Compile

Check `app/scripting/UnitCatalog.js`. If the entry has `blockClass: null`, it is UI-only. Add a backend `UnitBlock` and register it before expecting compile/run support.

## Dynamic Port Changes Break Wires

When changing types or removing ports, disconnect affected wires and dispatch `delete-port-connections` if the UI needs to remove visible lines. The OutputNode sidebar is the main reference implementation.

## Imported Program Fails

Imported compiled programs must be supported v2 artifacts and all block types inside the artifact must be registered in the current runtime.

## ROS Blocks Do Not Use Live Topics

The scripting ROS units are placeholders. Live topic integration currently flows through the 3D scene's `ClientManager`, not through scripting blocks.
