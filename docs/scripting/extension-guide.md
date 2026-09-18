# Extension Guide

Use this checklist when adding a new visual scripting block.

## Add A Compileable Block

1. Create or update a unit file under `app/scripting/units/`.
2. Export a React unit component that renders `Unit`.
3. Export a `UnitBlock` subclass.
4. Make React port labels/types match `registerInput` and `registerOutput`. Prefer a shared `*_BLOCK_PORTS` descriptor imported by both the React unit and `register()`, as in `ScalarBlocks.block.js` / `LogicBlocks.block.js`.
5. Implement `valid()` and `execute()`. For dual current/frozen ports, use `BlockOutput.setDeclared(this, label, value)` and guard `getInput()` with `hasInput()` (see `MultiplyTexBlock` `a`/`b` vs frozen `tex1d_a`/`tex1d_b`).
6. Add one explicit entry to `app/scripting/UnitCatalog.meta.js`, including stable `type`, keywords, settings, and the React-free `blockClass`.
7. Attach the React component to that type in `UnitCatalog.js`. Registration is derived from the metadata entry.
8. Add or update tests in `tests/visual-script-runtime.test.js` if compile/run behavior changes.
9. Run `npm test` and `npm run lint`.

`AddMenu.js` renders the block library from `UnitCatalog.js`. Only edit `AddMenu.js` when changing the menu UI, search/filter behavior, spawn positioning, or category presentation.

Every placeable block requires both a React component and a backend class. Use `placeable:false` only for compatibility types or graph-owned infrastructure such as `OutputNodeBlock`.

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

They also implement `getProgramPortDefinition()`. The built-in `OutputNode` (graph head) is the standard program output; see `app/scripting/units/program/ProgramIO.js`.

Program labels must be unique per role. Duplicate labels fail compilation.

For Program Input, keep the backend port id stable and expose the editable name separately. The built-in Program Input registers the internal output port as `input`, while its user-facing external label defaults to `input`, `input_2`, `input_3`, and so on. `getProgramPortDefinition()` exports that external label for compiled program inputs.

## Add A Polymorphic Type Scheme

Blocks that share one type across several ports declare:

```javascript
static typeScheme = {
    variables: {
        T: { inputs: ["true value", "false value"], outputs: ["out"] }
    }
};
```

Register those ports as `generic` from `app/scripting/types/PortTypes.js`. Optional `accept(type, unit)` rejects bindings the block cannot execute (Equality ordered operators only accept `float64` / `int32`). React units should render solved `portTypes` from the editor rather than a type selector.

Do not add `generic` to `SUPPORTED_TYPES`.

## Add A New Type

The scripting type system is string-based. To add a new type:

1. Use the type string consistently in React unit ports and backend `registerInput` / `registerOutput`.
2. Add a color to `app/scripting/Constants.js` if the type should have a distinct wire color.
3. Update `SUPPORTED_TYPES` in `ProgramTypes.js` if users should be allowed to expose it as a program input/output. Do not add `generic`. `unit` is a supported sequencing type. Structured value types follow the `actor_command` / `vec2` pattern: export a `*_TYPE` constant and `normalizeX()` from `PortTypes.js`, add a `Constants.TYPES` color, append the string to `SUPPORTED_TYPES`, and parse through `parseValueByType`. Opaque ids (`road_id`, `texture_id`) use `normalizeOpaqueId()` and must not JSON-parse. `vec2` / `vec3` / `pose2d` / `pose3d` are the frozen geometry examples (`{ x, y }`, `{ x, y, z }`, `{ position, yaw }`, `{ position, rotation: { x, y, z, order } }`).
4. Add parsing or runtime handling wherever the new type is created or consumed.

## Add Runtime State

For blocks that need state across compiled runs:

- Store editable configuration in `serializeState()`.
- Store changing runtime values in `serializeRuntimeState()`.
- Restore changing runtime values in `hydrateRuntimeState()`.

`app/scripting/units/math/SensorFlow.js` and `app/scripting/units/control/TemporalBlocks.block.js` contain useful examples.

## Common Mistakes

- Adding a component mapping without authoritative `UnitCatalog.meta.js` metadata.
- Deriving a stable type from a JavaScript class name instead of declaring it explicitly.
- Editing `AddMenu.js` directly for block inventory instead of updating catalog metadata.
- Changing a port label in the React component but not in the `UnitBlock`.
- Returning raw values from `execute()` instead of a `BlockOutput`.
- Calling `other.execute()` from `execute()` instead of `this.getInput(...)`. Fan-out is memoized per evaluation frame only when inputs go through `getInput`.
- Using duplicate program input/output labels.
