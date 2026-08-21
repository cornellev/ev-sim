---
name: cev-sim
description: >-
  Operates the cev-sim (ev-sim / sensor-fusion) autonomous-driving simulator
  through project workflows and its Streamable HTTP MCP endpoint: environments,
  visual scripts, bindings, scenarios, run manifests, experiment suites,
  recording, and replay. Use when working in this repo on MCP, simulation
  authoring, deterministic runs, SFLog telemetry, workspaces, or agent-driven
  setup without driving the browser UI by hand.
---

# cev-sim

Teach agents how to **use** this project and its MCP server comprehensively.
Canonical product/MCP name is **cev-sim**. Installer/docs may say **ev-sim**;
the local folder may be **sensor-fusion**. Prefer `cev-sim` in tool configs and
document kinds.

## Preflight

1. From the repo root: `npm install` (once), then `npm run dev`.
2. App: `http://localhost:3000` (or `$PORT`). MCP: `http://localhost:3000/mcp`.
3. This plugin's root [`mcp.json`](../../mcp.json) registers server id **`cev-sim`**
   as Streamable HTTP. Importing the plugin does **not** start Express — the
   process must already be listening.
4. Before any MCP call: discover live tools/schemas with `GetMcpTools` for
   server `cev-sim`. Never rely on frozen argument lists from this skill.
5. If MCP discovery fails: treat as **server not running / wrong port / wrong
   transport**, not auth. Fix with `npm run dev` and URL `http://localhost:3000/mcp`.

Manual fallback config (if not using the plugin): see [docs/mcp.md](../../docs/mcp.md).

## Quick operator path

```bash
npm install
npm run dev
# open http://localhost:3000 — Escape opens the workspace menu
```

Default workspace is 3D Simulation (built-in env `igvc`). Desktop-only UI
(widths &lt;768px are blocked).

| Workspace | Purpose |
|-----------|---------|
| Simulation | Live 3D sim loop |
| Environment Editor | Author worlds (roads, buildings, props); `b` may bake |
| Vehicle Editor | `cev-sim.vehicle` manifests + assets |
| Run Configuration | Deterministic run manifests |
| Scenarios | Reusable scenario docs / routes |
| Experiment Suite | Regression matrices + baselines |
| Scripting Canvas | Visual script graphs |
| Bindings | Wire compiled scripts to sim I/O |
| Replay / Analysis | SFLog inspection |

Detail: [references/project-operations.md](references/project-operations.md).

## Agent MCP protocol

1. Confirm Express is up (`npm run dev` or `npm start`).
2. `GetMcpTools` on `cev-sim` → then `CallMcpTool`.
3. Parse every tool result: `content[0].text` is JSON. Check MCP `isError` and
   body `ok` / `error`.
4. Prefer `*_list` / `fusion://…` resources before mutating.
5. After mutations, call the domain validator (`environment_validate`,
   `script_lint`, `scenario_validate`, `run_manifest_validate`,
   `experiment_suite_validate`).

### Typical end-to-end workflow

1. Environment: create → add roads/buildings/objects (`strict: true` when
   conflicts must block) → `environment_validate`.
2. Script: create → `unit_catalog` → add/connect units → wire into OutputNode
   at **`head-uuid`** → configure head outputs via `script_update_unit` →
   `script_lint`. Do **not** `script_add_unit` for `OutputNodeBlock`.
3. Bindings: `binding_suggest` → `binding_create` (needs compiled script).
4. Scenario: create/update → `scenario_verify_route` → `scenario_validate`.
5. Run: create/update → `run_manifest_validate` → `run_manifest_resolve` →
   `run_manifest_launch` (**needs Simulation tab**).
6. Experiments: suite validate → `experiment_run_start` (**browser**) →
   status → baseline / `experiment_compare`.
7. Logging: `recording_start` → sim → `recording_stop` → `replay_inspect` /
   `replay_series` (headless) or `replay_open` (browser).

Full sequencing, resources, failure modes:
[references/mcp-workflows.md](references/mcp-workflows.md).

## Non-negotiable constraints

- **Headless vs browser:** CRUD, validate, resolve, `replay_inspect` /
  `replay_series` are headless. `run_manifest_launch`, `recording_*`,
  `replay_open` / `replay_control`, `experiment_run_*` require **one**
  initialized Simulation tab; MCP may return `accepted` while UI does nothing
  if no tab is open.
- **Revisions:** Always `*_get` then pass current `expectedRevision` on updates.
- **Scripting:** Compile via `script_lint` before bindings or runs that need
  the artifact. Graph head uuid is `head-uuid`.
- **Geometry:** Placement tools return `conflicts`; use `strict: true` to reject.
- **No schema snapshots:** Tool Zod shapes live in `server/mcp/*Tools.js` and
  change with the code — discover at runtime.

Schemas, entry points, doc authority:
[references/architecture-and-schemas.md](references/architecture-and-schemas.md).

## Verification

```bash
npm run lint
npm test
node skills/cev-sim/scripts/validate.mjs
# focused: node --experimental-default-type=module --test tests/mcp-tools.test.js
```

MCP smoke: with server running, list tools then call `environment_list`.
UI (local, not CI): `npm run test:ui`.

See [references/verification.md](references/verification.md).

## When stuck

- [docs/troubleshooting.md](../../docs/troubleshooting.md)
- [docs/scripting/troubleshooting.md](../../docs/scripting/troubleshooting.md)
- [docs/mcp.md](../../docs/mcp.md) — tool categories and connect
- Implementation: [server/mcp/createMcpRouter.js](../../server/mcp/createMcpRouter.js)

## Maintenance

When adding MCP tools or document kinds: update references (category-level),
keep `SKILL.md` thin, re-run `skills/cev-sim/scripts/validate.mjs`. Do not
paste full Zod schemas into skill files.
