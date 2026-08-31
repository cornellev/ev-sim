# Headless batch supervisor

PR 7 adds a Node 22 process supervisor around the authoritative JavaScript
headless session. Each environment runs in one non-detached child process.
Clients use unary gRPC calls; Unix-domain sockets are the normal local
transport and insecure TCP must be selected explicitly.

The supervisor does not resolve authoring manifests. `CreateBatch` accepts
canonical immutable `cev-sim.run-bundle` version 1 bytes and `EpisodeSpec`
records from the authoritative
[`headless.proto`](../proto/cev_sim/headless/v1/headless.proto). Python and MCP
clients are supported. Camera/GPU sensors, shared memory, and distributed
scheduling remain later milestones.

## Starting and stopping

Exactly one listener is required:

```bash
cev-sim supervisor --socket /tmp/cev-sim.sock
cev-sim supervisor --tcp 127.0.0.1:50051 --preset permissive
cev-sim supervisor --socket /tmp/cev-sim.sock --config supervisor.json
```

The process writes one `cev-sim.headless.supervisor-listening` JSON record to
stdout after binding. `SIGINT` and `SIGTERM` stop accepting work, dispose every
batch, ask workers to close, escalate through `SIGTERM` and `SIGKILL`, shut
down gRPC, and remove the Unix socket. Workers also exit when their IPC parent
disconnects.

JavaScript callers can own the same lifecycle directly:

```js
import { startHeadlessSupervisor } from "./server/headless/SupervisorServer.js";

const running = await startHeadlessSupervisor({ socket: "/tmp/cev-sim.sock" });
try {
    // Connect a gRPC client to unix:/tmp/cev-sim.sock.
} finally {
    await running.close();
}
```

`close()` is asynchronous and idempotent. The returned object also exposes
`address`, the resolved `config`, and the in-process `supervisor` for embedding
and tests.

## Protocol and loading

The server advertises protocol `1.1`. It accepts clients with major `1` and a
minor version no greater than `1`. Schema changes remain additive within v1;
`EnvironmentHealth` now reports `batch_id`, `restart_count`, and
`requires_reset` in fields 7, 8, and 9.

JavaScript loads the checked-in proto dynamically with
`@grpc/grpc-js` 1.14.4 and `@grpc/proto-loader` 0.8.1. Loader values use camel
case, numeric enums, decimal-string uint64 values, `Buffer` bytes, defaults,
and oneof markers. There are no generated JavaScript bindings.

`GetCapabilities.backends` advertises physics, deterministic state sensors,
and backend kind 3 `deterministic-cpu-bvh-lidar` version `1`. Its locked local
configuration hash is
`488de17bbf8ecf635c18841cd64a9638e011a94a8d9fbb93e4a53943f38bd96d`.
LiDAR episodes require exactly one matching selection and a verified persisted
geometry resource; missing, duplicate, mismatched, and unused CPU LiDAR
selections fail batch preparation. Protocol 1.1 and Protobuf v1 are unchanged.

## Configuration

A config file is a versioned JSON object. Explicit CLI transport and preset
options override their config-file counterparts. Other config values override
the selected preset, whose fallback is `safety`.

```json
{
  "kind": "cev-sim.headless-supervisor-config",
  "version": 1,
  "preset": "safety",
  "maxWorkers": 16,
  "maxRpcMessageBytes": 67108864,
  "memoryPollIntervalMs": 250,
  "shutdownGraceMs": 5000,
  "killGraceMs": 5000,
  "defaultLimits": {
    "maxSensorsPerEnvironment": 32
  },
  "hardCeilings": {
    "maxSensorsPerEnvironment": 64
  }
}
```

Both `defaultLimits` and `hardCeilings` may contain any resource field shown
below. A missing field inherits the selected preset. Defaults cannot exceed
ceilings. A batch value of zero selects the configured default; a nonzero
value must not exceed the configured ceiling.

| Limit | Safety | Permissive |
| --- | ---: | ---: |
| Workers | 32 | 32 |
| RPC message | 64 MiB | 256 MiB |
| RSS/environment | 1 GiB | 2 GiB |
| Heap/environment | 512 MiB | 1 GiB |
| Actors | 256 | 1024 |
| Sensors | 64 | 256 |
| Observation | 16 MiB | 64 MiB |
| Aggregate queue | 16 MiB | 64 MiB |
| Artifacts/episode | 2 GiB | 10 GiB |
| Step timeout | 30 s | 120 s |
| Episode timeout | 6 h | 24 h |
| Restarts | 1 | 3 |

