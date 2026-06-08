# Built-In Blocks

Built-in block registration lives in `app/scripting/registerBuiltInBlocks.js`. User-facing menu categories live in `app/scripting/AddMenu.js`.

## Menu Categories

Current add menu categories:

- `expressions`: number, calculation, random number.
- `constants`: pi, e, tau, golden ratio.
- `vector2`: texture operations.
- `terrain`: terrain texture generation and processing.
- `sensorflow`: filters, gates, sensor fusion helpers.
- `randomization`: random ranges, seeded random, noise, jitter, weighted select, remap.
- `conversions`: numeric conversions.
- `objects`: string.
- `statements`: if, comparisons, conjunctions.
- `devices`: device-related units.
- `ros`: placeholder ROS input/output units.
- `program`: program input/output units.

## Compileable Vs UI-Only

Most menu entries have a backend block class and can compile. Entries with `class: null` are UI-only.

Known UI-only entries:

- `Scale Matrix (tex1d)`
- `LiDAR 2D`

If a UI-only entry becomes runtime behavior, add a `UnitBlock` subclass and register it in `registerBuiltInBlocks.js`.

## ROS Blocks

`app/scripting/units/ROSUnit.js` currently returns placeholder random/logged values. It does not yet connect to the external orchestrator client. Treat these blocks as prototypes until they are wired to `app/client/Client.js` or a scripting-specific integration layer.

## Program Blocks

`app/scripting/units/program/ProgramIO.js` provides:

- `OutputNode`: default canvas output node controlled by the right sidebar.
- `Program Input`: exposes external inputs to compiled programs.
- `Program Output`: exposes named outputs from compiled programs.
- Compiled program wrapper helpers for importing artifacts as reusable blocks.

Program block behavior is central to compiled artifact interfaces, so update tests when changing it.
