# Plugin range-image sensors

PLG-05 extends `cev-sim.plugin` API 1 with sensor ABI 1. It supports one
sampling family, `range-image`, through the host CPU LiDAR backend. The host
owns ray intersection, simulation timing, measurement policy, publishing,
recording, and external I/O. A plugin receives measured data and implements a
deterministic transformation and encoder.

## Declaration and registration

`plugin.json.sensorTypes` is optional. When present, the package must require
and the run must grant `sensors.sample.range-image`. Each declared type starts
with the package ID and has exactly these fields:

```json
{
  "type": "acme.sensor.synthetic",
  "sensorAbi": 1,
  "family": "range-image",
  "stateVersion": 1,
  "defaults": {
    "rateHz": 10,
    "scanLayout": {
      "kind": "cev-sim.range-image-layout",
      "version": 1,
      "channels": [
        { "id": 0, "elevationDeg": -5, "azimuthOffsetDeg": 0 }
      ],
      "azimuthsDeg": [-45, 0, 45],
      "minRangeM": 0.1,
      "maxRangeM": 100
    }
  },
  "settings": [
    { "key": "scale", "valueType": "float64", "default": 1, "min": 0.1, "max": 2 }
  ],
  "products": [
    {
      "kind": "pointCloud",
      "productId": "points",
      "outputKey": "pointCloudTopicId",
      "rosType": "sensor_msgs/PointCloud2",
      "contractId": "front-lidar-points"
    },
    {
      "kind": "vendor-packets",
      "productId": "packets",
      "streams": [{ "streamId": "data", "maxPayloadBytes": 1200 }]
    }
  ],
  "observation": {
    "productId": "points",
    "dtype": "float32",
    "components": ["rangeMeters", "incidence"]
  }
}
```

Settings use `float64`, `int32`, `boolean`, `string`, `json`, or `enum`.
Numeric settings may define `min` and `max`; enum settings must define unique
`options`. Values normalize into `calibration.parameters`. Unknown parameter
keys fail. `calibration.products` explicitly enables declared product IDs; the
host does not invent enabled products. `calibration.scanLayout` replaces the
default as a complete layout.

The runtime registers every declared type exactly once:

```js
export default {
  register(api) {
    api.contributeSensorType({ type: "acme.sensor.synthetic", create });
  },
};
```

Registration and `create()` are synchronous. Definitions publish only after
all package contributions validate, and each prepared run owns an isolated
factory and instance set.

## Scan layout

Channel array order is observation row order; `azimuthsDeg` order is column
order. Neither axis is sorted. Channel IDs are unique nonnegative safe
integers. Elevation is within `[-90, 90]`; azimuth values and offsets are
within `[-180, 180)`. Axes must be nonempty. `minRangeM` is at least `0.0001`
and `maxRangeM` exceeds it. Checked ray and byte arithmetic enforces host
limits before allocation.

Ray `(channel, column)` uses `elevationDeg` and
`azimuthsDeg[column] + azimuthOffsetDeg`. Coordinates are REP-103: +X forward,
+Y left, +Z up. All rays use the existing instantaneous capture pose. The
required backend is kind 3 `deterministic-cpu-bvh-lidar` version 2 with config
hash `70349dfde6494414249bbcf6e1befc13ce82b817a63eb01baac4f5402ce62c31`.

## Lifecycle and capture

`create()` returns an object with synchronous `prepare`, `reset`, `captureAt`,
`getDeterministicState`, `hydrateDeterministicState`, `finalize`, and
`dispose` methods. `prepare({ calibration, helpers })` receives frozen,
validated calibration. `reset({ resetSeed, sensorId })` starts an episode.
State is JSON-serializable and uses the declaration's `stateVersion`.

The host calls:

```text
captureAt({
  buffer, calibration, captureTimeNs, sampleIndex, scanDurationNs,
  rng, sampling
}) -> { messages, observation? }
```

`buffer` is a copied `Float32Array` with four values per authored ray:
range meters, incidence, semantic ID, and instance ID. It has already received
host range noise and point dropout once; the last two slots are zero. The
plugin may modify its copy. The scoped `rng` exposes `next`, `range`, `int`,
and `intRange`. Its stream is separate from host measurement and delivery RNG.

`sampling.buildPointCloud2(buffer)` creates the only admitted PointCloud2
shape: capture-time header and measurement frame, XYZ plus float32 intensity,
little endian, 16-byte points. The host validates and canonicalizes the
message, so a plugin cannot replace the capture time or frame.
`sampling.buildObservation(buffer)` creates the declared channel-major
`float32[channelCount, azimuthCount, 2]` range/incidence tensor.

A PointCloud2 capture message is `{ productId, value }`. A native packet
message is `{ productId, streamId, payload, offsetNs }`; payload is a copied
complete UDP payload and `offsetNs` is a safe integer in
`[0, scanDurationNs)`. A successful enabled mapped point-cloud capture returns
exactly one point-cloud message and one observation. Packet-only sensors omit
the observation and add no Gym tensor.

Thenables, undeclared products or streams, invalid shapes/values, excessive
payloads, queue overflow, and hook exceptions fail with structured plugin
identity, contribution type, sensor ID, hook, `requiresReset: true`, and
`infrastructureFailure: true`. The host commits a fully validated capture
atomically.

## Observations and identity

Measured observations preserve authored channel order and have range bounded
by `maxRangeM`, incidence in `[0, 1]`, and `[0, 0]` for no hit. The same
descriptor drives Gym spaces, tensor validation, pooling checks, and shared
memory sizing. A measured-perception profile fails when no enabled mapped
camera or point-cloud sensor exists.

The conditional `cev-sim.plugin-sensors@1` resolved resource binds the exact
effective configuration and required backend. Scan, settings, enabled
products, outputs, mount, rate/phase, latency, noise, and observation mapping
are semantic. Queue policy and host transport bindings are operational.
Plugin-free runs omit the resource and retain their prior hashes and state.

See `tests/fixtures/plugins/test.range-image-fixture/` for nonuniform channels,
azimuth correction, measured scaling, PointCloud2, two packet streams,
observations, and deterministic lifecycle state.

PLG-06a portable files and classic PCAP artifacts are documented in
[`sensor-packet-transports.md`](sensor-packet-transports.md) and
[`plugin-plan.md`](plugin-plan.md).
