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

The same-origin tab bridge uses `BroadcastChannel("sensor-fusion-telemetry-v1")`. The simulator tab remains authoritative. Remote tabs discover catalogs and snapshots, then request full-rate paths. They never record mirrored samples.

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

## SFLog v1

All multibyte numbers are little-endian. The file is self-contained; the `.json` sidecar is only a catalog cache and the editable name/tag store.

### Header

| Field | Encoding |
| --- | --- |
| Magic | ASCII `SFLG` |
| Version | `uint16`, currently `1` |
| Flags | `uint16`; bit 0 little-endian, bit 1 gzip chunks |
| Metadata length | `uint32` |
| Metadata | UTF-8 JSON |

Metadata includes the session identity, wall-clock start, environment, simulator snapshot, profile, application version, and optional git hash.

### Chunks

Each independently validated chunk starts with:

| Field | Encoding |
| --- | --- |
| Magic | ASCII `CHNK` |
| Start time | `uint64`, session-relative microseconds |
| End time | `uint64`, session-relative microseconds |
| Uncompressed length | `uint32` |
| Compressed length | `uint32` |
| CRC32 | `uint32`, over uncompressed records |
| Reserved | `uint32`, zero in v1 |
| Payload | gzip-compressed record stream |

Chunks are normally about one second. Readers reject oversized chunks, length mismatches, gzip errors, and CRC mismatches.

### Records

Unsigned integers, IDs, and lengths use base-128 varints. Signed integers use zigzag varints. A schema definition establishes the type for later values, so individual updates carry no type tag.

| Tag | Record |
| --- | --- |
| `0x01` | Schema ID, type code, path, unit, descriptor metadata |
| `0x02` | Delta timestamp, cycle number, changed signal count, then ID/value pairs |
| `0x03` | Timestamp, category, name, severity, JSON payload |
| `0x04` | Timestamp and the current replayable ID/value state |
| `0x05` | Timestamp, attachment name, MIME type, bytes |

Primitive codecs cover booleans, signed and unsigned integers, floats, strings, bytes, vectors, poses, and typed numeric arrays. JSON is the explicit fallback for structured values. Checkpoints are written every five seconds and at start/stop.

The first cycle record in each uploaded record stream carries an absolute timestamp marker. Later cycle records use a delta from the previous cycle; a clock regression starts a new absolute base. This keeps record streams independently decodable while preserving compact deltas across normal cycles.

### Index and recovery

Finalized files end with `INDX`, an entry count, and fixed-size entries containing start time, end time, file offset, and checkpoint presence. The final 12 bytes are the index offset followed by `SEND`. Import validates the locator, exact index length, chunk count, entry boundaries, gzip payloads, CRCs, and schemas.

Active sessions use `.partial`. On restart, the service scans complete chunk headers and valid CRCs, truncates an interrupted tail, builds a new index, and catalogs the result as incomplete. This permits analysis and state replay of the valid prefix.

Files live under `server/data/logs/`:

```text
<id>.sflog    finalized binary log
<id>.json     catalog metadata, editable name and tags
<id>.partial  active or interrupted recording
```

## HTTP API

The binary router is mounted before JSON storage middleware.

- `GET /api/logs`
- `POST /api/logs/sessions`
- `POST /api/logs/sessions/:id/batches`
- `POST /api/logs/sessions/:id/finalize`
- `GET /api/logs/:id/metadata`
- `GET /api/logs/:id/index`
- `GET /api/logs/:id/chunks?fromUs=&toUs=`
- `GET /api/logs/:id/file` with HTTP Range support
- `POST /api/logs/import` for streaming native `.sflog` import
- `PATCH /api/logs/:id`
- `DELETE /api/logs/:id`

Batch sequence numbers are monotonic and accepted retries are idempotent.

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
