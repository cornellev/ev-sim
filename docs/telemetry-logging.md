# Telemetry, Logging, Replay, and Analysis

The telemetry subsystem is the common data plane for simulation state, ROS topics, visual-script bindings, recording, replay, and analysis. It extends the existing `SignalStore`; producers should not create a second event bus or data model.

## Runtime model

The public convenience functions live in `app/telemetry/TelemetryRuntime.js`:

```js
defineSignal({
  path: "vehicles.ego.velocity",
  type: "vec3",
  unit: "m/s",
  source: "simulation",
  category: "vehicles",
  replayRole: "state",
  logClass: "core",
});

publishSignal("vehicles.ego.velocity", { x: 1, y: 0, z: 2 }, {
  timeUs,
  cycle,
  source: "simulation",
});
```

Every path has a descriptor. `replayRole` is `input`, `state`, or `derived`; `logClass` is `core`, `standard`, or `heavy`. Type changes create a new schema in an SFLog and emit a `schema/signal-type-changed` event. Never change the meaning of an existing type name.

`SignalStore` retains timestamped, bounded live histories. Structured signals are stored once. Analysis creates virtual numeric child fields at read time, so `imu.accel` can expose `imu.accel.x` without writing duplicate samples.

The same-origin tab bridge uses `BroadcastChannel("cev-sim-telemetry-v1")`. The simulator tab remains authoritative. Remote tabs discover catalogs and snapshots, then request full-rate paths. They never record mirrored samples.

## Recording profiles

Profiles are versioned, human-readable JSON persisted under the `logging-profiles-v1` setting. Glob rules run in order and the last matching rule wins.

```json
{
  "kind": "fusion-log-profile",
  "version": 1,
  "id": "replay-safe-default",
  "name": "Replay Safe",
  "mode": "replay-safe",
  "rules": [
    { "pattern": "**", "enabled": true, "sampling": "on-change", "rateHz": null },
    { "pattern": "devices.**", "enabled": false, "sampling": "disabled", "rateHz": null }
  ]
}
```

Replay-safe profiles force all `input` signals and `core` state signals on at every update. Telemetry profiles permit disabling and rate-limiting every descriptor. The singleton `RecordingController` owns recording across workspace changes, batches at 250 ms or 256 KiB, retries uploads idempotently, and maintains a 16 MiB client queue. Queue exhaustion pauses the simulator for replay-safe recordings.

## SFLog

Recordings persist as native SFLog v1 files (`SFLG`) under `server/data/logs/`. The `.sflog` is self-contained; the `.json` sidecar is only a catalog cache and the editable name/tag store. The browser encodes uncompressed record batches; `LogService` gzip-chunks them, writes an `INDX` footer, and recovers interrupted `.partial` files on startup.

The binary layout, record tags, value codecs, recording pipeline, run-manifest policies, HTTP API, Replay/Analysis consumers, and MCP tools are specified in [SFLog](sflog.md).

Managed headless experiment workers use the same `RecordingController` and
SFLog v1 writer, then import retained logs into this shared catalog after
checking run and resolved identities. Their experiment metrics are reduced
from the live `SignalStore`, independently of log retention.

## Workspaces

The live Three.js scene remains mounted after first load. Leaving Simulation hides its canvas and disables rendering and controls. It does not change play state. Replay owns a different read-only Three.js scene.

Replay loads the binary index and schemas, seeks from checkpoint state, applies exact updates to inspectors, and interpolates visual poses between samples. Analysis shares the timeline cursor and supports local live data, another browser tab, or a backend log. Its layout JSON is stored under `analysis:layout:v1` and can be exported and edited.

## Extension checklist

When adding a producer:

1. Define a stable path and explicit type.
2. Set unit, source, category, replay role, and log class.
3. Publish a session-relative timestamp and simulation cycle when available.
4. Mark large camera, LiDAR, point-cloud, and byte-buffer payloads `heavy`.
5. Add lifecycle failures or discontinuities as telemetry events.
6. Add round-trip tests when introducing a binary type.

The primary implementation files are `SignalStore.js`, `TelemetryRuntime.js`, `SFLogCodec.js`, `RecordingController.js`, `LogService.js`, `ReplayPage.js`, and `AnalysisPage.js`.
