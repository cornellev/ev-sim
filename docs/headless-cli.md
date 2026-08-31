# Headless CLI

PR 6 adds a single-process, single-environment command-line runner around the
authoritative JavaScript `HeadlessEpisode`. It loads immutable portable
`cev-sim.run-bundle` version 1 documents directly; it never resolves authoring
manifests or starts the web server.

## Commands

```bash
cev-sim validate --bundle bundle.json [--episode episode.json]
cev-sim inspect bundle.json
cev-sim inspect output-directory
cev-sim inspect output-directory/run.sflog
cev-sim run --bundle bundle.json --output result-dir [--episode episode.json] [--actions actions.jsonl]
cev-sim replay --bundle bundle.json --tape tape.json --output result-dir
cev-sim gpu-preflight --config supervisor.json
```

`validate` checks bundle integrity, semantic identity, episode profiles,
backend capabilities, world/vehicle/sensor prerequisites, and spaces without
stepping or writing artifacts. `inspect` reads a bundle, atomic result
directory, or native SFLog. `run` reads actions from `--actions` or stdin.
`replay` reads the versioned policy tape described below.
`gpu-preflight` launches the configured Chromium stack, validates production
WebGL2/ANGLE identity and required formats, performs minimal camera/LiDAR
render-readback, and verifies shared-memory round-trip, stale-generation
rejection, and cleanup. Its single JSON result includes launch/sandbox and
renderer provenance. It requires a supervisor config containing
`renderer.chromiumExecutable`; software renderers cannot satisfy production
availability.

The local repository executable is `./bin/cev-sim.js`. Installed packages
expose the `cev-sim` bin. JSON and JSONL are written to stdout; diagnostics are
written to stderr.

## Streaming actions and output

Each non-empty JSONL input line contains one normalized policy action:

```json
{"policyStep":1,"action":[0.5,-0.1]}
```

`policyStep` is one-based and contiguous. Speed and steering must both be
finite and within `[-1, 1]`. EOF before termination or truncation finalizes an
interrupted, non-passing result. An interactive terminal requires
`--actions`; a pipe may supply actions on stdin.

`run` and `replay` emit `cev-sim.headless.reset`, zero or more
`cev-sim.headless.transition`, and one `cev-sim.headless.result` version 1
record. Packed tensor bytes use `{ "encoding": "base64", "type": "...",
"data": "..." }`; uint64 result fields are decimal strings.

- Reset records contain `environmentIndex`, the episode/space `descriptor`,
  initial `observation`, and reset `info`.
- Transition records contain `policyStep`, `observation`, `reward`, terminal
  flags, hashes, reward terms, and diagnostic `info`.
- Final records contain the canonical `result`, content-addressed `artifacts`,
  and the atomically published `outputDirectory`.

## Policy action tape

The runner tape is deliberately distinct from the PR 1 topic-characterization
tape:

```json
{
  "kind": "cev-sim.headless.policy-action-tape",
  "version": 1,
  "episodeSpec": { "actionRepeat": 5 },
  "actions": [
    { "policyStep": 1, "action": [0.5, -0.1] }
  ],
  "expect": {
    "episodeHash": null,
    "trajectoryHash": null,
    "passed": null
  }
}
```

Expectation fields are optional. A mismatch is a semantic failure and is
recorded in the final result. The canonical PR 1
`cev-sim.headless.action-tape` remains a topic-level characterization input
and is not accepted by this command.

## Atomic artifacts

The runner stages beside the requested output path and publishes the complete
directory with one rename. Existing destinations are refused. Semantic
failures still publish evidence; invalid input, runtime failure, and required
artifact failure leave no final directory.

Every artifact profile writes:

```text
run-results.json
run-bundle.json
provenance.json
```

Retained native logs use stable names `run.sflog` and `run.json`. SFLog embeds
the resolved run, portable bundle, calibration when present, provenance, and
final result. Provenance records runtime/package, Node, platform,
architecture, git hash when supplied, and backend identities; it omits host,
user-path, and credential data.

Profiles:

- `evaluation` always retains a full SFLog. Log failure is fatal when the
  manifest policy is `required` and degradable otherwise.
- `training` keeps core JSON and retains a full SFLog when deterministically
  sampled or failure-promoted. Defaults are sample rate `0` and promotion on.
- `disabled` keeps core JSON and omits SFLog.

Use `--artifact-profile`, `--sflog-sample-rate`,
`--sflog-on-failure`, or `--no-sflog-on-failure`. Required manifest logging
cannot be downgraded and always produces a required evaluation log. Otherwise,
an explicit caller profile selects evaluation, training, or disabled; without
one, optional logging produces a degradable evaluation log and disabled
logging omits SFLog. Artifact policy and paths never enter episode or
trajectory identity.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Validation/inspection succeeded or the episode passed |
| `1` | Semantic failure, interrupted episode, or replay expectation mismatch |
| `2` | Command-line usage error |
| `3` | Invalid bundle, episode specification, action, or capability |
| `4` | Required artifact/output failure |
| `5` | Unexpected runtime failure |
| `130` | SIGINT after result finalization and teardown |

Process isolation, batching, gRPC, limits, and watchdogs are available through
the separate [headless batch supervisor](headless-supervisor.md). They are not
implicit in this direct runner.
