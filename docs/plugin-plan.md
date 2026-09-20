# Simulator Plugin Roadmap

This document is the implementation authority for simulator plugins. The
`PLG-*` program is separate from the headless, visual-layer (`VIS-*`), and
environment-editor (`ED-*`) programs. A plugin milestone does not extend or
renumber any of those roadmaps.

The repository root `plugin.json` describes cev-sim's agent tooling plugin.
Simulator plugin packages have an independent `plugin.json` inside each
package directory and use the contracts below.

## Status

| Milestone | Implementation | Verification | Merge status |
| --- | --- | --- | --- |
| PLG-01: foundation, isolated registries, verified packages | Complete in working tree | Verified | Unmerged |
| PLG-02: resolved selection and runner propagation | Not started | Not started | Unmerged |
| PLG-03: deterministic effects, systems, and identity profiles | Not started | Not started | Unmerged |
| PLG-04: editor/UI integration and distribution acceptance | Not started | Not started | Unmerged |

Only a merged change may be marked merged. A milestone is verified only when
all of its acceptance commands and evidence entries are present in this
document.

## Locked contracts

### Compatibility boundary

PLG-01 preserves run-manifest v11, run-bundle v1, visual-script artifact v3,
all Protobuf fields, plugin-free hashes, canonical state, and fixed-step
ordering. Managed runs reject plugin selections, resources, dependency
records, requirements, nested compiled-program requirements, and the reserved
`world-bound-plugins@1` identity profile before execution changes active
state. Plugin-specific fields are unsupported even when empty.

Packages are trusted local JavaScript. Static import validation, exact-byte
verification, and capability-checked facades reduce accidental authority;
they are not a hostile-code sandbox. Registration is definition-only and
episode state belongs to unit instances.

### Package document

`app/plugin/PluginDocument.js` owns `cev-sim.plugin` API 1. A package has a
lowercase dotted ID, a SemVer version, a cev-sim engine range, runtime and
optional UI entries, required capabilities, fixed-port unit descriptors,
optional system descriptors, and optional editor assets. Unknown fields are
rejected. Plugin IDs under `cev` are reserved. Unit types and system IDs must
start with the package ID followed by a dot.

Unit ports use the concrete `ProgramTypes.js` vocabulary. Plugin API v1
excludes `generic`, dynamic port layouts, custom value types, and
program-level input/output roles. Settings target authored `state`; the
built-in `storedData` mechanism is not public. Systems validate as
`{ id, phase: "scripts", priority, stateVersion }`, but PLG-01 rejects any
package that declares one.

### Package resource and hashes

A portable package is `cev-sim.plugin-package` version 1 with sorted file
records containing a relative path, byte size, SHA-256, base64 encoding, and
the exact bytes. `plugin.json` bytes are authoritative and are parsed during
verification.

All aggregate hashes use SHA-256 over domain-separated JCS projections:

| Hash | Projection |
| --- | --- |
| `packageHash` | Domain/version plus every sorted `{ path, sizeBytes, sha256 }` record, including raw `plugin.json` |
| `runtimeHash` | Domain/version, the parsed manifest without `entry.ui` or `editor`, and the exact runtime-closure file records |
| `uiHash` | Domain/version, UI entry/editor metadata, and the union of UI-closure files and declared assets |

Records use UTF-8 byte ordering. A shared runtime/UI module belongs to both
closures. Manifest whitespace changes only `packageHash`; UI code and editor
assets change package/UI identity; runtime code, capabilities, defaults,
ports, and all other retained manifest fields change `runtimeHash`.
Enumeration order, installation location, timestamps, absolute paths,
library revisions, and generated Node package markers do not affect identity.

### Module graph

Acorn 8.15.0 parses every packaged `.js`/`.mjs` file as an ECMAScript module
at a fixed language level. Explicit relative imports and re-exports may use
contained parent traversal. Absolute paths, bare packages, URLs,
query/fragment suffixes, backslashes, encoded path tricks, root escapes,
missing or case-mismatched targets, duplicate/case-fold-colliding paths,
dynamic import, top-level await or async iteration, JSX, import attributes,
and unsupported formats are rejected. Runtime edges into the UI entry or
editor assets are rejected. Unused JavaScript receives the same validation.

### Registry and unit ABI

`BlockRegistry` privately owns its map. Snapshots are frozen copies with
`builtin` ownership or frozen `{ pluginId, version, runtimeHash }` ownership.
Built-in re-registration of the identical type/class/owner is idempotent;
all conflicting registration and every repeated plugin contribution fail.
Sealed registries reject changes. Seeded registries never share maps. The
legacy wrappers use a plugin-disabled default registry.

