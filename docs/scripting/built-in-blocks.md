# Built-In Blocks

`app/scripting/UnitCatalog.meta.js` is the authoritative built-in inventory. It owns stable type IDs, display names, categories, keywords, placeability, deprecation, settings, signal requirements, and React-free block classes. `UnitCatalog.js` attaches React components by type, `registerBuiltInBlocks.js` registers the same explicit types, and `AddMenu.js` renders only placeable entries.

## Menu Categories

Current block library categories:

- `expressions`: number, calculation, random number.
- `constants`: pi, e, tau, golden ratio.
- `texture1d`: texture operations (scale, multiply, add, subtract, clamp, invert). Noise and Mask remain in this category. `ScaleBlock` is deprecated and non-placeable.
- `terrain`: terrain texture generation and processing.
- `sensorflow`: filters, gates, sensor fusion helpers.
- `randomization`: random ranges, seeded random, noise, jitter, weighted select, remap.
- `conversions`: numeric conversions, including the legacy `Float64 to Int32` / `Int32 to Float64` blocks plus atomic floor/ceil/round/truncate, boolean/number/string conversions, generic `To String` (any concrete `T` → `string`), parse/stringify JSON, opaque `string` ↔ `road_id` / `texture_id` conversions, and `Object ID to Scene Object` (`objectId` string → `scene_object` plus `found`). Failed string/JSON parses emit zero/`null`/`false` plus `valid:false` and do not fail the script. Object ID lookup reports `found:false` and an empty id when the object is missing; an empty `scene_object` parent is the hierarchy root, so branch on `found` before using it as a parent.
- `objects`: string and JSON constants, Texture Import (stored visual-asset `useHash` as `texture_id`), plus JSON path get/set/has/delete/merge. Get/Set use a `valueType` selector (`float64|int32|boolean|string|json`). Path ops reuse `getByPath`/`setByPath`/`deleteByPath` and clone every document output.
- `strings`: concat, length, contains/starts/ends, trim/case, slice, replace-all, split, and join. Empty strings are legal inputs. Split/Join use fixed `array[string]` ports.
- `collections`: typed arrays with `state.itemType` (`float64|int32|boolean|string|json`). Ports resolve to `array[itemType]`. Out-of-range gets return `fallback` with `found:false`; out-of-range sets leave a cloned array with `changed:false`. `Linspace` emits inclusive `array[float64]` samples and caps count at 4096.
- `statements`: if, nop, ignore, sequence, passthrough, pass, Repeat, Index, and deprecated comparison/conjunction composites. `If`, `Weighted Select`, `Signal Latch`, `Signal Default`, `Log Signal`, `Ignore`, `Passthrough`, and `Pass` infer a type variable `T` from connections instead of a type selector. `Pass` is the identity (`value` in, `value` out) for routing wires on the canvas. Deprecated `EqualityBlock` `eq`/`neq` accept any concrete type; ordered operators accept only `float64`/`int32`. Repeat pulls its `body` input up to 256 times; an Index block wired to its `repeat` output reads `index`, `count`, and `t` for the current pass.
- `math`: integer constant plus atomic arithmetic, clamp/lerp/smoothstep/deadband, and trig blocks. Domain errors (divide/modulo by zero, invalid roots/logs, non-finite results, equal inverse-lerp bounds) return `0`. Bounds are reordered so `min`/`max` may arrive swapped.
- `logic`: boolean constant plus Not/And/Or/Xor, Equal/NotEqual, ordered compares, Nearly Equal, and Is Finite. `And`/`Or` always short-circuit at runtime. `Equal`/`NotEqual` compare structurally and accept any concrete `T`. Ordered compares accept only `float64`/`int32`. `IsFiniteBlock` uses raw `Number.isFinite` and does not run values through `finiteFloat()`.
- `geometry`: Make/Split Vec2 and Vec3, add/subtract/scale/dot/length/normalize/distance, Cross Vec3, and Make/Split Pose 2D/3D. Shared helpers live in `vectorMath.js`; React siblings import `GEOMETRY_BLOCK_PORTS`. Zero-length normalize returns a zero vector. `pose3d.rotation.order` defaults to `"XYZ"`.
- `control`: Previous, Value Changed, rising/falling edge, debounce, hysteresis, pulse, stopwatch, moving average, median filter, slew rate, integrator, derivative, and PID controller. Every `dt` port is explicit; negative or non-finite `dt` fails the script before runtime state mutates. These blocks do not replace `sensorflow` LowPass/RateLimiter.
- `program`: program input/output units. Program I/O may expose `unit` and `actor_command`.
- `signals`: read/write and inspect signal-store values. Write Signal exposes identity `value` plus `then`.
- `topics`: topic snapshots, fields, staged publish messages, metadata, and stale gates. Stage Publish exposes `path` plus `then`.
- `simulator`: path-configured vehicle, device, simulation, scenario, and object snapshots, plus typed adapters (`VehicleStateBlock`, `DeviceStateBlock`, `SimulationClockBlock`, `ScenarioStatusBlock`), Sample Road, Road Cross Section, Get Nearest Road, Spawn Prop, Scatter Features, General Attachment, Road Attachment, Group Attachment, Building Attachment, Intersection Attachment, Prop Attachment, Asset Attachment, Place Feature, Clone Object, and Create Group. Derive From Attachment remains registered for old graphs and is not placeable. Spawn Prop and Scatter Features upsert onto the episode overlay (`episode:*` ids). They do not write the environment document. Bind scatter graphs to `episode-reset` (`phase: start` on Play / prepare, `phase: stop` on Stop). Sample Road and Scatter Features take `edgeId: road_id`. Get Nearest Road takes `pose:pose3d` and emits the closest centerline `edgeId` (unbounded; missing world is `found:false`). Each attachment block reads one editor host and emits `found:false` when the attachment is missing or the wrong type. General Attachment fits any selected object. A script may declare only one attachment host. Place Feature, Clone Object, and Create Group call `runtimeContext.author` and throw if that host is missing; they write permanent features, clones, and groups only when an object attachment runs the script. Road Cross Section reads a road edge's carriageway `width` and `shoulderWidth` in metres (`found:false` when the edge is missing). Clone Object copies a prop, asset instance, or primitive to `pose`; position and yaw come from the pose, and the prop type, asset pin, scale, and primitive shape, size, color, and tags come from `runtimeContext.lookupObject`.
- `mission`: waypoint, mission state, route progress, scenario flag helpers, actor-command Make/Split, and read-only route helpers. Set Mission State, Scenario Flag Write, and Advance Waypoint expose `then`. Make Actor Command builds `{ actorId, speedMps, steeringRad }` from required `speed`/`steering` and optional `actorId`. Split Actor Command unpacks that value. Route-controller speed/steering mappings remain `float64`. `Waypoint At Index` reads `route.waypoints` (or a bare array) and emits `found:false` plus an empty waypoint out of range. `Split Waypoint` unpacks `id`, `kind`, `position:vec3`, and `order`. `Route Length` wraps `routeLength()`. `Distance To Route End` wraps `distanceToRouteEnd()` (Euclidean 3D to the last polyline point, not remaining arc length; missing polyline becomes `0`). `Route Tangent` wraps `routeTangentAtPose()` and packs the XZ tangent into `vec2` as `{ x, y: z }`. `Frame Along Path` samples a Frenet pose along a route with `percent` in `[0, 1]` and `lateral` metres to the **right of travel**. These wrappers do not mutate routes or manufacture unverified routes.
- `bindings`: signal/tick/timer triggers and input/output/trigger bindings.
- `diagnostics`: probes, logs, assertions, recording/replay, and binding status. Log Signal, Log Message, Assert, and Record expose `then`. Log Message `console.log`s a wired string; it does not write sflog.

