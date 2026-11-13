# Native Protobuf mapping

ZPB-04 establishes the native local boundary. Live Zenoh browser, native SHM
and headless controller sessions are the separate ZPB-05–07 gates. The default
run writer remains v12 until the ZPB-08 consumer migration.

## Native documents and products

Run-manifest v13 topics carry `valueContract:{id,version:1}`. They contain no
`type` or `schema`; sensors also omit `schema`. `NativeTopicContracts.js`
defines and validates IMU, GNSS, odometry, measured/semantic points, image,
camera calibration, 2D/3D detections, lanes, traffic controls, transforms,
clock, goal, diagnostics, control commands and simple scalar/vector/byte values.
The exact used shape closure is `resolved.nativeTopicContracts:{document,hash}`.

Positions, vectors and quaternion orientations use REP-103. Times are integer
simulation nanoseconds. Measured points own packed `Float32Array` positions
(xyz triples) and intensities plus `count`; semantic points also own instance,
semantic and ray-index arrays. Images own bytes and declare dimensions,
`pixelFormat` and `strideBytes`. Native capture never constructs a ROS wrapper.
Heavy values retain one immutable reference; later captures own new buffers.

`NativeSensorProducts.js` uses the existing measurements. The LiDAR path uses
one noise/dropout pass for native products and measured observations. Browser
state sensors publish native products; headless state-topic publication is
deferred to ZPB-07. Camera and LiDAR browser/headless managers select the same
builders. Device signals retain native values, independent of Protobuf bytes.

## Interface@2 mappings

Interface@2 retains exact schema descriptors, route IDs, selected message types,
keys and bootstrap records. Its mapping supports:

```json
{ "fields": [
    { "to": "speed_mps", "from": "value.linearVelocity.x" },
    { "to": "yaw_rad", "from": "value.pose.orientation", "operation": "quaternionYaw" },
    { "to": "time_ns", "from": "metadata.captureTimeNs" },
    { "to": "run_id", "from": "run.runId" }
] }
```

Assignments select exactly one of `from`, `value`, or `each`.
Use `to:""` for a whole-value assignment, including scalar/byte native inputs;
it cannot overlap other assignments. Byte constants use integer arrays in 0–255.
Numeric sources can apply finite `scale` and `offset`. Exact 64-bit integers remain decimal
strings; unsafe narrowing fails. Ordinary absent proto3 scalars use wire
defaults, while absent optional/message fields remain absent. No assignment
can descend through a repeated field or map. Use a repeated projection:

```json
{ "to": "points", "each": { "from": "value.points", "fields": [
    { "to": "x", "from": "item.x" },
    { "to": "y", "from": "item.y" },
    { "to": "z", "from": "item.z" },
    { "to": "intensity", "from": "item.intensity" }
] } }
```

Measured/semantic point contracts expose the virtual `value.points` collection
without requiring a local message object per point. All output arrays/messages
are owned by the mapping call. Subscriber mappings must cover required native
fields and produce a fully valid native value.

`bindings:{vehicleId,sensorId,rearWheelIds}` explicitly selects resolved actors,
calibration and an optional fixed rear-wheel pair. Available binding values are
`bindings.vehicle.{wheelbase,length,width,rearAxleInBase}` and
`bindings.sensor.{poseInRoot,rootFrameId,frameId}` plus `poseInBase`/`poseInRearAxle`
for vehicle mounts or `poseInMap` for map mounts. Ambiguous or
incompatible geometry fails compilation. `derived` entries have an ID and one
fixed operation; later entries/fields can read `derived.<id>`. The only operations
are `quaternionYaw`, `poseAtOffset` (`offsetFrom`) and `frameTransform`
(`fromFrame`,`toFrame`). Poses require finite coordinates and unit quaternions.
`run.*` reads frozen resolved fields; execution hashes are unavailable.
No adapter registry, expressions, source evaluation or dynamic imports exist
in this native mapping path.

## Publication and inbound admission

`compileMapping(admittedRoute,{resolvedRun,runId})` builds execution-only typed
paths/bindings; `applyMapping(compiled,{value,metadata})` returns an owned value.
`ProtobufRouteRuntime.configure({resolvedRun,runId,publicationPort,inputQueue})`
compiles topic and concrete-key indexes. `publishTopic(envelope)` maps and
encodes at delivery. An envelope contains `topicId`, `valueContract`, `value`
and metadata for run/frame/capture/delivery/step/sequence identity. The injected
port receives `{key,bytes,routeId,generation}` and must synchronously return
`true` or `{ok:true}` for acceptance. A Promise is invalid. There is no outbound
queue and telemetry retention is not a transport queue.
All mappings for one topic validate before transport acceptance; their temporary
encoded payloads have a 64 MiB aggregate bound per synchronous call.

`deliver({step,timeNs})` sends each bootstrap once per reset when `repeatMs:0`.
Repeating bootstraps use integer simulation time, coalesce missed intervals and
send at most once per call. An empty bootstrap mapping sends the typed value
unchanged. `reset()` increments generation, clears inbound state and restarts
bootstrap lifetime; `dispose()` invalidates indexes and callbacks. Transport
subscription callbacks must retain and pass their configure-time generation.

`acceptInbound(routeIdOrKey,bytes,{clock,generation})` bounds decode to 16 MiB,
validates/mapping-checks the native result and enqueues it for `clock.step+1`.
Queue admission rejects the newest sample when full; accepted entries remain.
Successful admission returns `accepted:true,applied:false`. Kernel routing,
authority/deadline checks and actuator application happen during the next step.

Native `cev.control-command@1` fields are `runId`, `mode`, exact decimal-string
`sequence`, `captureTimeNs`, `deadlineNs`, `frameId`, `speedMps`,
`accelerationMps2`, `jerkMps3`, `steeringRad` and `steeringRateRadps`. Modes are
velocity/acceleration/stop, steering is positive-left, the frame must match the
controlled base frame, and deadline zero means unset. `ControlRuntime.ingestCommand()`
preserves increasing sequences, authority, delay, limits and stale policy.
Native fallback setpoints use the same SI field names without identity/time fields.

## Reviewed adoption

Storage exposes `planNativeRunMigration(id,{mappingOverrides,scriptPaths})`,
`validateNativeRunMigration(plan)` and
`applyNativeRunMigration(id,{plan,expectedRevision})`. REST endpoints are
`POST /run-manifests/:id/native-migration/{plan,validate,apply}`. MCP tools are
`run_manifest_{plan,validate,apply}_native_migration`.

Previews list changed topic contracts and blocked paths. Explicit mapping
replacements are keyed by route ID. Graph selector bindings are keyed by source
script ID and node UUID, with exact topic IDs as values. Adoption checks source
content/revision and the reviewed resolved dependency hash, archives original manifests/interfaces/scripts under
`native-run-migrations/<archiveHash>.json`, preserves descriptor bytes, recompiles
supported graph sources into new IDs, updates parameter/artifact/binding references
and binding hash pins, and finally publishes the manifest revision. Binding selection
is frozen to the reviewed embedded set, including an empty set.
Unknown custom schemas/graphs, unbound selectors, plugins, scenario consumers and
library bindings block adoption. Embedded topic/signal inputs and topic outputs
also block until ZPB-08; constant/simulation inputs with simulation triggers and
signal outputs can migrate. Existing compiled artifacts are never rewritten.
Further consumer migrations and the default writer change belong to ZPB-08.
