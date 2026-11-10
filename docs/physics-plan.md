# Vehicle physics roadmap

The `PHY-*` program adds a built-in JavaScript dynamic bicycle: gravity along
the road and tire friction at the two axles. It is not headless PR 13, and it
does not renumber the headless, visual-layer, environment-editor, plugin,
marketplace, or planner programs. Object rigid bodies live in
[`docs/rigid-body-plan.md`](rigid-body-plan.md) and leave this bicycle and the
kinematic characterization tape unchanged.

This revision (2026-10-19) replaces an earlier PHY-01–07 ladder. The product
ask is only to model gravity and friction at the two bicycle axles. Do not
model wheels as springs. A raycast chassis, true contact, world-varying mu,
and Pacejka are deferred. They are not part of this program.

## What prompted this

The program started from wanting real vehicle physics: gravity, colliders, and
whether wheels should roll. A later conversation with someone at Southwest
Research Institute (SWRI) argued that Unity and Unreal are attractive because
ground contact is already built in.

That remains the right pressure (do not invent a general contact solver) and
the wrong conclusion (do not adopt Unity or Unreal, and do not turn Rapier
into a vehicle-dynamics package). Ground is a query. Tire forces live in the
plant. Obstacle contact stays the existing hull.

The scale of this sim does not need sprung wheel colliders. The first useful
ego model is acceleration and steer in, two-axle lateral dynamics, and
gradient resistance from the road. A suspension layer is explicitly later.
This program does not take that layer.

## Status

| Milestone | Implementation | Verification |
| --- | --- | --- |
| PHY-01: contracts | Complete | `tests/physics-contract.test.js`; characterization delta empty |
| PHY-02: dynamic bicycle plant and controls | Complete | `tests/dynamic-bicycle.test.js`; obstacle clamp in `tests/oriented-vehicle-collision.test.js`; kinematic tape unchanged |
| PHY-03: sensors and a second characterization tape | Complete | `tests/localization-sensors.test.js`; browser/headless parity in `tests/headless-vehicle.test.js`; `tests/dynamic-bicycle-characterization.test.js`; `characterization.v1.json` unchanged |

## Rapier contact transition (`RZ-*`)

This separate program moves only contact vehicles onto a Rapier chassis.
The restrictions on Rapier drive contact and gravity below continue to apply
to the PHY kinematic and dynamic-bicycle plants. Their motion and both tapes
stay pinned. Suspension, wheel spin, and per-wheel rays remain out of scope.

RZ-01 prepares identity and admission. RZ-02 builds the floor, obstacle
hulls, and road trimeshes. RZ-03 puts a contact vehicle on a dynamic Rapier
chassis. RZ-04 deletes the JavaScript contact integrator and records
`characterization.contact-bicycle.v2.json`.

| RZ-01 work package | Implementation | Acceptance |
| --- | --- | --- |
| WP01: compatibility baselines | Eight pre-change full, semantic, episode, and vehicle hashes captured | Historical root/nested bundles remain inspectable |
| WP02: model/ABI split | Vehicle model v2; authoring v1 dynamics migrate during normalization and resolution | Plugin force ABI/model stays v1 |
| WP03: plugin host identity | Resolved vehicle record carries `contactHost: 2` | Root/nested semantic vehicle hashes bind it |
| WP04: execution admission | Shared bundle/kernel guard, before vehicle normalization or active-run teardown | Old bundles require re-resolution; inspection/import remain available |
| WP05: regression coverage | Migration, integrity, admission, recovery, dispatch, and plugin parity tests | Verification recorded below |
| WP06: guidance and release gate | Physics/rigid-body/plugin and manifest contracts updated | RZ-04 evidence, historical pins, and reviewed current-runtime v2 gate required |

| RZ-03 work package | Implementation | Acceptance |
| --- | --- | --- |
| WP01: chassis body | Dynamic Rapier body, cuboid at the tread, `rapierChassis` claim | Dispose releases the plant; kinematic cars stay on the sweep |
| WP02: tire step | Downward ray on `FLOOR_GROUP \| ROAD_GROUP`, `contactTireStep` / `contactChassisPush` | Resting car stays in contact; unresolved plugins apply no tire force |
| WP03: copy-back | Skip sweep for chassis, zero-roll projection, rest rules, full body sensor vectors | Steer sign matches the JS integrator; inertial IMU acceleration is not corrected twice |
| WP04: contacts | `contactPairsWith` through `colliderContactIds` | Wall and crate report start/end; roads stay unreported |
| WP05: module admission | Shared facade forwards sweep and vehicle flags; kernel steps admitted chassis when physics is off | Disabled chassis hold pose with colliders retained; enabled chassis still move without the sweep |
| WP06: coverage and docs | `tests/contact-chassis.test.js`; physics/rigid-body/architecture notes | Pinned kinematic and dynamic-bicycle tapes unchanged |

## What is modeled

