# Rigid body components

Optional Rapier rigid bodies on environment objects. This is not a `PHY-*`
milestone. Kinematic and dynamic-bicycle vehicles keep their sweep with
Rapier gravity off, and both characterization tapes stay pinned. The separate
`RZ-*` program permits Rapier gravity and drive contact for contact-v2 vehicles.
RZ-01 establishes identity and admission. RZ-02 builds the floor, obstacle
hulls, and road trimeshes. RZ-03 puts the contact vehicle on a dynamic Rapier
chassis, which pushes props through Rapier instead of the hull impulse.
RZ-04 deletes the JavaScript contact integrator.

## Contract

Hosts are `primitive`, `asset-instance` with a collision proxy, and
`builtin-prop`. The component is `components.rigidBody`:

```js
{
  bodyType: "dynamic" | "kinematic",
  mass: 1,
  useGravity: true,
  linearDamping: 0,
  angularDamping: 0,
  constantForce: { x: 0, y: 0, z: 0 }
}
```

Add, remove, and edit go through `addRigidBody`, `removeRigidBody`, and
`setRigidBody` on the CommandBus. The authored transform is the reset pose.
The live pose is not written back into the environment document.

`createWorldDescription` adds `rigidBodies` only when at least one component
exists. The entry stores the component, the spawn frame, and local collider
parts taken from the primitive, the prop metric cuboid, or the asset collision
proxy. A world with none of these keeps its previous description and
`worldHash`.

Dynamic bodies use the existing Rapier world gravity. Kinematic bodies and
`useGravity: false` set gravity scale to 0. `applyForce` and `applyImpulse`
queue until the next physics step. The floor slab is built whenever the document floor has a finite height,
including a world with no rigid bodies. Turning the collider off keeps the
slab for `CHASSIS_GROUP` and removes `DYNAMIC_GROUP`, so props fall
through it. Sweep-driven vehicles stay kinematic, so the floor and the
road meshes do not hit them. A contact chassis is dynamic and collides
with the floor, roads, obstacles, other cars, and props. Static obstacles are convex
hulls, or one convex prism per footprint triangle. Legacy environment
boxes stay bounds cuboids. Drivable surfaces become fixed trimeshes only
when a contact vehicle is in the run. Those meshes use `ROAD_GROUP`
membership and `CHASSIS_GROUP` filter, and stay out of the contact-id map.
`worldHash` does not change. A world with `rigidBodies` hashes
`staticCollision` into its physics config. A world without them keeps the
previous config hash. The vehicle
hull sweep treats a rigid body as another obstacle for kinematic and
dynamic-bicycle cars. A contact chassis skips that sweep; Rapier pushes the
crate. A kinematic hit that still has time left stops the car short of the
body. A dynamic body already overlapping the hull is moved out along the
sweep normal, including up, and the sweep-driven car keeps the part of the
step that does not enter it. That overlap does not also take the
closing-speed impulse. A separated approach still gives the body an impulse
for the remaining closing speed along the contact face. A vertical face falls
back to the horizontal direction from the vehicle origin to the body. A
kinematic plant receives the clamped pose and keeps its commanded speed.

With `modules.vehicles: false`, contact chassis hold their pose as
position-based kinematic bodies, keeping their colliders enabled. Dynamic
props still move and collide with the held chassis when physics steps.
Re-enabling restores the chassis's saved linear/angular velocity without
catch-up motion. Teleports update the held pose; reset and disposal discard
the saved motion. The general physics flag remains separate from vehicle
admission.

Editor Play, when no run is resolved, steps that live world description.
Entered from stopped, it rebuilds rigid bodies at the authored pose before
stepping. Pause then Play leaves them where they are. Stop, reset, and
entering the environment editor put each rigid-body mesh and its Rapier
body back on that authored transform. A resolved run keeps the world it
was prepared with.

CPU LiDAR uses the original static index while bodies remain at spawn. For
moving bodies, a capture updates changed triangle ranges and refits affected
nodes in one reusable world-space BVH. The headless sensor manager and browser
device database forward immutable per-object poses, including to Helios.
Browser GPU LiDAR updates registered primitive and asset-lidar slots immediately
before a scan consumes them. Receipt of a pose and viewport presentation do not
rebuild shader solids. Stop, reset, and editor entry restore authored vertices.
Resolved LiDAR resources and `lidarGeometryHash` remain authored and immutable.
Camera motion is separately versioned by the run's `cameraObjectMotion` policy;
absent policy retains historical authored captures. The live camera contract is
recorded in the visual-layer plan.

## Progress and decision log

### 2026-11-10 — Rigid-body performance packages

