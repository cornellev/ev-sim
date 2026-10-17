# Planner toolkit roadmap

The `PLN-*` program makes the Python package a low-setup client for testing
MPC and global planners (A*, RRT*, and similar) against the authoritative
JavaScript simulator. It is not headless PR 13, and it does not renumber the
headless, visual-layer, environment-editor, plugin, or marketplace programs.

Python remains a client. It does not grow a second simulation kernel.
`measured-state` stays the default observation and keeps its hashes. Oracle
pose is available only through the explicit `planning-oracle@1` profile.

State save/restore, so the simulator can be cloned as an MPC rollout model,
is out of scope and tracked as a later item.

## Status

| Milestone | Implementation | Verification |
| --- | --- | --- |
| PLN-00: roadmap and agent guidance | Complete | This document and `AGENTS.md` |
| PLN-01: zero-config Python launch | Complete | `npm run test:python` |
| PLN-02: world and occupancy helper | Complete | `npm run test:python` |
| PLN-03: `create-bundle` and example bundles | Complete | `npm run test:cli` and `tests/headless-planning-bundle.test.js` |
| PLN-04: `planning-oracle@1` | Complete | headless episode tests; characterization delta empty |
| PLN-05: protocol 1.5 start/goal overrides | Complete | episode, supervisor, and Python integration tests |
| PLN-06: rendering, examples, quickstart | Complete | example smoke runs |
| PLN-07: Python `configure` / `launch` | Complete | `npm run test:cli`, `npm run test:python`, example `00` |
| PLN-08: session clock, loop, and pose readers | Complete | `npm run lint:python`, `npm run test:python` |
| PLN-09: admit a saved environment into the planning store | Complete | `tests/headless-planning-bundle.test.js` |
| PLN-10: start clearance uses physics colliders | Complete | `tests/headless-planning-bundle.test.js`; example bundles unchanged |
| PLN-11: Python occupancy reads those footprints | Complete | `npm run test:python` |
| PLN-12: saved corridor through `create_bundle` | Complete | `python/tests/test_planning_corridor.py` |

## Locked decisions

### PLN-D01 — Oracle pose is opt-in

`planning-oracle@1` adds ground-truth ego pose, velocity, steering, other
actors, and the episode goal on top of every `measured-state` entry. Callers
select it with `EpisodeConfig`. The default Gymnasium environment still uses
`measured-state`. Policy observations under that profile still exclude oracle
pose.

### PLN-D02 — One planar frame

Planning helpers use `(x, z, yaw)` on the ground plane. `yaw` is the vehicle
rotation about Y. Forward is `(cos(yaw), -sin(yaw))` in `(x, z)`, matching
`vehicleForwardTangent` in `app/scenarios/route/geometry.js`. Route heading
`atan2(dx, dz)` is a different angle; `yaw_from_direction(dx, dz)` converts a
travel direction into vehicle yaw.

### PLN-D03 — Start and goal overrides are episode identity

Protocol 1.5 adds optional `EpisodeSpec.overrides` (field 10). A start pose
replaces the ego pose at reset and is rejected when the footprint overlaps an
obstacle or leaves the drivable surface. A goal adds a success region. The
bundle route still drives `task/*`. Planners should read `oracle/goal`.

`overrides` is included in `episodeHash` only when a start pose or goal is
present. Episodes without overrides keep their previous identity bytes.
Resource limits and artifact policy stay outside the hash.

A client that negotiated a protocol minor below 5 cannot send overrides.

### PLN-D04 — Bundles, not a second map format

`cev_sim.world.load_world` reads the resolved run bundle already exported by
JavaScript. `cev-sim create-bundle` is the supported way to produce one from
a stored or built-in environment. Example bundles under
`python/examples/bundles/` are generated from the built-in IGVC environment
because `server/data/` is not part of the repository.

### PLN-D05 — Built-in obstacle corridor is still open

IGVC includes roadside props, and `create-bundle` will advance the start pose
until the vehicle box is clear of them. `straight.json` is one IGVC edge.
`curve.json` is a turning multi-node IGVC route, not a dedicated corridor.
A dedicated obstacle-corridor environment template belongs to the
environment-editor program and is not added here.

### PLN-D06 — Free drive keeps a route and drops the finish line

Headless episodes still require a verified ego route. `create-bundle
--finish none` keeps that route and replaces the finish-zone trigger with a
trigger on the flag `cev-sim.free-drive.stop`, which nothing sets. The episode
ends on collision, off-road, the step limit, or when the caller
stops. `configure` always requests `--finish none`. The default `create-bundle`
finish remains `route`, so existing bundles stay the same.

