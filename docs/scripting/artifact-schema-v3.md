# Artifact Schema v3

Compiled visual scripts are JSON artifacts produced by `app/scripting/runtime/Compiler.js` and consumed by `app/scripting/runtime/Runner.js`.

The current compiler emits `version: 3`. The runtime accepts frozen `version: 2` and `version: 3` artifacts. Artifacts are data only. They do not include generated JavaScript, `eval`, or serialized functions.

The [v2 schema](artifact-schema-v2.md) remains historical. Existing v2 documents stay runnable without migration.

## Identity

Required identity fields:

```json
{
  "kind": "cev-sim.visual-script.program",
  "version": 3,
  "name": "program-name"
}
```

`app/scripting/runtime/Artifact.js` exports `VISUAL_SCRIPT_VERSION = 3` and `SUPPORTED_ARTIFACT_VERSIONS = [2, 3]`. `assertSupportedArtifact()` accepts only those versions. `EditorDocument.isCompiledArtifact()` uses the same membership test so editor documents retain v2 `latestValidArtifact` values and `createArtifactOnlyDocument()` can import both versions.

## Top-Level Fields

- `kind`: must be `cev-sim.visual-script.program`.
- `version`: `3` for newly compiled programs; `2` remains executable.
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

The compiler snapshots `nodes[].ports` from resolved editor types. Those maps, `transitions[].type`, and program interfaces must never contain `generic`. `generic` is editor-only and is solved (or rejected) before compile.

`VisualScriptRunner._hydrateUnits()` applies cloned `node.ports` to `unit.typeMap` after `hydrateState()` and `hydrateRuntimeState()`. Frozen artifact ports override the current class registration. That keeps v2 and early-v3 artifacts runnable when later block classes add or rename ports. Current effect blocks register `then` plus identity outputs; frozen artifacts may still contain `written`, `ok`, or `staged`. `BlockOutput.setDeclared()` writes only labels present on the hydrated `typeMap`.

Effect order is not implied by graph layout. A write or assert runs only if it is reachable from a final state through `then`, an identity output, `Sequence`, or `Passthrough`.

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

Program input/output labels must be unique within each role. Exported `type` values are concrete strings from `SUPPORTED_TYPES`, including `unit` and `actor_command`. They must never be `generic`.

## Evaluation Policy

Selector blocks read `this.manager.evaluationPolicy.lazySelectors`:

- Editor `ScriptManager`: `{ lazySelectors: true, memoizeExecute: true }`.
- Compiled `VisualScriptRunner`: `{ lazySelectors: artifact.version >= 3, memoizeExecute: true }`.

v2 compiled execution stays eager:

- `IfBlock.execute()`: condition, true branch, false branch.
- `WeightedSelectBlock.execute()`: `a`, `b`, probability, then random choice.
- `SignalLatchBlock.execute()`: always read `value`.

Editor and v3 compiled execution evaluate only the selected `If` / `WeightedSelect` input and skip `SignalLatch.value` when `valid === false` and a cached value exists. False, zero, and empty-string branch values are preserved without `||` coercion.

`SignalDefaultBlock.execute()` is lazy in every version: it reads `useDefault`, then only `fallback` or `value`.

## Hashes

Recompiling a script to v3 changes the artifact bytes, including `version`. `StorageService` locks scripts with `hash: semanticHash(artifact)`, so a v3 recompile changes the script lock hash, `resolvedHash`, `simulationSemanticHash`, and therefore `episodeHash`. It does not change `worldHash`.

## Runtime Behavior

`VisualScriptRunner.run(inputs)` hydrates block classes from registered types, overlays frozen ports, resolves external inputs by label, evaluates final states, and returns:

```json
{
  "status": "success",
  "outputs": {},
  "result": null,
  "e": null
}
```

On failure, `status` is `failure` and `e` contains a serialized error with `name`, `message`, and `stack`.