A single-track dynamic bicycle on the paved surface. Two axles, one center of
gravity. Planar dynamics are in the road-tangent frame. Kinematic and
dynamic-bicycle pose Y and pitch still come from the existing road sampler.
That drape is a kinematic constraint, not suspension. A `contact-bicycle-v2`
vehicle is a dynamic Rapier chassis: Rapier owns gravity, landing, walls, and
crates, and JavaScript applies only the tire pushes.

States are body-frame `vx`, `vy`, and yaw rate `r`, plus world `X`, `Z`, and
yaw. Kinematic and dynamic-bicycle pitch is sampled, not a dynamic state.
A contact chassis takes pitch from Rapier with roll projected to zero.

Inputs are the applied front steer `δ`, already delayed and limited by
`ControlRuntime`, and a longitudinal acceleration command `ax_cmd`. Velocity
mode becomes a speed loop that outputs `ax_cmd`. It does not write
`velocity.x = speed`.

Manifest parameters, with defaults: mass `m` = 1500 kg, yaw inertia `Iz` =
2250 kg·m², front and rear cornering stiffness `Cf` and `Cr` = 80000 N/rad,
friction coefficient `μ` = 0.9, rolling-resistance coefficient `Crr` = 0.015,
and `g` = 9.81 m/s². `g` is not a manifest field. `lf` and `lr` are not
manifest fields. PHY-02 derives them from version-3 axles or wheel
`position.x` when those are present, and otherwise splits
`kinematics.wheelbase` in half. An IGVC manifest with `wheels: []` must keep
working.

Modeled forces and moments:

- Gravity along the road, `mg sin(θ)`, from the sampler pitch `θ`. Downhill
  accelerates `+vx`. Uphill (`θ > 0`) opposes `+vx`.
- Gravity into the road, `mg cos(θ)`, sets the static axle normals only:
  `Fzf = mg cos(θ) · lr / L` and `Fzr = mg cos(θ) · lf / L`. This is a
  holonomic road constraint, not a spring. `Fzf + Fzr = mg cos(θ)`.
- Lateral tire force at each axle, `Fy = -C α`, then clipped so
  `|Fy| ≤ μ Fz`.
- Longitudinal friction as one lumped drive/brake force `m · ax_cmd`, plus
  rolling resistance `Crr · mg cos(θ)` opposing `vx`. Scale `Fx` so the
  longitudinal and lateral pair stays inside `|F| ≤ μ Fz`.
- Yaw moment `lf · Fyf · cos(δ) - lr · Fyr`, plus the steer contribution
  `lf · Fxf · sin(δ)`.

Slip angles, body `+x` forward:

- `αf = arctan((vy + lf · r) / vx) - δ`
- `αr = arctan((vy - lr · r) / vx)`

Guard `vx ≈ 0`. At rest the lateral force is 0. There is no divide-by-zero.

Newton–Euler in the body frame, integrated by the plant:

- `m (v̇x - r vy) = Fxf cos(δ) - Fyf sin(δ) + Fxr - mg sin(θ)`
- `m (v̇y + r vx) = Fxf sin(δ) + Fyf cos(δ) + Fyr`
- `Iz ṙ = lf (Fxf sin(δ) + Fyf cos(δ)) - lr Fyr`

The sign on `mg sin(θ)` follows the road sampler. `pitchFromTangent` is
`atan2(rise, run)` along the vehicle heading, so a positive pitch is uphill
and opposes `+vx`. Use the trigonometric form in the integrator. The
small-angle form is acceptable only for tests at modest steer.

World motion keeps the kinematic plant's yaw convention:
`Ẋ = vx cos(ψ) - vy sin(ψ)` on Z. Keep the Y/pitch drape and the existing
oriented-box obstacle clamp. After a clamp shortens the pose, zero or project
`vx` and `vy` so the next step does not drive back into the wall. Do not add a
contact solver.

## Free-body diagrams

Forces live in the road-tangent frame. The vehicle is a rigid bar `lf + lr`
with the center of gravity between two axle patches. The road normal replaces
any spring.

```mermaid
flowchart TB
  subgraph side [Side view along the road]
    rearS[Rear axle] --- cgS["CG m"] --- frontS[Front axle]
  end
  gAlong["mg sin theta along road"] --> cgS
  gInto["mg cos theta into road"] --> cgS
  Nf[Fzf normal] --> frontS
  Nr[Fzr normal] --> rearS
  Fxf[Fxf drive brake roll] --> frontS
  Fxr[Fxr drive brake roll] --> rearS
```

```mermaid
flowchart TB
  subgraph top [Top view]
    rearT["Rear Fyr Fxr"] --- cgT["CG m Iz"] --- frontT["Front Fyf Fxf delta"]
  end
  Fyf["Fyf = clip of minus Cf alpha_f"] --> frontT
  Fyr["Fyr = clip of minus Cr alpha_r"] --> rearT
  yawM["Mz = lf Fyf cos delta minus lr Fyr"] --> cgT
```

Normal forces are not spring forces. If an axle would need `|F| > μ Fz`,
saturate. There is no vertical ODE.

## Explicitly not modeled

