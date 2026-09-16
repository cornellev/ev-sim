# Types And Ports

Visual scripting port types are strings. The editor uses them to decide whether ports can connect and which wire color to show.

## Type Colors

Base type colors live in `app/scripting/Constants.js`.

Current base types:

- `float64`
- `int32`
- `string`
- `boolean`
- `array`
- `custom`
- `tex1d`
- `generic` (editor-only wire color; not a program I/O type)
- `unit` (concrete sequencing token; allowed as program I/O)
- `actor_command` (concrete `{ actorId, speedMps, steeringRad }` value; allowed as program I/O)
- `vec2` / `vec3` / `pose2d` / `pose3d` (frozen structured values; allowed as program I/O)

For bracketed types, such as `array[float64]`, the UI can fall back to the base type color. `generic` is listed in `Constants.TYPES` for unbound polymorphic ports. It is **not** in `ProgramTypes.SUPPORTED_TYPES` and must never appear in compiled artifacts. `unit`, `actor_command`, `vec2`, `vec3`, `pose2d`, and `pose3d` are in `SUPPORTED_TYPES`. `parseValueByType(_, "unit")` always returns the `UNIT` singleton from `PortTypes.js`. Numeric parsing uses `finiteFloat()` / `finiteInt32()`; nonfinite values become zero and int32 values truncate and clamp to the signed range. `finiteResult()` maps non-finite math results to `0`. `orderedBounds(min, max)` finite-normalizes both edges and swaps them when `min > max`. `valuesEqual()` is structural equality for serializable values: numbers treat `+0`/`-0` as equal, arrays compare element-wise, and plain objects compare key sets without depending on insertion order. `normalizeActorCommand()` applies the same finite rule, defaults `actorId` to `""`, and drops extra keys. `normalizeVec2()` / `normalizeVec3()` / `normalizePose2d()` / `normalizePose3d()` freeze the shapes below, map non-finite components to `0`, default pose3d Euler `order` to `"XYZ"`, and drop extra keys. `parseValueByType()` dispatches those four types through the normalizers (after optional JSON parse). `IsFiniteBlock` is the exception: it uses raw `Number.isFinite(Number(value))` so `Infinity` stays non-finite instead of collapsing to `0`.

Array and JSON path blocks do **not** infer `T`. They use a `state.itemType` / `state.valueType` selector restricted to `float64`, `int32`, `boolean`, `string`, and `json`, and register exact ports such as `array[float64]`. `array[float64]` will not connect to `array[json]`. JSON path reads use `getByPath` with a missing-path sentinel so a present `null` is distinct from absence; writes use `setByPath` / `deleteByPath` and always emit cloned documents. `asArray()` returns `[]` for non-arrays instead of wrapping scalars the way `parseValueByType(..., "array[…]")` does.

## Program I/O Types

`app/scripting/units/program/ProgramIO.js` defines the types exposed by Program Input and OutputNode configuration.

Current supported program I/O types:

- `float64`
- `int32`
- `boolean`
- `string`
- `tex1d`
- `array[float64]`
- `array[int32]`
- `array[boolean]`
- `array[string]`
- `custom[string]`
- `unit`
- `actor_command`
- `vec2`
- `vec3`
- `pose2d`
- `pose3d`

## Sequencing And Effect Ports

`unit` is a sequencing token, not a payload. `Nop` produces `then: unit`. `Sequence` evaluates `first` then `second`. `Passthrough` evaluates `then` before `value`. `Ignore` evaluates `value` and produces `then`.

Current effect blocks expose `then: unit` plus an identity or status output (`value`, `state`, `path`, `count`, `index`). They are reachable only when a downstream node consumes `then` or that identity output. Explicit `Sequence` / `Passthrough` is required for effect order.

Frozen v2 and early-v3 artifacts may still snapshot `written`, `ok`, or `staged`. `BlockOutput.setDeclared(unit, label, value)` writes a label only when `unit.outputType(label)` exists, so one `execute()` body serves current ports and frozen legacy ports. Editable graphs that still wire `written` / `ok` / `staged` are not migrated; restore records `restoreErrors`, compile fails closed, and `latestValidArtifact` stays runnable until the user rewires.

## Actor Command

`actor_command` is a scripting value type, not a scenario controller contract. The normalized payload is `{ actorId: string, speedMps: number, steeringRad: number }`.

`Make Actor Command` takes required `speed` / `steering` (`float64`) and optional `actorId` (`string`), and outputs `command`. `Split Actor Command` inverts that: `command` in, `speed` / `steering` / `actorId` out. Port labels map to payload fields as `speed` ↔ `speedMps` and `steering` ↔ `steeringRad`. Unwired `actorId` becomes `""`.

