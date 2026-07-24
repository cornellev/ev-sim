# MCP Server

Sensor-fusion exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint so AI agents can edit environments, visual scripts, simulation bindings, recordings, and replay sessions without driving the browser UI by hand.

## Connect

The MCP endpoint is mounted on the same Express process as the app:

```
http://localhost:3000/mcp
```

Example Cursor MCP config (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sensor-fusion": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Start the app with `npm run dev` (or `npm start` after a build). The server logs the MCP URL on boot.

Live sessions stay in sync: MCP writes and workspace commands publish Server-Sent Events on `GET /api/storage/events`. The open browser re-hydrates environments, scripts, bindings, log catalogs, and Replay controls automatically.

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

The resources `fusion://logs` and `fusion://logs/{logId}` expose the catalog and per-log metadata/signal catalog. Headless inspection tools read directly from the backend and do not require a browser. Recording and visual Replay controls require one initialized simulator browser tab; same-origin tabs elect exactly one command executor.

## Typical agent workflow

1. `environment_create` / `environment_add_road` / `environment_add_building` / `environment_add_object` — author a world, inspect `conflicts`.
2. `script_create` → `unit_catalog` → `script_add_unit` → `script_connect` (wire into head `OutputNode` at `head-uuid`) → `script_lint`.
   Configure output ports with `script_update_unit` on the head uuid (`storedData`/`state`: `{ outputs: [{ id, label, type }] }`). Do not add `OutputNodeBlock` via `script_add_unit`.
3. `binding_suggest` → `binding_create` with the compiled `scriptId`.
4. `environment_set_active` if the browser should switch worlds.
5. `recording_start` → run the simulation → `recording_stop`, then use `replay_inspect`, `replay_series`, or `replay_open`.

## Implementation map

- Express mount: [`server/App.js`](../server/App.js) → `/mcp`
- Tools: [`server/mcp/`](../server/mcp/)
- Geometry feedback: [`app/3d/editor/document/documentGeometry.js`](../app/3d/editor/document/documentGeometry.js)
- Compile / units API: [`app/api/scripting/`](../app/api/scripting/)
- Live sync client: [`app/client/storageEvents.js`](../app/client/storageEvents.js)