- Suspension springs, dampers, droop, or per-wheel load from travel
- Four separate wheels, wheel spin, drive shafts, or engine and brake maps
- Longitudinal load transfer and roll or camber
- Full Pacejka or TMeasy, and world-varying mu
- Airborne 6-DOF; Rapier dynamic vehicles and road-mesh drive contact for the
  kinematic and dynamic-bicycle plants (contact-v2 belongs to `RZ-*`)
- Replacing `tests/fixtures/headless/characterization.v1.json` in place

## Architecture

```mermaid
flowchart LR
  controls[ControlRuntime ax_cmd and delta] --> plant[Dynamic bicycle plant]
  plant --> collision[Existing OBB sweep clamp]
  collision --> sensors[IMU GNSS wheel odometry]
  road[Road sampler theta and Y] --> plant
```

`KinematicVehiclePlant` stays `motionModel: "bicycle"` for characterization,
scenario keyframes, linear motion, and a plugin plant. `dynamic-bicycle` is a
sibling branch. `HeadlessVehicleManager` and `attachVehiclePlant` dispatch on
the definition. Do not put the integrator in a Three.js vehicle class. Do not
enable Rapier gravity on kinematic or dynamic-bicycle vehicles. The separate
contact-v2 host belongs to `RZ-*`.

## Model identity

| Id | Meaning |
| --- | --- |
| `kinematic-bicycle-v1` | Current built-in bicycle. Omitted `dynamics` normalizes to this. |
| `dynamic-bicycle-v1` | This plant. Manifest physical fields are filled from the defaults above. The plant integrates and the host drapes height and pitch. |
| `contact-bicycle-v2` | Rapier chassis. JavaScript applies the tire pushes and copies pose back. The plugin force model remains `contact-bicycle-v1`. |

These ids are vehicle-manifest model ids. They are not `backendSelections`
entries, and this program does not add a protobuf backend kind. A dynamic
manifest changes `simulationSemanticHash`, and through it `episodeHash`,
because the resolved manifest is already inside the simulation semantic
projection. An explicit `kinematic-bicycle-v1` hashes the same as omitted
dynamics. `VEHICLE_PLANT_VERSION` stays 1. `PHYSICS_BACKEND_CONFIG` stays as
it is.

`dynamics.plant` cannot be combined with `dynamic-bicycle-v1` or
`contact-bicycle-v2`. A plugin plant replaces the built-in model. The built-in
model is not implemented as a plugin.

New editor vehicles and URDF imports use `contact-bicycle-v2`.
`createBlankVehicleManifest()`, built-in vehicles, documents with omitted or
explicit kinematic dynamics, and `characterization.v1.json` stay on the
kinematic bicycle.
`characterization.dynamic-bicycle.v1.json` stays the draped dynamic plant.
Legacy authoring `contact-bicycle-v1` dynamics normalize to v2, including at
new run resolution without saving the vehicle. Received resolved v1 contact
records cannot execute. `characterization.contact-bicycle.v2.json` is the
chassis motion tape. The v1 contact tape is gone with the JavaScript integrator.

Contact-plugin manifests and saved locks stay unchanged. Their resolved
vehicle records add numeric `contactHost: 3`, derived from the exactly locked
package's selected plant declaration. The semantic lock projection includes
that marker when recomputing vehicle hashes and both root/nested dependency
maps. Ordinary vehicle content hashes still identify manifest plus assets.
Hashing never infers a missing marker, so historical integrity hashes remain
valid. Execution requires the marker; inspection and authoring import do not.

## Locked decisions

### PHY-D01 — JavaScript built-in, plugin override

The dynamic bicycle is a built-in JavaScript plant. `dynamics.plant` remains
an override. It is not the implementation of this model. A plugin may copy
the same equations by setting plant `model` to `dynamic-bicycle-v1`. That
copy does not replace either characterization tape.

### PHY-D02 — Manifest identity, unchanged protobuf

Motion-model identity is the vehicle manifest `dynamics` block. PHY-01 does
not change `headless.proto`, backend admission, or the physics backend config
hash.

### PHY-D03 — Kinematic tape stays the pin

`motionModel: "bicycle"` and `characterization.v1.json` stay the reviewed
historical kinematic contract. `npm run fixtures:headless` never rewrites
that file; its identity ledger checksum remains pinned. The separately
reviewed 2026-11-07 steering-sign transition uses `characterization.v2.json`
for exact current-runtime acceptance. Neither plant integration nor the
dynamic-bicycle-v1 tape changes. The new-run default does not flip in PHY-01.

### PHY-D04 — Two-axle friction, no suspension

Scope is gravity and Coulomb-limited linear tire forces at two axles. Springs,
wheel spin, four-wheel rays, and Rapier drive contact are out of this program.

## Required verification

PHY-01 runs `tests/physics-contract.test.js`, `npm run lint`, `npm test`, and
`npm run fixtures:headless` with an empty fixture delta.

PHY-02 runs `tests/dynamic-bicycle.test.js` and keeps the active kinematic
characterization match plus the historical v1 checksum.

