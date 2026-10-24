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
outside the reserved `cev` namespace. Unit, system, and sensor types must start with `{pluginId}.`.

For simulator `0.2.0`, declare `engines.cevSim` as `>=0.2.0 <0.3.0` (or
`>=0.1.0 <0.3.0` if the package must also load on 0.1). A package that still
declares `<0.2.0` is rejected. `npm run plugin:create` emits the next-minor
0.x range for the current host.

```json
{
  "kind": "cev-sim.plugin",
  "api": 1,
  "id": "acme.demo",
  "version": "1.0.0",
  "engines": { "cevSim": ">=0.2.0 <0.3.0" },
  "entry": { "runtime": "runtime/index.js", "ui": "ui/index.js" },
  "capabilities": [],
  "units": [],
  "systems": [],
  "sensorTypes": [],
  "editor": { "assets": ["ui/icon.svg"] }
}
```

`entry.ui`, `editor`, and `sensorTypes` are optional. Existing packages should omit unused
`sensorTypes`; absence remains absent. Ports use the concrete `ProgramTypes.js` vocabulary. API 1
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
`contributeUnit`, `contributeSystem`, and `contributeSensorType` must match `plugin.json` exactly.

The frozen registration API contains only:

```text
pluginApi, plugin, capabilities, UnitBlock, BlockOutput, ports,
contributeUnit, contributeSystem, contributeSensorType, log
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
- `sensors.sample.range-image`
- `plant.step`

Pure computation needs no grant. `overlay.spawn` is unavailable on headless GPU backends.

See `tests/fixtures/plugins/acme.example/` and `examples/plugins/acme.pure-pursuit/`.

## Sensor ABI 1

Range-image sensor packages declare `sensorTypes` and register each exact type
with `api.contributeSensorType({ type, create })`. The host supplies CPU
sampling, measurement noise/dropout, timing, publishing, recording, and
resource limits. The plugin transforms already measured ranges and may emit a
declared PointCloud2 value and complete opaque vendor packet payloads. It does
not receive BVH, Three.js, renderer, socket, filesystem, or arbitrary raycast
access.

The strict descriptor, scan layout, lifecycle, capture result, observation,
and product shapes are documented in [`plugin-sensors.md`](plugin-sensors.md).
The native envelope and supervisor-owned live UDP adapter are in
[`sensor-packet-transports.md`](sensor-packet-transports.md). Classic PCAP
artifacts are operator-owned and optional unless a manifest binding requests
them. A working 3×4
nonuniform example is `tests/fixtures/plugins/test.range-image-fixture/`.

## UI ABI

UI is a separate browser entry. Node and headless never import it. The runtime ABI stays UI-free.

`ui/index.js` must `export default { registerUi(uiApi) {} }`. `registerUi` is synchronous. The
frozen UI API contains:

```text
pluginApi, plugin, React, hooks, Unit, SettingsForm, contributeUnitView, contributeSensorView, assetUrl, log, diagnostics
```

`hooks` is the approved React hook set (`useState`, `useEffect`, `useMemo`, `useCallback`,
`useRef`, `useId`). Unit views receive `{ uuid, state, settings, ports }`. Sensor views receive
frozen `{ context, sensor, descriptor, fields, diagnostics, onChange }`. `onChange({ path, value })`
may edit only declared scan-layout, parameter, product, and output paths; the host validates
before committing. `assetUrl(path)` only serves paths listed in `editor.assets`.

Integrity failures (tampered CAS bytes, invalid imports) are fatal. `registerUi` / render errors
are isolated: the editor keeps the generic settings fallback and does not unload the runtime
package. Do not ship JSX; use `React.createElement`.

## Authoring vs execution

| Document | Field | Pins |
| --- | --- | --- |
| Editor graph | `graph.pluginLocks` | `{ pluginId, version, packageHash, runtimeHash, types[] }` |
| Vehicle document | `pluginLocks` | `{ pluginId, version, packageHash, runtimeHash, sensorTypes[], plants[]? }` |
| Compiled artifact | `pluginRequirements` | `{ pluginId, version, runtimeHash, types[] }` |
| Run manifest | `plugins.artifacts` | `{ pluginId, expectedHash: packageHash, capabilities[] }` |

One package per `pluginId` per graph. Stamping a second `packageHash` for the same plugin fails.
`UNIT_CATALOG_META` remains the built-in catalog authority. The editor merges a revisioned plugin
catalog from the local library; placing a unit stamps `pluginLocks`. Missing packages render
`UnresolvedPluginUnit` placeholders and cannot compile.

Library install/remove does not hot-swap an open graph. Reimport rewrites
saved vehicle, script, and run-manifest pins, but an open editor keeps its
draft until reload. Reload the document to pick up a newly installed catalog
entry. Existing `pluginLocks` still resolve from CAS after library removal.
Compiled artifacts keep their previous `latestValidArtifact` when a later lint
fails.

## Plant ABI 1

A dynamics package is still a plugin. The host mounts it from `plugin.json` plus a compiled `plant.wasm`. The author does not ship a JavaScript adapter.

`entry` may be omitted only when `units`, `systems`, and `sensorTypes` are empty, `editor` is absent, and `plants` is non-empty. Each plant id starts with `{pluginId}.`. `abi` is `1`. `module` is a package-relative `.wasm` path of at most 4 MiB. `parameters` has at most 32 unique identifier keys. Each parameter source is `default` (with a finite `default`) or one of `kinematics.wheelbase`, `kinematics.maxSteeringAngle`, `kinematics.maxSpeed`, `kinematics.maxAcceleration`, `kinematics.maxDeceleration`, `kinematics.maxJerk`, `kinematics.maxSteeringRate`, and `boundingBox.size.x`, `boundingBox.size.y`, `boundingBox.size.z`.

Non-empty `plants` require the `plant.step` capability. The module has zero imports. It exports `memory`, `cev_plant_abi() -> i32` (`1`), `cev_plant_buffer() -> i32` (8-byte-aligned address of 45 `f64`s), and `cev_plant_step(params_len: i32, dt: f64) -> i32` (`0` on success). Rust's mutable stack global is allowed. The host writes state into `buffer[0..13]`, resolved parameters into `buffer[13..13+n]`, calls `cev_plant_step`, and reads `buffer[0..13]`.

State layout `cev-sim.plant-state@1`, Three.js frame:

| Index | Field |
| --- | --- |
| 0..2 | position x, y, z (planar motion is x/z) |
| 3..5 | rotation x, y, z (yaw is `rotation.y`) |
| 6..8 | velocity (`velocity.x` is body-frame longitudinal speed) |
| 9..11 | acceleration |
| 12 | steering, radians, already written by controls |

Optional `model` is omitted, `dynamic-bicycle-v1`, or `contact-bicycle-v1`. Omitted plants keep the layout above. `dynamic-bicycle-v1` uses the same 13 floats for the built-in dynamic bicycle: `velocity[1]` is right-positive lateral speed, `velocity[2]` is yaw rate, and `acceleration[0]` is the speed-loop `ax_cmd` on the way in and body `ax` on the way out. `acceleration[1]` comes back as body `ay`. The host still drapes pitch into `rotation[2]` after the step, and it clears Three.js `velocity.y` and `velocity.z` so lateral speed is not height rate. Parameters carry the built-in defaults (`mass` 1500, `yawInertia` 2250, `corneringStiffnessFront` and `corneringStiffnessRear` 80000, `frictionMu` 0.9, `rollingResistance` 0.015) plus wheelbase and maximum steer. `lf` and `lr` are half that wheelbase inside the crate. A plugin plant still cannot be combined with vehicle `dynamics.model`.

`contact-bicycle-v1` reuses those 13 floats for axle forces. On the way in, `velocity[0..2]` are `vx`, right-positive `vy`, and yaw rate. `acceleration[0]` is `ax_cmd`, `acceleration[1]` is `1` on the road and `0` in the air, and `acceleration[2]` is normal load in newtons. `rotation.x` and `rotation.z` are downhill pull in the car frame, in m/s², and `rotation.y` stays yaw. On the way out, `velocity[0]` and `velocity[1]` are the front axle force forward and sideways, and `acceleration[0]` and `acceleration[1]` are the rear axle force. The host ignores the plugin position and yaw, applies the forces at the axles, and adds gravity itself. Drive force is zero in the air.

After a successful step the host drapes the vehicle onto the road: it overwrites `y`, `rotation.x`, and `rotation.z`. Physics may still clamp position. A nonzero return or a non-finite output is `PLUGIN_EXECUTION` with `requiresReset`. The kernel does not fall back to the built-in bicycle. A fresh WebAssembly instance is created on reset so hidden module state does not survive.

`src/lib.rs` exposes `pub fn step(state, params, dt) -> i32` for a native caller. `src/abi.rs` is the generated WASM export. A Zenoh driver is a sibling crate outside the plant crate, and it calls `step` directly. Install builds only `cargo build --release --lib --locked --target wasm32-unknown-unknown`. The source fingerprint covers `plugin.json`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, and `src/**`, so a Zenoh-only commit does not look like a plant update.

Local discovery builds that crate when the user clicks Install and both `plants` and `Cargo.toml` are present. The build writes `CARGO_TARGET_DIR` under the plugin store, copies `plugin.json` and the wasm into a temporary package, and installs that package. It does not modify `plugins/`. A missing `cargo` fails with `PLUGIN_BUILD_FAILED` and the message `Install rustup to build plant plugins.` Cargo `build.rs` scripts run during that trusted local install. Marketplace Discover installs signed bytes and never runs Cargo. A prebuilt tree with `plants` and no `Cargo.toml` is packed as it stands.

A successful local build records `{ directoryKey, sourceFingerprint, pluginId, version, packageHash }` in `<plugin store>/local-builds.json` (`cev-sim.plugin-local-builds` version 1). That file is operational. It is not part of `library.json` or any semantic hash. The library shows Update available when a build record exists and the source fingerprint differs. Install adds a library row and does not rewrite locks. Reimport, from the plugin menu or `POST /api/storage/plugins/local/reimport` with `{ directory }`, packs or rebuilds that directory and replaces other manual library rows for the same plugin id. It rewrites saved vehicle `pluginLocks`, script `graph.pluginLocks` and compiled `pluginRequirements`, and run-manifest `plugins.artifacts` expected hashes onto the new package. It does not add capability grants. A saved document that no longer declares a locked sensor, plant, unit, or granted capability blocks the replacement and leaves the previous manual rows in place. Marketplace-owned rows, resolved runs, live sessions, and open editor drafts stay on the previous hash. Two machines can compile the same commit to different wasm bytes; `Cargo.lock` and `rust-toolchain.toml` do not make wasm bit-identical.

Scaffold a plant with:

```bash
node --experimental-default-type=module scripts/create-cev-plugin.mjs \
  --id acme.dynamics --kind plant --out plugins/acme.dynamics --no-verify
```

`--model dynamic-bicycle` emits the integrating bicycle. `--model contact-bicycle` emits axle forces for the host body. The committed copies are `examples/plugins/acme.dynamics.longitudinal`, `examples/plugins/acme.dynamics.cornering`, and `examples/plugins/acme.dynamics.bicycle`.

The committed bicycle fixture is `tests/fixtures/plugins/test.plant-fixture/`. `npm run fixtures:plant` rewrites it from the deterministic encoder so CI does not need Rust. `CEV_PLANT_CARGO=1` opts into a real `cargo` verify when the `wasm32-unknown-unknown` target is installed.

A vehicle selects the plant with optional `dynamics: { plant }`. Omitted dynamics keep the JavaScript bicycle. The matching `pluginLocks[]` entry may include `plants`. Empty `plants` is omitted, so sensor-only locks keep their previous hash projection. A plant-only lock does not require `sensors.sample.range-image`. A lock that lists plants requires the run to grant `plant.step`. Config shows one action that adds or replaces that plugin's run artifact and grant. Grants are not added silently. `cev-sim create-bundle` and `cev_sim.configure` copy a stored vehicle's plugin locks into the planning bundle, including `plant.step`, when those packages are installed in the data directory. A vehicle with no plugin locks stays on the plugin-free bundle.

## Install and operate

Scaffold:

```bash
node --experimental-default-type=module scripts/create-cev-plugin.mjs \
  --id acme.demo --out examples/plugins/acme.demo
```

Install into the local library (absolute directory, portable package file, or an
existing CAS digest):

- HTTP: `POST /api/storage/plugins/install` with `{ source: { kind: "directory", path } }`,
  `{ source: { kind: "file", path } }`, or `{ source: { kind: "digest", packageHash } }`
- HTTP upload: `POST /api/storage/plugins/install-file` with
  `Content-Type: application/vnd.cev-sim.plugin-package+json` and the raw
  `cev-sim.plugin-package@1` JSON body (16 MiB limit)
- MCP: `plugin_install`, `plugin_list`, `plugin_get`, `plugin_remove`
- Standalone: `cev-sim-plugin pack --directory <plugin-dir> --output <package.json>`
  then `cev-sim-plugin verify --file <package.json>`. Verify never loads runtime
  modules.

Portable-file ingestion limits (16 MiB JSON, 256 members, 8 MiB decoded, 4 MiB
per member, 240 UTF-8 path bytes) apply to pack/install tooling only. Embedded
run-bundle packages are not re-validated against those limits.

Remove drops library membership only. CAS bytes and immutable URLs remain.

`GET /api/storage/plugins/library` lists revisioned membership.
`GET /api/storage/plugins/packages/{packageHash}/files/...` serves verified members.

Config → Scripts (Advanced) authors `manifest.plugins`. Enablement with an empty lock list does not
invent packages. Locks are exact `packageHash` values. Capability checkboxes grant names; required
package capabilities are labeled. Validate/resolve reports missing packages as plugin issues.

Managed runs still reject plugins until the manifest lock resolves. Headless provenance records
`{ pluginId, version, packageHash, runtimeHash }` and omits `uiHash`. The npm headless distribution
includes Acorn and plugin runtime sources; it does not ship `app/plugin/browser`.

## Out of scope for API 1

Marketplace compilation, signatures, a hostile sandbox, JSX in packages, hot-swap of a live graph, CAS deletion
on remove, Python-side plugin install, extra Config tabs, package-defined ROS messages, plugin-owned
sockets, and GPU explicit-layout sampling. Plant packages do not open sockets; a native sibling calls
the same `step` function outside the simulator.
