# Artifact Schema v2

Compiled visual scripts are JSON artifacts produced by `app/scripting/runtime/Compiler.js` and consumed by `app/scripting/runtime/Runner.js`.

Artifacts are data only. They do not include generated JavaScript, `eval`, or serialized functions.

## Identity

Required identity fields:

```json
{
  "kind": "sensor-fusion.visual-script.program",
  "version": 2,
  "name": "program-name"
}
```

`app/scripting/runtime/Artifact.js` rejects artifacts with a different kind or version.

## Top-Level Fields

- `kind`: must be `sensor-fusion.visual-script.program`.
- `version`: must be `2`.
- `name`: human-readable program name.
- `head`: the head node UUID when compiling without program output-role blocks, otherwise `null`.
- `finalStates`: UUIDs evaluated to complete the program.
- `startStates`: UUIDs with no reverse success dependencies.
- `Q`: ordered list of reachable node UUIDs.
- `nodeIndex`: UUID to index map for `Q`.
- `nodes`: frozen node definitions.
- `transitions.success`: typed output-to-input edges.
- `transitions.failure`: currently always empty.
- `failureNode`: reserved failure node metadata.
- `F`: reserved failure-state list.
- `reverseSuccess`: input-to-upstream-output lookup used by the runner.
- `interface`: exported program inputs and outputs.

## Node Definition

Each entry in `nodes` has:

- `uuid`: node UUID.
- `type`: registered block type name.
- `state`: editor/configuration state from `serializeState()`.
- `storedData`: data stored through `ScriptManager.storeData()` or `storeData(...)`.
- `runtimeState`: state from `serializeRuntimeState()`.
- `ports.inputs`: input label to type map.
- `ports.outputs`: output label to type map.

## Success Transition

Each success transition has:

- `from`: upstream block UUID.
- `fromIndex`: index of `from` in `Q`.
- `output`: upstream output label.
- `to`: downstream block UUID.
- `toIndex`: index of `to` in `Q`.
- `input`: downstream input label.
- `type`: shared port type.

The compiler rejects missing ports, type mismatches, duplicate input edges, and cycles.

## Program Interface

`interface.inputs` and `interface.outputs` are arrays of exported ports:

- `uuid`: block UUID.
- `label`: external label.
- `type`: exported type.
- `portId`: optional stable internal port id, used by multi-output nodes.

Program input/output labels must be unique within each role.

## Runtime Behavior

`VisualScriptRunner.run(inputs)` hydrates block classes from registered types, resolves external inputs by label, evaluates final states, and returns:

```json
{
  "status": "success",
  "outputs": {},
  "result": null,
  "e": null
}
```

On failure, `status` is `failure` and `e` contains a serialized error with `name`, `message`, and `stack`.