PHY-03 runs browser/headless plant parity at the existing `1e-9` tolerance and
writes a second characterization tape.

## Progress and decision log

### 2026-11-10 — Resolved physics configuration and RC-scale overrides

The vehicle physics configuration work packages are recorded in
[`vehicle-physics-configuration-plan.md`](vehicle-physics-configuration-plan.md).
The six existing physical fields can accompany a plugin `dynamics.plant`.
For a declared standard bicycle model, explicit vehicle overrides win over
declared parameter values, then existing defaults. Unsupported overrides fail
resolution and pre-activation admission. Omitted overrides stay omitted.

`resolveVehiclePhysicsConfig` produces one immutable runtime configuration.
Built-in integration, WASM parameter packing, contact tire forces, and Rapier
chassis mass/inertia consume it. Built-ins retain wheel-derived axle distances;
plugins retain their half-wheelbase ABI. Reset keeps the same configuration.
Explicit physical values must remain positive after six-decimal canonical
rounding; rolling resistance may be zero. Unoverridden plugin parameter
precision is preserved.

The corrected contact host reads plugin mass/inertia rather than substituting
1500 kg / 2250 kg·m². Newly resolved contact-plugin records use numeric
`contactHost: 3`. Historical unmarked/host-2 records remain inspectable and
importable, but execution requires re-resolution before active-run teardown.
Package bytes, force ABI 1, plugin `contact-bicycle-v1`, built-in
`contact-bicycle-v2`, vehicle versions, world hashes, and pinned tapes stay
unchanged. Synthetic 30 cm RC tests prove parameter plumbing and parity, not
real vehicle calibration. No suspension or wheel-spin model is added.

### 2026-11-07 — Separate steering acceptance blocker resolved with v2

The earlier `5304766` control-sign correction is accepted explicitly, not
folded into RZ-04 or implemented again. Current positive-left steering stays
unchanged. `characterization.v2.json` is generated from the existing canonical
action tape and production runtime. A transition test constrains its delta
to artifact version 2, four steering-angle signs, and three trajectory
hashes. All other snapshot, control, input, time, phase, metric, assertion,
and run/action-tape identity fields remain unchanged. Positive, negative, and
zero command signs have independent assertions and real kinematic
browser/headless motion coverage.

The historical `characterization.v1.json` remains byte-for-byte pinned at
SHA-256 `60dc0bd2b02a9ec768f833070ce4d8d2047f5383838f09ea3f130dd31552dd6f`.
The existing identity ledger remains unchanged; release checks retain its
checksum gate alongside exact v2 regeneration. The dynamic-bicycle-v1 and
contact-v2 fixtures are not changed by this maintenance. The generator writes
only active fixtures and both CI drift gates monitor them. This changes the
acceptance baseline, not production steering, plant versions, plugin ABI,
Protobuf, or semantic hash algorithms; it does not certify historical
steering-sign replay. The earlier blocker reports below are historical.

The two Python verification failures were interpreter-selection failures:
they pass with the already installed Python 3.12 project venv. A shared test
helper now follows the parity probe's explicit-PYTHON/project-venv/system
precedence and surfaces errors without falling back or skipping. External
candidate evidence requirements and the three existing hook warnings are
unchanged.

Verification on 2026-11-07 (Node 22.22.2, macOS ARM64):

- Check-fix focused suites: 52 passed, zero failed, two Chromium-gated skips.
- RZ regression suites: 88 passed, zero failed/skipped. Compiled contact
  parity with `CEV_PLANT_CARGO=1`: three passed, none skipped.
- `npm test -- --test-concurrency=4`: 2,611 passed, zero failed, eight existing
  opt-in skips. All three formerly failing checks pass.
- `npm run fixtures:headless` in a disposable copy: zero byte deltas across
  the action tape, historical v1, active v2, dynamic-bicycle-v1, and contact-v2
  files. The older pinned files still match the pre-RZ Git objects.
- `npm run release:check` passes. Separate disposable tampering probes reject
  both historical checksum changes and active v2 snapshot changes; restored
  fixtures pass. Both modified workflow files parse and gate all fixtures.
- `npm run lint`: zero errors, three existing hook warnings.
  `git diff --check` passes. Hosted, hardware, and soak checks were not rerun.

### 2026-11-07 — RZ-04 review fixes: vehicle admission and contact IMU

The real shared runtime facade now forwards physics step options and
`hasChassis()`. Vehicle-module admission is independent of the general
physics/sweep flag. Disabled contact vehicles become position-based
kinematic bodies: their pose is held, tire/plugin execution is skipped,
forces and torques are cleared, and their colliders remain available to
dynamic props. Re-enabling restores saved world linear/angular velocity;
there is no catch-up integration. Teleports replace the held pose and reset
the acceleration baseline. Reset and disposal discard pause state. Saved
pause motion is included in contact physics canonical state.

