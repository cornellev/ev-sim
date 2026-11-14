# Native Zenoh transport (ZPB-06–07)

The native addon supplies bounded publication, subscription, reset, close and
SHM capability checks. ZPB-07 connects admitted routes to each headless kernel
and adds explicit external realtime execution. This
package does not change simulator stepping, semantic hashes, historical tapes,
the default run writer or the Python tensor shared-memory protocol.

## Host configuration and admission

Supervisors accept an optional operator-owned `zenohTransport` section:

```json
{
  "kind": "cev-sim.zenoh-transport-host-config",
  "version": 1,
  "connect": ["tcp/127.0.0.1:7447"],
  "shm": { "mode": "preferred", "thresholdBytes": 65536, "poolBytes": 67108864 },
  "queue": { "maxEntries": 256, "maxBytes": 16777216 },
  "connectTimeoutMs": 5000,
  "publishTimeoutMs": 5000,
  "closeTimeoutMs": 5000
}
```

Connections are explicit TCP endpoints; multicast discovery is disabled.
`disabled` uses network payloads. `preferred` uses SHM when a provider and a
negotiated direct neighbor support it, otherwise owned network bytes.
`required` rejects preflight unless every negotiated direct connection supports
SHM. A router may still forward to a remote network consumer. Required SHM
therefore promises the direct connections, not every downstream recipient.
Losing a required direct capability, or all direct connections, fails visibly.

The default pool is 64 MiB. Admission reserves the pool plus 4 MiB for SDK SHM
metadata, together with the existing Python tensor arena, against
`maxSharedMemoryBytesPerEnvironment` (128 MiB by default). Thresholds start at
64 KiB to bound allocation metadata; pool size is at most 128 MiB. Both native
queues share one entry/byte budget, including the in-flight publication.
Effective queue bytes are the smaller of host and supervisor limits.

`validateZenohTransportAdmission()` in
`server/sensor-transports/ZenohTransportConfig.js` admits only resolved v13
Zenoh runs. Its execution-only result contains `routesById` and
`imagePayloadBounds` maps, effective queue bytes and memory reservations.
Routes use the existing concrete key binding and compiled Protobuf mapping.
Image bounds include nested messages, duplicated image fields, constants,
tags and length prefixes without allocating the full image. The encoded
payload ceiling remains 16 MiB: raw 3840×2160 RGBA and 2048×2048 RGBA with
an envelope do not fit. A metadata-only mapping may fit at those dimensions.
Every actual publication is also bounded at the native boundary.

## Ownership and lifecycle

`HeadlessZenohRuntime` owns the existing `ProtobufRouteRuntime` and native
transport for one environment. It binds the kernel's actual `TopicInputQueue`,
fences generations on pause/reset and charges native, sensor, input, recording
and packet queues to the environment limit. Required publication, connection or
SHM failure stays latched until a fresh session is prepared. There is no host
forwarding queue and no reconnect mode.

`HeadlessExternalSession` owns a paced `SimulationKernel`; it never accepts
policy actions. `prepare`, `start`, `pause`, `resume`, `stop`, `reset`,
`waitForCompletion`, `finalize` and `close` form its lifecycle. Reset closes the
old native session, aborts failed staging, prepares a fresh run ID and leaves
the kernel paused until `start`. Native state sensors publish IMU, GNSS and
wheel products from the same captured measurements used for observations.
Delayed products retain bounded sensor-queue ownership and clear on reset.
See [headless-cli.md](headless-cli.md) for direct and supervised commands.

`ZenohNativeTransport` exposes asynchronous `openSession()`, `subscribe()`,
`unsubscribe()`, `reset(generation)` and `close()`, plus synchronous
`publish(packet)` and `diagnostics()`. Publications carry exact `key`,
`routeId`, `generation` and `Uint8Array` bytes. Admission supplies whether a
route is required; a caller cannot downgrade that policy.

`publish()` returns `{ok, accepted, code, fatal}` after copying bytes into owned
native storage and reserving queue space. Acceptance means queued, not a
delivery acknowledgement. A native Tokio worker performs the SDK put with a
deadline. Optional overload rejects the newest sensor frame; required overload
or send failure reports a sticky transport failure through `onEvent` and
diagnostics. SHM exhaustion does not silently bypass the bounded pool.

Large payloads use Zenoh's POSIX binary-heap provider. JavaScript bytes are
copied once into `ZShmMut`, converted to immutable `ZShm`/`ZBytes`, and retained
by SDK references. Safe garbage collection/defragmentation reclaims only
released allocations. There is no custom descriptor protocol or unsafe
reference revocation. Small and network payloads use an owned native vector.

