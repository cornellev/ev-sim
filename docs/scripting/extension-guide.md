# Extension Guide

Use this checklist when adding a new visual scripting block.

## Add A Compileable Block

1. Create or update a unit file under `app/scripting/units/`.
2. Export a React unit component that renders `Unit`.
3. Export a `UnitBlock` subclass.
4. Make React port labels/types match `registerInput` and `registerOutput`.
5. Implement `valid()` and `execute()`.
6. Add the block class to `app/scripting/registerBuiltInBlocks.js`.
7. Add a menu entry to `app/scripting/AddMenu.js` with a non-null `class`.
8. Add or update tests in `tests/visual-script-runtime.test.js` if compile/run behavior changes.
9. Run `npm test` and `npm run lint`.

## Add A UI-Only Block

Use `class: null` in `AddMenu.js` only when the unit is intentionally visual-only. UI-only blocks cannot compile or run as part of a v2 artifact.

Existing examples include the `Scale Matrix (tex1d)` and `LiDAR 2D` add menu entries.

## Add Program Inputs Or Outputs

Program-level ports are implemented by blocks with:

```javascript
static programNodeRole = "input";
```

or:

```javascript
static programNodeRole = "output";
```

They also implement `getProgramPortDefinition()`. See `app/scripting/units/program/ProgramIO.js`.

Program labels must be unique per role. Duplicate labels fail compilation.

## Add A New Type

The scripting type system is string-based. To add a new type:

1. Use the type string consistently in React unit ports and backend `registerInput` / `registerOutput`.
2. Add a color to `app/scripting/Constants.js` if the type should have a distinct wire color.
3. Update `SUPPORTED_TYPES` in `ProgramIO.js` if users should be allowed to expose it as a program input/output.
4. Add parsing or runtime handling wherever the new type is created or consumed.

## Add Runtime State

For blocks that need state across compiled runs:

- Store editable configuration in `serializeState()`.
- Store changing runtime values in `serializeRuntimeState()`.
- Restore changing runtime values in `hydrateRuntimeState()`.

`app/scripting/units/math/SensorFlow.js` contains useful examples.

## Common Mistakes

- Adding a block to the menu but not registering it for compile/run.
- Registering a block but forgetting to expose it in the menu.
- Changing a port label in the React component but not in the `UnitBlock`.
- Returning raw values from `execute()` instead of a `BlockOutput`.
- Using duplicate program input/output labels.