Contact canonical vehicle state adds REP-103 `bodyVelocity`,
`bodyAngularVelocity`, and `bodyAcceleration`. These are measured from the
post-zero-roll chassis, independently of the tire/controller motion frame.
Origin acceleration is the Rapier world-velocity delta over the fixed step,
projected into the current chassis frame. Contact sensor snapshots use it
without another `omega x v` correction. All three gyro axes and their
capture-interval derivatives reach the existing offset-IMU formula, so pitch
contributes both tangential and centripetal acceleration. Kinematic and
dynamic-bicycle measurements, force ABI 1 and its 13-slot state, model/host
admission, Protobuf, backend identities, and `worldHash` are unchanged.

The contact-v2 tape records pitch and all gyro axes. Its reviewed delta is
limited to the new fields and physical contact sensor measurements. Both
older tapes remain pinned. The pre-existing four steering-angle and three
hash mismatches remain a separate compatibility blocker; RZ acceptance and
release are still pending restoration of that gate without rewriting the
kinematic fixture.

Verification on 2026-11-07 (Node 22.22.2, macOS arm64):

- The focused chassis, kernel, localization, admission/hash, rigid-body,
  collision, URDF, headless, and dynamic characterization suites passed 169
  tests, with no failures or skips. After the contact fixture refresh, the
  final core regression and contact characterization gate passed 64 tests.
- `CEV_PLANT_CARGO=1` passed all three tests in
  `tests/dynamic-bicycle-plant-plugin.test.js`, including the compiled-WASM
  contact parity test; none were skipped.
- `npm run fixtures:headless` succeeded in a disposable copy of the current
  working tree. The reviewed contact-v2 delta contains 21 pitch fields, 42
  gyro X/Y fields, and 53 contact IMU linear-acceleration changes; all existing
  vehicle-motion and wheel samples stay unchanged. The dynamic tape has no
  delta. The known seven-field kinematic delta was not applied. Both older
  tapes still match pre-RZ commit `34d4fbc` byte-for-byte.
- Final `npm test -- --test-concurrency=4`: 2,597 passed, three failed, eight
  skipped. The failures are the known kinematic characterization gate and
  two Python integration checks (`cosmos-clip` and `occupancy-oracle`) whose
  selected Python environment lacks `gymnasium`. The refreshed contact-v2
  characterization passes. No unrelated simulator or dependency repairs are
  included.
- Final `npm run lint`: zero errors and the same three existing hook
  warnings. `git diff --check` passes.

### 2026-11-07 — RZ-04 deletes the JavaScript contact integrator

A contact vehicle moves only as a Rapier chassis. `KinematicVehiclePlant.update`
keeps the steer and longitudinal command and does not integrate. Pose, landing,
and obstacle contact come from Rapier. `characterization.contact-bicycle.v2.json`
replaces the v1 contact tape and is recorded from that chassis. Browser and
headless agree in one process. Cross-OS bit identity is not claimed.
`characterization.v1.json` and `characterization.dynamic-bicycle.v1.json` stay
pinned. The plugin force model remains `contact-bicycle-v1` on ABI 1.

Verification on 2026-11-07: `npm run lint` reported zero errors and the same
three existing hook warnings. `npm test` passed 2,584, failed 4, and skipped
8. The kinematic characterization check in `tests/headless-contract.test.js`
is the known steering-sign mismatch. The other three failures (archive time
budget, glTF validation timeout, and a plugin runtime-cache membership check)
passed when re-run alone. `npm run fixtures:headless` left
`characterization.dynamic-bicycle.v1.json` and
`characterization.contact-bicycle.v2.json` byte-for-byte and rewrote only the
known kinematic mismatch, which was discarded. With `CEV_PLANT_CARGO=1`, the
compiled contact plant matched the built-in chassis at `1e-9`.

### 2026-11-07 — RZ-03 Rapier chassis

A contact vehicle is a dynamic Rapier body. Rapier integrates gravity, lands
on the floor and road trimeshes, and resolves walls, other cars, and crates.
JavaScript computes the four tire pushes from a downward ray and copies pose
and body-frame velocity back onto the plant.

Roll is projected out after each step. Rapier's `setEnabledRotations` locks
world axes, so `(false, true, true)` would lock pitch instead of roll at yaw
90°. Roads use `ROAD_GROUP` so the ray can select floor and road; a handle
set still excludes default-group obstacle cuboids. The plant `update()` path
keeps `stepContactPlant` until a chassis claims it, so the v1 tape and the
plant-only stopping tests stay on the JS integrator. `modules.physics = false`
still steps Rapier while any chassis exists and skips the kinematic sweep.
The collider is a cuboid with Rapier contact skin rather than a round cuboid:
the skin holds the tread above the allowed penetration.

`worldHash`, `PHYSICS_BACKEND_CONFIG`, and both pinned characterization tapes
stay unchanged. Release waits for RZ-04 to delete the integrator and record
the v2 tape.

