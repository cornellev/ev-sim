# Extension Guide

Use this checklist when adding a new visual scripting block.

## Add A Compileable Block

1. Create or update a unit file under `app/scripting/units/`.
2. Export a React unit component that renders `Unit`.
3. Export a `UnitBlock` subclass.
4. Make React port labels/types match `registerInput` and `registerOutput`.
5. Implement `valid()` and `execute()`.
6. Add the block class to `app/scripting/registerBuiltInBlocks.js`.
7. Add a catalog entry to `app/scripting/UnitCatalog.js` with a non-null `blockClass`.
8. Add or update tests in `tests/visual-script-runtime.test.js` if compile/run behavior changes.
9. Run `npm test` and `npm run lint`.

`AddMenu.js` renders the block library from `UnitCatalog.js`. Only edit `AddMenu.js` when changing the menu UI, search/filter behavior, spawn positioning, or category presentation.

## Add A UI-Only Block

Use `blockClass: null` in `UnitCatalog.js` only when the unit is intentionally visual-only. UI-only blocks can appear in the block library but cannot compile or run as part of a v2 artifact.

The current example is `Scale Matrix (tex1d)`.

## Add Or Rename A Category

Catalog entries have a category string. `AddMenu.js` can display unknown categories with fallback labels and icons, but add the category to `CATEGORY_META` when it needs a deliberate label, icon, or accent color.

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

For Program Input, keep the backend port id stable and expose the editable name separately. The built-in Program Input registers the internal output port as `input`, while its user-facing external label defaults to `input`, `input_2`, `input_3`, and so on. `getProgramPortDefinition()` exports that external label for compiled program inputs.

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
- Editing `AddMenu.js` directly for block inventory instead of updating `UnitCatalog.js`.
- Changing a port label in the React component but not in the `UnitBlock`.
- Returning raw values from `execute()` instead of a `BlockOutput`.
- Using duplicate program input/output labels.