The registration API is frozen and contains exactly:

```text
pluginApi, plugin, capabilities, UnitBlock, BlockOutput, ports,
contributeUnit, contributeSystem, log
```

Capabilities are a frozen, sorted array. The public `UnitBlock` fixes its
ports after the synchronous registration hook. A host-owned adapter extends
the existing scripting block, owns one plugin instance per adapter instance,
validates JSON state and declared outputs, rejects thenables from synchronous
hooks, and revokes its private bridge after idempotent disposal. The bridge
looks up the adapter's current `getInput(label)` on every call so compiled
runtime connection hydration remains effective.

### Capability names and availability

API 1 reserves:

- `signals.read.vehicles`, `signals.read.devices`,
  `signals.read.simulation`, `signals.read.scenario`,
  `signals.read.mission`, `signals.read.objects`, and
  `signals.read.topics`
- `signals.write.debug`, `signals.write.mission`, and
  `scenario.flags.write`
- `world.read`, `controls.reference`, `topics.subscribe`,
  `topics.publish`, and `overlay.spawn`

Grant validation separately rejects unknown names, missing required grants,
and grants unavailable from the selected host. PLG-01 production hosts
advertise no simulator capabilities. Tests may inject explicit read-only
signal services. Pure computation needs no grant. Host RNG is deferred and
plugins must not treat ambient `Math.random()` as a deterministic service.

### Storage and module sources

`PluginStore` publishes immutable CAS resources below
`plugins/cas/sha256/<packageHash>`, maintains a revisioned `library.json`,
uses operation-owned staging, and materializes verified Node closures below
`plugins/runtime/<runtimeHash>`. Installation never imports code. Library
removal preserves CAS bytes and immutable URLs.

The Node source imports a verified, runtime-only tree with a host-generated
`{ "type": "module" }` marker. The browser source imports the runtime entry
from the verified same-origin CAS route. Paths derive only from digests and
relative member paths. UI execution is unavailable in PLG-01.

## Milestones and acceptance gates

### PLG-01 — Foundation, isolated registries, and verified packages

Deliver the registry instance API and complete built-in registration; public
unit ABI and host adapters; strict package document and module-graph
verification; exact package/runtime/UI hashing; immutable storage and
revisioned library membership; transactional registration; injected Node and
browser module sources; verified read-only HTTP routes; and managed-run
rejection.

Acceptance requires:

- A fixed-port fixture registers and executes in isolated live,
  compiled-Runner, Node, and Chromium harnesses.
- Registration failure publishes no registry entries or metadata and retained
  callbacks are closed.
- Storage and integrity inspection execute no package code.
- Node and browser loading produce matching contribution descriptors/results,
  and the fixture UI entry is never evaluated.
- Package hash vectors are stable and runtime identity is independent of UI.
- Built-in catalogs, compilation, execution, plugin-free identity vectors,
  and action-tape characterization remain unchanged.
- All focused suites, scripting/runtime/identity regressions, Playwright,
  `npm run lint`, and `npm test` pass.

PLG-01 does not propagate plugin selection into managed simulations, expose
production simulator services, execute systems or UI modules, or alter
versioned run/script contracts.

### PLG-02 — Resolved selection and runner propagation

Add authoring selection and immutable resolution into run manifests/bundles;
lock selected package/runtime identities; add per-session registries and
loader lifetime; propagate selected registries through `ScriptManager`, graph
loading, compiler bindings, scenarios, direct execution, supervisor workers,
and browser/headless preparation; and advertise only services actually wired
by each backend.

Acceptance requires browser/headless parity for a pure unit, deterministic
selection of one version per plugin ID, exact bundle integrity failures,
session isolation across simultaneous runs, clean reset/disposal behavior,
and unchanged hashes for plugin-free runs. Run/proto contract changes must be
versioned additively and recorded in the headless roadmap as well as here.

### PLG-03 — Deterministic effects, systems, and identity profiles

Define the effect journal and deterministic commit order; implement allowed
write capabilities and host RNG; execute declared systems in the scripts
phase with state versioning; add explicit plugin capability negotiation;
version semantic projections so selected runtime identities and episode
semantics are hashed; and implement the gated `world-bound-plugins@1` profile.

Acceptance requires replay and browser/headless parity for effects and
systems, ordering tests for multiple plugins, reset/state migration tests,
capability-negative tests, characterization of all identity projections, and
failure before state mutation when a backend cannot honor requirements.

### PLG-04 — Editor integration, UI packages, and distribution

Add package library management surfaces, explicit install/remove control-plane
operations, catalog/package selection, safe UI metadata and custom renderer
loading under the versioned UI ABI, production asset serving, MCP/Config
integration, Python-facing parity evidence, and clean-distribution packaging.