Inbound SDK callbacks retain owned `ZBytes` in the same bounded native queue.
A one-token napi wakeup schedules JavaScript draining; it carries no payload.
Draining returns owned Node buffers. Callbacks must be synchronous. Command
validation rejections remain application-level results; a throwing required
callback or native queue failure reports infrastructure failure. Subscription
declaration and incoming packets are fenced by generation.

Reset requires a newer uint32 generation, cancels queued/in-flight work,
undeclares subscriptions and reuses the session and pool. It cannot retract
an SDK publication that was already accepted. Close is idempotent, awaits
aborted workers and closes the SDK session under a deadline. Environment
cleanup also drops native ownership. Consumers retain their own SDK references;
close never forcibly invalidates a live consumer buffer.

Diagnostics include pool capacity/availability, queue gauges/peaks,
allocations, copies/copy bytes, SHM/network publications, drops, cancellation,
resets and the last failure. Cumulative uint64 counters are decimal strings.
Copy counters cover the addon boundary and inbound flattening; they do not
claim to count internal SDK/router copies, JavaScript mapping/encoding or GPU
readback. Pool and metadata reservations are budget figures, not RSS readings.

## Build and install

Release targets are Linux x64 and ARM64 GNU, glibc 2.31 or newer, Node 22 with
N-API 8. Rust is pinned to 1.98.0, Zenoh to 1.10.2, and dependencies to
`native/zenoh-transport/Cargo.lock`. Build each architecture in Debian bullseye:

```sh
npm run build:zenoh-native -- --output artifacts/zenoh
```

The builder checks compiler identity, ELF architecture and imported glibc
versions, then emits `.node` and `.node.json` files. Metadata includes the
artifact SHA-256/size, Cargo-lock SHA-256, target, SDK, Rust and N-API versions.
Both architectures must use the same lock. After collecting them in one folder:

```sh
npm run dist:headless -- --output artifacts/headless --zenoh-artifacts artifacts/zenoh
npm run release:check -- --dist artifacts/headless
npm run dist:verify -- --dist artifacts/headless
npm run artifacts:install -- --dist artifacts/headless --node-prefix /opt/cev-sim
```

Native binaries are separate checksummed release artifacts, outside the npm
tarball's existing 10 MiB ceiling. The installer verifies both records and
copies the matching artifact explicitly after `npm install --ignore-scripts`.
The loader verifies host, ABI, glibc and SHA-256 before loading. macOS/Windows
retain existing headless use without claiming native Zenoh availability. A
distribution built without `--zenoh-artifacts` remains valid for those uses;
the internal candidate workflow supplies both artifacts.

## Evidence and hardware reports

Focused JavaScript tests run with `npm run test:zenoh-native`. Rust ownership
and queue tests run with `cargo test --locked --manifest-path
native/zenoh-transport/Cargo.toml`. Live integration requires
`CEV_SIM_ZENOH_TEST_ADDON`, `CEV_SIM_ZENOH_TEST_CONSUMER` and a compatible
`zenohd` on PATH (or `CEV_SIM_ZENOHD`). A version string alone does not prove
SHM support; build the 1.10.2 router with its `shared-memory` feature.

```sh
cargo build --locked --manifest-path native/zenoh-transport/Cargo.toml --bin consumer
npm run benchmark:zenoh-native -- \
  --addon artifacts/zenoh/cev-sim-zenoh-linux-arm64.node \
  --router /path/to/shm-enabled/zenohd \
  --width 1920 --height 1080 --frames 120 \
  --role jetson-arm64 --output artifacts/zenoh-jetson-arm64.json
```

The probe produces `cev-sim.zenoh-transport-report@1` with verified artifact
provenance, byte-equivalent local SHM/network consumers, retained-buffer
integrity, exhaustion, 100 resets, consumer/producer crash checks, cleanup,
publication latency/throughput, addon copies and process RSS. Synthetic native
images pass through the real JavaScript mapping and Protobuf encoder. Reports
explicitly mark GPU readback unmeasured and end-to-end zero copy false.

`.github/workflows/zenoh-native.yml` builds/tests both architectures against an
SHM-enabled official router. The candidate workflow incorporates both binaries;
`headless-hardware.yml` downloads them and runs the probe on x64 NVIDIA and
Jetson ARM64. Hardware hosts need build tools and outbound crate access;
the workflow installs isolated pinned Rust to build the consumer/router.
Native implementation is available; ZPB-06
acceptance remains pending Linux and Jetson workflow reports and artifact hashes.
Local macOS development results cannot satisfy those gates.
