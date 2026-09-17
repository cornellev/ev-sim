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

## Canvas Camera

The scripting canvas is an infinite world with a pan/zoom camera. Node `position` values stay in world CSS pixels. The editor camera is `{ x, y, scale }` on `.script-canvas-world` (`translate` then `scale`, origin `0 0`).

- Trackpad two-finger scroll and mouse wheel: zoom toward the cursor (pinch as Ctrl/Cmd+wheel does the same).
- Grab-drag pans: empty-canvas left-drag, middle-mouse drag, or Space+left-drag over nodes. Wheel/trackpad never pans.
- Bottom-right camera panel `−` / percent / `+` / `Fit`, plus Ctrl/Cmd `+` `-` `0`.

`graph.viewport` is saved with the editable editor document. It is not part of the compiled artifact and does not affect compile, `episodeHash`, or script lock hashes. Existing scripts without `viewport` open at identity (`x: 0, y: 0, scale: 1`).

## Read First

1. [Architecture](architecture.md): editor execution, compiled execution, and data flow.
2. [Authoring Units](authoring-units.md): how to create React units and `UnitBlock` behavior.
3. [Extension Guide](extension-guide.md): checklist for adding a block safely.
4. [Artifact Schema v3](artifact-schema-v3.md): compiled program format.
5. [Artifact Schema v2](artifact-schema-v2.md): historical v2 format; still runnable.
6. [Testing](testing.md): runtime test patterns.

## Key Files

- `app/scripting/Scripting.js`: canvas shell, output node sidebar, compile/run/import buttons.
- `app/scripting/canvas/CanvasViewport.js`: world/screen camera math for the scripting canvas.
- `app/scripting/canvas/ScriptCanvas.js`: pan/zoom host, world transform, and grid.
- `app/scripting/ScriptManager.js`: graph manager, `UnitBlock`, connections, compiled program wrapper.
- `app/scripting/LineManager.js`: visual wire creation and deletion.
- `app/scripting/UnitCatalog.meta.js`: authoritative server-safe block types, categories, keywords, settings, placeability, and backend classes.
- `app/scripting/UnitCatalog.js`: React components attached to catalog entries by stable type.
- `app/scripting/AddMenu.js`: searchable/categorized block library UI and spawn positioning.
- `app/scripting/ScriptRuntime.js`: load local or URL scripts and run compiled artifacts from code.
- `app/scripting/BlockRegistry.js`: block type registry.
- `app/scripting/types/PortTypes.js`: `generic` compatibility, `unit` singleton, `actor_command` normalization, and `portsCompatible()`.
- `app/scripting/types/TypeScheme.js`: per-block type variable schemes.
- `app/scripting/types/unifyGraph.js`: graph-wide unification (union-find).
- `app/scripting/registerBuiltInBlocks.js`: built-in block registration.
- `app/scripting/runtime/Compiler.js`: v3 artifact compiler (v2 artifacts remain runnable).
- `app/scripting/runtime/Runner.js`: v2 and v3 artifact runner.
- `app/scripting/units/`: built-in unit UI and block classes.