The configurable resource keys are
`maxRssBytesPerEnvironment`, `maxHeapBytesPerEnvironment`,
`maxActorsPerEnvironment`, `maxSensorsPerEnvironment`,
`maxObservationBytes`, `maxQueueBytes`, `maxArtifactBytes`,
`stepWallTimeoutMs`, `episodeWallTimeoutMs`, and `restartBudget`.

## Transport security

Unix sockets inherit normal filesystem access controls. PR 7 TCP has no TLS
or authentication. Loopback hosts are allowed with `--tcp`; binding any other
host requires `--allow-remote-tcp`. That flag is an explicit acceptance of
cleartext, unauthenticated access and should normally be combined with a
container network, firewall, VPN, or local proxy.

## Batch lifecycle

`CreateBatch` validates protocol compatibility, canonical bundle bytes and
envelope hashes, unique bundle IDs, contiguous environment indexes, bundle
references, capacity, static actor/sensor limits, capabilities, and pooled
action/observation spaces. Creation is all-or-nothing and leaves one prepared
worker per environment.

`ResetBatch` takes a sorted unique subset, requires any prior episode to have
been finalized, and creates a new artifact episode. `StepBatch` takes exactly
one sorted action for every ready environment, fans out concurrently, and
returns results in ascending environment-index order. `FinalizeBatch` accepts
a subset or all environments and is idempotent for a completed episode.
`CloseBatch` may finalize active episodes, always disposes every worker, removes
the batch, and deletes known sibling staging directories.

Artifacts publish atomically under:

```text
<output_uri>/<batch-id>/env-<index>/episode-<sequence>-<episode-hash-prefix>/
```

Resource policy, listener choice, logging policy, and artifact paths remain
operational data and do not affect `episodeHash` or `trajectoryHash`.

## Failures and recovery

Malformed and batch-wide failures use the response `ErrorStatus`. An
environment-specific failure occupies that environment's result entry while
healthy peers finish. gRPC status errors are reserved for calls that cannot
be decoded, exceed the message limit, are cancelled, or reach an unavailable
server.

The server centrally maps existing simulator errors to the proto `ErrorCode`
enum. Infrastructure failures never include an observation, reward,
termination, or truncation transition. A crash, step timeout, uncertain IPC
backpressure result, memory breach, or resource breach terminates that worker,
consumes one restart, prepares a replacement, and reports `requires_reset`.
The failed action is never replayed and the failed episode never continues.
An exhausted budget permanently faults only that environment. `Health`
reports environments in stable `(batch_id, environment_index)` order and is
degraded while any environment is restarting or faulted.

## Resource enforcement

Actor and sensor counts are checked before preparation. Packed observation
bytes are checked before a response. The queue limit aggregates pending IPC,
kernel input, delayed sensor delivery, and recording queues. Recording retains
its historical 16 MiB default when no headless limit is supplied. Artifact
staging and log bytes are checked before atomic publication.

Workers report `heapUsed`, RSS, queue use, and their last completed step after
commands and on the configured polling interval (250 ms by default). V8 old
space is also bounded with the worker's heap option. A wall watchdog wraps
every step, and the episode watchdog starts only after a successful reset.

These checks are operational safeguards, not a substitute for an operating
system hard boundary. On Linux, add cgroup-v2 or container constraints sized
for the supervisor plus all selected workers. Examples:

```bash
docker run --memory=40g --memory-swap=40g --pids-limit=256 ...
systemd-run --user --scope -p MemoryMax=40G -p TasksMax=256 cev-sim supervisor --socket /tmp/cev-sim.sock
```

Choose the outer memory limit above `maxWorkers * RSS/environment` plus
supervisor and runtime overhead. A cgroup OOM kill is observed as a worker
crash and follows the same no-replay recovery policy. macOS has no equivalent
per-child cgroup boundary here; RSS polling, V8 heap bounds, watchdogs, and
signal escalation are best-effort enforcement.