## Compileable And Legacy Blocks

Every placeable catalog entry has a backend block class and can compile into a v3 artifact. Frozen v2 artifacts remain runnable.

`CalculationBlock`, `EqualityBlock`, and `ConjugationBlock` remain registered and renderable for old graphs and artifacts, but are deprecated and non-placeable. Atomic replacements live in `math` (`AddBlock`, `SubtractBlock`, …) and `logic` (`EqualBlock`, `AndBlock`, …). `OutputNodeBlock` is also non-placeable because the graph head owns it. `ScaleBlock` stays registered for old graphs (`tex1d`/`scalar` → `result`) but is deprecated and non-placeable; place `ScaleTextureBlock` instead. Texture ops are React-free runtime blocks; none of them perform DOM or canvas work.

## Atomic Scalar And Logic Blocks

React-free classes live in `app/scripting/units/math/ScalarBlocks.block.js` and `app/scripting/units/statements/LogicBlocks.block.js`. React siblings import the same `SCALAR_BLOCK_PORTS` / `LOGIC_BLOCK_PORTS` descriptors. Shared numeric helpers are `finiteFloat()`, `finiteInt32()`, `finiteResult()`, and `orderedBounds()` in `PortTypes.js`, plus `scalarMath.js` for domain-safe ops. Structural comparison is `valuesEqual()`.