Acceptance requires editor authoring/round-trip tests, custom UI fallback and
failure isolation, install/remove authorization and audit evidence, Node and
Chromium distribution tests from a clean checkout, full managed browser and
headless parity, Python integration, and documentation for package authors and
operators.

## PLG-01 evidence ledger

| Gate | Evidence | Result / limitation |
| --- | --- | --- |
| Baseline identity | `visual-script-catalog`, `visual-identity`, and `headless-contract` before implementation | 21/22 passed; only the v11 golden helper comparison failed |
| Hermetic v11 resolution | Temporary `StorageService` seeded with exact fixture manifest, historical environment bytes, and binding envelope | Golden comparison repaired without changing committed fixture bytes |
| Action-tape characterization | Existing in-memory regeneration and committed comparison | Passed; committed characterization was not regenerated |
| Plugin focused Node suites | `node --experimental-default-type=module --test tests/plugin-*.test.js` | 20/20 passed on 2026-09-19; includes fixed hash vectors, state/output types, cache corruption, capability-before-import, and failed index publication |
| Targeted lint | ESLint over plugin implementation, fixtures, and focused suites | Passed on 2026-09-19 |
| Browser module source and build | `npx playwright test tests/ui/plugin-module-source.spec.js` using the production build/server | 1/1 Chromium test passed on 2026-09-19; relative runtime import and connected unit result matched Node, throwing UI entry was not evaluated |
| Regression matrix | `node --experimental-default-type=module --test tests/visual-script-*.test.js tests/visual-identity.test.js tests/headless-contract.test.js tests/run-manifest.test.js tests/simulation-hashes.test.js tests/storage-api.test.js tests/storage-service.test.js` | 170/170 passed on 2026-09-19 |
| Repository lint | `npm run lint` | Passed with zero errors on 2026-09-19; two pre-existing warnings remain in `MapSurface.js` and `Client.js` |
| Full tests | `npm test` with loopback access required by existing HTTP/supervisor suites | 1,506 passed, 0 failed, 4 existing skips on 2026-09-19 |

Fixture coverage includes a fixed-port scale unit with a parent-relative
shared helper, a throwing UI entry, hash/edit variants constructed from exact
bytes, transactional registration failures, asynchronous hooks, descriptor
mismatches, unavailable systems, hostile temporary paths, and symlinks. The
foundation deliberately has no production simulator capabilities and cannot
admit plugins to managed runs.

The fixed fixture vectors are `packageHash`
`f9e2255bed1adcdadbe7a3fa9cb75ee6644fc791c07acd9734bd4d43f8ea52d9`,
`runtimeHash`
`f29ebbc784e41f926b0aba3a8de763262be2b0e8181b63031dc4b7a9107657c7`,
and `uiHash`
`aae5470e2dbb18c3a70cd222d70aa83063fbda998b7636c8b84652ae0400823d`.
The full-suite loopback run was necessary because sandboxed local listening
causes the existing HTTP tests to fail with `EPERM`; the elevated acceptance
run completed without failures.

## Decision log

- **2026-09-19 — PLG names are independent.** Use `PLG-01` through `PLG-04`;
  “PLRG-01” in early planning material means `PLG-01`. Do not treat the work
  as headless PR 13, a VIS milestone, or an ED milestone.
- **2026-09-19 — Preserve current versioned contracts.** PLG-01 introduces no
  plugin field into managed manifests, bundles, Protobuf, or visual-script
  artifacts. Reserved fields fail before normalization or execution.
- **2026-09-19 — Isolate registration.** The default built-in registry remains
  plugin-disabled. Each host publishes a candidate registry and metadata only
  after complete synchronous validation.
- **2026-09-19 — Hash exact bytes and semantic projections separately.** Raw
  package membership determines `packageHash`; parsed runtime and UI
  projections determine their respective identities.
- **2026-09-19 — Keep import validation structural.** Acorn parses every
  packaged module. Regex import discovery and package-authored Node metadata
  are not trusted.
- **2026-09-19 — Keep PLG-01 capability-free in production.** Reserved names
  are stable vocabulary, not evidence that a service is wired.
- **2026-09-19 — Preserve immutable content after removal.** Removing library
  membership does not delete CAS bytes or invalidate digest URLs; garbage
  collection and multi-process writers remain deferred.
- **2026-09-19 — PLG-01 acceptance completed.** Node and Chromium loaded the
  same fixed-port fixture through verified sources, plugin-free regressions and
  characterization stayed unchanged, lint had no errors, and the complete
  repository suite passed. PLG-01 is verified but remains unmerged.
