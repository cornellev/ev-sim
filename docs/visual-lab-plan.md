# Visual Lab: inspect what survives the bake

Status: Experiment 0 remains frozen and Experiment 1 now has a separate case,
prepared room assets, measured browser stills, an opt-in browser renderer, and
a pinned Cycles capture workflow. Long motion/reference jobs remain incomplete
until their manifests report every scheduled sample. This Visual Lab work does
not resume the paused managed or distribution milestones.

This workspace implements the first comparison in the
[photorealism product action plan](photorealism-action-plan.md). Its central
question is whether a generated appearance survives as retained scene geometry
and materials when the camera moves or the arrangement changes. A generated
image and a fresh render of the baked scene are therefore distinct records and
remain visibly distinct in the UI and review export.

## Experiment 0 fixture

The built-in `experiment-0-room` case freezes a 6 × 5 × 2.8 m visual-only room.
Its source is [ExperimentZeroScene.js](../app/visual-lab/ExperimentZeroScene.js),
and its versioned schedule is
[ExperimentZeroCase.js](../app/visual-lab/ExperimentZeroCase.js). The room has
an actual window opening, a framed door opening, a table, two chairs, a
cabinet, folded fabric, a metal lamp, books, and a storage box. B0 and B1 retain
the same object IDs, dimensions, and placement. B1 adds rounded edges, four
thin furniture legs, stretchers, seams, hardware, folds, recesses, and visible
undersides.

The case contains twelve named stills: four room views and eight detail views.
Three paths contain 25 integer-nanosecond samples over 24 seconds. The normal
walk-through and reverse/return are captured as independent camera paths. The
third path changes height and is explicitly withheld. Three withheld stills
inspect the chair underside, window recess, and clutter scale. Generation input
and withheld status are stored on every viewpoint and path.

The review calibration is 1280 × 720 with explicit intrinsics, near/far planes,
and no distortion. Ordinary illumination uses recorded sRGB output, exposure
1, no tone mapping, and no shadows. Directional lighting with shadows and AgX
is a reference-renderer-only condition because the current measured recipe
does not support those controls.

Run `npm run fixtures:visual-lab` to render 174 PNGs from the actual B0 and B1
scene graphs. The generator records renderer settings and every frame's
SHA-256 in
[manifest.json](../public/visual-lab/experiment-0/manifest.json). The generated
hash module binds those digests to the immutable candidate records. Reopening a
review uses retained frames and never runs a model.

The committed fixture is repository-owned and Apache-2.0. A real-material
reference board names the CC0 Poly Haven Wood Table, Bi Stretch, and Metal Plate
02 assets with their declared physical reference widths. Poly Haven states
that downloadable assets are CC0 while the website and API have separate
terms. Acquisition references stay in the case even though the procedural B0
and B1 fixture does not redistribute those material files.

Metric support remains deliberately incomplete. Fabric, the lamp, and books
have no fabricated truth bindings. The case reports
`blocked-partial-bindings`, so it cannot produce or claim a measured-camera
capture. The room shell and supported rigid objects retain their individual
available binding records.

## Versioned records and ownership

[VisualLabDocuments.js](../app/visual-lab/VisualLabDocuments.js) defines three
version-1 documents:

| Record | Mutability | Contents |
| --- | --- | --- |
| `cev-sim.visual-lab-case` | Immutable | Scene and asset references, source revision, calibration, viewpoints, path samples, conditions, edit variants, comparison variables, and metric status |
| `cev-sim.visual-lab-candidate` | Immutable | Case ID, attempt, declared variables, retained scene reference, output stage, renderer/model provenance, completion state, and still/sequence media |
| `cev-sim.visual-lab-review` | Revisioned | Selected A/B targets, display mode, close-ups, defects, editable-copy arrangement, and disposition |

Registration rejects a candidate whose calibration, condition, edit variant,
viewpoint, path sample, or nanosecond timestamp is outside the frozen case.
Generated images require model provenance. Baked-scene renders require a
retained scene artifact hash. Only a capture with the calibrated sensor capture
contract can use the measured-camera stage.

`StorageService` owns `visual-lab/cases`, `visual-lab/candidates`, and
`visual-lab/reviews`. Cases and candidates are write-once. Reviews use atomic
JSON writes and optimistic revisions. The REST surface under
`/api/storage/visual-lab` supports registration, reads, review creation/update,
JSON pack export, and a standalone HTML report. Review data does not enter a
run bundle, `episodeHash`, or the active environment document.

The export pack contains the normalized case, every candidate registered for
it, the mutable review, matched/unmatched result, renderer and stage labels,
all referenced frame records, SHA-256 values, close-ups, defects, and the HTML
report. The HTML report preserves the stage separately from renderer identity.

## Comparison workspace

Visual Lab appears in the Inspect section of the workspace switcher. The top
row selects a case, named viewpoint or path, and a candidate/output for A and
B. The match indicator is true only when case, calibration, condition, edit
variant, viewpoint/path, sample index, and capture timestamp agree except for
declared experiment variables.