Route-controller speed and steering mappings remain `float64`. A compiled program may export `actor_command`, but `StorageService` scenario resolution rejects mapping that output to `speed` or `steering`.

## Vectors And Poses

`vec2`, `vec3`, `pose2d`, and `pose3d` are scripting value types. Extra keys are dropped. Arrays, empty strings, and non-objects become zeros.

Frozen shapes:

- `vec2 = { x, y }`
- `vec3 = { x, y, z }`
- `pose2d = { position: vec2, yaw }`
- `pose3d = { position: vec3, rotation: { x, y, z, order } }`

`pose2d.position.y` is the second generic axis, not world-up. `pose3d.rotation.order` is a THREE Euler string from `XYZ|YZX|ZXY|XZY|YXZ|ZYX`; anything else becomes `"XYZ"`. When `position` is missing, top-level `x` / `y` / `z` on the object are used so a flat point can parse as a pose.

Make/Split geometry blocks compose and unpack these shapes. `Make Pose 3D` takes required `position` / `x` / `y` / `z` (Euler radians) and optional `order`. Vector arithmetic lives in `app/scripting/units/geometry/vectorMath.js`. Zero-length `Normalize Vec2/Vec3` returns a zero vector. Domain-invalid components become `0` via `finiteFloat()` / `finiteResult()`.

`Route Tangent` packs the route helper’s planar XZ tangent `{ x, z }` into `vec2` as `{ x, y: z }`. Heading stays `float64` (`Math.atan2(dx, dz)`). `route` and `waypoint` remain opaque JSON in `parseValueByType()`.

## Port Matching

`app/scripting/types/PortTypes.js` defines `portsCompatible(a, b)`: either side may be editor-only `generic`, otherwise the strings must match exactly (`float64` ≠ `int32`). `LineManager` uses that check on the full `data-encoded` type, not CSS class names.

Polymorphic blocks declare `static typeScheme = { variables: { T: { inputs: [...], outputs: [...] } } }`. Graph-wide unification in `app/scripting/types/unifyGraph.js` unions connected generic variables, propagates every concrete constraint across the component, and rejects a candidate wire when two distinct concrete types would meet. Existing wires are never deleted to make a new wire fit. `Previous` and `Value Changed` infer `T` the same way as Equal/Passthrough (no type selector).

Derived bindings live on `unit.typeBindings` (for example `{ T: "float64" }`) and are cached on editor graph nodes as `typeBindings`. On restore, connections are the authority and bindings are recomputed.

`ScriptManager.connectUnitsDetailed(...)` returns `{ ok, error }` and is the mutation API. `connectUnits(...)` remains the boolean wrapper. `disconnectUnits()` recomputes bindings; an unconstrained component returns to `generic`.

The compiler snapshots **resolved** `nodes[].ports` into compiled v3 artifacts. Only reachable nodes must be fully concrete. Frozen v2 artifacts remain runnable; their ports override later class registration. Artifact `nodes[].ports`, `transitions[].type`, and program interfaces may never contain `generic`.

React units that participate in inference receive solved `portTypes` from `Scripting.js` after connect, disconnect, load, and reregister. Legacy stored `type` fields on If / latch / default / log may round-trip but do not constrain inference.

React units and backend blocks must use the same labels and types:

```javascript
// React unit
outputs={[{ label: "out", type: "float64" }]}

// UnitBlock
this.registerOutput("out", "float64");
```

If a port has a separate display label and internal id, pass both from the React unit. `Unit` encodes `id` into the connection metadata and only uses `label` for display:

```javascript
outputs={[{ id: "input", label: "speed", type: "float64" }]}
```

The backend block must register the stable id:

```javascript
this.registerOutput("input", "float64");
```

Program Input uses this pattern. Its visible external label defaults to `input`, then `input_2`, and so on, while its internal output port remains `input` so compilation and existing wires do not depend on generated unit IDs.

## Dynamic Ports

When a setting changes a block's port map or generic acceptance, call `requestUnitReconfiguration(_uuid, patch)` from the UI. `Scripting.js` invokes `ScriptManager.reconfigureUnitDetailed()`, runs graph-wide unification, and commits the React setting only on success. `reregister-unit` remains a compatibility event and uses the same atomic manager path.

When changing a port type would invalidate existing wires, remove those wires through the `delete-port-connections` event or another explicit disconnect path.
