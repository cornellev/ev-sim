# Run Configuration Simple Mode

This document is the implementation handoff for the `CFG-*` program. It adds
Simple Mode to the existing Run Configuration workspace and preserves the
current detailed editor as Advanced Mode. Both views edit one run manifest.

## Status and scope

- Status: CFG-06 is implemented. Playwright was not run, so the browser gate is open. CFG-05, CFG-04, CFG-03, and CFG-01 browser gates remain open.
- Next package: none. The code packages are complete. Browser acceptance is still open.
- Delivery: six dependency-ordered PRs, each implemented in a separate session.
- Last updated: **2026-11-10**.

| Package | Depends on | Status |
| --- | --- | --- |
| CFG-01 — Shared session and preservation safeguards | None | Implemented; Playwright not run |
| CFG-02 — Two execution presets and comparison model | CFG-01 | Implemented |
| CFG-03 — Simple workspace and mode switching | CFG-02 | Implemented; Playwright not run |
| CFG-04 — Effective summary and Custom Settings | CFG-03 | Implemented; Playwright build failed |
| CFG-05 — Validation navigation and launch integration | CFG-04 | Implemented; Playwright build failed |
| CFG-06 — Acceptance, documentation, and default | CFG-05 | Implemented; Playwright not run |

Phase 1 covers Run Configuration only. Keep its existing workspace-switcher
entry and existing browser launch path. Scenario Simple Mode, editor redesigns,
new headless submission controls, and a Test / CI preset are outside this
phase. Do not add scaffolding for deferred presets.

This is separate from the headless, environment, visual, plugin, marketplace,
planner, and vehicle roadmaps. It does not extend their numbered milestones.

## Locked behavior

### One shared editor session

`app/config/ConfigPage.js` remains the owner of the draft, saved revision, raw
JSON, catalogs, validation, and actions. Extract only the components and
helpers needed by both views. Keep the JavaScript/ES module style and existing
dependencies.

- Mode switching changes presentation only. It must not normalize, apply a
  preset, save, or otherwise mutate the draft.
- Preserve unsaved changes, Advanced tab selection, and invalid JSON buffers.
- Keep the Advanced editor mounted while Simple is visible, with its hidden
  content excluded from keyboard navigation and the accessibility tree.
- Show all existing technical fields within Advanced through a local
  authoring-provider override. Do not change other editors' field visibility.
- Remove draft-changing effects triggered solely by mounting or revealing a
  panel. Inherited plugin selections must change through explicit editor
  actions that retain the existing lock validation and capability behavior.
- Both views use the same validation, optimistic save, migration, serialization,
  resolution, and launch actions. Resolution output never replaces the
  authoring draft.

Register invalid raw and field-level JSON buffers with the shared session.
While an unapplied invalid buffer exists, show the error in both views and
block ordinary configuration mutations, Save, and Launch. Users can still
switch views, repair the buffer, or explicitly discard it. Discarding a buffer
restores that editor from the current valid draft and preserves other unsaved
changes. Include pending buffers in navigation protection.

### Workspace-specific preference

Use `cev-sim.ui.runConfig.mode` with `simple` and `advanced` values, following
the existing application preference conventions.

1. An explicit valid Run Configuration preference wins.
2. Without one, honor the existing global Advanced preference when it is true.
3. Otherwise default to Simple.

Persist only explicit mode choices. Keep switching functional for the current
session when storage is unavailable. Changing the run preference must not
write the global preference or change another workspace's settings. The
Simple / Advanced control is in the workspace menu Settings pane.

### Simple workspace

Reuse the existing dark theme, typography, borders, shared controls, segmented
control, status messages, and dialogs. Use a compact single-page layout.

| Area | Content |
| --- | --- |
| Header | Editable name, validation state, Validate, Save, Launch |
| Scenario | Scenario selection, environment summary, missing/stale-reference status |
| Vehicle | Ego vehicle selection and sensor-inheritance status |
| Execution | Standard Simulation / External Controller, actual control source, pacing and speed |
| Optional settings | Recording policy; manifest-only initial position, heading, and longitudinal speed |
| Sensors | Effective sensor counts/types, inheritance status, Customize action |
| Effective summary | Scenario, environment, vehicle, control, timing, recording, sensors |
| Custom Settings | Differences from the comparison baseline, with Edit and Reset actions |

