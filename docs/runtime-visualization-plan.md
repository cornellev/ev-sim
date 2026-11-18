# Runtime visualization implementation

This records the nine approved runtime visualization packages. It is separate
from the headless, VIS, ED, and other simulator roadmaps. Display bindings,
visibility, cached display outputs, and CPU timings are presentation state;
they do not enter manifests, bundles, world identity, episode identity, or
canonical simulator state.

## Progress and acceptance

Packages were implemented in dependency order in fresh contexts on the same
simplification branch, as requested. No package was staged, committed, pushed,
or opened as a PR during this work.

| Package | Implemented behavior | Full Node gate |
| --- | --- | --- |
| WP01 | Input validation, dirty flags, timings, source routing, cached snapshots | 2,884 tests: 2,864 pass, 20 skip |
| WP02 | Completed-step live source and engine lifecycle | 2,901 tests: 2,881 pass, 20 skip |
| WP03 | Independent read-only Zenoh source and descriptor admission | 2,918 tests: 2,898 pass, 20 skip |
| WP04 | Shared Ackermann arcs; vehicle ribbons removed | 2,931 tests: 2,911 pass, 20 skip |
| WP05 | Planned paths and bounded shared per-actor history | 2,945 tests: 2,925 pass, 20 skip |
| WP06 | Localization and owned appearance clones | 2,959 tests: 2,939 pass, 20 skip |
| WP07 | Shared occupancy samplers, buffers, RGBA, and comparison channels | 2,971 tests: 2,951 pass, 20 skip |
| WP08 | Map subscriptions, paused waypoint notifications, visibility adapters | 2,982 tests: 2,962 pass, 20 skip |
| WP09 | Integration, lifecycle/isolation checks, browser acceptance, documentation | 2,989 tests: 2,969 pass, 20 skip |

Each completed package passed lint with zero errors and the three existing
hook warnings. Each listed full Node gate had zero failures or cancellations.
All nine packages are complete. WP09 focused Node checks, browser checks,
parity, and final full-suite evidence are recorded below.

## Ownership and source boundary

`Visualizer.js` and `VisualizationManager.js` do not import React, Three.js,
DOM, or Zenoh. One owned instance of each concrete tool serves both scene and
map. The base validates merged required/defaulted inputs and measures listener
and display CPU work. The manager routes source events, coalesces dirty display
work through the engine presentation path, and publishes cached snapshots.
Each target has independent tool and occupancy-channel visibility.

`LiveVisualizationSource` owns runtime signal subscriptions and oracle/LiDAR
occupancy samplers. Local callbacks retain data until the authoritative step
finishes. Paused document notifications defer one microtask so `SceneProjector`
finishes before projected poses are read. Reset, replacement, and disposal
cancel subscriptions and fence late samples. A cancelled held sensor step
notifies the mounted map after reset drains, without requiring another step.

The live source can own a separate `ZenohVisualizationSource`. It uses existing
browser configuration, descriptor limits, schema fingerprints, and transport.
Consumers sharing an exact key share decoding. It accepts only code-owned
projections into display inputs; it never calls managed inbound route,
control, or topic-input admission. Independent messages redraw paused displays
even when the run's Protobuf transport is disabled.

Sources implement `subscribe(bindings, onEvent)` with immediate cancellation,
and `dispose()`. Events are plain `data`, `pose`, `clock`, `status`, or `reset`
objects. A replacement source can support replay later; playback is deferred.
Preserve available `runId`, `captureTimeNs`, `sequenceId`, and `frameId` in
metadata. Sequence strings remain exact, including values beyond safe integer
range. Frame metadata identifies the source frame and is retained after the
coordinate projection.

All concrete spatial inputs use internal Three.js scene coordinates: +X
forward, +Y up, +Z right. Convert raw REP-103 vectors and orientations at the
projection boundary with `CoordinateFrames.js`. `localizationSnapshotInputs()`
performs this conversion for native/replay localization snapshots. Direct
localization `orientation` inputs are internal Three.js quaternions or Euler
rotations. Vehicle-relative planned paths and grids follow the latest bound
pose; world inputs and past samples stay world-fixed.

`AutonomyOverlay` retains perception/lane rendering and its public snapshot
facade. Explicit snapshots delegate to the shared tools. Its live runtime
update does not overwrite independently bound migrated tools. `EgoPresentation`
no longer owns steering ribbons. Map controls, planned paths, trails,
localization, and occupancy consume cached manager output; remaining map
actors/roads/sensor wedges refresh from completed-state and document/UI events.
No visualization-specific RAF or interval polling remains.

Every tool root is non-colliding, uses operator layer 31, and disables raycast.
Every owned renderable is tagged for sensor capture exclusion. Geometry,
materials, textures, and appearance clones are owned by tools and disposed
without disposing source vehicle appearance. Occupancy retains three fixed
channels (`oracle`, `lidar`, `stack`) and converts RGBA once per accepted sample
for both targets. History keeps 120 seconds and at most 10,000 samples per actor;
its default visible window is 10 seconds and its sampling threshold is 5 cm.
Arbitrary status-badge templates are bounded to 64; displayed badges own cloned
textures, so cache eviction cannot dispose a displayed texture.

## Binding examples

`SimulationEngine.configureVisualizations(toolBindings)` replaces the complete
tool configuration. Omitted tools stop receiving data and are hidden/reset.
The engine creates its default five-tool live configuration automatically.
Explicit API visibility wins; existing menu/map choices survive implicit
configure, reset, and run rebinds.

A runtime binding identifies an existing signal and an optional trusted
projection. Zero steering is valid data. For example, this intentionally
configures only the Ackermann tool:

