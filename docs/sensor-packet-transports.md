# Native sensor packets and host transports

Plugin vendor packets are opaque complete UDP payloads. They contain no
Ethernet, IP, or UDP wrapper. The simulation host validates and copies the
bytes, schedules them with the rest of the capture, and records them without
passing them to the ROS encoder.

## Native envelope

`NativeSensorPacket.js` emits a `CEVP` version 1 envelope. Its canonical JCS
metadata records sensor, product, and stream IDs; sample and packet indexes;
capture, offset, scheduled-delivery, and actual-delivery time; delivery step;
payload length; and SHA-256 payload digest. The envelope then carries the
payload bytes unchanged. Decoding verifies the length and digest before
returning a copy.

Packet order for equal offsets is the plugin's capture-array order. Whole
capture dropout and delivery latency apply coherently to ROS products,
packets, and observations. Packet bytes count toward the sensor's bounded
delivery queue. Overflow is a reset-required infrastructure error for plugin
sensors.

## Manifest bindings

Run manifest v11 recognizes an optional strict operational document:

```json
{
  "kind": "cev-sim.sensor-transports",
  "version": 1,
  "bindings": [
    {
      "sensorId": "fixture",
      "productId": "packets",
      "streamId": "data",
      "adapter": "pcap",
      "endpointId": "capture-0"
    }
  ]
}
```

Adapters are `pcap` or `udp`. A binding must name an admitted enabled plugin
sensor, a declared vendor-packet product, and one of its streams. Duplicate
sensor/product/stream/adapter bindings fail. `endpointId` refers to
operator-owned host configuration and is never passed to the plugin.

The saved document affects manifest definition and full resolved identity but
is projected out of simulation semantics and episode identity. Endpoint
addresses, paths, pacing, wrapper settings, and transport budgets never alter
payload bytes or canonical simulator state.

## PLG-05 availability

PLG-05 implements native capture and telemetry recording only. No PCAP or UDP
adapter is available, so any nonempty requested binding fails admission before
the run becomes ready. The reserved host permissions
`sensors.transport.pcap` and `sensors.transport.udp` are not plugin runtime
capabilities and do not appear in `manifest.plugins.artifacts[].capabilities`.
PCAP is assigned to PLG-06a and supervisor-owned UDP to PLG-06b. Plugins never
receive sockets, host endpoints, artifact paths, or send operations.