Preserve catalog create, select, duplicate, delete, import, and export actions
and their existing safeguards. Keep them reachable at the supported narrow
breakpoint as well as desktop size.

Keep manifest-only runs supported. Show environment selection when no scenario
supplies it. Edit the existing control target's vehicle type and basic initial
state; leave actor creation and multiple-actor management in Advanced. Editing
one position, rotation, or velocity component must preserve the others.

Scenario runs show initial state as supplied by the scenario. Do not expose
run-level pose inputs whose values would be replaced during resolution.

New Simple-created runs initialize compatible vehicle sensor inheritance
through existing utilities. Do not change the global manifest constructor,
built-in saved runs, or existing saved configurations. Vehicle changes preserve
run overrides and extra sensors. Removed inherited mounts stay represented as
errors until explicitly resolved. Newly required plugin locks or grants need
an explicit preview and confirmation; unsupported sensors must not be omitted.

### Two execution presets

Keep the interface label **Execution profile**, with exactly two choices.
Implement them as small UI-level patches over existing supported manifest
fields, without a persisted profile field or an inheritance system.

| Profile | Fields applied | Compatibility and explanation |
| --- | --- | --- |
| Standard Simulation | Reference authority; realtime pacing; speed 1; optional recording | The scenario ego uses a local route follower, script, or script-with-route controller. Display the actual controller. |
| External Controller | Realtime pacing; speed 1; clock publishing enabled; authority appropriate to the existing external-control path | Use candidate authority for direct command input, or reference authority when the scenario's ego `external-ros` controller consumes it. Show the connection requirements. |

Neither preset changes the seed, fixed step, manifest step limit, scenario
duration, sensor configuration, topic mappings, controller scripts, watchdog,
stale policy, fallback commands, actuator limits, or plugin grants. External
Controller also preserves the recording policy. Do not add a finite-duration
requirement or require recording for either preset.

Presets do not create or rewrite scenario controllers or repair missing
topics. Explain unmet prerequisites and link to their editing surface.
Preserve manifest-only and unusual existing configurations as Custom rather
than changing them to make a preset fit.

Use one pure preview interface:

```text
previewProfile(manifest, profileId, context)
    -> { nextManifest, changes, issues }
```

Show the actual old and new values, including normalization consequences.
Require confirmation before applying changes to an existing draft. Apply the
reviewed candidate atomically and preserve all unrelated fields. Cancellation
leaves the draft unchanged. A changed draft or dependency context invalidates
the preview. Opening a configuration or switching views never applies a
preset.

### Effective summaries and overrides

Use the existing draft-capable resolve endpoint for authoritative effective
values. Refresh after 400 ms without edits, allow one request in flight, and
retain only the latest pending draft. Reject stale responses and invalidate
results when relevant dependencies change. Invalid JSON suspends resolution.
Show checking, unresolved, and failed states explicitly; never present stale
values as current or validated.

Construct the comparison baseline from existing defaults, the selected
scenario/environment/vehicle, normal vehicle inheritance, and the chosen
preset patch. Use the existing resolver for effective baseline values too;
refresh that baseline only when its context changes.

- Infer the comparison profile from its supported settings and compatibility.
  Check External first, then Standard. If neither matches, compare with
  Standard and label the run Custom.
- Retain the comparison baseline for the current editing session. Reopen by
  inference; do not store a profile selection locally or in the manifest.
- A matching execution profile with other overrides displays Custom and names
  the comparison baseline. Do not claim to know which fields were edited
  manually.
- Exclude configuration identity, storage metadata, and scenario/environment/
  vehicle selections themselves from override counts. Include supported
  advanced behavior, provenance, locks, bindings, scripts, and transports.
- Display current effective values beside baseline or inherited values. Group
  collection differences by stable IDs instead of array-index noise.