`configure` defaults to `planning-oracle@1`. `CevSimEnv` and
`gym.make("CevSim-v0")` stay on `measured-state`.

### PLN-D07 — Plugin vehicle locks travel with the bundle

`create-bundle` copies a stored vehicle's plugin locks onto the run and
embeds the packages installed in the data directory. A dynamics plant
therefore steps in `configure`. A vehicle with no plugin locks keeps
`world-bound@2` and the previous plugin-free bundle shape. This does not
change the Protobuf contract or the `measured-state` profile.

### PLN-D08 — Planning colliders are the physics colliders on the ground plane

Asset-proxy collision meshes and scene primitives join building and feature
rings as planner obstacles. Each mesh becomes the convex hull of its vertices
on `(x, z)`. There is no height filter. `worldHash`, `measured-state`, and the
Protobuf contract stay unchanged. IGVC has neither proxies nor primitives, so
its start pose and the example bundles stay put.

The temporary planning store does not contain editor-asset bytes. `create-bundle`
validates each embedded asset-metric snapshot against the source data directory,
then commits that environment with `trustedAssetPins`. When `visualLayer.accessHash`
is set, the access record, its descriptor, and its use records are copied first.
GLB bytes stay in the source store. A built-in bundle with no `dataDir` does not
take this path.

## Milestones

### PLN-01

`SupervisorLaunch()` from a checkout finds `bin/cev-sim.js`, runs it with
`node`, and rejects a Node version outside `>=22.22.2 <23` before launch.
`output_dir` is optional: the client uses a temporary directory, disables
artifacts, and deletes the directory on `close()`. `gym.make("CevSim-v0", ...)`
is registered.

### PLN-02

`load_world(bundle)` returns the route polyline, obstacle footprints, drivable
surfaces, vehicle limits, the start pose, and the goal. `occupancy_grid`
rasterizes drivable-but-free cells as 0 and obstacle or off-road cells as 1.

### PLN-03

`cev-sim create-bundle` writes a validated run bundle with a verified route,
state sensors by default, and a start pose clear of obstacles.
`npm run fixtures:planning` refreshes the example bundles.

### PLN-04

Register and advertise `planning-oracle@1`. The observation adds:

- `oracle/ego/pose` float64[3] `(x, z, yaw)`
- `oracle/ego/velocity` float32[3] `(vx, vz, yaw rate)`
- `oracle/ego/steering` float32[1]
- `oracle/actors/pose` float64[N,3], `oracle/actors/footprint` float32[N,2],
  `oracle/actors/validity` bool[N]
- `oracle/goal` float64[3] and `oracle/goal/validity` bool[1]

`N` is the number of non-ego actors in the bundle, sorted by id.

### PLN-05

`env.reset(options={"start_pose": (x, z, yaw, speed), "goal": (x, z, yaw)})`.
Vector environments take the same options through `set_reset_options`.

### PLN-06

`render_mode="human"` or `"rgb_array"` draws the route, obstacles, actors, the
goal, and an optional planned path. It requires `planning-oracle`. Examples
`01` through `04` cover pure pursuit, A* tracking, RRT*, and a kinematic
bicycle MPC.

### PLN-07

`cev_sim.configure(environment, vehicle=...)` builds a temporary free-drive
bundle from a saved or built-in environment and vehicle. `cev_sim.launch`
starts one worker. `goal=None` does not add a finish line. A goal is a
protocol 1.5 reset override. The tutorial is
[`docs/python-getting-started.md`](python-getting-started.md).

### PLN-08

`sim.clock.time()` and `sim.clock.steps()` read elapsed simulation time since
reset. `sim.clock.dt()` is the fixed simulation step in seconds. `sim.loop()`
is true while that episode is running and does not itself step. `pose()`,
`velocity()`, `steering()`, and `goal()` copy the latest `planning-oracle`
values. `max_steps=0` remains no policy-step limit.

### PLN-09

`create-bundle` validates editor-asset pins against the source data directory,
then writes the environment into the temporary store without a second asset
lookup. A pinned visual-layer closure is copied when one is present. Built-in
bundles do not take this branch.

### PLN-10

Start clearance uses `planningObstacleFootprints`: building and feature rings
plus the ground-plane convex hull of each asset-proxy collision mesh and each
scene primitive. A collider on the first route sample advances the start pose.

### PLN-11

`PlanningWorld.obstacles` includes those three sources. `occupancy_grid` and
the planner view already consume `obstacle.footprint`.

### PLN-12

