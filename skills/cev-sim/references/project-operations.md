# Project operations

How to run and operate cev-sim as a human or agent without duplicating full docs.

## Install and start

Requirements: **Node.js 20+** (CI uses 22), npm. Optional: Python 3.9+ for bake /
orchestrator; ROS 2 for the external bridge; `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
in `.env.local` for Earth Import.

```bash
npm install
npm run dev          # Express + Next; storage + MCP
npm run build && npm run start
```

- App: `http://localhost:${PORT:-3000}`
- Storage: `/api/storage`
- Logs: `/api/logs`
- MCP: `/mcp`
- Live sync SSE: `GET /api/storage/events`

Env vars:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `CEV_SIM_DATA_DIR` | `server/data` | JSON persistence |
| `CEV_SIM_LOGS_DIR` | `server/data/logs` | SFLog files |
| `CEV_SIM_NEXT_DIR` | `.next` | Next build dir |

Installer one-liner (upstream name **ev-sim**): see root `README.md` /
`install.sh`. Product name in code remains **cev-sim**.

## Workspaces (Escape menu)

Defined in `app/3d/viewState.js`; shell in `app/page.js`.

| Label | Mode / view | Primary code |
|-------|-------------|--------------|
| Simulation | 3D simulation | `app/3d/Scene.js`, `app/simulation/SimulationEngine.js` |
| Environment Editor | 3D environment | `app/3d/editor/`, `app/3d/environment/` |
| Vehicle Editor | vehicle-editor | `app/vehicles/editor/VehicleStudio.js` |
| Run Configuration | config | `app/config/ConfigPage.js` |
| Scenarios | scenarios | `app/scenarios/ui/ScenarioWorkspace.js` |
| Experiment Suite | experiments | `app/experiments/ui/ExperimentWorkspace.js` |
| Scripting Canvas | scripting | `app/scripting/Scripting.js` |
| Bindings | bindings | `app/scripting/bindings/BindingsPage.js` |
| Replay | replay | `app/replay/ReplayPage.js` |
| Analysis | analysis | `app/analysis/AnalysisPage.js` |

Default load: Simulation with environment **`igvc`**.

## Operator workflows

### World authoring

1. Environment Editor → scene / map / earth-import modes.
2. Edits persist via `EnvironmentPersistence` (debounced PUT) under
   `server/data/environments/<id>.json`.
3. Optional bake: key `b` when harness is configured; Python backend typically
   `cd baking && python baking.py` (HTTP `http://localhost:8000`). Persistent
   photoreal baking is specified in
   [docs/visual-layer-plan.md](../../../docs/visual-layer-plan.md).

### Vehicles

Vehicle Editor → `cev-sim.vehicle` docs + GLB/GLTF under `vehicle-assets/`.
See `docs/vehicle-manifests.md`.

### Scripting and bindings

1. Scripting Canvas: graph → compile to `cev-sim.visual-script.program` v2.
2. Bindings workspace: attach triggers (topic, fixed-update, signal-update,
   timer) and I/O mappings. Manifest: `server/data/bindings.json`.
3. Compile APIs: `/api/scripting/compile`, `/api/scripting/units`.

Docs: `docs/scripting/README.md`, `docs/script-bindings.md`.

### Deterministic runs

Config workspace → validate → resolve → launch. Session ownership:
`RunSessionController`. Schema: `app/simulation/RunManifest.js`.

### Scenarios and experiments

- Scenarios: actors, routes (A* verify), zones, completion, outcomes.
  Schema: `app/scenarios/ScenarioDocument.js`. No dedicated user doc page —
  UI + MCP + tests are authority.
- Experiments: suite matrix → browser sequential execution → results /
  baselines / compare. Schema: `app/experiments/ExperimentSuite.js`.

### Telemetry

Record in Simulation → SFLog on disk → Replay / Analysis. Codec:
`app/logging/SFLogCodec.js`. Doc: `docs/telemetry-logging.md`.

## Storage layout (`CEV_SIM_DATA_DIR`)

- `environments/<id>.json`
- `scripts/<id>.json`
- `run-manifests/<id>.json`
- `scenarios/<id>.json`, `scenario-catalog.json`
- `experiment-suites/`, `experiment-results/`, `experiment-baselines/`
- `vehicles/<id>.json`, `vehicle-assets/<id>/`
- `bindings.json`, `settings.json`
- Logs: `CEV_SIM_LOGS_DIR` (default `logs/`)

`server/data/` is gitignored.

## External services

| Service | Role | Notes |
|---------|------|-------|
| Orchestrator (`cornellev/orchestrator`) | ROS-style topics over WS | Default `ws://localhost:8080` |
| Bake Python server | Environment visualization bake | Default `http://localhost:8000` |
| CommonRoad XML | Traffic scenarios | Place under `public/scenarios/` |
| Google Maps key | Earth Import 3D tiles | `.env.local` |

Client: `app/client/Client.js`. ROS overview: `docs/ros-integration.md`.

## UI conventions

See `docs/ui-system.md`. Prefer Escape menu for mode switches; keep one
authoritative Simulation tab when using MCP launch/recording/experiment
commands (same-origin tabs elect a single executor).
