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
- `conversions`: numeric conversions.
- `objects`: string.
- `statements`: if, comparisons, conjunctions, nop, ignore, sequence, passthrough. `If`, `Equality`, `Weighted Select`, `Signal Latch`, `Signal Default`, `Log Signal`, `Ignore`, and `Passthrough` infer a type variable `T` from connections instead of a type selector. Equality `eq`/`neq` accept any concrete type; ordered operators accept only `float64`/`int32`.
- `program`: program input/output units. Program I/O may expose `unit` and `actor_command`.
- `signals`: read/write and inspect signal-store values. Write Signal exposes identity `value` plus `then`.
- `topics`: topic snapshots, fields, staged publish messages, metadata, and stale gates. Stage Publish exposes `path` plus `then`.
- `simulator`: vehicle, device, simulation, scenario, and object snapshots.
- `mission`: waypoint, mission state, route progress, scenario flag helpers, and actor-command Make/Split. Set Mission State, Scenario Flag Write, and Advance Waypoint expose `then`. Make Actor Command builds `{ actorId, speedMps, steeringRad }` from required `speed`/`steering` and optional `actorId`. Split Actor Command unpacks that value. Route-controller speed/steering mappings remain `float64`.
- `bindings`: signal/tick/timer triggers and input/output/trigger bindings.
- `diagnostics`: probes, logs, assertions, recording/replay, and binding status. Log, Assert, and Record expose `then`.
- `math`, `logic`, `strings`, `collections`, `geometry`, and `control`: reserved searchable categories for the atomic standard-library blocks.

## Compileable And Legacy Blocks

Every placeable catalog entry has a backend block class and can compile into a v3 artifact. Frozen v2 artifacts remain runnable.

`CalculationBlock`, `EqualityBlock`, and `ConjugationBlock` remain registered and renderable for old graphs and artifacts, but are deprecated and non-placeable. `OutputNodeBlock` is also non-placeable because the graph head owns it. `ScaleBlock` and `MultiplyTexBlock` are React-free runtime blocks; neither performs DOM or canvas work.

## ROS Blocks

`app/scripting/units/ROSUnit.js` still contains placeholder ROS input/output blocks, and those block classes are registered. They are not currently exposed in `UnitCatalog.js`. Topic-oriented scripting work now appears in the `topics` category through signal blocks.

## Program Blocks

`app/scripting/units/program/ProgramIO.js` provides:

- `OutputNode`: default canvas output node controlled by the right sidebar (and `graph.outputNodeConfig` for MCP).
- `Program Input`: exposes external inputs to compiled programs.
- Compiled program wrapper helpers for importing artifacts as reusable blocks.

Program block behavior is central to compiled artifact interfaces, so update tests when changing it.
