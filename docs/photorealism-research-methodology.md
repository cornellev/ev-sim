# Photorealism research methodology

Prepared 2026-09-09, before external literature or product searches.

## Research question

How can an authored, interactive simulator scene become convincingly real under camera movement, lighting changes, and object rearrangement, while preserving a coherent world and trustworthy sensor observations?

The desired outcome is perceptual realism **and** useful transfer to camera perception models. Existing VIS acceptance is not evidence of either. Compute cost will be recorded, but will not eliminate an otherwise promising method in this investigation. VIS-15c and later implementation remain frozen during this work.

## Order of work

1. Record this methodology before searching websites.
2. Audit the repository's design, implementation, existing bake inputs/outputs, and acceptance gates. Distinguish implemented infrastructure from demonstrated visual quality. Do not modify simulator behavior.
3. Search primary research and first-party systems across all candidate families below. Follow both backward references and newer follow-up work. Record what was actually demonstrated and what remains a claim.
4. Compare methods against the same tests, including the user's two proposals. Retain a method's useful role even when it is unsuitable as the complete solution.
5. Propose a synthesis; explicitly separate established components, engineering hypotheses, and possible research novelty. Search for overlapping prior art before making novelty claims.
6. Recommend a sequence of decisive experiments, measurable gates, failure branches, and a conditional implementation direction. Do not substitute another infrastructure roadmap for evidence of realism.

## Candidate families: none excluded in advance

- Sequential whole-scene image enhancement, depth reprojection, inpainting, and accumulated texture baking.
- Per-object generative geometry, multiview texture generation, and reusable PBR material assets.
- Joint multiview or video-conditioned scene generation and 3D reconstruction/distillation.
- Scanned assets, photogrammetry, procedural detail, physical materials, lighting, and high-quality rendering.
- NeRF, Gaussian splatting, and editable/relightable hybrid scene representations.
- Inverse rendering and intrinsic decomposition into materials, geometry, and illumination.
- Learned image/video enhancement of a simulator's final camera stream.
- Generative world models and native 3D scene generation.
- Hybrid methods that share information across objects and views while preserving physical scene ownership.

## Questions to answer for each family

1. **Appearance:** What improves geometry, silhouettes, material response, fine detail, lighting, composition, and camera optics? What cannot improve?
2. **Consistency:** Does a detail stay attached to the same surface on reverse paths, closed loops, new elevations, wide baselines, and close inspection? Is consistency demonstrated or merely asserted?
3. **Editability:** Can an object move, rotate, be reused in a different room, and respond correctly to new light? Are shadows or reflections baked into color?
4. **World integrity:** What happens to occlusion, depth, labels, collisions, transparent/reflective surfaces, moving actors, and camera/LiDAR correspondence?
5. **Control:** Can authored geometry, dimensions, object identity, and scene layout be respected? Can uncertainty and unsupported surfaces be detected?
6. **Reproducibility:** Separate bake repeatability, artifact identity, replay stability, cross-device rendering tolerance, and cross-view consistency. A seed or the word “realistic” does not establish any of these.
7. **Evidence:** Is there a paper, code, weights, inspectable output, held-out evaluation, commercial demonstration, or only a claim? Do the demos use real capture or authored synthetic input?
8. **Practical adoption:** What are the input/output formats, integration implications, dependencies, access restrictions, and licenses? Unknowns stay unknown; compute is a later optimization concern.

## Source strategy and search locations

Prefer original papers and project pages, arXiv, CVF Open Access (CVPR/ICCV), ECCV proceedings, SIGGRAPH/ACM author manuscripts, OpenReview, official code/weight repositories and model cards, and first-party company documentation or technical reports. Use secondary sources only to discover primary evidence.

Search by problems and failure modes as well as model names, so FLUX Fill or any fashionable representation does not predetermine the answer. Initial query groups:

- “depth conditioned sequential scene inpainting texture reprojection multiview consistency”
- “texturing existing mesh multiview diffusion PBR material relighting”
- “synthetic to real rendering enhancement perception benchmark ground truth consistency”
- “scene generation geometry conditioned video diffusion simulator”
- “inverse rendering relightable Gaussian scene object editing”
- “generative material texture intrinsic decomposition scene harmonization”
- “photoreal simulation path tracing camera domain gap perception”

Search established work and current follow-ups through the search date. Record publication/version dates independently of search-result crawl dates. Do not infer publication recency or scientific validation from a search snippet. First-party commercial claims will be labeled separately from peer-reviewed evidence.

## Evidence extraction and comparison

Maintain a source register with stable links, dates/venues where verified, actual inputs and representation, demonstrated capabilities, relevant limitations, and availability. Open core sources rather than relying on search-result summaries. Reconcile negative findings with the underlying paper's scope: a research prototype's limitation does not prove the whole family impossible.

Use a qualitative decision matrix rather than invented numerical precision. Assess each candidate on image realism, movement consistency, reuse/relighting, adherence to authored geometry, sensor-label integrity, and distance from an executable proof. Identify the best role, not just a winner.

Separate four evidence levels:

- **Observed here:** directly inspected repository code or existing artifacts.
- **Demonstrated externally:** a primary source reports an experiment or provides an artifact, with its scope stated.
- **Claimed externally:** a vendor/research claim without an independently inspected matching test.
- **Proposed here:** a hypothesis or experimental design, not an achieved capability.

## Evaluation designed before selecting the method

Use one shared authored test room, a deliberately difficult material/occlusion test, and a target-domain real reference set. Render every candidate along identical paths. Include an ordinary room, oblique and close views, a reverse path and loop closure, a moved object, changed illumination, glossy surfaces, thin structures, and newly exposed surfaces. Keep unseen paths out of bake/model selection.

Compare the current simulator, physically authored/scanned assets under high-quality lighting, whole-scene baking, object baking, and the strongest feasible hybrid. Include ablations separating geometry/assets, lighting/materials, and learned enhancement.

Evaluate blind human realism judgments and temporal defect rates alongside actual target perception tasks on held-out real data. Feature-distribution metrics are diagnostics; a camera model being confidently wrong is not success. Use geometric reprojection and identity checks, measured label/depth alignment, and repeat/replay checks. Pre-register provisional acceptance thresholds in the final action plan, with a pilot to calibrate them where empirical variance is unknown.

## Novelty and decision discipline

Do not promise that an approach is unprecedented. Locate the closest precedents for any proposed combination, state exactly what is different, and define an experiment that could refute the claimed benefit. A useful system integration is valuable even if it is not a new research algorithm.

The final recommendation must name its strongest rival, explain its tradeoffs, preserve useful components from other families, identify what existing VIS work can be reused, and say what evidence would change the decision. Implementation proceeds only after the realism objective and a concrete evidence gate are accepted; this research itself does not unfreeze VIS-15c onward.

## Research outputs

Added after executing the methodology: [findings and recommendation](photorealism-research.md), [source register and search execution notes](photorealism-sources.md), and [experimental action plan](photorealism-action-plan.md). The methodology above was recorded before external searches; the proposed intervention-based synthesis emerged during the research.

Product follow-up, 2026-09-09: the owner clarified that a useful simulation
tool is the objective. The revised action plan therefore makes formal studies
and custom optimization optional, proposes a small comparison workspace before
larger editor development, and includes transformer viability and illustrative
costs. This note records the subsequent clarification without rewriting the
original pre-search methodology. No implementation milestone was resumed.
