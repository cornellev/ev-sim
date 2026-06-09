# Built-In Blocks

Built-in block registration lives in `app/scripting/registerBuiltInBlocks.js`. User-facing block library inventory lives in `app/scripting/UnitCatalog.js`. `app/scripting/AddMenu.js` renders that catalog with category filters and search.

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
- `statements`: if, comparisons, conjunctions.
- `program`: program input/output units.
- `signals`: read/write and inspect signal-store values.
- `topics`: topic snapshots, fields, staged publish messages, metadata, and stale gates.
- `simulator`: vehicle, device, simulation, scenario, and object snapshots.
- `mission`: waypoint, mission state, route progress, and scenario flag helpers.
- `bindings`: signal/tick/timer triggers and input/output/trigger bindings.
- `diagnostics`: probes, logs, assertions, recording/replay, and binding status.

## Compileable Vs UI-Only

Most catalog entries have a backend block class and can compile. Entries with `blockClass: null` are UI-only.

Known UI-only entries:

- `Scale Matrix (tex1d)`

If a UI-only entry becomes runtime behavior, add a `UnitBlock` subclass and register it in `registerBuiltInBlocks.js`.

## ROS Blocks

`app/scripting/units/ROSUnit.js` still contains placeholder ROS input/output blocks, and those block classes are registered. They are not currently exposed in `UnitCatalog.js`. Topic-oriented scripting work now appears in the `topics` category through signal blocks.

## Program Blocks

`app/scripting/units/program/ProgramIO.js` provides:

- `OutputNode`: default canvas output node controlled by the right sidebar.
- `Program Input`: exposes external inputs to compiled programs.
- `Program Output`: exposes named outputs from compiled programs.
- Compiled program wrapper helpers for importing artifacts as reusable blocks.

Program block behavior is central to compiled artifact interfaces, so update tests when changing it.
