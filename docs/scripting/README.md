# Visual Scripting

The scripting system is a node editor plus a compile/run runtime. It lets users wire visual units together, execute them in the editor, export a versioned JSON artifact, run the artifact, and import compiled programs as reusable units.

## Load And Run From Code

Use `loadScript` when application code needs to load a compiled artifact or a locally saved editor document and execute it without opening the visual editor:

```javascript
import { loadScript } from "@/app/scripting/ScriptRuntime";

const script = await loadScript("/scripts/add-two.json");
const outputs = script.run({ input: 21 });
```

`loadScript("local:<script-id>")` loads from the browser-local script library. `script.run(...)` accepts either a named input object or positional inputs in the order exposed by the compiled script interface.

## Read First

1. [Architecture](architecture.md): editor execution, compiled execution, and data flow.
2. [Authoring Units](authoring-units.md): how to create React units and `UnitBlock` behavior.
3. [Extension Guide](extension-guide.md): checklist for adding a block safely.
4. [Artifact Schema v2](artifact-schema-v2.md): compiled program format.
5. [Testing](testing.md): runtime test patterns.

## Key Files

- `app/scripting/Scripting.js`: canvas shell, output node sidebar, compile/run/import buttons.
- `app/scripting/ScriptManager.js`: graph manager, `UnitBlock`, connections, compiled program wrapper.
- `app/scripting/LineManager.js`: visual wire creation and deletion.
- `app/scripting/UnitCatalog.js`: block library inventory, categories, React components, and backend block classes.
- `app/scripting/AddMenu.js`: searchable/categorized block library UI and spawn positioning.
- `app/scripting/ScriptRuntime.js`: load local or URL scripts and run compiled artifacts from code.
- `app/scripting/BlockRegistry.js`: block type registry.
- `app/scripting/registerBuiltInBlocks.js`: built-in block registration.
- `app/scripting/runtime/Compiler.js`: v2 artifact compiler.
- `app/scripting/runtime/Runner.js`: v2 artifact runner.
- `app/scripting/units/`: built-in unit UI and block classes.