- Provide Edit actions that focus a Simple field or open its Advanced tab.
  Reset only the selected field or necessary dependent group, previewing
  consequential changes before applying them. Do not add a reset-all action.
- Show **Custom advanced settings active** with direct links to affected tabs.
- When resolution fails, keep authored differences visible and mark effective
  values unavailable. Do not substitute an apparently compatible configuration.

The run manifest remains the authoritative saved representation. No new
manifest fields, schema version, REST endpoint, package format, protocol field,
or hash algorithm is required. Presentation and mode choices enter no
simulation identities; explicit manifest edits retain their existing identity
effects.

## Work packages and gates

### CFG-01 — Shared session and preservation safeguards

Separate the existing Advanced view from workspace chrome while retaining
state and actions in ConfigPage. Preserve its tab and editor lifetimes.
Register invalid JSON buffers, navigation protection, and shared action
guards. Move draft-changing mount effects into explicit configuration actions.
Add the CFG progress table and decision log before feature implementation.

**Gate:** Existing Advanced workflows work unchanged. Visibility changes
preserve draft values, dirty state, tab, JSON buffers, sensor configuration,
and plugin selections. Invalid buffers cannot be silently saved or launched.

**CFG-01 checks, 2026-11-06.** `node --experimental-default-type=module --test tests/run-config-session.test.js tests/authoring-mode.test.js` passed 10 tests. `npm run lint` exited 0 with the three existing warnings in `app/3d/overlay/map/MapSurface.js` and `app/marketplace/ui/MarketplaceWorkspace.js`. `npm test` ran 2505 tests: 2492 passed and 5 failed. Those five match the 2026-11-05 suite and sit outside this package: the pinned headless characterization comparison, plan-view control arcs, plugin range-image parent updates, state-sensor vehicle mounts, and the lidar hierarchy row. The characterization fixture was left unchanged. Playwright was skipped; a launch in this session exited before any assertion because the browser executable was missing. The Advanced-workflow part of this gate is unverified.

### CFG-02 — Two execution presets and comparison model

Implement the two definitions, compatibility checks, pure previews, profile
inference, contextual baselines, and override comparison helpers under the
configuration UI. Reuse normalization and sensor-inheritance utilities.

**Gate:** Unit tests verify exact patch boundaries, both external-control
paths, meaningful Custom inference, non-mutating previews, and preservation of
advanced customizations. Neither preset changes seed or duration bounds, and
neither requires a finite scenario duration.

**CFG-02 checks, 2026-11-06.** `node --experimental-default-type=module --test tests/execution-profiles.test.js` passed 9 tests. `npm run lint` exited 0 with the three existing warnings in `app/3d/overlay/map/MapSurface.js` and `app/marketplace/ui/MarketplaceWorkspace.js`. `npm test` ran 2514 tests: 2501 passed, 5 failed, and 8 skipped. The five failures match the CFG-01 suite and sit outside this package: the pinned headless characterization comparison, plan-view control arcs, plugin range-image parent updates, state-sensor vehicle mounts, and the lidar hierarchy row. The characterization fixture was left unchanged. Playwright was not run; this package adds no UI.

### CFG-03 — Simple workspace and mode switching

Add the scoped preference and visible segmented switch. Build the essential
controls, inheritance status, two-choice profile picker, and preview dialog.
Retain existing catalog operations and the workspace switcher. Make Simple
available explicitly; keep the initial default Advanced until CFG-06.

**Gate:** Users can select a compatible scenario and vehicle, save, and launch
from Simple. Mode switches preserve unsaved edits. Missing catalog entries
remain represented and recoverable. Other editor preferences are unchanged.

**CFG-03 checks, 2026-11-06.** `node --experimental-default-type=module --test tests/run-config-mode.test.js tests/simple-run-workspace.test.js` passed 10 tests. `npm run lint` exited 0 with the three existing warnings in `app/3d/overlay/map/MapSurface.js` and `app/marketplace/ui/MarketplaceWorkspace.js`. `npm test` ran 2524 tests: 2511 passed, 5 failed, and 8 skipped. The five failures match the CFG-01 suite and sit outside this package: the pinned headless characterization comparison, plan-view control arcs, plugin range-image parent updates, state-sensor vehicle mounts, and the lidar hierarchy row. The characterization fixture was left unchanged. Playwright was not run. Selecting a scenario and vehicle, saving, and launching from Simple in the browser are unverified.

