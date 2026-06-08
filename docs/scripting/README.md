# Visual Scripting

The scripting system is a node editor plus a compile/run runtime. It lets users wire visual units together, execute them in the editor, export a versioned JSON artifact, run the artifact, and import compiled programs as reusable units.

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
- `app/scripting/AddMenu.js`: visual add menu categories and React unit creation.
- `app/scripting/BlockRegistry.js`: block type registry.
- `app/scripting/registerBuiltInBlocks.js`: built-in block registration.
- `app/scripting/runtime/Compiler.js`: v2 artifact compiler.
- `app/scripting/runtime/Runner.js`: v2 artifact runner.
- `app/scripting/units/`: built-in unit UI and block classes.
