# Photorealism product action plan

Proposed sequence, revised 2026-09-09 after the owner's clarification: the goal is a comprehensive, convincing simulation tool. These experiments are engineering comparisons that decide what to build. Publication, a novel model architecture, and a formal human study are not prerequisites.

This replaces the earlier research-oriented execution sequence. The [research report](photorealism-research.md) and [source register](photorealism-sources.md) remain its technical background. Nothing here implements or resumes VIS-15c, VIS-16b, or VIS-17, changes runtime contracts, or claims an achieved visual-quality result.

Implementation update (2026-09-09): Experiment 1 is now a separate frozen
case with prepared Blender/browser assets, complete static metric bindings,
324 calibrated browser stills, controlled B4 corrections, and a resumable
512-sample Cycles/linear-EXR workflow with 48 base PNGs and 48 paired linear
EXRs retained across B2/B3 and both conditions. The browser renderer extension is
versioned as `pbr-mesh@2` and remains opt-in and browser-only. The full motion
and reference edit matrices are still an open acceptance gate; see
[Visual Lab](visual-lab-plan.md#experiment-1-rendering-bottleneck) for exact
evidence and limitations. Measured still capture retained every scheduled
sample and reports 5.459 samples/s separately from its integer-nanosecond
schedule; the locked live UI gate checks the 30 fps warm-up target.

## Recommendation and scope

Start with **one detailed room, a small comparison workspace, and actual outputs from existing models**. Use a separate Visual Lab page for the first comparison, backed by existing scene, capture, asset, and bake services. Develop the environment editor once those outputs identify the tools it needs. The eventual workflow should be accessible from the editor as **Edit → Bake → Compare → Apply**.

The recommended technical direction remains scene-aware object baking: scene references guide reusable object materials; lighting remains a renderable scene property. Existing transformer-based image and 3D models are practical components. Keep sequential scene baking and neural camera enhancement in the comparison. If detailed conventional assets give the best result, ship that improvement and use generation to reduce authoring effort.

The first usable product slice means: import supported assets, arrange them, improve their appearance, inspect the actual baked scene, retain accepted assets, reuse them in another environment, save/reload, and obtain the intended measured-camera output in a supported browser configuration. It does not imply arbitrary materials, an entire city, a newly trained foundation model, or completion of the paused managed/hardware/distribution program.

**Planning estimate:** 2–3 PRs for Experiment 0; roughly 4–6 cumulative PRs to reach a useful real-model and rendering decision; 12–16 cumulative PRs for the first usable product slice if existing models and a bounded renderer extension succeed. These are engineering estimates, not evidence that realism can be achieved in a fixed number of PRs. Model runs and asset preparation are work even when they do not create a PR.

## What the repository already provides

| Existing capability | Consequence for this plan |
| --- | --- |
| Environment documents, guarded persistence, selection, hierarchy, transform gizmos, map editing, sky preview | Reuse these owners. A second mutable scene editor would create synchronization and persistence problems. |
| Validated visual assets, content storage, descriptors, isolated preview, atomic promotion, incremental bake dependencies | Reuse these seams for candidate artifacts and accepted results. Do not recreate storage or another general bake scheduler. |
| Calibrated capture, frozen bake snapshots, aligned geometric products, atlas construction | Use exact scene correspondence for fitting. Sparse LiDAR overlay need not reconstruct surfaces when dense authored geometry is available. |
| Experiment suites and Headless Runs | Retain their simulation-run ownership. Visual Lab reviews appearance candidates; it does not replace the suite runner or enable frozen managed PBR capabilities. |
| An optional six-channel intrinsic material proposal interface | A real model still needs output conversion, explicit channel semantics, validation, and a quality demonstration. A checkpoint name is not an implementation. |

There are concrete editor limitations. The [placement catalog](../app/3d/editor/placement/placementCatalogData.js) offers signs, barrels, tires, and cones. [ObjectInspector](../app/3d/overlay/ObjectInspector.js) displays transform values rather than providing numeric editing. [TransformTool](../app/3d/editor/tools/TransformTool.js) restricts ground-authored objects to planar movement and yaw; prop scaling is disabled. Arbitrary furniture, shelf placement, and imported object instances require durable authoring support, not just extra gizmo buttons.

Distinguish render defaults from supported controls. [PbrRenderScene](../app/simulation/render/PbrRenderScene.js) already accepts ambient color/intensity, exposure, and an environment-map reference. [BrowserPbrRenderRuntime](../app/3d/perception/BrowserPbrRenderRuntime.js) applies the map as environment lighting and background. Shadows and tone mapping are explicitly unsupported in this profile, and direct-light authoring is absent. Editor sky state is independent of the measured render recipe. Reuse working environment lighting; a better editor preview alone does not establish better sensor images.

The [static material profile](visual-layer.md#materials-and-assets) excludes alpha blending and transmission. Glass must be a named challenge case until supported, rather than silently substituted with an opaque material and counted as solved.

There is also an entry-point discrepancy: the editor menu's Bake action calls the legacy harness start method, while the normal keyboard path uses persistent promotion. Unify these when integrating the new bake workflow, with explicitly labeled diagnostic access where still useful. No code is changed by this plan.

## Where Experiment 0 should live

### A thin Visual Lab page first

Create a small development-accessible page that opens a selected comparison case. Share the app's services and immutable scene/artifact references. Initially it needs:

The implemented contract, Experiment 0 fixture, storage layout, comparison behavior, and remaining measured-rendering gates are recorded in the [Visual Lab plan](visual-lab-plan.md).

1. Case and candidate selection, with the source environment revision visible.
2. Matched A/B images, synchronized clip playback, a wipe, and close-up inspection.
3. Clear labels for model-generated images, the final baked scene, and measured-camera captures.
4. Named viewpoints and paths; file-defined schedules are sufficient initially.
5. A short defect list attached to a view/time/object and an exportable comparison.

Imported offline reference renders are allowed when camera and scene provenance are recorded and they are labeled as reference-renderer output. Live inspection can start with one active viewport plus cached comparisons; two simultaneous renderers are unnecessary.

Review must not mutate the active environment or autosave over it. Store references to frozen inputs and candidate outputs. Later Apply uses revision-checked promotion. A comparison sidecar describes views and results; it is not a second authoritative world format.

Do not build a full evidence browser, cloud queue, generalized benchmark framework, or polished workspace navigation before the first images exist. The paused VIS-17b evidence catalog is a separate commitment; this viewer neither completes nor implicitly resumes it.

### Extend the editor in the order the workflow needs

| Build after the visual direction is demonstrated | Why it matters |
| --- | --- |
| Durable imported asset instances with units, transforms, and metric/appearance bindings | Makes a room with real furniture possible and ensures reload reconstructs it correctly. |
| Numeric transforms, useful snapping, duplicate, and undo/redo for the new commands | Makes arranging and revising a scene practical. Controls must persist through the canonical document. |
| Material assignment, texture scale, normal strength, roughness, and supported properties | Lets users correct generation and diagnose a surface that looks wrong. |
| Lighting and camera presets applied to an explicit measured render recipe | Makes capture reproducible. Preview that same recipe. |
| An asset library with thumbnails, accepted variants, and instance reuse | Pays the object-baking cost once and makes it useful beyond one scene. |
| Bake selected objects/regions, inspect, repair a selected defect, and apply | Makes generation controllable. Show which dependencies will be regenerated. |

Later add groups/prefabs, align/distribute, surface placement, architectural room tools, richer lighting, and collections in response to actual authoring needs. Mesh sculpting, UV unwrapping, and a complete procedural modeling graph can stay in a DCC tool initially. A comprehensive simulator can offer strong import and assembly without recreating every modeling tool.

## Experiment 0 — Build the shared room and viewing schedule

**Question:** Do complete, inspectable inputs expose the failures we care about?

Use a proposed 6 m × 5 m room with a roughly 2.8 m ceiling, a window opening, door frame, table, two chairs, cabinet, fabric item, metal object, and small clutter. Freeze dimensions before comparison. Include bevels, recesses, seams, thin legs, and a gap under furniture. These expose detail that exists only in an image.

Prepare simple and detailed versions of the same arrangement. The detailed version can be authored in Blender and imported as a fixture; general-purpose furniture editing is not a prerequisite. Use reproducible acquisition/preparation instructions and hashes for large assets. Keep editable sources and generated outputs in appropriate external asset storage, and commit small manifests, camera schedules, and bindings rather than weights or machine-specific output.

Identify each relevant object's dimensions, transform, visual geometry, and metric counterpart. Reuse supported metric geometry. If a new fixture adapter is required, isolate it as the possible third setup PR. Until corresponding metric support exists, the room is a visual reference and cannot be presented as a valid measured-sensor case. Do not conceal gaps by giving the whole room an unrelated truth ID.

| Observation | What it reveals |
| --- | --- |
| 8–12 named still viewpoints | Overall plausibility, corners, contact, and material close-ups |
| A 20–30 second normal walk-through | Whether the scene remains convincing in motion |
| Reverse traversal and return to the starting point | Seams and accumulated identity drift |
| A closer path at a different height, excluded from generation | New surfaces, parallax, undersides, and poor coverage |
| A moved/rotated chair and an independently moved light | Material stays with the object; illumination changes with the scene |

Freeze camera calibration, resolution, exposure policy, and scene scale. Include ordinary illumination and a directional setup. A dramatic screenshot is not the whole acceptance target. Gather a small real-material/room reference board to define desired appearance without changing the layout.

**Deliverable:** one frozen case, view/light/edit schedules, baseline captures, and a comparison that can be reopened. Keep unsupported reference-renderer outputs separately labeled.

**Pass:** another person can inspect the same scene and paths without rebuilding them. Objects and dimensions remain recognizable in all candidates. This is a setup gate, not a requirement that the incumbent already look real.

## Experiment 1 — Find the largest visual bottleneck

**Question:** How much improvement comes from assets, materials, and rendering before generation?

| Variant | Assets/geometry | Appearance/rendering | Interpretation |
| --- | --- | --- | --- |
| B0 | Current/simple | Current measured recipe | The incumbent |
| B1 | Detailed compatible assets | Current renderer and recorded recipe | Benefit from assets, including unavoidable material changes |
| B2 | Simple scene | Improved materials and physical reference rendering | Benefit from material/lighting treatment with limited geometry |
| B3 | Detailed scene | Improved materials and physical reference rendering | Strong conventional target |

Render the detailed scene through both the existing renderer, including supported environment lighting, and a pinned offline reference such as Cycles. Match projection, placement, units, and presentation. Where geometry and materials change together, label the combined change instead of claiming perfect isolation.

Review missing shape detail, contact shadows, reflections, texture scale, color/exposure, and aliasing. Name the three largest defects and make one controlled correction at a time.

**Decision:** if B3 is convincing, identify what approaches it inside the simulator. Prioritize a bounded lighting/shadow/color improvement if sufficient. If indirect lighting and reflections dominate, allow offline path-traced capture or a more capable renderer; compute cost should not force an inferior target. Full offline renderer integration is larger than adding lights to Three.js and changes the PR estimate.

If B3 is weak, correct its content or lighting before judging model potential. A generator should not win solely by beating an intentionally poor input.

**Deliverable:** matched stills/clips and a ranked defect list naming the next visible improvement. Formal statistical evaluation is unnecessary to recognize a plainly missing shadow or badly proportioned chair.

## Experiment 2 — Run real models before building their product UI

**Question:** Which mechanism produces the best usable scene, rather than the best source image?

Begin with a small sequential-versus-object comparison plus B3. Use existing runnable tools and small conversion scripts, with outputs in the shared review case. Screen representative surfaces first, then run survivors on the room. Include three declared attempts for stochastic candidates to avoid treating one lucky output as reliability.

| Candidate family | How to try it | What must survive review |
| --- | --- | --- |
| Sequential scene baking | Add calibrated visibility, overlap, and genuine geometry conditioning where supported. Compare historical FLUX Fill with a current image model; retain accepted observations and refine weak regions. | The re-rendered world on new paths, not just generated images. |
| Object baking | Start with supplied-mesh PBR texturing in TRELLIS.2 or Hunyuan3D-2.1; consider Material Anything for recovery. | Materials, seams, undersides, shape preservation, and relocation. |
| Scene-aware object baking | Add shared scene references and compatible material intentions; reconcile overlapping observations. Compare the same object model without that context. | Improved coherence without transporting room shadows/reflections into reusable assets. |
| Neural camera enhancement | Run an accessible geometry-conditioned image/video method from the source register on the same paths. | Stable objects and boundaries, other paths/cameras, and suitable temporal behavior. |
| Conventional assets/rendering | Retain B3. | Generation earns complexity through quality, control, or easier authoring. |

Not every candidate needs a production provider or UI. Try explicit shared references before training a scene transformer. RoomPainter, MatMart, and TRON remain conceptual references until runnable official releases are verified. A blocked dependency should not consume the phase reproducing a paper.

Pass depth/normals/pose only through controls the model actually supports. An ordinary reference image depicting depth does not prove geometric conditioning. Use existing dense aligned bake products for projection and rejection of invalid observations. LiDAR remains a measured sensor product; the bake can use known full surface correspondence.

Check whether voxelization, remeshing, or export changes a supplied mesh. Transfer appearance back onto the original mesh where possible. Treat useful generated geometry as a separately reviewed proposal, not a texture-only success.

Map actual material channels and coordinate frames into the current interface. Missing normal, emissive, or occlusion channels require a declared supplied/default/derived policy supported by the contract. Do not label constant maps as model inference.

**Deliverable:** actual model outputs, final assets, rendered clips, all attempts, and a short decision record. Put generated-image quality beside final-scene quality so projection losses remain visible.

**Pass:** a method improves usable appearance or reduces authoring work without breaking the intended world. If none does, retain conventional improvements and fix the failing component before building generation controls into the editor.

## Experiment 3 — Make the winner editable and reusable

**Question:** Can users rely on it after normal scene edits?

Move and rotate the chair, move an occluder, change the light, and reuse the asset in a second room. These are product checks even if no new optimization algorithm is written.

Grain and scratches should move with the object; shadows and reflections should respond to the scene. Reusing accepted materials must not silently regenerate them. Inspect the back and underside. Reopen the project and render the retained candidate.

Fix defects in increasing order of complexity:

1. Correct mapping, scale, color spaces, material conventions, and missing coverage.
2. Improve model references and multiview agreement.
3. Add scene context when independently generated objects look unrelated.
4. Only if necessary, fit across changed lights/objects to separate material and illumination.
5. Consider a neural residual or fine-tuning for a documented remaining failure.

The proposed intervention-based material optimizer is optional. Keep it only if a matched comparison beats the simpler pipeline. Compare adaptive sampling against fixed camera steps when missing coverage or redundant generation is an observed issue.

**Deliverable:** edit clips, a reusable asset opened in two scenes, and a supported-case/defect list.

**Pass:** ordinary edits preserve identity and valid appearance; defects can be repaired locally. A compelling fixed-light result can be offered explicitly as a fixed-light bake while reusable relightable assets remain a separate target.

## Experiment 4 — Make it a product workflow

**Question:** Can someone create a second convincing environment without assembling developer scripts?

Build the selected pipeline into this sequence:

1. Open an environment and place supported assets.
2. Set material character, references, lighting, and camera.
3. Select objects or a region and generate a candidate.
4. Inspect through the actual renderer and saved paths.
5. Repair a selected defect or accept.
6. Save accepted objects to the library and reuse them without generation.
7. Reload and run a supported measured-camera scenario with that appearance.

Repeat on another room and a street/IGVC section. The room targets the immediate realism goal; the outdoor case preserves the simulator's existing use case. Include a case assembled independently from the first demonstration. Check persistence, export/reimport where supported, cancellation, and stale-scene conflicts.

Normal authoring should expose actionable issues such as unsupported glass, missing maps, an outdated candidate, or incomplete coverage. Users should not need G-buffer formats or source-use hashes to operate the workflow.

## Product acceptance and optional deeper evaluation

Keep a modest review pack: about 12 matched stills, three motion paths, and edit/reuse checks. An initial 3–5-person internal review can expose subjective disagreements; it is a product decision aid, not statistical proof. Record realism, consistency, editability, and defects separately.

| Requirement | Initial decision rule |
| --- | --- |
| Quality | Clear improvement over the incumbent on ordinary views and motion, or comparable quality with substantially easier authoring. B3 remains the reference. |
| Identity | No invented/deleted task-relevant objects, openings, or major silhouette changes in texture-only candidates. |
| Movement | No objectionable seams, swimming detail, or reverse-path changes; inspect worst views. |
| Coverage | Intended paths have supported appearance; disclose missing/challenge regions and their image share. |
| Editing | Detail follows its object; lighting responds according to the declared material mode. |
| Persistence | Accepted assets and mappings survive reload without a hidden generation call. |
| Measured capture | Appearance reaches the supported sensor renderer; detached editor preview is not proof. |

The earlier 2-pixel drift and 99% eligible opaque coverage values remain possible diagnostics to calibrate for a declared 1080p camera/profile. They are not new universal gates. Specular motion, glass, depth discontinuities, and optics need different treatment.

Detection/segmentation can provide smoke tests. Transfer claims require target-camera real data and a controlled training comparison. A confidently wrong detector is not success. For neural enhancement, check output boundaries independently; its input IDs cannot validate its changed output.

A larger blind study, real-versus-synthetic classifier, and multiple training seeds are optional follow-ups when the product question needs them, removed from the first milestone. Fixed action tapes support matched visual comparisons; policy-controlled behavior is a separate test. Future-frame-dependent video generation may help offline data without being eligible as a live sensor.

## Transformer generation: viable and already in the shortlist

Transformers are a model architecture; sequential baking, object baking, and camera enhancement describe where generation happens. They can be combined. FLUX.1 Fill itself uses a rectified-flow transformer. Its historical shortcomings show the need for appropriate conditioning and 3D fitting, not that transformers are unsuitable. [Official model card](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev).

TRELLIS.2 uses diffusion transformers and provides shape-conditioned PBR texturing. Its official implementation requires at least 24 GB NVIDIA GPU memory and reports H100 timings, not timings on this project's scenes. Hunyuan3D-2.1 provides supplied-mesh painting and reports approximately 21 GB VRAM for texture generation. These are viable pilot candidates, not guarantees of room-scale quality. [TRELLIS.2](https://github.com/microsoft/TRELLIS.2), [Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1).

| Use | Recommendation |
| --- | --- |
| Tileable or object-specific material maps | Strong early candidate; check seams, scale, and separation of lighting from material. |
| Geometry-conditioned views fitted to shared surfaces | Strong candidate for photographic detail with an editable world. Enforce agreement across views. |
| Scene references guiding individual assets | Try before training; tests the value of shared context with less engineering. |
| Geometry and texture generation together | Useful as a reviewed authoring proposal with explicit metric-binding changes. |
| Every camera frame | Keep as a quality competitor; consistency and recurring runtime expense matter. |
| A new transformer trained from scratch | Defer until an existing-model comparison identifies a specific unsolved gap. |

A focused custom model could attend to multiview features, camera poses, object identity, surface coordinates, and scene context, and predict shared object-local material fields. This is a proposed direction, not a novelty claim or off-the-shelf capability. Training requires consistent multiview/material data, not just attractive room photos. Start targeted adaptation only after collecting recurrent failures. A generic text LLM emitting texture pixels is not the recommended mechanism.

Ignoring compute cost permits more candidates, higher resolution, multiview optimization, and stronger rendering. It cannot guarantee compatible generated observations or uniquely determine hidden materials. Judge the resulting world rather than assuming model size resolves those ambiguities.

## Cost after establishing viability

Prices checked 2026-09-09; USD. These are illustrative arithmetic scenarios, not a quoted budget or measured pipeline results. Separate implementation, asset preparation, inference, optional training, and rendering.

BFL lists FLUX.2 pro editing from $0.045 at the base configuration and FLUX.1 Fill pro at $0.05/image; applicable FLUX.2 charges depend on resolution and reference inputs. Thus 1,000 base-priced calls are roughly $45–$50 for these examples, before larger inputs or additional passes. This prices image generation, not complete PBR assets or rooms. [Official API pricing](https://docs.bfl.ai/quick_start/pricing).

For a view-image pipeline, count objects × generated views × attempts × refinement rounds, plus scene references. Thirty objects, eight views, and three attempts already mean 720 images before repair. Some 3D models jointly produce an asset in one call; do not apply that image-call formula to their billing.

Lambda lists a single H100 SXM at $4.29/hour. Ten GPU-hours cost $42.90; 100 cost $429. This prices consumed compute without predicting how long the chosen pipeline needs. Include setup, idle rental, fitting, export, storage, tax, and any license fees separately. [Official GPU pricing](https://lambda.ai/pricing).

| Workload | Cost behavior |
| --- | --- |
| Existing-model bake | Often an affordable pilot: calls or GPU-hours multiplied by attempts. Measure cost per accepted asset, including rejects. |
| Reuse | No new model inference if retained materials remain valid; rendering still costs compute. |
| Fine-tuning | Additional training and data-preparation budget. For scale, 200 GPU-hours at $4.29 equals $858 before engineering/data; this is not a training-duration estimate. |
| Large-model training from scratch | Potentially a separate major program. An illustrative 64-GPU, 30-day run at an assumed $4/GPU-hour is about $184,000 compute alone. Required hardware and duration remain unknown. |
| Repeated camera-frame generation | One camera at 30 fps generates 108,000 frames/hour. At an illustrative $0.05 per independent image, that is $5,400/hour. This illustrates scaling, not pricing for a coherent video model. |

Spend inference on reusable assets and refinement that improves the result. Freeze accepted outputs and cache unchanged dependencies. Camera movement should not regenerate material. A moved light normally requires rendering, not regeneration of intrinsic material; fixed-light captured radiance has different reuse rules.

Existing transformer inference is included in the PR estimate. Fine-tuning/custom training is not. Architecture alone does not determine price: model size, resolution, views, sampling, repairs, and acceptance rate do. Benchmark ten representative assets and one room to replace these scenarios with actual cost per accepted output.

## Proposed PR decomposition

These are provisional work items, not new VIS milestone IDs or authorization to implement paused milestones. Each PR must include a visible artifact or concrete workflow improvement. Reassess after the first comparison rather than automatically executing the whole list.

| PR | Bounded result | Observable acceptance |
| --- | --- | --- |
| 1 | Shared room fixture, schedule, baseline/reference capture recipe | Reopen matched captures with known inputs; isolate any metric fixture adapter and disclose missing truth support. |
| 2 | Thin Visual Lab page | Compare real captures and synchronized clips, inspect generated versus baked results, retain defects. Experiment 0 is usable. |
| 3 | Executable model comparison and conversion scripts | Real sequential/object outputs against B3, with failures. Import scene-context/neural candidates where runnable and select a direction. |
| 4 | Demonstrated measured-rendering improvement | Bounded lighting/shadow/color support under an explicit versioned contract; show measured capture and reuse existing environment lighting. |
| 5 | One real bake adapter with candidate staging | Actual selected-model output can be reviewed before promotion; no fake-backend quality demonstration. |
| 6 | Targeted coverage/seam/context repair | Improve weak regions and pass reverse-path/edit checks against the simpler version; omit unnecessary complexity. |
| 7 | Persistent imported instances and world bindings | Supported objects retain units, full permitted transforms, identity, and metric/appearance relationships after reload. |
| 8 | Practical object editing | Numeric placement, snapping, duplication, and reversible commands update canonical persisted state. |
| 9 | Material and lighting inspection | Correct scale/response and preview a selected measured recipe; edits persist as intended. |
| 10 | Accepted-asset library | Browse/place/reuse assets and variants in a second environment without model calls. |
| 11 | Editor Bake → Compare → Apply | Unified entry points, region selection, repair, cancellation, stale-input handling, and revision-checked application. |
| 12 | End-to-end product validation | A second room and street case survive editing, baking, reuse, reload, and supported measured-camera execution with visible improvement. |

The nominal sequence is twelve PRs. Budget **12–16** because fixture bindings, renderer contracts, arbitrary-instance persistence, and output fitting may need splits. Setup may need a third PR; the comparison may need another adapter or refinement, hence **2–3 for setup and 4–6 cumulative for the first meaningful technical decision**.

PRs 1–3 provide the decision; 4–6 establish the quality-producing path; 7–10 support repeated authoring; 11 connects them; 12 validates the workflow. A narrow editor blocker can move earlier. Broad editor expansion must not become a prerequisite for seeing model output.

The estimate excludes a foundation model, full DCC tooling, unrestricted transparent/volumetric materials, and existing VIS hardware, managed-admission, distribution, and release gates. If the winning approach requires a new offline renderer bridge, neural runtime, or simulator geometry representation, re-estimate that concrete integration after the comparison. Counting it as one convenient PR would be misleading.

Future implementation follows repository roadmap reading and focused verification. Renderer/instance contracts need identity, persistence, failure, and browser/headless capability checks; simulator behavior changes need characterization comparison. Unsupported backends continue to fail validation. JS remains authoritative; metric truth and appearance remain separate.

## Immediate recommendation

Proceed next with the room fixture and thin comparison page, targeting visible evidence within 2–3 PRs. Use existing models, including transformers, to establish a quality result before committing to the remaining editor work. Retain successful physical-rendering improvements even if no generator wins. Choose each subsequent bounded PR from what the comparison actually demonstrates.
