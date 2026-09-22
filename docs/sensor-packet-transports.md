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

Per-packet telemetry publication preserves that envelope. Host transports
consume a copied batch after the publisher has frozen payload bytes:

```js
nativePacketSink.enqueueBatch({
  sensorId,
  sampleIndex,
  captureTimeNs,
  scheduledDeliveryTimeNs,
  deliveryTimeNs,
  actualDeliveryStep,
  packets: [{
    productId,
    streamId,
    packetIndex,
    offsetNs,
    payload,
    envelope,
    payloadDigest
  }]
});

nativePacketSink.endDeliveryStep(clock);
```

`endDeliveryStep()` runs after every sorted device has delivered for that
simulation step. Sink state, queue state, and wrapper configuration are not
canonical simulator state.

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

## Host configuration

PCAP wrappers live in operator-owned
`cev-sim.sensor-transport-host-config` version 1. Direct CLI runs accept
`--sensor-transport-config <file>`. Supervisors store the same document under
`packetTransports`. The document does not affect `resolvedHash`,
`simulationHash`, `episodeHash`, or `trajectoryHash`.

```json
{
  "kind": "cev-sim.sensor-transport-host-config",
  "version": 1,
  "pcap": {
    "artifacts": [
      {"id": "sensors", "fileName": "sensors.pcap"}
    ],
    "endpoints": [
      {
        "id": "camera-data",
        "artifactId": "sensors",
        "mtu": 1500,
        "ethernet": {
          "sourceMac": "02:00:00:00:00:01",
          "destinationMac": "02:00:00:00:00:02"
        },
        "ipv4": {
          "sourceAddress": "192.0.2.1",
          "destinationAddress": "192.0.2.2",
          "ttl": 64
        },
        "udp": {"sourcePort": 5000, "destinationPort": 5001}
      }
    ]
  },
  "udp": {
    "maxQueueBytesPerEnvironment": 16777216,
    "endpoints": [{
      "id": "helios-data",
      "mtu": 1500,
      "source": {"address": "0.0.0.0", "port": 5000},
      "destination": {"address": "127.0.0.1", "port": 6699},
      "pacing": {"mode": "burst"}
    }]
  }
}
```

Resolved rules:

- Artifact and endpoint IDs are unique after trim.
- `fileName` is a safe `.pcap` basename with no path traversal.
- MTU defaults to 1500 and must be in `[576, 65535]`.
- MAC addresses are canonical six-octet colon form.
- Addresses are IPv4 only.
- TTL defaults to 64 and must be in `[1, 255]`.
- UDP ports are in `[1, 65535]`.
- Multiple endpoints may share one PCAP artifact.
- `pcap` and `udp` are independently optional; at least one must exist.
- UDP destinations must be IPv4 unicast literals; source may be `0.0.0.0`.
- UDP endpoint IDs are unique across PCAP and UDP.
- UDP queue capacity is the lower bound of
  `maxQueueBytesPerEnvironment` and `ResourceLimits.maxQueueBytes`.
- Omitted UDP pacing is `burst`. `packet-offset` requires
  `latenessBudgetNs` and a realtime clock at speed 1:
  `anchor + actualDeliveryStep * stepNs + offsetNs`.
- Direct `--sensor-transport-config` and browser hosts reject UDP.
  Supervisors execute UDP from `packetTransports` in `--config`.

## Structural validation versus execution admission

Structural validation is responsible for sensor, product, and stream
references, duplicate binding keys, adapter names, and endpoint identifiers.
Immutable bundle verification uses that structural pass and does not require a
local adapter, so a bundle can be verified on any machine.

Execution admission receives an app-neutral host descriptor:

```js
{
  adapters: ["pcap", "udp"],
  endpoints: [
    { id, adapter: "pcap", mtu, maxPayloadBytes },
    { id, adapter: "udp", mtu, maxPayloadBytes }
  ]
}
```

With `execution: false`, structurally valid bindings are returned without a
local adapter. With `execution: true`, every binding’s adapter and endpoint
must exist and the declared stream maximum must be at most `mtu - 28`
(IPv4 header 20 plus UDP header 8). Browser execution exposes no host
adapters and therefore rejects requested PCAP and UDP bindings. Direct
unsupervised CLI also rejects a UDP host section. Supervised `run --config`
and managed execution send UDP when `packetTransports.udp` is configured.

PCAP is optional globally but mandatory when a manifest binding requests it.
Unsupported or failed capture fails the run before readiness or as an
infrastructure failure during stepping.

## Classic PCAP encoding

Classic PCAP is little-endian, microsecond-resolution, version 2.4, snap
length 65535, link type Ethernet (1). Each record contains Ethernet + IPv4 +
UDP + the unchanged native payload.

