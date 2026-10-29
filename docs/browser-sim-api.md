# Browser simulation lifecycle API

External controllers can launch a saved manifest and control an already-open
simulator page through `/api/browser-sim`. Start the usual `npm run dev` or
`npm run start` server and open its simulator page first. This API does not
launch browser processes or change driving authority. Sensor and `/clock`
traffic continues through the existing orchestrator/Zenoh connection.

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
new ID. Accepted commands keep their original target even if focus changes.

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
| `stop` | Required `runId`. Pause immediately, wait for active sensor work, finalize assertions/results and SFLog, and retain the actual terminal status. Repeated stops return the existing result. |
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
