# Simulator plugin API

This is the package-author contract for cev-sim simulator plugins (`cev-sim.plugin` API 1). The
roadmap and identity rules live in [plugin-plan.md](plugin-plan.md). Built-in visual-scripting
blocks still follow [scripting/extension-guide.md](scripting/extension-guide.md).

Simulator packages are trusted local JavaScript. Static import checks, exact-byte hashes, and
capability facades reduce accidents; they are not a hostile-code sandbox.

## Package layout

```text
plugin.json
runtime/index.js
ui/index.js          # optional
ui/icon.svg          # optional, listed in editor.assets
```

`plugin.json` is the authority. Unknown fields are rejected. Plugin IDs are lowercase dotted names
outside the reserved `cev` namespace. Unit types and system IDs must start with `{pluginId}.`.

```json
{
  "kind": "cev-sim.plugin",
  "api": 1,
  "id": "acme.demo",
  "version": "1.0.0",
  "engines": { "cevSim": ">=0.1.0 <0.2.0" },
  "entry": { "runtime": "runtime/index.js", "ui": "ui/index.js" },
  "capabilities": [],
  "units": [],
  "systems": [],
  "editor": { "assets": ["ui/icon.svg"] }
}
```

`entry.ui` and `editor` are optional. Ports use the concrete `ProgramTypes.js` vocabulary. API 1
does not allow `generic`, dynamic port layouts, custom value types, or program-level input/output
roles. Settings target authored `state` (`target: "state"`). The built-in `storedData` mechanism is
not public.

Systems, when declared, are `{ id, phase: "scripts", priority, stateVersion }`.

## Module graph

Acorn 8.15.0 parses every packaged `.js` / `.mjs` file as an ES module. Allowed imports are
explicit relative specifiers that stay inside the package. Rejected: bare packages, URLs, absolute
paths, dynamic `import()`, top-level await, JSX, import attributes, and runtime edges into the UI
entry or editor assets. Unused JavaScript is validated the same way.

Do not put verify scripts, Node tests, or `package.json` tooling that uses `node:` imports inside
the package directory. Keep those as siblings (the scaffold writes `{out}.verify.mjs`).

## Hashes

| Hash | Changes when |
| --- | --- |
| `packageHash` | Any file bytes, including `plugin.json` whitespace |
| `runtimeHash` | Runtime closure or the parsed manifest except `entry.ui` / `editor` |
| `uiHash` | UI entry, UI closure, or declared editor assets |

A UI-only edit changes bundle `resolvedHash` but not `runtimeHash`, simulation identity, or
`episodeHash`. Enumeration order, install path, timestamps, and library revision do not affect
identity.

## Runtime ABI

`runtime/index.js` must `export default { register(api) {} }`. `register` is synchronous.
`contributeUnit` / `contributeSystem` must match `plugin.json` exactly.

The frozen registration API contains only:

```text
pluginApi, plugin, capabilities, UnitBlock, BlockOutput, ports,
contributeUnit, contributeSystem, log
```

Units extend `api.UnitBlock`, register fixed ports in `register()`, and return `api.BlockOutput`
from `execute()`. Host adapters own JSON state, declared outputs, and disposal. Thenables from
synchronous hooks fail as `PLUGIN_ASYNC_HOOK`.

Use `api.plugin.runtimeHash` and granted `api.capabilities`. Deterministic noise must come from the
host RNG facade, not `Math.random()`.

Required capabilities are declared on the package and granted by the run lock. API 1 names:

- `signals.read.vehicles|devices|simulation|scenario|mission|objects|topics`
- `signals.write.debug`, `signals.write.mission`, `scenario.flags.write`
- `world.read`, `controls.reference`, `topics.subscribe`, `topics.publish`, `overlay.spawn`

Pure computation needs no grant. `overlay.spawn` is unavailable on headless GPU backends.

See `tests/fixtures/plugins/acme.example/` and `examples/plugins/acme.pure-pursuit/`.

## UI ABI

UI is a separate browser entry. Node and headless never import it. The runtime ABI stays UI-free.

`ui/index.js` must `export default { registerUi(uiApi) {} }`. `registerUi` is synchronous. The
frozen UI API contains:

```text
pluginApi, plugin, React, hooks, Unit, SettingsForm, contributeUnitView, assetUrl, log, diagnostics
```

`hooks` is the approved React hook set (`useState`, `useEffect`, `useMemo`, `useCallback`,
`useRef`, `useId`). Views receive `{ uuid, state, settings, ports }`. `assetUrl(path)` only serves
paths listed in `editor.assets`.

Integrity failures (tampered CAS bytes, invalid imports) are fatal. `registerUi` / render errors
are isolated: the editor keeps the generic `SettingsForm` fallback and does not unload the runtime
package. Do not ship JSX; use `React.createElement`.

## Authoring vs execution

| Document | Field | Pins |
| --- | --- | --- |
| Editor graph | `graph.pluginLocks` | `{ pluginId, version, packageHash, runtimeHash, types[] }` |
| Compiled artifact | `pluginRequirements` | `{ pluginId, version, runtimeHash, types[] }` |
| Run manifest | `plugins.artifacts` | `{ pluginId, expectedHash: packageHash, capabilities[] }` |

One package per `pluginId` per graph. Stamping a second `packageHash` for the same plugin fails.
`UNIT_CATALOG_META` remains the built-in catalog authority. The editor merges a revisioned plugin
catalog from the local library; placing a unit stamps `pluginLocks`. Missing packages render
`UnresolvedPluginUnit` placeholders and cannot compile.

Library install/remove does not hot-swap an open graph. Reload the document to
pick up a newly installed catalog entry. Existing `pluginLocks` still resolve
from CAS after library removal. Compiled artifacts keep their previous
`latestValidArtifact` when a later lint fails.

## Install and operate

Scaffold:

```bash
node --experimental-default-type=module scripts/create-cev-plugin.mjs \
  --id acme.demo --out examples/plugins/acme.demo
```

Install into the local library (absolute directory or an existing CAS digest):

- HTTP: `POST /api/storage/plugins/install` with `{ source: { kind: "directory", path } }` or
  `{ source: { kind: "digest", packageHash } }`
- MCP: `plugin_install`, `plugin_list`, `plugin_get`, `plugin_remove`
- Remove drops library membership only. CAS bytes and immutable URLs remain.

`GET /api/storage/plugins/library` lists revisioned membership.
`GET /api/storage/plugins/packages/{packageHash}/files/...` serves verified members.

Config → Scripts (Advanced) authors `manifest.plugins`. Enablement with an empty lock list does not
invent packages. Locks are exact `packageHash` values. Capability checkboxes grant names; required
package capabilities are labeled. Validate/resolve reports missing packages as plugin issues.

Managed runs still reject plugins until the manifest lock resolves. Headless provenance records
`{ pluginId, version, packageHash, runtimeHash }` and omits `uiHash`. The npm headless distribution
includes Acorn and plugin runtime sources; it does not ship `app/plugin/browser`.

## Out of scope for API 1

Marketplace, signatures, a hostile sandbox, JSX in packages, hot-swap of a live graph, CAS deletion
on remove, Python-side plugin install, and extra Config tabs.