The performance trace attributed 94.18% of sampled frame work to two copies of
the browser LiDAR solid sync, rather than the Rapier step. WP01 adds reporting
for both synchronous and asynchronous simulation advances and deterministic
1,000/5,000-triangle fixtures. WP02 indexes texture slots and captures authored
geometry at registration. WP03 tracks scalar pose revisions per object and
removes LiDAR work from viewport presentation. WP04 defers hidden-solid writes
until a consuming scan; unchanged poses and spawn-only bodies write no slots.
WP05 reuses the CPU combined BVH, updates changed body ranges, and refits their
nodes. WP06 retains pooled GPU geometry and exact shader specializations with
bounded resource accounting. WP07–WP09 introduce opt-in, hash-bound live camera
motion and make it the default for newly authored runs; their contracts and
acceptance are recorded in the visual-layer and run-manifest documentation.

The deterministic motion benchmark is `npm run benchmark:rigid-body-motion`.
It measures changed and unchanged browser geometry preparation separately from
GPU rendering. CPU timing is diagnostic and is not evidence for native GPU
frame-rate acceptance. Existing world, solver, plant, and characterization
identities remain pinned. Hosted, NVIDIA, Jetson, and native browser performance
acceptance require their own recorded evidence.

Final maintenance verification: `npm run lint` passes with three existing
warnings. `npm test -- --test-concurrency=2 --test-timeout=120000` passes
2,711 cases with nine hardware/toolchain skips and zero failures. The isolated
production build passes. All seven pinned
characterization checks pass without fixture changes. Browser, direct headless,
CLI, gRPC, and Python parity and the quick lifecycle soak pass. Browser reporting
and presentation checks pass, as does isolated PBR cloud pixel/depth/ID parity.
The 5,000-triangle local preparation benchmark measured about 6.3 ms at the
median for changed poses and 0.003 ms for unchanged poses; this is diagnostic
CPU preparation timing, not a frame-rate or GPU acceptance claim.

### 2026-11-10 — Contact host uses the resolved vehicle physics configuration

The contact chassis now shares the immutable configuration used for its WASM
parameters and tire forces. Plugin mass/inertia are no longer substituted with
full-size defaults. New contact-plugin execution records use `contactHost: 3`;
historical host-2 records remain inspectable/importable but require re-resolution.
Rigid-body components, collider geometry, gravity, world hashes, and pinned
motion tapes do not change. The working packages and verification are recorded
in [`vehicle-physics-configuration-plan.md`](vehicle-physics-configuration-plan.md).

### 2026-11-09 — LiDAR follows a rigid body that leaves its spawn pose

The kernel already published rigid-body poses at the sensor step. The
headless manager now forwards them to CPU LiDAR, Helios, and GPU LiDAR.
The browser device database forwards them to the Helios runtime and writes
the same pose into primitive and asset-lidar slots before the GPU scan.
Headless GPU LiDAR copies moved static triangles into the capture frame and
leaves camera jobs on the authored geometry. Restore puts those slots
back. `lidarGeometryHash`, `worldHash`, and the characterization tapes stay
unchanged.

### 2026-11-09 — authored pose returns on stop, reset, and the editor

The viewport mesh follows the live Rapier pose only while Simulation is
playing or paused. Stop, reset, and entering the environment editor put
the mesh and the Rapier body back on the authored transform. The document
is not written. Pause inside Simulation still resumes in place. `worldHash`,
the rigid-body component, and the characterization tapes are unchanged.

### 2026-11-07 — RZ-04 review: disabled chassis do not integrate

The shared runtime forwards vehicle admission independently of the sweep
flag. A disabled contact chassis becomes position-based kinematic, so
gravity, inertia, drive forces, and prop impacts cannot move it. Its collider
still stops dynamic props and publishes contacts. Re-enabling restores saved
body velocities. Reset/disposal clear the saved state. `worldHash`, the
rigid-body component, and both older pinned tapes are unchanged. Verification
and the separate kinematic acceptance blocker are recorded in the physics
plan's RZ-04 review entry.

### 2026-11-07 — RZ-04 contact motion is Rapier only

The JavaScript contact integrator, settle, and floor catch are gone. A contact
chassis still pushes props through Rapier. Kinematic and dynamic-bicycle cars
keep the sweep. `worldHash` and both pinned tapes stay unchanged.
Verification on 2026-11-07 matches the physics-plan RZ-04 entry.

### 2026-11-07 — RZ-03 chassis pushes props through Rapier

A contact vehicle is a dynamic Rapier body. It no longer queues a closing-speed
impulse or separates crate overlaps from the hull sweep. Rapier resolves the
chassis against dynamic props, and `contactPairsWith` reports `vehicle|crate`
through the existing contact-id map. Kinematic and dynamic-bicycle cars still
use the sweep push. `worldHash` and both pinned tapes stay unchanged. Release
waits for RZ-04.

### 2026-11-07 — worlds with props get a new physics config hash