### CFG-04 — Effective summary and Custom Settings

Connect draft resolution, baseline resolution, loading/failure states,
advanced-customization indicators, Edit links, and targeted Reset actions.
Invalidate summaries and previews after draft or dependency changes. Preserve
unsupported sensor/plugin placeholders and report their failures.

**Gate:** Summaries match resolved output, including scenario state and
inherited sensors. Overrides remain visible after reopening. Resets affect
only reviewed fields, and delayed responses cannot restore stale values.

**CFG-04 checks, 2026-11-07.** `node --experimental-default-type=module --test tests/effective-resolution.test.js tests/execution-profiles.test.js tests/simple-run-workspace.test.js` passed 23 tests. `npm run lint` exited 0 with the three existing warnings in `app/3d/overlay/map/MapSurface.js` and `app/marketplace/ui/MarketplaceWorkspace.js`. `npm test` ran 2455 tests: 2419 passed, 28 failed, and 8 skipped. Five failures match the CFG-01 suite and sit outside this package: the pinned headless characterization comparison, plan-view control arcs, plugin range-image parent updates, state-sensor vehicle mounts, and the lidar hierarchy row. The other 23 fail while importing `setDriveAreaElevation` from `app/3d/editor/document/documentMutations.js`, which this package does not change. The characterization fixture was left unchanged. `npx playwright test tests/ui/run-config-simple.spec.js` did not reach an assertion: the production build exited while prerendering `/` because the uncommitted `drive-area` object type has a legacy domain the registry rejects. Selecting a scenario, saving, and launching from Simple in the browser remain unverified.

### CFG-05 — Validation navigation and launch integration

Give validation issues actionable locations. Focus available Simple fields;
otherwise switch to Advanced, select the relevant tab, and focus its control
or section. Cover plugin selections, sensor transports, parameters, schemas,
render recipes, and unknown paths. Unknown paths open Advanced JSON.

Retain original technical details alongside understandable explanations.
Preserve shared optimistic saves, migration behavior, launch validation,
runtime preflight, and preparation failures. Serialize launch actions to
prevent duplicate launches from repeated clicks.

**Gate:** Both views block the same invalid configurations. Hidden errors
remain visible and actionable. Revision conflicts and failed preparation
preserve the draft. Valid server resolution is not presented as proof of an
available external connection or successful runtime preparation.

**CFG-05 checks, 2026-11-07.** `node --experimental-default-type=module --test tests/simple-run-workspace.test.js tests/run-config-session.test.js` passed 16 tests. `npm run lint` exited 0 with the three existing warnings in `app/3d/overlay/map/MapSurface.js` and `app/marketplace/ui/MarketplaceWorkspace.js`. `npm test` ran 1692 tests: 1534 passed, 156 failed, and 2 skipped. The failures sit outside this package. The uncommitted `drive-area` object type is rejected by the object registry and fails every file that imports it. The pinned headless characterization comparison, plan-view control arcs, state-sensor vehicle mounts, and the lidar hierarchy row still fail. Marketplace CLI assertions failed as well, including a writer-lock timeout. The characterization fixture was left unchanged. `npx playwright test tests/ui/run-config-simple.spec.js` did not reach an assertion: the production build exited while prerendering `/` because of that same `drive-area` type. Clicking a validation issue and launching from the browser remain unverified.

### CFG-06 — Acceptance, documentation, and default

Update existing UI tests to choose Advanced explicitly when testing technical
controls. Add complete Simple workflows and compatibility coverage. Update
operator documentation and the CFG decision log, then enable Simple by
default under the scoped preference rules.

**Gate:** Required checks pass, with the pre-existing characterization failure
tracked separately as described below. Final acceptance remains pending until
that failure is resolved through the existing contract-review process.