- Ethernet: 14 bytes, EtherType `0x0800`.
- IPv4: IHL 5, protocol 17, DF set, deterministic 16-bit record ID, valid
  header checksum. No fragmentation, VLAN, IPv6, or payload substitution.
- UDP: pseudo-header checksum; write `0xffff` when the computed checksum is
  zero.

Logical egress time is:

```js
BigInt(actualDeliveryStep) * BigInt(manifest.clock.stepNs) + BigInt(offsetNs)
```

PCAP timestamps use `logicalEgressTimeNs / 1_000n`, truncated toward zero.
Exact nanoseconds remain in the `CEVP` envelope and evidence metadata.

Host-bound packets sort by:

1. logical egress nanoseconds
2. UTF-8 sensor ID
3. product ID
4. stream ID
5. sample index
6. packet index

Queued encoded bytes are bounded by the environment `limits.maxQueueBytes`.

## Artifacts, evidence, and failures

Workers own PCAP files. Writers open with exclusive creation inside artifact
staging, drain after each completed simulation step, and finalize before
artifact enumeration and directory rename. Abort closes writers and removes
staging, leaving no published partial artifact.

Published `sensor-transport-evidence.json`:

```json
{
  "kind": "cev-sim.sensor-transport-evidence",
  "version": 1,
  "bindings": [],
  "wrappers": [],
  "artifacts": [
    {
      "id": "sensors",
      "fileName": "sensors.pcap",
      "recordCount": 0,
      "payloadBytes": 0,
      "firstLogicalEgressTimeNs": null,
      "lastLogicalEgressTimeNs": null,
      "sizeBytes": 0,
      "sha256": null
    }
  ]
}
```

Each artifact records resolved filename, record count, payload bytes, first
and last logical egress nanoseconds, output size, and SHA-256 digest.
Artifact MIME mapping treats `.pcap` as `application/vnd.tcpdump.pcap` and
`.ndjson` as `application/x-ndjson`.

When UDP ran, evidence may include an optional `udp` section (endpoint
configuration, generation, sidecar/runtime identity, counts, payload bytes,
sequence digest, first/last logical egress, and first/last/max submit,
accept, and lateness values) plus `sensor-udp-timing.ndjson`. PCAP-only
runs omit that section and file. UDP timing is operational and never enters
canonical simulation state or semantic hashes.

Internal worker-to-sidecar batches carry `environmentKey`, `generation`,
`sensorId`, `sampleIndex`, delivery timestamps, and packets
`[{productId, streamId, packetIndex, offsetNs, payload, payloadDigest}]`.
The sidecar recomputes payload digests before sending.

One `submit-batch` may exceed Node's 16 KiB IPC writable high-water mark. A
600 RPM Helios scan is 150 payloads of 1248 bytes, about 187 KiB, before
serialization overhead. `UdpTransportSidecarOwner.dispatch` treats
`child.send()` returning false on a still-connected channel as flow control:
the message stays queued, and the pending request resolves from the sidecar
response. The send callback, IPC disconnect, and sidecar exit remain the
failure signals. This is the Node IPC pipe, not the UDP socket buffer, and it
does not change `maxQueueBytesPerEnvironment`.

Failure mapping:

- missing adapter or endpoint, direct/browser UDP, bind permission, or
  pacing incompatibility → `UNSUPPORTED_CAPABILITY`
- queue overflow or packet-offset lateness → `RESOURCE_LIMIT`
- sidecar death or IPC disconnect → `WORKER_CRASHED`
- socket send or evidence I/O failure → `ARTIFACT_FAILURE`

Canonical error details attach
`{component:"udp-sidecar", endpointId, generation, operation,
uncertainSubmission, requiresReset:true}`. `ARTIFACT_FAILURE` is
reset-required. These failures are never fabricated as Gymnasium
termination or truncation transitions. Health reports
`packetTransportQueueBytes` and includes sidecar queue bytes in aggregate
queue usage.

Browser logs export through `POST /api/logs/:id/pcap-export` using the same
host resolver, ordering, encoder, and writer. Export fails if the recording
lacks native envelopes, an attached manifest or run bundle, or required
transport bindings.

## Availability

PLG-06a implements native capture, telemetry recording, portable plugin
files, and classic PCAP artifacts. PLG-06b adds supervisor-owned live IPv4
unicast UDP as a dedicated sidecar child. Browser hosts expose no adapters
and reject requested PCAP or UDP bindings. Direct unsupervised CLI rejects a
UDP host section. `run --config` and managed execution send UDP when the
supervisor config includes `packetTransports.udp`. The reserved host
permissions `sensors.transport.pcap` and `sensors.transport.udp` are not
plugin runtime capabilities and do not appear in
`manifest.plugins.artifacts[].capabilities`. Plugins never receive sockets,
host endpoints, artifact paths, or send operations. Workers never import
`node:dgram` or sidecar modules.