Verification on 2026-11-07: `npm run lint` reported zero errors and the same
three existing hook warnings. `npm test` passed 2,591, failed the pre-existing
kinematic characterization check in `tests/headless-contract.test.js`, and
skipped 8. `npm run fixtures:headless` left
`characterization.dynamic-bicycle.v1.json` and
`characterization.contact-bicycle.v1.json` byte-for-byte. It rewrote only the
known kinematic steering-sign mismatch, which was discarded.

### 2026-11-07 — props select a new physics config hash

RZ-02 changed where a prop stops: obstacle hulls replace bounds cuboids, the
floor exists without props, and collider order changed. Worlds with
`rigidBodies` hash `staticCollision` onto the existing backend config and
must be re-resolved. Worlds without props keep `PHYSICS_BACKEND_CONFIG`,
`PHYSICS_BACKEND_CONFIG_V2`, and both pinned tapes. Road trimeshes are built
only when a contact vehicle is in the run.

### 2026-11-07 — RZ-02 world colliders

Rapier now builds a floor for every finite ground plane, convex obstacle
shapes in place of bounds cuboids, and one chassis-only trimesh per
drivable surface. Kinematic and dynamic-bicycle motion stay on the sweep.
`worldHash`, `PHYSICS_BACKEND_CONFIG`, and both pinned tapes are unchanged.
Release still waits for the RZ-03 chassis and the RZ-04 tape. The 2026-11-07
fixture run left the two pinned tapes byte-for-byte; the kinematic tape's
pre-existing steering-sign mismatch was regenerated and discarded.

### 2026-11-07 — RZ-01 contact host identity and admission

Split vehicle `contact-bicycle-v2` from plugin `contact-bicycle-v1`. A single
DOM-free guard checks raw root/nested records in bundle execution and kernel
pre-activation. Legacy built-in contact models, missing/unsupported plugin
host markers, and markers on unrelated plants fail with
`UNSUPPORTED_CAPABILITY` and "re-resolve this run". A rejected kernel
candidate is disposed and leaves the active run intact. Integrity-only
inspection and authoring import keep authentic received content unchanged.
Re-resolution migrates old saved contact dynamics and stamps contact-plugin
records without rewriting saved vehicles or reimporting packages.

Vehicle/run-bundle versions, identity profiles, ABI 1 and its 13-slot state,
`VEHICLE_PLANT_VERSION`, package/runtime hashes, backend config, and world
identity are unchanged. RZ-01 changes no tire forces or motion samples.

Before edits, `headless-contract.test.js` failed on four legacy steering-angle
signs and three trajectory hashes after the control-sign correction in
`5304766` (`rep103SteeringToThree` and its inverse became identity mappings).
This is a separate compatibility blocker: the pinned fixture must not be
regenerated to accept it. Resolving that earlier sign-contract change is
separate from RZ-01; production steering and the frozen recorder are unchanged.
RZ-01 implementation is complete, but acceptance and release remain pending
the existing failures below and RZ-02–04.

Verification on 2026-11-07 (Node 22.22.2, macOS arm64):

- `npm run lint`: zero errors, the same three existing hook warnings. ESLint
  on every changed JavaScript file also passes.
- Focused acceptance: 69 passed, zero failed/skipped, including the real
  compiled contact-plugin parity check with `CEV_PLANT_CARGO=1` and the wasm32
  target installed. The exact focused command is:

  ```sh
  CEV_PLANT_CARGO=1 node --experimental-default-type=module --test \
    tests/contact-host-contract.test.js tests/physics-contract.test.js \
    tests/contact-bicycle.test.js tests/contact-bicycle-characterization.test.js \
    tests/dynamic-bicycle-characterization.test.js tests/contact-stopping.test.js \
    tests/dynamic-bicycle-plant-plugin.test.js tests/headless-plant-plugin.test.js \
    tests/plugin-admission.test.js tests/simulation-hashes.test.js \
    tests/vehicle-urdf-import.test.js
  ```

- `npm test` with loopback networking available: 2,549 passed, six failed,
  eight skipped. Besides the pre-existing kinematic characterization failure,
  the control-arc sign assertion, both sensor parent-rotation mock failures,
  and the LiDAR hierarchy-row assertion reproduce on an exported pre-RZ-01
  `34d4fbc` tree. The timeline subscriber-count failure passes in isolation
  on both that tree and RZ-01. No unrelated fixes are included.
- `npm run fixtures:headless`: generator exits successfully. The dynamic
  tape and contact samples have no delta; only the already-known seven-field
  kinematic mismatch is produced. That generated kinematic delta was inspected
  and discarded. Both older tapes remain byte-for-byte committed, and the
  contact fixture has only the reviewed `model` metadata change.
- `git diff --check` passes. Backend config, Protobuf, plugin package sources,
  and the ordinary vehicle plant ABI files have no changes.

### 2026-10-27 — Contact stopping without speed hunting

