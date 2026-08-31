# MCP Server

cev-sim exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint so AI agents can edit environments, visual scripts, simulation bindings, scenarios, deterministic run manifests, experiment suites, evidence, baselines, recordings, and replay sessions without driving the browser UI by hand.

## Connect

The MCP endpoint is mounted on the same Express process as the app:

```
http://localhost:3000/mcp
```

Server name: **`cev-sim`** (see `server/mcp/createMcpRouter.js`). Prefer this
id in client configs.

### Preferred: portable Agent Plugin

This repo ships as an Agent Plugin (`plugin.json`, root `mcp.json`,
`skills/cev-sim/`). Importing the plugin registers Streamable HTTP MCP at
`http://localhost:3000/mcp` and loads the auto-invoked **cev-sim** skill.

Import does **not** start Express. Always run `npm run dev` (or `npm start`)
before agents discover tools. See the root README for Git URL, `--plugin-dir`,
and local symlink/copy options.

### Manual fallback (`.cursor/mcp.json`)

If you are not using the plugin, configure Cursor locally:

```json
{
  "mcpServers": {
    "cev-sim": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Do not use ad-hoc aliases (for example a user-level `user-ev-sim` entry) unless
you intentionally maintain a separate client config — the registered MCP server
name and docs use **`cev-sim`**.

Start the app with `npm run dev` (or `npm start` after a build). The server logs the MCP URL on boot.

Live sessions stay in sync: MCP writes and workspace commands publish Server-Sent Events on `GET /api/storage/events`. The open browser re-hydrates environments, scripts, bindings, and log catalogs; it also executes Replay, recording, browser run-manifest, and browser experiment commands in the authoritative simulation tab. Headless experiment queues are owned by the Express process.

## Tool categories

### Environment

| Tool | Purpose |
|------|---------|
| `environment_list` | List worlds + active id |
| `environment_create` / `environment_rename` / `environment_delete` | Catalog CRUD |
| `environment_get` | Summary or full document |
| `environment_set_active` | Change the app's active environment |
| `environment_add_road` | Polyline of xz points → snapped nodes + edges |
| `environment_remove_road` / `environment_move_road_node` | Road edits |
| `environment_add_building` / `environment_remove_building` | Rectangle buildings |
| `environment_add_object` / `environment_move_object` / `environment_remove_object` | Props (`stop-sign`, `one-way-sign`, `barrel`, `tire`, `cone`) |
| `environment_validate` | Full geometric conflict report |

Mutating placement tools return a `conflicts` array (road crossings, corridor overlaps, building overlaps, object proximity). Pass `strict: true` to reject instead of keeping the edit.

### Scripting

| Tool | Purpose |
|------|---------|
| `script_list` / `script_create` / `script_rename` / `script_delete` / `script_get` | Document CRUD |
| `unit_catalog` / `unit_describe` | Discover unit types, ports, settings |
| `script_add_unit` / `script_update_unit` / `script_remove_unit` | Graph nodes |
| `script_connect` / `script_disconnect` | Typed wires |
| `script_lint` | Compile the graph; persists `latestValidArtifact` on success |

Compile / unit metadata run through Next API routes (`/api/scripting/compile`, `/api/scripting/units`) so the Express MCP process does not need to load React. Block classes live in React-free `*.block.js` modules (see `registerBuiltInBlocks.js` / `UnitCatalog.meta.js`); UI components stay in the sibling unit files.

### Binding

| Tool | Purpose |
|------|---------|
| `binding_list` / `binding_get` | Inspect the bindings manifest |
| `binding_create` / `binding_update` / `binding_delete` | Edit bindings |
| `binding_set_enabled` | Per-binding or master switch |
| `binding_suggest` | Propose trigger + I/O from a compiled script |

Triggers (`topic`, `fixed-update`, `signal-update`, `timer`) are the run modes. Input/output labels must match the script artifact's `interface`.

### Run manifests

| Tool | Purpose |
|------|---------|
| `run_manifest_list` / `run_manifest_get` | Discover and read versioned authoring manifests |
| `run_manifest_create` / `run_manifest_update` / `run_manifest_duplicate` / `run_manifest_delete` | Catalog CRUD with optimistic revisions |
| `run_manifest_validate` | Validate schema, deterministic constraints, and dependency hashes |
| `run_manifest_resolve` | Produce the immutable resolved run snapshot |
| `run_manifest_export` / `run_manifest_import` | Portable run-bundle round trips |
| `run_manifest_launch` | Validate and launch through the authoritative simulator tab |

The resources `fusion://run-manifests` and `fusion://run-manifests/{manifestId}` expose the catalog and complete saved manifests. MCP mutations publish live-sync events, so an open Config workspace refreshes without overwriting a dirty local draft. Launching requires an initialized simulator browser tab; validation, resolution, import, and export are fully headless.

### Scenarios

| Tool | Purpose |
|------|---------|
| `scenario_list` / `scenario_get` | Discover and read complete scenario documents |
| `scenario_create` / `scenario_update` / `scenario_duplicate` / `scenario_delete` | Scenario CRUD with optimistic revisions |
| `scenario_validate` | Validate actors, routes, zones, triggers, completion, outcomes, sensors, scripts, and parameters |
| `scenario_resolve` | Freeze environment, routes, scripts, vehicles, parameter values, and dependency hashes |
| `scenario_verify_route` | Run deterministic directed A* for an authored route without implicitly saving it |
| `scenario_catalog_get` / `scenario_catalog_update` | Read or replace the ordered folder catalog |

Resources expose the catalogs and complete documents at `fusion://scenarios`, `fusion://scenario-folders`, and `fusion://scenarios/{scenarioId}`. Route verification accepts an optional unsaved scenario draft; apply the returned canonical verification to the route and save it with `scenario_update` using the current revision.

