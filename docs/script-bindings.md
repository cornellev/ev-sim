# Script Bindings

Bindings connect compiled visual scripts to live triggers: ROS topics, fixed simulation updates, signal changes, wall-clock timers, and deterministic simulation-time timers. They are managed in the **Bindings** workspace (Escape menu, "Bindings") and executed by the `BindingRuntime`.

## Concepts

- A **binding** references one script from the local script library and describes when it runs, where its inputs come from, and where its outputs go.
- All bindings live in a single versioned **library manifest** at `server/data/bindings.json`. Version 2 adds ordered single-level folders and activation scope; version 1 documents are accepted and migrated as global, unfiled bindings.
- A binding with `scope: "global"` is active outside resolved runs and in every run manifest. A `scope: "selected"` binding is active only in manifests that include its id in `scripts.bindingIds`; new bindings start selected and unassigned.
- All bound scripts share one **signal store**. Topic updates are bridged into `topics.<name>`, and each fixed step writes a `simulation` snapshot (`{ dt, time, step, frame }`), so signal blocks inside scripts observe live data.

## Files

- `app/scripting/bindings/BindingDocument.js` — manifest schema, normalization, validation, trigger suggestions from artifact metadata.
- `app/scripting/bindings/BindingStorage.js` — canonical `/bindings` persistence, legacy settings migration, and JSON serialize/parse.
- `app/scripting/bindings/BindingRuntime.js` — the dispatcher. Singleton via `getBindingRuntime()`, exposed as `data.bindings()`.
- `app/scripting/bindings/BindingsPage.js` — the Bindings workspace UI.
- `tests/script-bindings.test.js` — document and runtime tests.

## Manifest schema

```json
{
  "kind": "cev-sim.script-bindings",
  "version": 2,
  "enabled": true,
  "updatedAt": "2026-07-03T00:00:00.000Z",
  "folders": [
    { "id": "controllers", "name": "Controllers" }
  ],
  "bindings": [
    {
      "id": "5f0c9a7e-...",
      "name": "Drive command handler",
      "enabled": true,
      "folderId": "controllers",
      "scope": "selected",
      "scriptId": "abc-123",
      "trigger": { "kind": "topic", "topic": "/ackdrive" },
      "inputs": [
        { "input": "speed", "source": "message", "field": "speed" },
        { "input": "gain", "source": "constant", "value": 1.5 },
        { "input": "dt", "source": "sim", "key": "dt" },
        { "input": "pose", "source": "signal", "path": "vehicle.ego", "field": "pose" }
      ],
      "outputs": [
        { "output": "steering", "sink": "signal", "path": "vehicle.ego.steering" },
        { "output": "cmd", "sink": "publish", "topic": "/cmd_out", "type": "sensor_fusion_msgs/AckermannDrive" }
      ]
    }
  ]
}
```

`scriptId` is the local script document id (the same id used by `loadScript("local:<id>")`).

### Triggers

| Kind | Fields | Fires |
| --- | --- | --- |
| `topic` | `topic` | Each time the ROS bridge delivers an update for that topic. The message is available to `message` inputs. |
| `fixed-update` | `everyN` (default 1) | Every N fixed simulation steps, from `SimulationEngine._fixedStep`, gated by the `scripting` module toggle. |
| `signal-update` | `path` | When the value at a signal store path changes (checked after each tick and topic write). The first observation is a baseline and does not fire. |
| `timer` | `intervalMs` | On a wall-clock interval, independent of the simulation loop (runs while paused). |
| `simulation-timer` | `intervalNs` | At deterministic simulation-time intervals; pauses with the simulation and is valid in resolved runs. |

### Input sources

| Source | Fields | Resolves to |
| --- | --- | --- |
| `signal` | `path`, optional `field` | Value at a signal store path, optionally a dotted sub-field. |
| `message` | optional `field` | The triggering topic message (topic triggers only), optionally a sub-field. |
| `constant` | `value` | The literal JSON value. |
| `sim` | `key`: `dt` \| `time` \| `step` | The simulation clock value for the dispatch. |

### Output sinks

| Sink | Fields | Effect |
| --- | --- | --- |
| `signal` | `path` | Writes the script output to the signal store (source `"binding"`). |
| `publish` | `topic`, `type` | Publishes through the orchestrator WebSocket via `Client.publish`. |

## Runtime behavior

- The runtime is a module singleton so it survives workspace switches. It keeps the editable library separate from the active binding set: library mode activates only global bindings, while resolved runs install a frozen global-plus-selected set. `Data` attaches its `ClientManager` on scene start; `SimulationEngine` calls `bindings().update(dt)` each fixed step when `modules.scripting` is enabled.
- Scripts are loaded and cached per `scriptId`, sharing the runtime's signal store. Scripts without a valid compiled artifact report a load failure in telemetry; the loop is never interrupted.
- Script failures roll back staged signal writes (standard runner transaction semantics) and are recorded per binding: last status, error, inputs, outputs, run count, timing.
- The master `enabled` flag on the manifest suspends all automatic dispatch. "Run now" in the UI dispatches manually regardless, using the last received topic message as context.

## Relationship to in-graph trigger blocks

`On Tick` / `On Signal Update` / `On Timer` / `Bind Trigger` blocks still compile into `artifact.entrypoints` / `artifact.bindings` metadata. The manifest is the source of truth for execution; when you select a script in the Bindings page and the trigger is still untouched, the page pre-fills the trigger from that metadata as a suggestion.