Obstacle hulls, the always-on floor, and collider creation order change
where a prop stops. A world with `rigidBodies` now hashes `staticCollision`
(`obstacle-hull-prisms-v1`) on top of the existing config, so an old bundle
must be re-resolved. Worlds without props keep `PHYSICS_BACKEND_CONFIG` and
`PHYSICS_BACKEND_CONFIG_V2` and their hashes. Road trimeshes are built only
when a contact vehicle is present. The sweep-driven vehicle collider stays
on Rapier's default groups, because a kinematic body does not contact a
fixed body.

### 2026-11-07 — RZ-02 gives Rapier the static world

The floor slab is created for every finite ground plane, including a world
with no rigid bodies and a floor whose collider is switched off. An off
collider collides with `CHASSIS_GROUP` only. Sweep-driven vehicle colliders
use `DYNAMIC_GROUP` membership so they stay out of those filters. Static
obstacles use the convex mesh or per-triangle prism the sweep already
tests. Legacy environment boxes stay cuboids. Each drivable surface becomes
one fixed trimesh for `CHASSIS_GROUP` only, and those colliders are not
contact ids. `worldHash`, backend hashes, and both pinned characterization
tapes stay unchanged. The contact chassis is still RZ-03.

Verification on 2026-11-07: `npm run fixtures:headless` rewrote only the
already-known kinematic steering-sign mismatch, which was discarded. The
dynamic-bicycle and contact tapes had no delta. `npm test` passed 2,570,
failed the same kinematic characterization check, and cancelled one unrelated
storage-timeout test.

### 2026-11-07 — RZ-01 versions the contact host

Vehicle `contact-bicycle-v2` and resolved contact-plugin `contactHost: 2`
identify the separate Rapier chassis transition. The plugin force declaration
stays `contact-bicycle-v1` on ABI 1; saved locks and package hashes do not
change. Raw legacy built-in contact records and unmarked contact-plugin
records require re-resolution before execution, while integrity inspection
and authoring import remain available. The shared guard covers root and
nested scenario vehicles and preserves an active run on failed preparation.
RZ-01 retains the JS contact integrator and changes no collider, gravity,
rigid-body component, backend config, `worldHash`, or recorded motion samples.
The pre-existing kinematic steering-sign characterization mismatch remains
a separate acceptance blocker; neither pinned older tape may be repinned.

### 2026-10-20 — component, Rapier step, CPU LiDAR

The inspector can add and remove the component on the three hosts. Physics
steps dynamic and kinematic bodies, and CPU LiDAR follows the live pose.
`VEHICLE_PLANT_VERSION` and the kinematic characterization tape are unchanged.

### 2026-10-20 — CPU LiDAR capture cost

Each rigid body keeps the index built from its authored triangles. A capture
inverts that body's pose once and transforms the ray. The static index is
rebuilt only when the set of body ids changes. Each index returns its nearest
hit, and an exact distance tie still uses primitive id then triangle index.
The LiDAR buffer, the resolved resource, and `lidarGeometryHash` are unchanged.

### 2026-10-21 — one rigid-body index per scan

Moved bodies are baked into a single world-space index when a capture runs,
and that index is reused while the poses stay the same. A scan whose bodies
are all still at spawn queries the original static index. On a 32 by 1024
scan over 1,000 triangles, four moving boxes dropped from 25.6 ms to 17.0 ms.
The same four boxes at spawn take 12.7 ms, and a scene with no rigid body
takes 10.8 ms. The LiDAR buffer is unchanged.

### 2026-10-21 — floor collider toggle

The Floor inspector can turn the Rapier floor collider off. The document
stores `collider: false` only in that case, and `groundPlane` carries the
same flag, so that world's `worldHash` changes. LiDAR, the checker, and the
vehicle support plane stay. An enabled floor with the collider left on keeps
its previous description and hash.

### 2026-10-21 — object scripts write the component

Make, Split, Get, and Add Rigid Body are scripting canvas blocks. Add records a `put-rigid-body` op. `putRigidBody` writes the same `components.rigidBody` the inspector writes. The component schema and the kinematic characterization tape are unchanged.

### 2026-10-21 — vehicle push matches closing speed

A dynamic body is pushed by the remaining closing speed along the sweep's contact face, so holding the car against a block does not stack speed. Editor Play from stopped rebuilds bodies at the authored pose when no run is resolved. The component schema, `worldHash` rule, and kinematic characterization tape are unchanged.

### 2026-10-21 — a fallen cube no longer pins the car

A nested kinematic plant takes the clamped pose and keeps its commanded speed. The Rapier car collider follows the sweep center and yaw, so a box rests on the roof. A cube that already overlaps that roof is lifted out along the normal, and the car keeps the motion that does not enter it. `worldHash` and the kinematic characterization tape are unchanged.