### Experiment suites and evidence

| Tool | Purpose |
|------|---------|
| `experiment_suite_list` / `experiment_suite_get` | Discover and read suite documents |
| `experiment_suite_create` / `experiment_suite_update` / `experiment_suite_duplicate` / `experiment_suite_delete` | Suite CRUD with optimistic revisions |
| `experiment_suite_validate` | Validate and return expanded cases, exclusions, and incompatible matrix cells |
| `experiment_case_resolve` | Resolve one expanded case into its frozen deterministic run |
| `experiment_result_list` / `experiment_result_get` / `experiment_result_create` / `experiment_result_update` / `experiment_result_validate` / `experiment_result_delete` | Manage persisted queue evidence |
| `experiment_baseline_list` / `experiment_baseline_get` / `experiment_baseline_create` / `experiment_baseline_validate` / `experiment_baseline_delete` | Manage immutable named baselines |
| `experiment_compare` | Classify metric deltas, gated regressions, improvements, dependency changes, and unmatched cases |
| `experiment_run_status` | Inspect persisted queue progress |
| `experiment_run_start` | Start sequential browser execution by default, or server-owned execution with `execution: "headless"` |
| `experiment_run_pause` / `experiment_run_resume` | Control browser-owned queues only |
| `experiment_run_cancel` | Route cancellation to the persisted browser or headless owner |

Resources expose suites, results, and baselines through `fusion://experiment-suites`, `fusion://experiment-results`, and `fusion://experiment-baselines`, plus the corresponding `/{id}` document URIs. `experiment_result_get` also returns its result URI and the `fusion://logs/{logId}` links retained by its cases.

Browser execution remains the default and uses same-origin executor election.
Headless start first validates the suite revision and complete deterministic
expansion, resolves every case, and rejects the request without creating a
result if any case uses candidate control, external ROS, camera/unknown
sensors, unavailable LiDAR geometry, or lacks a finite semantic bound. Managed
LiDAR cases use the locked deterministic CPU/BVH backend and include it in
episode identity and provenance. The Express process admits one
headless queue globally and runs cases sequentially in isolated workers.
Status and cancellation use the result's persisted `execution.backend`;
headless queues cannot pause or resume. Headless results retain run,
simulation-semantic, episode, and trajectory hashes plus artifacts and import
warnings. Baselines preserve the hashes but do not depend on retained files.

The PR 12 npm/Python candidate artifacts do not start Express or add a second
MCP server. MCP remains part of the full browser application at `/mcp`, and
`release:check` only enforces that its advertised `cev-sim` version matches
the CLI/worker, plugin, and Python adapter. Installing a headless artifact
therefore exposes the CLI/supervisor or Python client, not MCP authoring and
storage tools. See [Headless release and CI gates](headless-release.md).

### Logging and replay

| Tool | Purpose |
|------|---------|
| `log_list` / `log_get` | Discover logs, metadata, checkpoints, and typed signal schemas |
| `log_update` / `log_delete` | Edit catalog names/tags or delete a log |
| `recording_status` | Inspect active backend recording sessions |
| `recording_start` / `recording_stop` | Control the authoritative open simulator tab |
| `replay_open` / `replay_control` | Open, seek, play, pause, loop, and set Replay speed |
| `replay_inspect` | Read exact state and nearby events at a timestamp, with optional path globs |
| `replay_series` | Read a bounded, downsampled signal or nested-field series |

The resources `fusion://logs` and `fusion://logs/{logId}` expose the catalog and per-log metadata/signal catalog. Headless inspection tools read directly from the backend and do not require a browser. Recording and visual Replay controls require one initialized simulator browser tab; same-origin tabs elect exactly one command executor. See [SFLog](sflog.md) for the file format and recording pipeline.

## Typical agent workflow

1. `environment_create` / `environment_add_road` / `environment_add_building` / `environment_add_object` — author a world, inspect `conflicts`.
2. `script_create` → `unit_catalog` → `script_add_unit` → `script_connect` (wire into head `OutputNode` at `head-uuid`) → `script_lint`.
   Configure output ports with `script_update_unit` on the head uuid (`storedData`/`state`: `{ outputs: [{ id, label, type }] }`). Do not add `OutputNodeBlock` via `script_add_unit`.
3. `binding_suggest` → `binding_create` with the compiled `scriptId`.
4. `scenario_create` / `scenario_update` → `scenario_verify_route` → `scenario_validate` for reusable scenario behavior.
5. `run_manifest_create` or `run_manifest_update` → `run_manifest_validate` → `run_manifest_launch` to start one exact deterministic configuration.
6. `experiment_suite_create` → `experiment_suite_validate` → `experiment_run_start` (omit `execution` for browser, or select `headless`) → `experiment_run_status` → `experiment_result_get` → `experiment_baseline_create` / `experiment_compare` for regression evidence.
7. `recording_start` → run the simulation → `recording_stop`, then use `replay_inspect`, `replay_series`, or `replay_open`.

## Implementation map

- Express mount: [`server/App.js`](../server/App.js) → `/mcp`
- Tools: [`server/mcp/`](../server/mcp/)
- Scenario tools: [`server/mcp/scenarioTools.js`](../server/mcp/scenarioTools.js)
- Experiment tools: [`server/mcp/experimentTools.js`](../server/mcp/experimentTools.js)
- Browser experiment command bridge: [`app/experiments/McpExperimentBridge.js`](../app/experiments/McpExperimentBridge.js)
- Geometry feedback: [`app/3d/editor/document/documentGeometry.js`](../app/3d/editor/document/documentGeometry.js)
- Compile / units API: [`app/api/scripting/`](../app/api/scripting/)
- Live sync client: [`app/client/storageEvents.js`](../app/client/storageEvents.js)
