# Documentation

This folder is the contributor guide for sensor-fusion. Start here when you need to run the app, understand the major systems, add a visual scripting block, or connect the simulator to the external orchestrator/ROS bridge.

## Reading Paths

- New contributors: [Getting Started](getting-started.md), then [Development](development.md).
- Architecture work: [Architecture](architecture.md), [Simulation](simulation.md), and [ROS Integration](ros-integration.md).
- Environment authoring: [Environment Editor](environment-editor.md), then [Earth Import](earth-import.md) for geographic imports.
- Visual scripting work: [Scripting Overview](scripting/README.md), then [Scripting Architecture](scripting/architecture.md) and [Extension Guide](scripting/extension-guide.md).
- IGVC/domain work: [IGVC Overview](igvc/overview.md) and [Competition Rules](igvc/competition-rules.md).
- Asset setup: [Assets](assets.md).
- Broken local setup: [Troubleshooting](troubleshooting.md).

## Project Map

- `app/page.js` selects between the visual scripting canvas and the 3D scene (simulation or environment editor).
- `app/scripting/` contains the node editor, block registry, compiler, runner, and built-in units.
- `app/3d/` contains Three.js scenes, vehicles, devices, overlays, and IGVC scenarios.
- `app/3d/editor/` and `app/3d/environment/` contain the environment editor document model, tools, and baking.
- `app/3d/earth/` contains Earth Import (tiles, roads, geospatial transforms).
- `app/simulation/SimulationEngine.js` owns the simulation loop and module toggles.
- `app/client/Client.js` implements the orchestrator WebSocket protocol used for ROS-style topics.
- `server/App.js` runs the production Next app behind Express.
- `public/` stores browser-served assets and fallback message definitions.
- `tests/` contains Node test-runner tests for scripting, editor, bake, and earth-import behavior.