**CFG-06 checks, 2026-11-07.** `node --experimental-default-type=module --test tests/run-config-mode.test.js tests/run-config-session.test.js tests/simple-run-workspace.test.js tests/execution-profiles.test.js tests/effective-resolution.test.js` passed 36 tests. `npm run lint` exited 0 with the three existing warnings in `app/3d/overlay/map/MapSurface.js` and `app/marketplace/ui/MarketplaceWorkspace.js`. `npm test` ran 2553 tests: 2540 passed, 5 failed, and 8 skipped. The five failures match the CFG-01 suite and sit outside this package: the pinned headless characterization comparison, plan-view control arcs, plugin range-image parent updates, state-sensor vehicle mounts, and the lidar hierarchy row. The characterization fixture was left unchanged. Playwright was not run. Browser workflows, accessibility, and the production build remain unverified. Final acceptance stays pending while the characterization comparison fails.

For every package, run focused checks first, then `npm run lint` and
`npm test`. Run affected Playwright tests as UI packages land. Record actual
verification and milestone status in this document; do not mark unrun gates
verified. Update other roadmaps only if their contracts or acceptance evidence
actually change.

## Verification and acceptance

Finish with the complete UI and accessibility suites and a production build.
Use the existing test tooling; add no dependency for this program.

Required cases:

- Fresh preferences, inherited Advanced preference, explicit run preference,
  and unavailable storage.
- Simple to Advanced and back with unsaved fields, invalid raw JSON, and
  invalid field-level JSON.
- New and existing manifests, legacy migrations, manifest-only runs, and
  multiple actors.
- Local route followers, scripted controllers, direct external commands, and
  scenario `external-ros` controllers.
- Both execution presets with bounded and unbounded scenarios, preserving
  existing seeds, step sizes, and limits.
- Inherited sensors, run overrides, extra/orphaned sensors, empty vehicle rigs,
  and plugin sensors or plants that need explicit grants.
- Preview cancellation, stale preview rejection, confirmed application, and
  consequential reset confirmation.
- Missing dependencies, stale locks, unsupported products, disconnected
  orchestrator, failed preparation, and revision conflicts.
- Slow and out-of-order resolution responses and dependency storage events.
- Save/reload, import/export, catalog actions, and navigation protection.
- Keyboard operation, accessibility, and usable layout at 1280 by 720 and the
  existing narrow breakpoint.

Opening or switching views must leave manifest content and identities
unchanged. Keep the committed action tape and characterization pinned. Do not
regenerate the characterization fixture to make this UI program pass.

### Existing baseline issue

The initial planning check ran the authoring-mode, config-catalog-loader,
sensor-inheritance, run-manifest, run-session, and headless-contract suites:
**48 tests passed; one failed**. The failure is the existing pinned headless
characterization comparison, with steering-sign and trajectory-hash
differences before any implementation edits. Treat its resolution as a
separate simulator-contract issue. It is not authorization to change physics,
controls, or the fixture in a CFG package.

## Decision log

### 2026-11-10 — WP09 exposes camera motion without migrating saved runs

Approved rigid-body camera maintenance adds optional `cameraObjectMotion` to
Advanced Sensors and the effective summary. Factory-created runs explicitly
select live motion; saved built-ins and old documents stay unset. Comparison
baselines copy the current policy, including absence, so opening Simple or applying
an execution preset does not infer a migration. The selector changes the draft
only on an explicit edit. This is WP09 maintenance, not a new CFG package or a
change to CFG-06's acceptance status. Mode/session tests pass in the 79-case focused
camera suite; parent integration records full npm/lint and browser results.

### 2026-11-06 — Keep two execution presets

Keep Standard Simulation and External Controller as lightweight patches over
the existing manifest. Remove Test / CI from the initial program, including
its fixed-seed changes, required-recording default, unbounded-pacing default,
scenario-duration eligibility rules, and related UI and tests. Existing
Advanced controls remain available. Consider another preset only after a
concrete user workflow justifies it; add no extension framework now.

### 2026-11-06 — Preserve the workspace and saved contract