Constant blocks (`IntegerBlock`, `BooleanBlock`, `JsonBlock`) read `storedData` and always emit their declared `out` type. `0`, `false`, `null`, and `{}` are legal stored values. `JsonBlock` clones JSON and emits `null` for invalid strings.

Port labels are atomic (`a`/`b`/`value`/`out`). Legacy composites keep `input A` / `result` / `bool a`.

## Conversion, String, JSON, And Array Blocks

React-free classes live in `Conversions.block.js`, `StringBlocks.block.js`, `JsonBlocks.block.js`, and `ArrayBlocks.block.js`. React siblings import the same `*_BLOCK_PORTS` descriptors (or port helpers that take `itemType`/`valueType`). Shared helpers are `ARRAY_ITEM_TYPES` / `asArray()` in `valueOps.js`, `conversionMath.js`, `stringOps.js`, and `arrayOps.js`. JSON path blocks clone with `cloneValue()` and never mutate `getInput()` documents.

`itemType` and `valueType` are editor state, not inference. Changing them goes through `reconfigureUnitDetailed()` so conflicting wires are rejected without dropping connections.

## Geometry And Route Helper Blocks

React-free classes live in `app/scripting/units/geometry/GeometryBlocks.block.js` and `app/scripting/units/mission/RouteBlocks.block.js`. React siblings import `GEOMETRY_BLOCK_PORTS` / `ROUTE_HELPER_BLOCK_PORTS`. Vector math is `vectorMath.js`. Route helpers call `routeLength()`, `distanceToRouteEnd()`, and `routeTangentAtPose()` from `app/scenarios/route/Route.js` without calling `normalizeRoute()` or `normalizeWaypoint()`.

## Temporal And Controller Blocks

React-free classes live in `app/scripting/units/control/TemporalBlocks.block.js` and `app/scripting/units/control/ControllerBlocks.block.js`. React siblings import `TEMPORAL_BLOCK_PORTS` / `CONTROLLER_BLOCK_PORTS`. Shared helpers are `temporalMath.js`.

`dt` is an ordinary `float64` input, not an `execute()` argument. Wire it from a Program Input mapped with binding `source: "sim", key: "dt"`, from `SimulationClockBlock.dt`, or from `SimulationSnapshotBlock`. `requireDt()` throws `${typeId} dt must be finite and non-negative.` before writing instance fields; `dt === 0` is legal. Integrators use forward Euler. PID is derivative-on-error with conditional-integration anti-windup and does not write `actor_command` or the plant. Runtime memory lives in `serializeRuntimeState()` / `hydrateRuntimeState()` and is JSON-cloned. `Previous` / `Value Changed` infer `T` like Equal/Passthrough. These blocks do not replace `LowPassFilterBlock` or `RateLimiterBlock` in `sensorflow`.

## Texture Blocks

React-free classes live in `app/scripting/units/math/tex/Scale.block.js`. React siblings import `TEXTURE_BLOCK_PORTS`. Shared helpers are `textureMath.js`.

`ScaleTextureBlock` takes `tex`/`scalar` → `out`. `MultiplyTexBlock`, `AddTextureBlock`, and `SubtractTextureBlock` take `a`/`b` → `out`. `ClampTextureBlock` takes `tex`/`min`/`max` → `out` and reorders bounds. `InvertTextureBlock` maps each sample to `1 - sample`. Empty arrays are legal. Binary ops throw on unequal lengths. All new ops throw when a sample is non-finite. `MultiplyTexBlock.execute()` still accepts frozen `tex1d_a`/`tex1d_b` → `result` ports via `hasInput` and `setDeclared`. `SampleTextureBlock` (category `sensorflow`) requires a perfect-square length ≥ 1 and finite samples; `x`/`y` clamp to `[0, 1]`.