The main viewer provides side-by-side, wipe, A-only, B-only, and live 3D modes.
Image views share fit or 1:1 display, zoom, pan, and close-up rectangles. Clip
controls share one logical sample cursor, frame stepping, scrub, speed, and
loop bounds. Playback waits until both image elements report the selected
frames ready. Missing and buffering frames stay visible instead of advancing
one pane alone. Recorded media receives no automatic per-pane enhancement.

Each media pane carries a persistent output-stage label and a separate renderer
label. The supported labels are Source render, Generated image, Baked-scene
render, Measured-camera capture, and Reference renderer / photograph. A model
image cannot pass baked-scene acceptance, and an offline or editor render
cannot acquire the measured-camera label.

Defect notes attach to an exact candidate, output, viewpoint/path sample,
optional object ID, and optional normalized image rectangle. The initial
categories cover geometry/identity, seams, missing coverage, texture scale,
contact/shadows, reflections/relighting, temporal instability, and
color/aliasing. Selecting a note restores its target. Notes can be resolved and
reopened without altering candidate media.

These controls follow established review behavior from the
[OpenRV sequence and wipe manual](https://openrv.readthedocs.io/en/latest/rv-manuals/rv-user-manual/rv-user-manual-chapter-four.html)
and frame-attached annotation behavior described by
[Autodesk Overlay Player](https://help.autodesk.com/view/SGSUB/ENU/?contextId=SA_OVERLAY_PLAYER).
The seam and coverage categories target failure modes demonstrated by
[MVPaint](https://mvpaint.github.io/); that research is a diagnostic reference,
not evidence of quality in this simulator.

## Localized arrangement

Live 3D mode renders the retained B0 or B1 scene, not a generated image. It is
explicitly labeled exploratory because orbit cameras are unscheduled. The lab
operates on an editable copy stored in the review and never touches the active
environment or autosave.

The editable copy supports selection, translation, rotation, uniform scale,
numeric XYZ/radian values, grid snapping, duplication with shared source
geometry, deletion, and undo/redo. New instances keep a unique instance ID and
the immutable source object ID. This follows the useful data reuse distinction
documented by Blender's
[Asset Browser](https://docs.blender.org/manual/en/4.2/editors/asset_browser.html).

This staging arrangement is sufficient for controlled visual review. Applying
it to a simulation environment remains a separate revision-checked action.
The current slice intentionally has no Apply button because partial metric
bindings would make that promotion invalid. A later supported integration must
write imported instances through the canonical environment document and its
adapters, freeze a new case revision for every recapture, and leave earlier
reviews reopenable.

## Acceptance and remaining gates

Implemented checks cover document validation, false stage claims, unmatched
cameras/samples, immutable registration, review revision conflicts, restart
reopen, retained notes and arrangement, HTML export, and all 174 frame hashes.
The Playwright workflow exercises workspace navigation, source/baked labels,
synchronized path stepping, close-up and note persistence, report export, and
the retained-scene live viewport.

B2/B3 physical reference renders and generated Experiment 2 candidates are
registered through the candidate import action; none is fabricated as part of
Experiment 0. A missing candidate remains absent from the selectable output
set. Candidate JSON may reference visual-asset use hashes so media loads through
`VisualAssetClient`; repository fixture URLs are used for the small built-in
PNG baseline. `VisualLabFixtureAdapter` validates a candidate against its frozen
case before loading the built-in retained scene; descriptor-backed fixtures
delegate to the existing validated `VisualLayerMaterializer` path and require a
real world resource and truth bindings. Future captured geometry uses the existing bake snapshot,
calibrated capture, artifact writer, dependency, and promotion owners.

The next gate is a real B2/B3 or generated candidate with declared provenance,
followed by source-versus-baked and generated-versus-baked review. Complete
room truth bindings are required before `BrowserPbrRenderRuntime` output may be
registered as measured-camera capture. Edit to Bake to Compare to Apply remains
separate work and must use guarded environment promotion. City/map tooling,
mesh modeling, a cloud queue, and a generalized evidence catalog remain outside
the Visual Lab.

## Experiment 1: rendering bottleneck

Experiment 1 is the independent `experiment-1-room` case. It preserves the
6 × 5 × 2.8 m layout while closing the ceiling and replacing placeholder
furniture with constructed parts, bevels, cabinet recesses, fabric layers,
thin supports, and contact geometry. The repository-owned source fixture is
[experiment-one-fixture.json](../app/visual-lab/experiment-one-fixture.json).
The pinned Blender 4.5.4 LTS build `b3efe983cc58` produces the editable `.blend`,
browser GLB, and deterministic base-color/roughness textures. The generated
[asset manifest](../public/visual-lab/experiment-1/assets/manifest.json) records
all exact-byte hashes and preparation provenance.

The case freezes twelve corrected views, including a window-recess view aimed
at the actual north-wall opening. Each forward, independently captured return,
and withheld-height path has 577 samples from 0 through 24,000,000,000 ns.
Every timestamp is `round(sampleIndex × 1e9 / 24)`. The calibrated camera is
1280 × 720 with exact intrinsics, principal point, clipping planes, and no
distortion.

Every visible room object has an object-specific static metric fixture. The
optional authored domain stores stable fixture/object IDs plus explicit box or
triangle primitives in the canonical environment document. It is absent from
legacy environments, so their world bytes and hashes remain unchanged. When
present, it enters `worldHash`, LiDAR/analytic geometry, truth-binding
validation, and box-based collision obstacles. The Experiment 1 world and all
nine object bindings therefore report `ready-complete-bindings`; Experiment 0
continues to report its original partial state.

The browser capture workflow in
[generate-experiment-one-browser.mjs](../scripts/generate-experiment-one-browser.mjs)
uses the calibrated `AlignedCaptureProducts` path. The retained manifest
currently contains 324 new PNG stills: both conditions and all four edit states
for B0 and B1; lighting, shadow, and color-only B4 controls; and the combined
B4 matrix. The light edit moves `room-key` independently of the lamp mesh.
Each output declares its exact geometry, materials, renderer recipe, lighting,
color treatment, calibration, schedule, stage, and SHA-256. A same-name
condition is insufficient for a match: undeclared provenance differences make
the comparison fail, while declared variables list the fields they may affect.
The current measured still run retained all 324 scheduled samples in 59.347 s
(5.459 samples/s, including synchronous readback and PNG encoding); this
wall-clock throughput is recorded separately from the sample timestamps. The
locked live-view UI gate also requires at least 30 rendered animation frames/s
after warm-up on the configured browser host.

`cev-sim.pbr-render-recipe@2` and `pbr-mesh@2` are browser-only opt-ins. They
add bounded directional and point lights, PCF soft shadow settings, exposure,
and `none`/AgX presentation. Browser inspection and measured beauty capture
share the same recipe applier. Offscreen beauty renders to a linear intermediate
target and then runs `OutputPass`; numeric depth, normals, semantic IDs, and
instance IDs keep their unlit contracts. Renderer state, owned lights, shadow
maps, render targets, and the output pass are restored or disposed on success,
failure, cancellation, and teardown. Headless capability validation rejects
`pbr-mesh@2`; v1 normalization, defaults, provider behavior, and hashes remain
unchanged.

The pinned Cycles workflow is
[generate-experiment-one-cycles.mjs](../scripts/generate-experiment-one-cycles.mjs).
It uses a fixed seed, 512 samples, disabled denoising, recorded bounce limits,
Metal/CPU device identity, AgX display output, and a 32-bit linear EXR beside
every PNG. B2 hides detail parts while retaining improved materials; B3 uses
the complete prepared room. The bounded retained subset contains all 48 base
stills (B2/B3 × two conditions × twelve views) and their 48 linear EXRs, for 96
hash-verified reference artifacts. Partial executions remain `incomplete`, and
the UI does not present missing edit/path frames as evidence.

Current review findings from the retained stills are:

1. B0's largest defect is missing construction detail: reduced supports,
   cabinet seams, fabric layers, and furniture edge profiles dominate the
   geometry/material comparison.
2. B1 remains flat and dark under the v1 ambient-only measured recipe; the
   Cycles reference shows contact and interior light transport that the
   incumbent browser renderer cannot express.
3. B4 corrects direct illumination and contact shadows, but its combined
   ordinary-light result remains substantially darker, has a harsher one-sided
   falloff, and shows stronger repeated texture banding than Cycles. Light
   energy/exposure and texture response remain the largest reference gap.

The twelve-view ordinary B3 review found no missing construction, camera error,
or lighting failure severe enough to invalidate it as the conventional
reference. Its bright AgX treatment and repeated procedural material structure
remain declared reference limitations and must not be scored as browser-only
defects.

The consistency, prepared-asset, metric-binding, and bounded renderer gates are
implemented and covered by focused tests. Final acceptance remains open until
the full 24 fps browser and Cycles path manifests, all Cycles edit stills,
cross-renderer landmark measurements, and a reopened accepted review are
retained. Run the two `fixtures:visual-lab:experiment-1-*` capture commands to
continue those resumable jobs; completed samples are not rerendered by Cycles.
The `-browser-stills` and `-cycles-base` variants reproduce the bounded retained
subsets without starting the complete motion/edit matrices.

The requested six-change delivery order is preserved in the implementation
boundaries: (1) live/capture output and projection consistency, (2) prepared
assets and schedules, (3) canonical metric fixtures/bindings, (4) Cycles
capture/import, (5) the versioned renderer and B4 controls, and (6) final
comparison evidence. Boundaries 1–5 are reviewable in this working tree;
boundary 4 has partial retained evidence and boundary 6 remains open on the
long capture gates above. They should be split into dependency-ordered PRs from
that sequence without rewriting the frozen Experiment 0 commits or media.