Keep Run Configuration in the existing workspace switcher. Remember its mode
separately from other editors, preserve unsaved state across mode switches,
and keep browser launch unchanged. Infer preset identity from saved values;
persist neither a profile selection nor a profile inheritance graph.

### 2026-11-06 — Force advanced authoring inside Run Configuration

Run Configuration mounts `AuthoringModeProvider` with `advanced={true}`. A
boolean override wins over `cev-sim.ui.advancedAuthoring`, and `setAdvanced`
does not write storage. Other editors keep the stored preference.
`cev-sim.ui.runConfig.mode` stays absent until CFG-03. `AdvancedRunEditor`
wraps the existing tabbed editor, stays mounted with `hidden={false}`, and
leaves tab state in `ConfigPage`.

### 2026-11-06 — Hold invalid JSON outside the draft

Invalid raw and field JSON stay in a buffer map and stay out of the draft. A
repaired buffer is ready and writes the draft only when every other buffer is
also ready. A ready flush applies the raw document first, then field patches
onto that document. Discard restores one editor from the current valid draft
and leaves other unsaved edits in place. Pending buffers count as unsaved
work for `beforeunload`, the workspace guard, and catalog select. While any
buffer exists, Validate, Save, and Launch stay blocked, and the workspace
guard offers Stay or Discard. Plugin JSON textareas report a buffer only when
`onJsonBuffer` is passed; the vehicle editor does not pass it. Custom plugin
sensor views that never call `onChange` do not report their own text.

### 2026-11-06 — Stamp inherited plugin selections on explicit actions

The Sensors effect that stamped inherited plugin selections on mount, catalog
change, or draft change is gone. Enable inheritance, reset to parent, add
sensor, and change sensor type still stamp and lock.

### 2026-11-06 — Infer execution profiles from manifest fields

Standard Simulation and External Controller are patches in
`app/config/executionProfiles.js`. They are not stored on the manifest.

External matches first: realtime pacing, speed 1, clock publishing, and
authority `reference` when the ego controller is `external-ros`, or
`candidate` when the run has no scenario. A local route follower, script, or
script-with-route controller is not a direct-command match. Logging is
ignored. Standard matches next: reference authority, realtime pacing, speed
1, optional logging, and a local ego controller. Publish-clock is ignored. A
manifest-only run does not match Standard. Otherwise the run is Custom and
the comparison baseline is Standard. A matching profile with other overrides
is also labeled Custom and names that profile as the baseline.

Preview withholds the whole patch when a scenario is selected and its
document is not loaded. The external baseline still sets pacing, speed, and
clock publishing, and leaves authority at the default candidate value. A
known control source applies its patch even when prerequisites are unmet.
The preview reports those issues and does not rewrite controllers or topics.
Neither preset changes seed, step size, the manifest step limit, or scenario
duration, and neither requires a finite duration.

### 2026-11-06 — Simple is an explicit view over the same draft

`cev-sim.ui.runConfig.mode` stores `simple` or `advanced`. An explicit value
wins. With no run preference, a true `cev-sim.ui.advancedAuthoring` value
selects Advanced. Otherwise the fallback stays Advanced until CFG-06. Writing
the run preference does not write the global preference. If storage throws,
the choice stays in the page for the session and storage events are ignored.

`SimpleRunWorkspace` edits the ConfigPage draft. Advanced stays mounted and
uses `advancedEditorA11yProps` while Simple is visible. Switching modes does
not write the draft. New runs created while Simple is selected call
`enableSensorInheritance` for the built-in vehicle. Constructor sensors whose
ids do not match that vehicle stay as extras. Advanced create still uses
`createDefaultRunManifest` alone.

An execution profile confirms through `previewProfile` before `update`. A
vehicle change that would add plugin locks confirms through
`pluginGrantPreview`. Cancellation writes nothing. The resolved summary and
Custom Settings stay in CFG-04.

### 2026-11-07 — Resolve effective values without storing a profile