```js
import { controlsSnapshotInputs } from "../visualization/visualizers/AckermannVisualizer.js";

engine.configureVisualizations({
  ackermann: {
    data: [{
      id: "controls", kind: "runtime",
      signalPath: "visualization.controls.snapshot",
      project: (snapshot) => controlsSnapshotInputs({
        ...snapshot,
        wheelbase: engine.controlRuntime?.getLimits("ego")?.wheelbase ?? snapshot.wheelbase ?? 1.5,
      }),
    }],
    pose: [{ id: "ego-pose", kind: "runtime", vehicleId: "ego" }],
    predictedPath: true,
    visible: { scene: true, map: true },
  },
});
```

An independent binding uses existing descriptor bytes/fingerprints and exact
Zenoh keys. This example configures localization and imported occupancy only;
the projection is trusted application code, not a stored mapping language.

```js
import { SimulationEngine } from "./SimulationEngine.js";
import { rep103ToThreeVector, rep103OrientationToThreeEuler } from "../autonomy/CoordinateFrames.js";

const engine = new SimulationEngine(data, {
  visualizationZenoh: {
    schemas: [{ id: "display", descriptorBase64, fingerprint }],
  },
});
engine.configureVisualizations({
  localization: {
    data: [{
      id: "estimate", kind: "zenoh", key: "display/localization",
      schemaId: "display", messageType: "display.Estimate",
      project: (message, metadata) => {
        metadata.frameId = message.frameId;
        metadata.sequenceId = message.sequenceId;
        return {
          position: rep103ToThreeVector(message.position),
          orientation: rep103OrientationToThreeEuler(message.orientation),
        };
      },
    }],
  },
  occupancy: {
    data: [{
      id: "stack", kind: "zenoh", key: "display/occupancy",
      schemaId: "display", messageType: "display.Grid",
      project: (message) => ({ stack: {
        width: message.width, height: message.height, cells: message.cells,
        resolutionM: message.resolutionM,
        origin: rep103ToThreeVector(message.origin),
        vehicleRelative: true, encoding: "cost",
      } }),
    }],
    pose: [{ id: "grid-pose", kind: "runtime", vehicleId: "ego" }],
    visible: { scene: true, map: true },
  },
});
engine.visualizationManager.setLayerVisible("occupancy", "stack", "scene", true);
engine.visualizationManager.setLayerVisible("occupancy", "stack", "map", true);
```

Dimensions, cells, resolution, and origin belong to one atomic grid sample.
Cells must exactly match positive integer dimensions. Missing grid resolution
defaults to 0.05 m, origin to zero, and encoding to `cost`. A direct independent
`stack` binding does not require a declared simulator occupancy input.
Malformed samples retain the last valid display state and publish an error.

## WP09 evidence

- The focused Node gate passes all 191 tests, including visualization,
  existing occupancy/map adapters, deterministic integration, and committed
  characterization checks. Integration/lifecycle/import coverage includes 40 repeated
  configure/reset/source-replacement cycles and complete owned resource cleanup.
- All three committed current characterization checks pass: current v2,
  dynamic-bicycle v1, and contact v2. Historical v1 checksum remains pinned.
  No fixture files were regenerated or changed.
- Lint passes with zero errors and three baseline hook warnings.
- Parity passes for state-only, CPU LiDAR, road geometry v2, and asset-assembly
  metric v1 against direct headless, CLI, gRPC/UDS, and Python (16 comparisons).
- Fresh dedicated Playwright build and all four browser cases pass:
  `npx playwright test tests/ui/runtime-visualization.spec.js tests/ui/browser-simulation-performance.spec.js --workers=1`.
  The real bundled app proves paused independent Zenoh redraw, exact sequence
  metadata, all five tools in both views, comparison toggles, paused waypoints,
  map zoom without resampling, and internal quaternion placement. The existing
  PBR fallback/presentation and performance smoke also pass.
- Real WebGL2 capture checks enable operator layer 31 deliberately. Operator
  rendering differs visibly, while RGB/depth/semantic/instance bytes equal
  captures without the five tools. CPU capture-pass and raycast checks also pass.
- Browser operation counts: idle and pose-only updates have zero centerline
  rebuilds, occupancy conversions, or canvas paints; pose-only texture/ribbon
  versions remain unchanged. A blocked 512×512 grid converts and paints exactly
  once per channel (three each), including when scene and map both flush.
  Each dirty tool flushes once per target in the simultaneous-view case.
- CPU hook timings and end-to-end wall timings are in
  `/private/tmp/cev-runtime-visualization-browser.json`. The embedded existing
  monitor's simulation-rate and machine timing verdicts are diagnostic for
  this paused workload; acceptance asserts operation counts without applying
  those machine-specific thresholds.
- Root review and final full Node gate pass:
  `npm test -- --test-timeout=120000 --test-concurrency=4` reports 2,989 tests,
  2,969 pass, 20 skip, zero failures/cancellations (159.3 seconds).
  Output is retained at `/private/tmp/cev-runtime-visualization-full.log`.
  The interrupted earlier run stalled and was stopped; this clean rerun is
  the acceptance result. Final lint has zero errors and the same three baseline
  warnings; `git diff --check` passes. All changes remain on `simplification`.

## Decisions and limits

2026-11-16: completed the shared runtime presentation migration without
versioning a simulator, manifest, bundle, or wire contract. Source-boundary
orientation conversion keeps native/replay behavior while making direct
independent position and orientation inputs use the same internal convention.

Deferred: configuration/timing UI, replay-source playback, logging integration,
multiple instances per tool, and new dependencies. Hook timings measure CPU
work, not GPU completion. Browser wall timings are machine-specific evidence
under `/private/tmp`, not committed benchmark logs or acceptance thresholds.
