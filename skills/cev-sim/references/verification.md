# Verification

## Skill / plugin self-check

```bash
node skills/cev-sim/scripts/validate.mjs
```

Checks: `plugin.json` / `mcp.json` shape, skill frontmatter, `SKILL.md` line
count &lt; 500, relative links resolve, no machine-specific absolute home paths
in skill files, and that every `server/mcp/*Tools.js` registration module is
mentioned in MCP references.

## Unit and lint (matches CI)

```bash
npm run lint
npm test
```

Focused MCP:

```bash
node --experimental-default-type=module --test tests/mcp-tools.test.js
```

### Area → test files

| Area | Tests |
|------|-------|
| MCP | `tests/mcp-tools.test.js` |
| Storage | `tests/storage-service.test.js`, `storage-api.test.js`, `storage-events.test.js` |
| Run manifests | `tests/run-manifest.test.js`, `run-session.test.js`, `simulation-deterministic.test.js` |
| Scenarios | `tests/scenario-document.test.js`, `scenario-routes.test.js`, `scenario-runtime.test.js` |
| Experiments | `tests/experiment-suite.test.js`, `experiment-runtime.test.js`, `experiment-scenario-hardening.test.js` |
| Scripting / bindings | `tests/visual-script-runtime.test.js`, `script-library.test.js`, `script-bindings.test.js` |
| Telemetry | `tests/telemetry-logging.test.js`, `analysis-performance.test.js` |
| Bake / editor | `tests/bake-*.test.js`, `editor-core.test.js`, `earth-import-mode.test.js` |
| Vehicles / sensors | `tests/vehicle-manifest.test.js`, `sensor-type-registry.test.js`, `sensor-contract.test.js` |

## UI / E2E (local, not CI)

```bash
npm run test:ui
npm run test:a11y
```

Playwright uses isolated data dirs and port **3100** (`playwright.config.mjs`).

## MCP connection smoke

1. `npm run dev` — boot log should print MCP URL.
2. Ensure Cursor/plugin MCP server id is **`cev-sim`** → `http://localhost:3000/mcp`.
3. Discover tools (`GetMcpTools` / tools/list).
4. Call read-only `environment_list`; expect JSON with `ok` and environments.
5. If discovery fails: server down, wrong port, or non-HTTP transport — **not** auth.

Unavailable server vs auth: this endpoint has no MCP auth handshake. Treat
connection refused / fetch failures as process/URL issues. Fix by starting
Express and matching `PORT`.

## Manual app smoke

After visual/sim changes (`docs/development.md`): Escape menu switches; 3D
loads without console errors; MCP mutations refresh open workspaces via SSE.

## Skill maintenance checklist

- [ ] `SKILL.md` still under 500 lines; references one level deep
- [ ] Description includes WHAT + WHEN trigger terms; auto-invoke enabled
  (no `disable-model-invocation: true`)
- [ ] New MCP modules named in `references/mcp-workflows.md`
- [ ] New document kinds listed in `references/architecture-and-schemas.md`
- [ ] No copied Zod schemas or machine-specific home-directory absolute paths in skill files
- [ ] `validate.mjs` passes; MCP tests pass when handlers change
- [ ] README / `docs/mcp.md` still describe plugin import vs manual config

## Troubleshooting pointers

- General: [docs/troubleshooting.md](../../../docs/troubleshooting.md)
- Scripting: [docs/scripting/troubleshooting.md](../../../docs/scripting/troubleshooting.md)
- MCP connect and categories: [docs/mcp.md](../../../docs/mcp.md)