`run-20261028T014154935Z-da1fd9a3` reaches about -1.00 m/s and then
+0.34 m/s with a zero speed target on the flat floor. The contact plant no
longer uses the legacy one-step speed-error command followed by a jerk clamp.
Its speed/stop loop integrates a critically damped jerk command from speed
error and the previous realized body acceleration. Bandwidth is
`min(4, 2 J / max(A, D, 1e-9), 0.5 / dt)`; acceleration and jerk still obey
the existing actuator limits. Hold and acceleration modes are unchanged.
Loss of contact clears the command and damping feedback; reset and landing
cannot retain an airborne braking sample. Contact canonical state now includes
`axCommand` and `contactControlActive`, which affect subsequent steps.
The shared runtime context retains the complete contact plant snapshot even
when a browser vehicle view exposes only pose/velocity fields; legacy
kinematic and draped dynamic canonical snapshots are unchanged. A focused
40-test snapshot/kernel/determinism/reset/characterization gate passes.

Rolling resistance is bounded by the impulse needed to reach rest after
drive and grade: `clip(-m vx / dt - drive - m gradeX, Crr N)`.
The zero-duration force query retains finite static/friction behavior, while
a zero-duration vehicle update is a no-op. Axle shares, tire friction limits,
gentle-grade support, and downhill motion beyond available friction remain.
All three Rust examples and the local plugin use the same rolling equation.
ABI 1, manifest/Protobuf schemas, model IDs, and `worldHash` are unchanged.

The sanitized `contact-stopping-regression.v1.json` retains the recorded road,
vehicle geometry and 126 keyboard transitions, without sensors or assets.
Stopping tests inspect every step for reversal, command limits, settling and
ten-second rest drift across 10, 16.67, 50 and 100 ms timesteps. They cover
forward/reverse targets, recorded and maximum steering, near-rest rolling,
landing/reset, nondefault limits and browser/numeric replay. Compiled local
WASM matches the JavaScript replay within 1e-9 using identical half-wheelbase
axles; the package cannot read authored asymmetric axle centers through ABI 1.
Regeneration leaves all three characterization tapes unchanged relative to
the preceding contact-support correction, including the contact tape's
acceleration-mode samples. Focused gates pass (40 contact/characterization/
compiled-example checks and 49 stopping/collision/vehicle/sensor checks),
as do the seven native Rust example tests.

Acceptance: the 5,018-step reported-input replay has peak lateral speed
2.437807 m/s during landing, no final-stop reversal beyond roundoff, and
zero measurable displacement over the final ten seconds (speed below
3.5e-15 m/s). The rebuilt/reimported local 0.1.2 kit passes its full native,
tape, predict, wire, Zenoh loopback and compiled-WASM parity suite.
Fresh browser run `run-20261028T020535412Z-cd802b0c`, recording
`log-20261028T020609Z-5y3cmi`, covers 3,970 steps (66.166668 seconds),
reaches +4.999983 and -4.994045 m/s, and stops on the floor at Y 0.0171 m.
Neither release reverses direction; the final ten seconds have exactly zero
logged forward speed and pose drift. A separate steered incline probe,
`run-20261028T020120024Z-cd802b0c`, retains slow cross-slope sliding
(about 0.16 m over ten seconds). Static cross-slope parking is not added by
this correction; the existing cross-slope gravity/sliding behavior is retained.

ESLint passes with the same three existing hook warnings. Full `npm test`
reports 2,411 passed, two failed, two cancelled and eight skipped. The
unrelated artifact deadlines in `run-package-storage.test.js` and
`visual-asset-pack.test.js` pass without full-suite load; the isolated rerun
of those files plus `vehicle-hierarchy.test.js` is 23 passed and one failed,
the same existing LiDAR-zone row assertion at line 21. Neither failure area
was changed for this correction. Both repository whitespace checks pass.
The final full-suite rerun with bounded concurrency
(`node --experimental-default-type=module --test --test-concurrency=4 tests/*.test.js`)
reports 2,415 passed, one failed, zero cancelled and eight skipped. Only the
same hierarchy assertion remains; all artifact deadline cases pass. Final
lint and the local compiled-WASM replay/parity rerun also pass.

### 2026-10-27 — Contact support and reverse-slip correction

The contact model uses the higher road or enabled environment floor, with the
road winning equal surface heights. Tire forces, settling, and floor contact
events use that same choice; a buried road cannot disable floor traction.
The floor's Rapier collider toggle still does not disable vehicle support.
Contact pitch follows the surface normal along the vehicle heading. Its
orthonormal tangent frame includes lateral downhill motion, while visual roll
stays zero. Wheel-cylinder support against that plane determines rest height.
The earlier world-Y-only clearance approximation below is superseded.

Axle slip uses tire-frame velocities and `atan2(v_lateral,
max(abs(v_longitudinal), 1e-3))`. Reverse and zero-forward-speed sliding receive
dissipative friction. A `dt`-dependent impulse limit uses row sums of the
coupled lateral/yaw inverse-mass matrix to prevent low-speed overshoot.
The recorded ramp drop is reduced to `contact-ramp-regression.v1.json`;
browser/numeric replay, passive-energy, support, and tire-force tests cover it.
The contact characterization changes its low-speed steering samples (steps
14-21), replacing alternating saturated lateral accelerations with damped
motion. Kinematic and draped dynamic characterization tapes, model IDs,
`VEHICLE_PLANT_VERSION`, schemas, and `worldHash` remain unchanged.

