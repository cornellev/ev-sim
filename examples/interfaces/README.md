# Native interface examples

`onboarding-lease.v2.json` is an immutable interface@2 snapshot of the real
`cev.onboarding.v1` descriptor. It publishes native state, sensor-local measured
points, goal, and transforms; it subscribes to leased commands and map-frame
paths. The LiDAR wire sequence is the zero-based capture sample index plus one.
Run IDs, frames, capture times, and exact uint64 sequences are authored metadata.
Command field 7 carries the lease ID. Command validity is 300 ms of simulation
time. Measured points use the resolved JavaScript calibration and remain in
`front_lidar_frame`; the 2D Rust consumer rejects a nonlevel sensor mount.

`cev-interfaces-imu.v2.json` uses the pinned, actual `cev-interfaces` IMU
descriptor. It does not invent a wheel-speed schema or adapter.

Import either JSON through the storage Protobuf interface endpoint. The returned
SHA-256 hash is the run's immutable interface pin. Historical runs require a
reviewed native migration; new runs use v13 and scenario v2.

The onboarding installer is `./install.sh --onboarding`. It verifies the pinned
Zenoh 1.10.2 archive and writes router/browser/supervisor configuration without
replacing existing files. Start the router with `.onboarding/router.json5`, then
start the simulator with the generated configuration. The Rust launcher imports
its snapshot with `setup`, writes a preview, and applies it only with
`setup --apply-migration native-migration-plan.json`. A new v13 run gets a native
configuration preview; a historical run gets a complete migration preview.

Source pins are in [source-pins.json](source-pins.json). The upstream and SDK
commits are local review artifacts, not published GitHub revisions. Their git
bundles are `/private/tmp/zpb08-upstream.bundle` and
`/private/tmp/zpb08-simcontrol.bundle`. A compact SDK change bundle is
`/private/tmp/zpb08-simcontrol-change.bundle` (requires the base commit recorded
in the source pins). Publish the SDK revision before upstream
users fetch its pinned Cargo dependency. Student algorithms are unchanged.
