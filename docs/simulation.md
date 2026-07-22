# Simulation

The simulation workspace is the Three.js mode where vehicles, sensors, and physics run. Open it from the app menu (`Escape` → **Simulation**).

For authoring static world content — roads, buildings, props, geographic imports — use the [Environment Editor](environment-editor.md) instead.

## Startup Flow

```mermaid
flowchart LR
  totalScene[TotalScene] --> threeObjects[Scene Camera Renderer]
  totalScene --> dataObject[Data]
  dataObject --> simEngine[SimulationEngine]
  totalScene --> envLoader[EnvironmentLoader]
  envLoader --> selectedEnvironment[Selected Environment]
  totalScene --> setupVehicles[setupVehicles]
  simEngine --> frameLoop[Animation Frame Loop]
  frameLoop --> registries[Vehicles Devices Rendering]
```

`TotalScene` creates a `Data` object, assigns the key/mouse managers and Three.js references, configures `SimulationEngine`, and asks `EnvironmentLoader` to load the shared active environment. The IGVC environment uses `setupIGVC` as its native bootstrap; blank and duplicated environments use their own manifest/template metadata.

The active setup path depends on `mode` (`app/3d/viewState.js`):

- `THREE_D_MODES.SIMULATION` — enables vehicles, sensors, physics, and playback.
- `THREE_D_MODES.ENVIRONMENT` — pauses runtime modules and enables authoring tools, Earth Import, and baking.

Changing between these modes no longer reloads the world: both use the same selected environment and road/intersection meshes. Changing the environment itself performs a clean world reload and resets simulation runtime state.

## Data Registries

`app/3d/data/Data.js` centralizes shared runtime systems:

- `devices()` for sensors.
- `objects()` for scene objects.
- `vehicles()` for cars and moving agents.
- `city()` for roads and intersections.
- `physics()` for physics integration.
- `simulation()` for the simulation engine.
- `client()` for orchestrator topic integration.
- `environment()` for the selected environment container (shared by both 3D modes).
- `earthTilesManager()` / `earthImportController()` for Earth Import (environment mode only).

## Simulation Engine

`app/simulation/SimulationEngine.js` handles:

- `play`, `pause`, `stop`, and manual `step`.
- Fixed time step simulation with an accumulator.
- Real-time vs deterministic progression.
- Speed scaling.
- Module toggles for physics, vehicles, sensors, controls, rendering, environment, and scripting.
- Per-frame `earthTilesManager.update()` while Google 3D Tiles are loaded in environment mode.

The bottom simulation menu in `app/3d/overlay/SimulationMenu.js` exposes some of these controls.

## Vehicles And Sensors

Vehicles live under `app/3d/vehicles/`. Sensors live under `app/3d/devices/`. New runtime behavior usually belongs in a vehicle/device class and then gets registered through the appropriate `Data` registry during scene setup.

Current orchestrator control input is handled in `app/3d/Scene.js`: updates on `/ackdrive` are read as `sensor_fusion_msgs/AckermannDrive`, then converted from mph/degrees to m/s/radians before being applied to the main car.

## Scenario Assets

CommonRoad scenarios should be placed under `public/scenarios/` locally. They are loaded through `TrafficScenario.load(...)` with browser paths such as `/scenarios/recorded/NGSIM/Peachtree/USA_Peach-1_1_T-1.xml`.

Downloaded scenario folders should stay out of git.

## Environment vs Simulation

Both workspaces share `app/3d/Scene.js` and the `Data` object, but they initialize different runtime paths:

| | Simulation | Environment Editor |
|---|------------|-------------------|
| Entry | `Escape` → Simulation | `Escape` → Environment Editor |
| Vehicles/sensors | Enabled (IGVC setup) | Disabled |
| Primary UI | `SimulationChrome` | `EnvironmentEditorChrome` |
| Authoring | Not the focus | `EnvironmentDocument`, map tools, earth import |

See [Environment Editor](environment-editor.md) for editor modes, baking, and the document model.