Simple Mode reads effective values from `POST /run-manifests/:id/resolve`
with the draft or baseline manifest in the body. It does not copy the
response onto the draft. One resolve runs at a time, and the draft lane goes
first. Each lane waits 400 ms after its latest submit, keeps only that body,
and drops a response whose generation has changed. Invalid JSON suspends both
lanes. Storage events for scenario, scenario catalog, environment, vehicle,
script, bindings, and plugin clear the current results and resolve again.
Run-manifest events do not.

The comparison profile stays latched in ConfigPage for the open manifest and
scenario. A scenario id whose document is not loaded does not create a latch.
Confirming an execution profile replaces the latch. Opening another manifest
infers again. The latch is not written to preferences or the manifest.

Reset writes one override path back to its baseline value, normalizes with
the authoring sensor registry, and applies only after the dialog lists every
resulting change. Unknown sensor types stay on the manifest.

### 2026-11-07 — Validation issues navigate without writing the draft

`validationIssueTarget` maps an issue to a Simple control id or an Advanced
tab and focus id. Show uses that target. A Simple control is focused only
while Simple is visible. Otherwise the page selects the Advanced tab and
calls `chooseMode`, which does not write the draft. Empty-path normalizer
errors for `sensorTransports` and `renderRecipe` recover the path from the
message. Unknown paths, including `dependencies`, open JSON. Parameter
issues open Scenario, where those controls already live. A render recipe
focuses a note on Sensors and stays editable in JSON.

Launch holds `createLaunchGate` across save, validate, resolve, and prepare.
A second click returns. Save stays optimistic. A revision conflict still
throws before the draft is replaced, and a failed prepare still leaves the
draft in place. The valid-manifest message stays hidden while the action is
busy, the run is preparing, or the run is in error. The message says the
check is not an external connection or a completed preparation.

### 2026-11-07 — Simple is the unset default

`RUN_CONFIG_MODE_FALLBACK` is `simple`. An explicit `cev-sim.ui.runConfig.mode`
still wins. `cev-sim.ui.advancedAuthoring === "true"` still selects Advanced
when the run key is absent. `chooseMode` is the only writer. Opening the
workspace does not write the key or the manifest. The first paint uses the
fallback constant; a stored Advanced preference appears after the mount
effect. Reading localStorage during render would disagree with the server HTML.

### 2026-11-07 — Comparison baseline grants vehicle plugins

The comparison baseline stamps the selected vehicle's plugin locks into
`plugins.artifacts` so inherited plugin sensors and plants can resolve. A
sensor lock grants `sensors.sample.range-image`. A plant lock grants
`plant.step`. A stamp failure is a baseline issue and keeps grants already
applied. Execution presets still do not rewrite the draft's plugin grants.

### 2026-11-07 — Simple / Advanced lives in workspace settings

The view control moved from the Run Configuration header to the workspace
menu Settings pane. `chooseRunConfigMode` is the only writer of
`cev-sim.ui.runConfig.mode`. Validation targets and Customize still call it.
The global Advanced switch stays a separate preference.

### 2026-11-10 — Onboarding setup and reviewed wiring maintenance

Both modes expose Legacy / Brake-v1 zero-speed response. A local new-run setup
marker survives the initial New persistence and ends at the first explicit
Save/Launch or document switch. Explicit compatible vehicle selection seeds
Brake-v1, using an exactly locked plant declaration for plugins. An explicit
braking choice wins; loading, import, duplication, normalization, and Save/Launch
never apply defaults to existing manifests.

New measured sensors receive typed output mappings during explicit creation,
inheritance setup/reset, and comparison-baseline construction. Existing mappings
are preserved. Sensors offers a review of proposed topic creation/reuse; an
ambiguous mapping requires selection. Review commits ready JSON buffers first,
blocks invalid pending JSON, and validates the draft/vehicle/catalog stamp before
one shared draft update. Cancel does not persist anything. Save/Launch never
silently repair sensor wiring. Intentional observation-only sensors remain valid.

CFG-06 and its open browser gates are unchanged. Node regression, lint, full
suite, compiled-plugin, and existing parity gates apply; Playwright is waived
for this maintenance at the user's request.