Acceptance: the compiled contact example and local WASM match JavaScript;
the local kit's full native/tape/predict/wire/Zenoh/parity suite passes.
The original keyboard regression matches browser/numeric state within 1e-9,
peaks at 2.437807 m/s lateral speed during landing, and stops after release.
A fresh browser run, `run-20261028T013057868Z-da1fd9a3`, recorded 3,268 steps
with plugin 0.1.1, reached 4.332591 m/s horizontal speed under forward input,
and finished at zero velocity with origin Y 0.0171 m. Its complete recording
is `log-20261028T013057Z-lekd1k`. Both pinned older tapes have an empty delta.
ESLint reports zero errors and three existing hook warnings. The full Node
suite reports 2,406 passed, eight skipped, and three failures: Marketplace
publisher/CLI timeouts (both files pass separately, 2/2 and 5/5), and the
existing LiDAR-zone row assertion in the unchanged vehicle-hierarchy test
(also fails alone). The 27 focused contact/compiled-plant/oracle checks pass.

### 2026-10-27 — Contact rest height

A contact car whose tire tread hangs below the origin rests that origin on the tread, on the road and on the checker. The hold is the surface plus `groundClearance`, the deepest `radius - axle height`. Clearance is 0 when the tread is on or above the origin, or when the car has no wheels, and then the origin still rests on the surface. The offset is world Y. Kinematic and dynamic cars still rest the origin on the surface. Both older characterization tapes, the contact tape, and `worldHash` stay as they were.

### 2026-10-24 — Contact floor

With the environment floor enabled, a contact car that falls through the checker lands on that plane and can drive. A road underneath still wins. Floor off, and no pavement, the car keeps falling.

### 2026-10-23 — Contact bicycle

`contact-bicycle-v1` returns per-axle forces in the car frame. The host adds gravity, integrates `vx`, right-positive `vy`, yaw rate, pose, and vertical speed, then lifts the car only if the obstacle sweep left it through the pavement. Pitch follows the road ribbon. Roll stays 0. Off pavement the car keeps falling. Drive force is off in the air. `dynamic-bicycle-v1`, both older characterization tapes, and `VEHICLE_PLANT_VERSION` stay as they were. New editor vehicles and URDF imports use the contact model. The three `acme.dynamics` crates emit the same axle forces.

### 2026-10-20 — Plugin copy of the dynamic bicycle

`examples/plugins/acme.dynamics.longitudinal`, `acme.dynamics.cornering`, and
`acme.dynamics.bicycle` copy this plant in stages. The last one matches
`stepDynamicBicycle` when `lf` and `lr` are half the wheelbase. The JavaScript
plant stays the built-in model. `characterization.v1.json` and
`characterization.dynamic-bicycle.v1.json` stay pinned.

### 2026-10-19 — PHY-01

`dynamics.model` accepts `kinematic-bicycle-v1` and `dynamic-bicycle-v1`.
Kinematic normalizes to omitted `dynamics`, so existing manifest hashes stay
put. `dynamic-bicycle-v1` stores mass, yaw inertia, front and rear cornering
stiffness, friction, and rolling resistance, filling the defaults in
`DEFAULT_DYNAMIC_BICYCLE` when a field is omitted. A plugin `plant` combined
with the dynamic model is rejected. The plant factory derives
`motionModel: "dynamic-bicycle"` and copies those fields onto the definition.
`KinematicVehiclePlant` throws for that model until PHY-02 implements the
integrator, so a requested dynamic plant cannot silently run as kinematic.
`VEHICLE_PLANT_VERSION` stays 1. No protobuf or backend-selection change.
Built-in vehicles stay on `bicycle` or `scenario-keyframes`.

### 2026-10-20 — PHY-02

The built-in plant integrates the dynamic bicycle: body `vx`, `vy`, and yaw
rate, gravity from the draped pitch, and Coulomb-limited linear axle forces.
Velocity mode is a jerk-limited speed loop onto `ax_cmd`. Acceleration mode
writes `ax_cmd` and does not snap `velocity.x`. A shortened obstacle step
removes the into-wall part of `vx` and `vy` for this model only. New editor
vehicles and URDF imports store `dynamic-bicycle-v1`. The blank helper,
built-in vehicles, and `characterization.v1.json` stay kinematic.
`VEHICLE_PLANT_VERSION` stays 1.

### 2026-10-20 — PHY-03

IMU and wheel odometry read the dynamic plant. Body `vx`, right-positive
`vy` flipped into REP-103, yaw rate, and the plant's body-component
derivatives feed the existing `ω×v` correction. Kinematic snapshots still
finite-difference `velocity.x` and use `v/L tan(δ)`. Browser and headless
plants match within `1e-9` on the dynamic tape.
`characterization.dynamic-bicycle.v1.json` records that tape.
`characterization.v1.json` is unchanged. `VEHICLE_PLANT_VERSION` stays 1.
