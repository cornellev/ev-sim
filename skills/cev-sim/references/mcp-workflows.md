# MCP workflows

Authoritative narrative: [docs/mcp.md](../../../docs/mcp.md).
Implementation: [server/mcp/](../../../server/mcp/).

**Always discover live schemas** with `GetMcpTools` / tool descriptors before
`CallMcpTool`. This file lists domains, sequencing, and constraints — not Zod
field copies.

## Connect

| Item | Value |
|------|-------|
| Transport | Streamable HTTP |
| URL | `http://localhost:${PORT:-3000}/mcp` |
| Server name | `cev-sim` |
| Plugin config | root [`mcp.json`](../../../mcp.json) |
| Process | Same Express app as `npm run dev` / `npm start` |

No stdio MCP binary exists. Wrong transport or stopped server → discovery
failure (not authentication).

Live sync: MCP mutations publish events → `GET /api/storage/events` → browser
re-hydrates via `app/client/storageEvents.js`.

## Result shape

Helpers in `server/mcp/toolResult.js`:

- Success: `{ content: [{ type: "text", text: "<pretty JSON>" }] }`
- Failure: same + `isError: true`; JSON body usually `{ ok: false, error, ... }`

Parse `content[0].text` as JSON. Check both wrapper `isError` and body `ok`.

Scripting tools call `http://127.0.0.1:${PORT}/api/scripting/compile|units`
internally — Express must be listening.

## Resources (`fusion://`)

| URI | Domain |
|-----|--------|
| `fusion://run-manifests`, `…/{manifestId}` | Run manifests |
| `fusion://scenarios`, `…/{scenarioId}` | Scenarios |
| `fusion://scenario-folders` | Scenario folder catalog |
| `fusion://experiment-suites`, `…/{suiteId}` | Suites |
| `fusion://experiment-results`, `…/{resultId}` | Results |
| `fusion://experiment-baselines`, `…/{baselineId}` | Baselines |
| `fusion://logs`, `…/{logId}` | SFLog catalog / metadata |

No MCP prompts are registered.

## Tool domains (~93 tools)

Modules registered in `createMcpRouter.js`:

| Module | Prefix / focus |
|--------|----------------|
| `environmentTools.js` | `environment_*` — worlds, roads, buildings, props, validate |
| `scriptingTools.js` | `script_*`, `unit_*` — graph CRUD, lint/compile |
| `bindingTools.js` | `binding_*` — manifest, suggest, enable |
| `runManifestTools.js` | `run_manifest_*` — CRUD, validate, resolve, launch |
| `scenarioTools.js` | `scenario_*` — CRUD, routes, catalog |
| `experimentTools.js` | `experiment_*` — suites, results, baselines, run control |
| `loggingTools.js` | `log_*`, `recording_*`, `replay_*` |

Use `docs/mcp.md` tables for one-line purposes; use live schemas for args.

### Browser-required matrix

| Headless | Requires initialized Simulation tab |
|----------|-------------------------------------|
| Environment / script / binding CRUD + validate | `run_manifest_launch` |
| Scenario / suite / result / baseline CRUD + validate / resolve / compare | `experiment_run_start/pause/resume/cancel` |
| `log_*`, `replay_inspect`, `replay_series` | `recording_start/stop`, `replay_open/control` |
| `run_manifest_validate/resolve/export/import` | (launch only) |

Tools may return `browserRequiredForLaunch` / `browserRequiredForControl` and
`accepted: true` after publishing SSE. Without a tab, UI execution is a no-op.

Same-origin tabs elect one executor (`app/client/mcpCommandClaim.js`).

## Safe sequencing

```
environment_* → (validate)
script_* → script_lint
binding_suggest → binding_create
scenario_* → scenario_verify_route → scenario_validate
run_manifest_* → validate → resolve → launch [browser]
experiment_suite_* → validate → experiment_run_* [browser]
  → baseline / experiment_compare
recording_* [browser] → replay_inspect / replay_series [headless]
```

### Revision safety

For `run_manifest_update`, `scenario_update`, `scenario_catalog_update`,
`experiment_suite_update`, `experiment_result_update`, and similar: read current
document, pass `expectedRevision`. Stale revision → storage error → `fail()`.

### Scripting gotchas

- Default OutputNode uuid: **`head-uuid`**. Wire `to: "head-uuid"`.
- Configure outputs with `script_update_unit` on the head — never add
  `OutputNodeBlock` via `script_add_unit`.
- Artifact-only scripts cannot be edited as graphs.
- `script_lint` persists `latestValidArtifact` on success; bindings need it.

### Environment geometry

Mutating placement tools return `conflicts`. Pass `strict: true` to reject and
not persist when conflicts exist. Object types include `stop-sign`,
`one-way-sign`, `barrel`, `tire`, `cone`. Default active env: `igvc` (cannot
delete built-in).

### Routes

`scenario_verify_route` runs A* and does not save. Apply returned geometry via
`scenario_update` with the current revision.

## Failure recovery

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Discovery fails / tools unavailable | App not running, wrong PORT, stdio config | `npm run dev`; use URL transport |
| `isError` + not found | Bad id | `*_list` / resources first |
| Revision / conflict errors | Stale `expectedRevision` | Re-get, retry |
| Geometry conflicts | Overlaps / crossings | Inspect `conflicts`; use `strict` |
| Compile / binding interface errors | Unlinted or mismatched labels | `script_lint`, `unit_describe` |
| Launch/recording/run no UI effect | No Simulation tab | Open app, wait for scene ready |
| Scripting self-fetch fails | Compile routes down | Ensure same PORT Next/Express |

## Verification hooks

- Unit: `tests/mcp-tools.test.js` (registration + handler smoke; no HTTP MCP handshake).
- Manual: start server → Cursor connects to `cev-sim` → `environment_list`.
- SSE: mutate via MCP while watching `/api/storage/events`.
