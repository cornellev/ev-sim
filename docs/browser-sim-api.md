# Browser simulation lifecycle API

External controllers can launch a saved manifest and control an already-open
simulator page through `/api/browser-sim`. Start the usual `npm run dev` or
`npm run start` server and open its simulator page first. This API does not
launch browser processes or change driving authority. Sensor and `/clock`
traffic continues through the admitted Zenoh connection. The server acquires
the pinned local router automatically; see [protobuf-routing.md](protobuf-routing.md)
for startup, explicit endpoints, and Windows x64 browser use.

## Endpoints

| Method and path | Response |
| --- | --- |
| `GET /api/browser-sim/browsers` | `{ browserId, browsers }`; `browserId` is the current default, or `null`. Each browser includes status and `isDefault`. |
| `GET /api/browser-sim/status?browserId=…` | The requested or default browser's latest status. |
| `POST /api/browser-sim/commands` | HTTP `202` with a command receipt. Acceptance does not mean execution has completed. |
| `GET /api/browser-sim/commands/:commandId` | The current receipt, including a completion snapshot or error. |

All responses disable HTTP caching. The existing local HTTP host/origin
protections apply, including the existing explicit opt-in for remote access.

### Default browser selection

An explicit `browserId` always selects that exact page. Without it, commands
and status use the connected page with the most recently reported human
interaction: window/tab focus, pointer presses, keyboard input, or scrolling.
Synthetic DOM events, API requests, heartbeats, and simulation updates do not
advance interaction order. The server assigns that order; browser wall clocks
are not compared. An initially focused page reports activity on registration.
If no page has reported activity, the most recently registered page wins.

Pages report status every five seconds and on lifecycle/activity changes.
After fifteen seconds without contact, a page is unavailable. Default selection
excludes unavailable pages. An unavailable explicit target returns HTTP `503`
`BROWSER_UNAVAILABLE` instead of selecting another page. A page reload gets a
new ID. The page keeps a tab id in `sessionStorage`, which survives reload in
that tab and is not shared with other tabs. Registering that tab again drops
the previous id immediately, so one visible tab is one connected browser
before the fifteen-second timeout. A crashed or killed page still waits out
that timeout. Accepted commands keep their original target even if focus changes.

Every status and command receipt identifies its selected `browserId`. Status
also reports `connected`, `lastSeenAt`, `lastInteractionAt`, `interactionOrder`,
`commandId`, `status`, `runId`, `manifestId`, `manifestRevision`, `resolvedHash`,
`step`, `timeNs`, `stepNs`, `transitioning`, `degraded`, `error`, and a compact
`runResult` after finalization. `timeNs` and `stepNs` are decimal strings from
the simulator's integer clock. `lastSeenAt` is server wall time and describes
snapshot freshness; polling status is not a synchronous stepping protocol.

### Commands

Submit a JSON object with `action` and the following action-specific fields:

| Action | Fields and behavior |
| --- | --- |
| `start` | Required `manifestId`; optional `autoplay` defaults to `true`. Resolve the saved manifest once, prepare that exact snapshot, and play. `false` leaves it ready at step zero. |
| `pause` | Required `runId`. Freeze the current episode after active sensor work settles. Pausing a ready run leaves it ready. |
| `resume` | Required `runId`. Play a ready/paused episode; an already-running episode is unchanged. |
| `stop` | Required `runId`. Pause immediately, drain active sensor work, finalize assertions/results and SFLog, and stop the engine within a shared 15-second shutdown budget. Repeated stops retain the existing result or failure. |
| `reset` | Required `runId`. Resolve the latest saved revision of that run's manifest, finalize the old run if needed, and prepare a fresh run at zero without autoplay. Resolution failure leaves the current run intact. |

All actions accept optional `browserId` and `requestId`. `runId` guards against
controlling a replacement run. It does not select a browser: without a
`browserId`, the default page is selected first, then its run ID is checked.
For a multi-command session that must stay on one page, retain and explicitly
send the `browserId` returned by start.

A repeated `requestId` with the same normalized arguments returns the original
receipt and target without execution or resolution again. Different arguments
return HTTP `409` `REQUEST_ID_CONFLICT`. Omitted `autoplay` and `true` are
equivalent. Idempotency lasts while the receipt is retained.

Only one command can be active per page. A new start while a run is preparing,
ready, running, or paused returns a conflict; stop it first. Preparation and
finalization, including initial scene loading, return `BUSY`; an experiment-owned page returns
`EXPERIMENT_ACTIVE`, and stale run IDs return `RUN_ID_MISMATCH`. Commands that
would leave unsaved workspace edits return `NAVIGATION_BLOCKED`, without a
dialog or a deferred launch. The browser repeats these checks against live
state before execution. Invalid JSON command fields return HTTP `400`
`INVALID_REQUEST`. Browser execution and resolution failures appear in the
command receipt's `error: { code, message }`.

