# Built-In Blocks

`app/scripting/UnitCatalog.meta.js` is the authoritative built-in inventory. It owns stable type IDs, display names, categories, keywords, placeability, deprecation, settings, signal requirements, and React-free block classes. `UnitCatalog.js` attaches React components by type, `registerBuiltInBlocks.js` registers the same explicit types, and `AddMenu.js` renders only placeable entries.

## Menu Categories

Current block library categories:

- `expressions`: number, calculation, random number.
- `constants`: pi, e, tau, golden ratio.
- `vector2`: texture operations.
- `terrain`: terrain texture generation and processing.
- `sensorflow`: filters, gates, sensor fusion helpers.
- `randomization`: random ranges, seeded random, noise, jitter, weighted select, remap.
- `conversions`: numeric conversions, including the legacy `Float64 to Int32` / `Int32 to Float64` blocks plus atomic floor/ceil/round/truncate, boolean/number/string conversions, and parse/stringify JSON. Failed string/JSON parses emit zero/`null`/`false` plus `valid:false` and do not fail the script.
- `objects`: string and JSON constants plus JSON path get/set/has/delete/merge. Get/Set use a `valueType` selector (`float64|int32|boolean|string|json`). Path ops reuse `getByPath`/`setByPath`/`deleteByPath` and clone every document output.
- `strings`: concat, length, contains/starts/ends, trim/case, slice, replace-all, split, and join. Empty strings are legal inputs. Split/Join use fixed `array[string]` ports.
- `collections`: typed arrays with `state.itemType` (`float64|int32|boolean|string|json`). Ports resolve to `array[itemType]`. Out-of-range gets return `fallback` with `found:false`; out-of-range sets leave a cloned array with `changed:false`.
- `statements`: if, nop, ignore, sequence, passthrough, and deprecated comparison/conjunction composites. `If`, `Weighted Select`, `Signal Latch`, `Signal Default`, `Log Signal`, `Ignore`, and `Passthrough` infer a type variable `T` from connections instead of a type selector. Deprecated `EqualityBlock` `eq`/`neq` accept any concrete type; ordered operators accept only `float64`/`int32`.
- `math`: integer constant plus atomic arithmetic, clamp/lerp/smoothstep/deadband, and trig blocks. Domain errors (divide/modulo by zero, invalid roots/logs, non-finite results, equal inverse-lerp bounds) return `0`. Bounds are reordered so `min`/`max` may arrive swapped.
- `logic`: boolean constant plus Not/And/Or/Xor, Equal/NotEqual, ordered compares, Nearly Equal, and Is Finite. `And`/`Or` always short-circuit at runtime. `Equal`/`NotEqual` compare structurally and accept any concrete `T`. Ordered compares accept only `float64`/`int32`. `IsFiniteBlock` uses raw `Number.isFinite` and does not run values through `finiteFloat()`.
- `geometry` and `control`: reserved searchable categories for later standard-library blocks.
- `program`: program input/output units. Program I/O may expose `unit` and `actor_command`.
- `signals`: read/write and inspect signal-store values. Write Signal exposes identity `value` plus `then`.
- `topics`: topic snapshots, fields, staged publish messages, metadata, and stale gates. Stage Publish exposes `path` plus `then`.
- `simulator`: vehicle, device, simulation, scenario, and object snapshots.
- `mission`: waypoint, mission state, route progress, scenario flag helpers, and actor-command Make/Split. Set Mission State, Scenario Flag Write, and Advance Waypoint expose `then`. Make Actor Command builds `{ actorId, speedMps, steeringRad }` from required `speed`/`steering` and optional `actorId`. Split Actor Command unpacks that value. Route-controller speed/steering mappings remain `float64`.
- `bindings`: signal/tick/timer triggers and input/output/trigger bindings.
- `diagnostics`: probes, logs, assertions, recording/replay, and binding status. Log, Assert, and Record expose `then`.

## Compileable And Legacy Blocks

Every placeable catalog entry has a backend block class and can compile into a v3 artifact. Frozen v2 artifacts remain runnable.

`CalculationBlock`, `EqualityBlock`, and `ConjugationBlock` remain registered and renderable for old graphs and artifacts, but are deprecated and non-placeable. Atomic replacements live in `math` (`AddBlock`, `SubtractBlock`, …) and `logic` (`EqualBlock`, `AndBlock`, …). `OutputNodeBlock` is also non-placeable because the graph head owns it. `ScaleBlock` and `MultiplyTexBlock` are React-free runtime blocks; neither performs DOM or canvas work.

## Atomic Scalar And Logic Blocks

React-free classes live in `app/scripting/units/math/ScalarBlocks.block.js` and `app/scripting/units/statements/LogicBlocks.block.js`. React siblings import the same `SCALAR_BLOCK_PORTS` / `LOGIC_BLOCK_PORTS` descriptors. Shared numeric helpers are `finiteFloat()`, `finiteInt32()`, `finiteResult()`, and `orderedBounds()` in `PortTypes.js`, plus `scalarMath.js` for domain-safe ops. Structural comparison is `valuesEqual()`.

Constant blocks (`IntegerBlock`, `BooleanBlock`, `JsonBlock`) read `storedData` and always emit their declared `out` type. `0`, `false`, `null`, and `{}` are legal stored values. `JsonBlock` clones JSON and emits `null` for invalid strings.

Port labels are atomic (`a`/`b`/`value`/`out`). Legacy composites keep `input A` / `result` / `bool a`.

## Conversion, String, JSON, And Array Blocks

React-free classes live in `Conversions.block.js`, `StringBlocks.block.js`, `JsonBlocks.block.js`, and `ArrayBlocks.block.js`. React siblings import the same `*_BLOCK_PORTS` descriptors (or port helpers that take `itemType`/`valueType`). Shared helpers are `ARRAY_ITEM_TYPES` / `asArray()` in `valueOps.js`, `conversionMath.js`, `stringOps.js`, and `arrayOps.js`. JSON path blocks clone with `cloneValue()` and never mutate `getInput()` documents.

`itemType` and `valueType` are editor state, not inference. Changing them goes through `reconfigureUnitDetailed()` so conflicting wires are rejected without dropping connections.

## ROS Blocks

`app/scripting/units/ROSUnit.js` still contains placeholder ROS input/output blocks, and those block classes are registered. They are not currently exposed in `UnitCatalog.js`. Topic-oriented scripting work now appears in the `topics` category through signal blocks.

## Program Blocks

`app/scripting/units/program/ProgramIO.js` provides:

- `OutputNode`: default canvas output node controlled by the right sidebar (and `graph.outputNodeConfig` for MCP).
- `Program Input`: exposes external inputs to compiled programs.
- Compiled program wrapper helpers for importing artifacts as reusable blocks.

Program block behavior is central to compiled artifact interfaces, so update tests when changing it.
