# Documentation

This folder is the contributor guide for cev-sim. Start here when you need to run the app, understand the major systems, add a visual scripting block, or connect the simulator to the external orchestrator/ROS bridge.

## Reading Paths

- New contributors: [Getting Started](getting-started.md), then [Development](development.md).
- Architecture work: [Architecture](architecture.md), [Simulation](simulation.md), and [ROS Integration](ros-integration.md).
- Telemetry work: [Telemetry, Logging, Replay, and Analysis](telemetry-logging.md).
- Environment authoring: [Environment Editor](environment-editor.md), then [Earth Import](earth-import.md) for geographic imports.
- Visual scripting work: [Scripting Overview](scripting/README.md), then [Scripting Architecture](scripting/architecture.md) and [Extension Guide](scripting/extension-guide.md).
- Running scripts on live data: [Script Bindings](script-bindings.md) (topics, fixed updates, signals, timers).
- Agent tooling: [MCP Server](mcp.md) — environment, scripting, binding, logging, and replay tools for AI agents.
- IGVC/domain work: [IGVC Overview](igvc/overview.md) and [Competition Rules](igvc/competition-rules.md).
- Asset setup: [Assets](assets.md).
- Broken local setup: [Troubleshooting](troubleshooting.md).

## Project Map

- `app/page.js` selects Simulation, Environment, Scripting, Bindings, Replay, and Analysis workspaces while preserving the live scene runtime.
- `app/telemetry/`, `app/logging/`, `app/replay/`, and `app/analysis/` contain the shared signal transport, SFLog client, and inspection workspaces.
- `app/scripting/` contains the node editor, block registry, compiler, runner, and built-in units.
- `app/scripting/bindings/` contains the bindings manifest, runtime dispatcher, and Bindings workspace UI.
- `app/3d/` contains Three.js scenes, vehicles, devices, overlays, and IGVC scenarios.
- `app/3d/editor/` and `app/3d/environment/` contain the environment editor document model, tools, and baking.
- `app/3d/earth/` contains Earth Import (tiles, roads, geospatial transforms).
- `app/simulation/SimulationEngine.js` owns the simulation loop and module toggles.
- `app/client/Client.js` implements the orchestrator WebSocket protocol used for ROS-style topics.
- `server/App.js` runs the Next app behind Express (both `dev` and `start`), hosts the storage API at `/api/storage`, and the MCP endpoint at `/mcp`.
- `server/mcp/` contains the MCP tool suites for environments, scripts, and bindings.
- `public/` stores browser-served assets and fallback message definitions.
- `tests/` contains Node test-runner tests for scripting, editor, bake, and earth-import behavior.