## Simulator Adapters

React-free classes live in `app/scripting/units/simulator/SimulatorAdapters.block.js`. React siblings import `SIMULATOR_ADAPTER_PORTS`. These blocks only call `manager.readSignal()`; they do not write the store or the kernel.

`VehicleStateBlock` takes `actorId:string` (empty becomes `"ego"`) and reads `vehicles.{id}.pose`, `.velocity`, and `.steeringAngle`. The `steering` port is `float64`; missing steering is `0` and does not flip `exists`. Invalid ids (dots, spaces) emit zeros with `exists:false` and `stale:true`. Ego graphs fall back to `vehicle.ego.*` when the canonical leaf is missing. `DeviceStateBlock` reads `devices.{id}.pose` and `.enabled`; missing enabled is `false`. `exists` follows pose. Values are normalized with `normalizePose3d()` / `normalizeVec3()`.

`SimulationClockBlock` has no inputs. It prefers kernel leafs `simulation.time` / `.step` / `.status` when they exist, uses the bindings blob `simulation.dt` when that blob exists, and otherwise falls back to `simulation.fixedDt` and blob `time`/`step`/`frame`. Missing clock values are `0` / `""`. `ScenarioStatusBlock` reads `scenario.status`, `.terminal`, and `.latestTrigger`, cloning JSON outputs.

## Episode Overlay Blocks

`FrameAlongPathBlock`, `SampleRoadBlock`, `GetNearestRoadBlock`, `SpawnPropBlock`, and `ScatterFeaturesBlock` live in `app/scripting/units/world/WorldBlocks.block.js`. Path math is `app/roads/PathFrame.js`. Get Nearest Road wraps `nearestRoadEdge()` (closest centerline, no paved-footprint gate). Spawn writes `SimulationRuntimeContext.episodeOverlay`, which the kernel applies to physics and CPU LiDAR on reset. Overlay ids use the `episode:` prefix. Missing overlay host throws `Spawn Prop requires an episode overlay (bind the script to episode-reset).` Scatter requires exactly one of `route` or `edgeId`. `worldHash` and frozen `lidarGeometryHash` stay unchanged.

## Repeat and Index

`RepeatBlock` and `RepeatIndexBlock` live in `app/scripting/units/statements/Repeat.block.js`. Repeat takes `count:int32` and `body:unit` and outputs `then:unit`, `count:int32`, and `repeat:repeat_ref`. Count is clamped to 0..256. For each pass, Repeat stores a loop frame `{ index, count }`, clears the cached outputs of the pass set, and pulls `body`. `then` fires after the last pass, including when count is 0.

Index takes `repeat:repeat_ref` and outputs `index:int32`, `count:int32`, and `t:float64` (`index / max(count - 1, 1)`, so the last pass reaches 1). Index never pulls its `repeat` input; it reads the frame of the Repeat on the other end. Outside an active pass it throws `Index read outside its Repeat.`

The pass set comes from `loopPassUnits()` in `app/scripting/runtime/LoopFrames.js`. Inside the body region (everything upstream of `body`), it contains the blocks downstream of this Repeat's Index blocks plus the `unit` chain that ends at `body`. Other body-region blocks are pulled by data only and run once per evaluation, so a Create Group whose `id` feeds the body makes one group. Wire setup blocks by data, not by `then`, to keep them out of the pass. Nested Repeats each clear and read their own frame.

Saved scripts that contain the removed `RepeatProgramBlock` fail to load with the unknown-block error and must be rebuilt with Repeat and Index.

## ROS Blocks

`app/scripting/units/ROSUnit.js` still contains placeholder ROS input/output blocks, and those block classes are registered. They are not currently exposed in `UnitCatalog.js`. Topic-oriented scripting work now appears in the `topics` category through signal blocks.

## Program Blocks

`app/scripting/units/program/ProgramIO.js` provides:

- `OutputNode`: default canvas output node controlled by the right sidebar (and `graph.outputNodeConfig` for MCP).
- `Program Input`: exposes external inputs to compiled programs.
- Compiled program wrapper helpers for importing artifacts as reusable blocks.

Program block behavior is central to compiled artifact interfaces, so update tests when changing it.