### Acknowledgements and recovery

Stop uses one 15-second wall-time deadline across sensor drain, transport close,
recording startup, uploads, and log finalization. A stalled stage reports
`RUN_STOP_TIMEOUT`; the engine is stopped and `transitioning` clears. Required
logging failure produces an error result with `passed: false`. Optional logging
failure preserves the simulation result and marks logging degraded. Known log
IDs remain available for partial-log inspection. Repeated Stop does not retry
finalization, dispatch another episode stop, or erase the failure.

Pause also bounds its sensor drain at 15 seconds. If capture cannot settle,
it ends the run with a shutdown error. Canceled captures cannot complete their
delivery/assertion/hash phase, and an interrupted episode requires Reset or
fresh preparation before playback. Play, Pause, and Step are disabled during
shutdown and after a terminal result; Reset becomes available once shutdown
settles. Timers require a responsive browser JavaScript thread; suspension or
a blocked thread can still delay acknowledgement under the `unknown` rules below.

Receipts have `commandId`, `browserId`, `action`, `state`, `createdAt`,
`updatedAt`, `error`, and `snapshot`. States are `accepted`, `running`,
`succeeded`, `failed`, or `unknown`. Only a browser acknowledgement produces
`succeeded`. A succeeded lifecycle command can still have a failed or
interrupted *simulation result*; inspect `snapshot.runResult` separately.

The bridge uses the existing shared SSE stream for prompt delivery and
heartbeats to recover missed notifications. Internal `/bridge/*` endpoints
register pages, report status, claim commands, and complete them using a
page-specific token. They are not the external controller interface.

An unclaimed command expires after sixty seconds or when its page becomes
unavailable. Losing contact after a claim produces `unknown`, not a fabricated
success or simulation transition. That page remains busy until its original
execution acknowledges completion or the page is reloaded. Never retry an
uncertain action with a new request ID to guess its outcome.

The registry is process memory: at most 32 pages and 256 receipts. Completed
receipts expire after ten minutes and can be evicted earlier at capacity;
unresolved commands are not evicted while their page remains connected.
Server restart discards the registry. Page reload and server restart never
replay commands. A closed HTTP client does not stop a simulation. Browser
suspension can delay execution and heartbeats.

### Owned external controllers

The onboarding leased command@2 interface requires control ownership:

1. Select a connected `browserId` and acquire a lease with
   `POST /api/interfaces/control-ownership`, body
   `{ "target": { "kind": "browser", "id": "BROWSER_ID", "vehicleId": "ego" }, "mode": "autonomous" }`.
   Retain `leaseId` and the returned credential `token`.
2. Renew every 250 ms with `POST /api/interfaces/control-ownership/LEASE_ID/renew`
   and `Authorization: Bearer TOKEN`. The lease expires after 750 ms; keep
   renewing throughout preparation and execution.
3. Submit `start` with the saved manifest, selected browser, `autoplay: false`,
   `controlLeaseId`, and `controlLeaseToken`. Wait for its succeeded receipt.
4. Use its `snapshot.runId` in wire commands. Submit `resume` with that run ID,
   browser ID, and the same lease ID/token. Command@2 carries the lease ID;
   never reuse a prior run's identity or sequence fence.

Lease loss clears controls and pauses locally. Router ownership and control
ownership are separate. An owned headless run uses the existing
`/api/headless/external-runs` preparation/commands API with its headless lease;
the direct CLI does not provide the ownership service. Headless Zenoh requires
the Linux addon, including when using WSL2 on Windows.

## Example

Start the manifest in the most recently interacted-with simulator page:

```sh
curl -sS http://127.0.0.1:3000/api/browser-sim/commands \
  -H 'Content-Type: application/json' \
  -d '{"action":"start","manifestId":"igvc-default","requestId":"controller-session-001"}'
```

Poll the returned command ID until its state is terminal, then retain the
`browserId` and `snapshot.runId` from the successful receipt:

```sh
curl -sS http://127.0.0.1:3000/api/browser-sim/commands/COMMAND_ID
curl -sS http://127.0.0.1:3000/api/browser-sim/status
curl -sS 'http://127.0.0.1:3000/api/browser-sim/status?browserId=BROWSER_ID'

curl -sS http://127.0.0.1:3000/api/browser-sim/commands \
  -H 'Content-Type: application/json' \
  -d '{"action":"pause","browserId":"BROWSER_ID","runId":"RUN_ID"}'
```

Use `resume`, `stop`, or `reset` with the same targeting fields. Poll each
command receipt before submitting the next. Reset returns a new run ID; use
that ID for subsequent commands. To start a new session, use a new request ID.
