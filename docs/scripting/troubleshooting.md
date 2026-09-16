# Scripting Troubleshooting

## Unknown Block Type

Error example:

```text
Unknown block type "MyBlock". Register it before compiling.
```

Add an explicit stable-type entry and backend class to `app/scripting/UnitCatalog.meta.js`, then confirm `UnitCatalog.js` maps that type to its React component. `registerBuiltInBlocks.js` registers metadata entries automatically.

## Missing Port

The React unit and `UnitBlock.register()` probably disagree about a port label or type. Check both sides.

Loading an older editable graph that still wires `written`, `ok`, or `staged` after those outputs were replaced by `then` produces restore errors such as:

```text
Missing output port "written" on block "<uuid>". Rewire this connection manually.
```

Compile fails closed and keeps `latestValidArtifact`. Status shows `Invalid, stale artifact` until you rewire `then` (or an identity output) and the old edge is pruned. The stored graph JSON keeps the unrestored connections; they are not silently dropped.

## Type Mismatch

`LineManager` and `connectUnitsDetailed` use `portsCompatible()`: `generic` may connect to any type, then graph-wide unification binds or rejects. Distinct concrete types (`float64` vs `int32`, or `float64` vs `string` through an `If`) do not connect. A rejected candidate does not delete existing wires.

Reachable nodes must be fully concrete to compile. Unreachable unbound generics are allowed on the canvas. Actionable errors name the node UUID, block type, and variable, for example:

```text
Type conflict on IfBlock "if-uuid" variable T: float64 vs string.
Unbound generic T on IfBlock "if-uuid".
```

Mapping a compiled `actor_command` program output to a route-controller `speed` or `steering` target fails at scenario resolve, not compile:

```text
Route controller output "command" must be float64 for speed.
```

Split the value with Split Actor Command, or export `float64` ports instead.

## Duplicate Program Labels

Program input labels must be unique among inputs. Program output labels must be unique among outputs. The default OutputNode sidebar also validates duplicate output labels.

## Cycle Detected

The compiler rejects cycles while walking reachable nodes:

```text
Cycle detected in visual script: a -> b -> a.
```

Live editor execution also detects recursion while evaluating a node:

```text
Cycle detected at runtime while evaluating "a".
```

`checkValidity()` does not reject cycles (it skips already-visited UUIDs), so Run on a cyclic live graph fails at runtime and rolls back staged `writeSignal` values. Break feedback loops into explicit stateful blocks if you need memory.

## Block Is Visible But Does Not Compile

Check `app/scripting/UnitCatalog.meta.js` and the component mapping in `UnitCatalog.js`. Every placeable entry must have a backend `UnitBlock` and React component.

## Dynamic Port Changes Break Wires

When changing types or removing ports, disconnect affected wires and dispatch `delete-port-connections` if the UI needs to remove visible lines. The OutputNode sidebar is the main reference implementation.

## Imported Program Fails

Imported compiled programs must be supported v2 or v3 artifacts and all block types inside the artifact must be registered in the current runtime. Frozen `nodes[].ports` override the current class registration.

## ROS Blocks Do Not Use Live Topics

The scripting ROS units are placeholders. Live topic integration currently flows through the 3D scene's `ClientManager`, not through scripting blocks.