`tests/fixtures/planning-corridor/` is a saved road with one pinned cone, one
box, and a plugin-free vehicle. `create_bundle` plus `load_world` is the same
path `configure` uses. `server/data` stays untracked.

## Verification

```text
npm run lint
npm test
npm run lint:python
npm run test:python
npm run proto:python
```

PLN-03 through PLN-05 also run `npm run test:headless`, `npm run test:supervisor`,
`npm run test:cli`, and `npm run test:parity`. `npm run fixtures:headless` must
show an empty characterization delta. PLN-06 runs each example with `--steps 50`.
PLN-07 also runs `npm run test:cli` and `python python/examples/00_free_drive.py --steps 50`.
PLN-08 runs `npm run lint:python` and `npm run test:python`.
PLN-09 through PLN-12 run `tests/headless-planning-bundle.test.js`,
`npm test`, `npm run lint:python`, `npm run test:python`, and `npm run test:cli`.
`npm run fixtures:planning` must leave the example bundles unchanged.

## Progress and decision log

### 2026-10-13 — PLN-00 through PLN-06

The Python client can launch the checkout supervisor without a PATH install,
read a planning world from a run bundle, and generate bundles with
`cev-sim create-bundle`. `planning-oracle@1` is opt-in. Protocol 1.5 adds
`EpisodeSpec.overrides` field 10; episode hashes change only when that message
carries a start pose or goal. State save/restore remains deferred.

Local verification on 2026-10-13: ESLint passed. The full Node suite reported
2073 passes and 2 failures. The protocol capability assertion was updated for
minor 5 and re-ran successfully. The remaining failure,
`startup marketplace log matches the default-on kill switch`, is pre-existing:
it compares the result of async `startup()` without awaiting it. Characterization
regeneration was a zero delta. Headless parity passed. Python unit tests
passed, and the planner examples plus a protocol 1.5 reset-options round trip
passed against the local supervisor.

### 2026-10-14 — PLN-07

`configure` and `launch` start one worker from an environment id and a vehicle
id. Free-drive bundles use `--finish none`: the verified route remains, and
the finish zone is replaced by an unset `cev-sim.free-drive.stop` flag trigger.
Start and goal stay protocol 1.5 reset overrides. `configure` defaults to
`planning-oracle@1`. The measured-state default on `CevSimEnv` is unchanged.
`cev-sim catalog` lists environments and vehicles. A source manifest with no
IMU, GNSS, or wheel odometry receives that localization rig, so a saved
`igvc-default` can still launch. The getting-started tutorial is
`docs/python-getting-started.md`.

### 2026-10-14 — PLN-08

`CevSimEnv` caches the latest transition. `clock.time()` reports elapsed
seconds, `clock.steps()` reports simulation steps, and `clock.dt()` reports
the bundle step length. `loop()` is true only while the episode is ready.
`pose()`, `velocity()`, `steering()`, and `goal()` copy planning-oracle
fields. `max_steps=0` is unchanged.

### 2026-10-14 — Planning bundles carry vehicle plugin locks

`create-bundle` stamps a stored vehicle's plugin locks onto the generated run
and copies the installed packages into the temporary store before resolve. A
dynamics plant selected on that vehicle is stepped by the existing headless
worker. Plugin-free vehicles stay on `world-bound@2`. The Protobuf contract
and `measured-state` hashes are unchanged.

### 2026-10-17 — PLN-09 through PLN-12

Saved schema-v4 environments can become planning bundles. Editor-asset pins are
checked on the source store, and the temporary store commits that snapshot
without reading GLB bytes. A pinned visual-layer access record, descriptor, and
use closure are copied when `accessHash` is set. A stored vehicle's model bytes
are copied before its manifest is published, so a version 3 model closure such
as `merceves` validates in the temporary store. Planner obstacles are the
physics colliders projected to the ground plane: building and feature rings,
asset-proxy collision hulls, and scene primitives. `cev_sim.configure` follows
the same `create_bundle` path. `worldHash`, `measured-state`, and the IGVC
example bundles are unchanged.

Local verification on 2026-10-17: ESLint and Python lint passed. The Node suite
reported 2281 passes, 7 skips, and 1 failure in `tests/vehicle-hierarchy.test.js`
(`a lidar sensor is one hierarchy row and does not share the LiDAR zone id`),
which does not import the planning bundle. `npm run test:cli` passed.
`npm run test:python` passed, 129 tests. `npm run fixtures:planning` changed
only `exportedAt` on the IGVC example bundles, and those files were left as
committed. `npm run fixtures:headless` produced an empty characterization delta.
