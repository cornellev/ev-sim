# Visual layer contracts

This document freezes the VIS-01 contracts. It describes interfaces that
later VIS milestones implement. VIS-12a activates the identity contracts below;
VIS-02 dispatches exact camera render provider ID/version. VIS-03 adds
environment schema v3, server revisions, and an internal descriptor store.
VIS-04 adds a source-aware immutable visual-asset CAS with validation, quotas,
staging recovery, and internal root/pin primitives. VIS-05a adds immutable
`cev-sim.visual-layer-access@1` sidecars and browser preview materialization
for owned GLB/glTF and PNG/JPEG/KTX2. VIS-06a adds the headless-safe
`cev-sim.visual-camera-calibration@1` and immutable calibrated-capture seam.
VIS-06b adds the internal `cev-sim.visual-capture-pass-set@1` contract and
aligned visual/analytic capture adapter without activating a provider.
VIS-07 adds the in-memory bake-job catalog, frozen `bake-snapshot` scenes,
deterministic capture plans, and local `captured-appearance@1` provider
dispatch. VIS-08 persists projected captured-radiance PNG/GLB artifacts and
atomically promotes environment descriptor/access references. VIS-09 reuses
unchanged bake units from a trusted `cev-sim.bake-reuse-manifest@1`; reports
never enter `visualLayerHash`, `worldHash`, or episode identity. VIS-10a
defaults new persistent bakes to deterministic per-chunk atlases under
bake-contract v2; `projected-captured-radiance@1` remains an explicit
compatibility mode. VIS-10b adds opt-in `bake-construction@2` intrinsic
proposal fusion, material-proposal evidence, multi-channel atlas outputs, and
artifact/contribution/atlas dispatch without changing the captured-radiance
default or visual-layer identity. VIS-11 adds an opt-in
`intrinsic-material-model@1` adapter that converts VIS-07 captures into VIS-10b
intrinsic proposals through a pinned fake or operator-injected backend. The
default `captured-appearance@1` path remains model-free and performs no network
or model probing.
VIS-16a adds strict visual-evaluation, correspondence-report, threshold-profile,
and admission contracts with synthetic boundary fixtures. It does not run a
validator or activate managed visual execution.
VIS-12b adds conditional `pbr-mesh@1` resolution, exact render/asset resources,
and separate source-bound run evidence for export and offline inspection.
VIS-13a adds the frozen streaming run-package codec and authoring import/export;
VIS-13b adds same-host package admission across the supervisor, CLI, and Python.
Photoreal rendering, corrected GPU backend v2 execution, measured PBR cameras,
and PBR execution remain unavailable.

The implementation authority and acceptance gates remain in
[the visual-layer roadmap](visual-layer-plan.md). JavaScript remains the only
simulation kernel. Visual resources affect requested camera pixels and never
become collision, route, LiDAR, registry, or oracle truth.

## Versions and activation

| Contract | Frozen version | Activation owner |
| --- | --- | --- |
| `cev-sim.run-bundle` | 1 | Existing runtime |
| Corrected authored/resolved run manifest | 11 | VIS-12a |
| Identity selector | `world-bound@2` | VIS-12a / protocol 1.3 |
| Simulation-semantic and episode identity | 2 | VIS-12a |
| `cev-sim.world-description` | 1, unchanged | Existing runtime |
| Legacy analytic scene | `canonical-analytic@1`, unchanged | Existing runtime |
| Corrected analytic scene | `canonical-analytic@2` | VIS-02 known/unavailable; runtime VIS-06/VIS-14/VIS-15 |
| PBR scene | `pbr-mesh@1` | VIS-12b resolution/inspection; runtime VIS-14/VIS-15 |
| PBR render recipe | `cev-sim.pbr-render-recipe@1` | VIS-12b authoring and resolution |
| PBR asset closure | `cev-sim.visual-asset-closure@1` | VIS-12b exact render resource |
| PBR run evidence | `cev-sim.visual-run-evidence@1` | VIS-12b source-bound resolution evidence |
| Corrected GPU sensor backend | `chromium-webgl2-rendered-sensors@2` | VIS-14/VIS-15 |
| Visual camera calibration | `cev-sim.visual-camera-calibration@1` | VIS-06a internal opt-in; provider activation VIS-14/VIS-15 |
| Immutable visual capture input | `cev-sim.visual-capture-input@1` | VIS-06a internal opt-in |
| Aligned capture pass set | `cev-sim.visual-capture-pass-set@1` | VIS-06b internal opt-in; VIS-07 version-1 bake jobs |
| Bake run config | `cev-sim.bake-run-config@1` / `@2` | VIS-07 catalog; VIS-08/VIS-10a persistent no-model jobs |
| Bake source snapshot | `cev-sim.bake-source-snapshot@1` | VIS-07 `static-snapshot@1` |
| Bake capture plan | `cev-sim.bake-capture-plan@1` | VIS-07 |
| Bake provider request | `cev-sim.bake-provider-request@1` | VIS-07 |
| Bake provider response | `cev-sim.bake-provider-response@1` | VIS-07 local `captured-appearance@1`; VIS-11 input acknowledgements |
| Bake model output set | `cev-sim.bake-model-output-set@1` | VIS-11 transport-only intrinsic channel/confidence/mask digests |
| Bake job status | `cev-sim.bake-job-status@1` | VIS-07 mutable status |
| Bake construction | `cev-sim.bake-construction@1` / `@2` | VIS-10a captured-radiance policy; VIS-10b intrinsic proposal fusion |
| Bake material proposal set | `cev-sim.bake-material-proposal-set@1` | VIS-10b durable provenance and exact per-unit/channel output digests |
| Bake artifact set | `cev-sim.bake-artifact-set@1` / `@2` / `@3` | VIS-08 projected records; VIS-10a chunk/page records; VIS-10b proposal binding |
| Bake atlas manifest | `cev-sim.bake-atlas-manifest@1` / `@2` | VIS-10a captured atlas; VIS-10b multi-channel output metadata |
| Bake atlas contribution | `cev-sim.bake-atlas-contribution@1` / `@2` | VIS-10a radiance reuse; VIS-10b proposal reuse codec |
| Bake reuse manifest | `cev-sim.bake-reuse-manifest@1` / `@2` | VIS-09 fragments; VIS-10a contributions and chunk hashes |
| Bake reuse report | `cev-sim.bake-reuse-report@1` | VIS-09 audit evidence only |
| Visual evaluation input | `cev-sim.visual-evaluation-input@1` | VIS-16a contract only |
| Visual correspondence report | `cev-sim.visual-correspondence-report@1` | VIS-16a diagnostic/synthetic evidence only |
| Visual threshold profile | `cev-sim.visual-threshold-profile@1` | VIS-16a synthetic profiles; production registry empty |
| Visual evidence admission | contract-level checker | VIS-16a; managed execution integration VIS-16b |
| Identity negotiation | Protocol 1.3 | VIS-12a |
| Environment schema | 3 | VIS-03 |
| Package admission | Protocol 1.4 | VIS-13b |

The current runtime advertises protocol 1.4 and `identity_profiles: ["world-bound@2"]`.
Configured Unix-socket supervisors additionally advertise
`asset_admission_profiles: ["cev-sim.run-package@1"]`; TCP and explicitly
disabled admission advertise none and reject the admission RPC. Unknown
required versions, profiles, providers, products, or extensions fail explicitly.

## Visual layer descriptor

`app/simulation/visual/VisualLayer.js` defines and validates
`cev-sim.visual-layer` version 1. The descriptor is immutable and contains
only inputs that can affect reusable static appearance:

```json
{
  "kind": "cev-sim.visual-layer",
  "version": 1,
  "sourceWorldHash": "<sha256>",
  "assetProfile": { "id": "static-gltf-surface", "version": 1 },
  "assets": [],
  "materials": [],
  "chunks": [],
  "instances": [],
  "bindings": [],
  "appearanceDependencies": []
}
```

Assets use lowercase `{ sha256, mediaType, sizeBytes, role }` records. All
descriptor graph edges use `sha256:<digest>` and must resolve inside the
closed asset set. Digest-addressed external glTF buffers use
`application/octet-stream` and role `buffer`. Dependencies discovered inside
GLB/glTF are checked against the same set during bounded asset validation. URLs
and filesystem paths are not resource identities. Chunks and instances bind each
other explicitly. A visual-to-truth
binding names a validated truth entity for evaluation; it does not register
the visual object as truth.

Instance transforms are finite, nonsingular, column-major affine 4×4 matrices.
Each instance records a primary `assetUri` and a non-empty `lodLevels` sequence
from highest to lowest detail; its first level equals the primary URI. LOD
sequence order is semantic and is never sorted. Identifiers are non-empty NFC
strings. Identifier collections use UTF-8 byte ordering; ordered numeric data
such as matrices and LOD sequences retain their declared order.

`normalizeVisualLayer` converts authoring data to the complete canonical
shape and returns a new object. `assertVisualLayer` accepts only that immutable
shape: missing defaults, reordered sets, unknown fields, invalid references,
and unsupported versions are errors. `hashVisualLayer` hashes RFC 8785/JCS
UTF-8 bytes without applying the simulator's historical six-decimal numeric
projection.

VIS-03 persists canonical descriptor JSON at
`server/data/visual-layer-descriptors/sha256/<hash>.json`. Writes verify with
`assertVisualLayer` and `hashVisualLayer`, store exact JCS bytes, and never
overwrite an existing digest. Environment documents reference a descriptor as
`visualLayer: { descriptorHash }` or
`{ descriptorHash, accessHash }`. Legacy descriptor-only references remain
readable but are not materializable until an access hash is attached. Older
clients that rewrite the same descriptor without `accessHash` preserve the
existing sidecar; replacing the descriptor without a matching access hash is
rejected. Rename retains both hashes. Duplicate, ID change, and conflicting
import rebind the descriptor and create a corresponding access sidecar with
unchanged use selections.

`accessHash` stays outside `visualLayerHash`, `worldHash`, simulation-semantic
identity, and episode identity. It may change normalized authoring/resolved
environment identity as provenance changes.

VIS-05a stores canonical access sidecars at
`server/data/visual-layer-access/sha256/<accessHash>.json`. The sidecar is:

```json
{
  "kind": "cev-sim.visual-layer-access",
  "version": 1,
  "descriptorHash": "<sha256>",
  "assets": [{ "sha256": "<asset digest>", "useHash": "<source-bound use hash>" }]
}
```

Assets are canonicalized by UTF-8 digest order and hashed as exact JCS bytes.
The sidecar must cover every descriptor asset exactly once. Each use record
must match the descriptor digest/media/size/role, and glTF dependency-use
mappings must agree with the sidecar without extra closure members. Publish
and read re-evaluate `display` rights. Digest-only asset URLs and filesystem
paths are not exposed.

Browser access is `VisualLayerClient` at `/api/storage/visual-layers`:

- `POST /api/storage/visual-layers` with canonical `{ descriptor, assetUses }`
  returns `{ descriptorHash, accessHash }`.
- `GET /api/storage/visual-layers/:descriptorHash/access/:accessHash` returns
  the verified descriptor, access sidecar, and additive `verification`
  metadata (decoded-size estimates, geometry counts, texture dimensions, and
  permission summary) after re-evaluating `display` rights. `accessHash` is
  unchanged. Digest-only URLs and filesystem paths are not exposed.

VIS-04 stores binary assets at `server/data/visual-assets/sha256/<digest>` and
source-bound `cev-sim.visual-asset-use@1` records at
`uses/sha256/<useHash>.json`. A use record contains the asset reference, sorted
trusted source IDs, and exact dependency-use mappings. Use hashes are RFC
8785/JCS SHA-256 values; identical bytes uploaded under different provenance
produce distinct use hashes. Version-2 validation evidence is stored beside the use and
does not enter `visualLayerHash`, semantic hashes, or episode hashes.
`normalizeVisualAssetReference` / `assertVisualAssetReference` are the reusable
asset-reference validators.

Publication streams to staging, hashes while writing, validates, fsyncs
file and directory, then exclusively publishes bytes and metadata. Published
objects are immutable regular files; symlink paths are rejected. Range reads
use verified handles, digest ETags, and `416` for unsatisfiable ranges.
Published deletion is disabled. Internal `acquire/replace/releaseRoot` and
`acquire/renew/releasePin` APIs reference use closures, not bare digest paths.
Environment promotion, bake, package, queue, worker, replay, and report owners
wire those primitives in later milestones.

Browser access is `VisualAssetClient` at `/api/storage/visual-assets`. Streaming
content routes are mounted before the shared JSON parser. Digest-only content
URLs, filesystem paths, root/pin mutation, and published deletion are not
exposed. Constructor and environment configuration may lower operational limits
but cannot exceed the frozen ceilings: 32 GiB published, 4 GiB staging, 1 GiB
per asset, 16,384 assets, depth 64, 100,000 nodes, 4,000,000 triangles, 8192
pixels, 14 mips, 4 GiB decoded closure, two uploads, one validation, 32 readers,
60-second validation, and a one-hour abandoned-stage TTL.

Every content read, closure check, access-sidecar check, and cached
materialization requires current version-2 validation evidence. Missing or old
records are revalidated against immutable CAS bytes and the current restricted
profile without changing the asset digest or source-bound use hash. Preflight
uses the same total timeout as the validator and iteratively bounds arbitrary
object and node graphs. Required, used, and instantiated glTF extensions share
one allowlist. Data-URI, buffer-view, and digest-backed images are inspected for
media type, dimensions, mip expansion, bounds, and decoded-memory cost before
`GLTFLoader` or an image decoder runs. Loader-created object URLs are allowed
only inside that validated materialization call; authored blob, relative,
network, and file URIs remain denied. Texture and decoder failures abort the
whole staged preview. VIS-13a verifies `cev-sim.run-package@1` USTAR archives
and can import them into the authoring store; CLI/supervisor package execution
remains VIS-13b.

The operator-controlled `cev-sim.visual-source-registry@1` file is the only
trusted grant source. There is no mutation API. Missing registries and unknown,
expired, revoked, or incomplete grants fail closed. Upload creation and
finalization require `persistent-cache`, `machine-interpretation`, and
`retention`. Content access re-evaluates `display`. Root and pin acquisition
re-evaluate the caller-requested operations over the full dependency-use
ancestry.

New exact contracts normalize negative zero to zero and reject non-finite
numbers, unsafe integer counters, duplicate JSON keys, lone surrogates, and
values outside the JSON data model. Immutable JSON ingestion uses
`parseExactJson` before schema validation so duplicate keys cannot be silently
discarded by `JSON.parse`. Existing world, resolved-run, semantic, episode,
and trajectory hash implementations remain unchanged.

Provenance, rights attestations, correspondence reports, bake status, job
logs, and timestamps are separate evidence documents. A resolved run or
package may reference their exact digests. Evidence does not enter
`visualLayerHash`, and pixel-identical evidence changes do not enter semantic
or episode identity.

## Correspondence evidence contract

`app/validation/VisualCorrespondence.js` is an ES module without Three.js,
DOM, or renderer dependencies. It strictly normalizes, asserts, parses,
serializes, and hashes `cev-sim.visual-evaluation-input@1`,
`cev-sim.visual-correspondence-report@1`, and
`cev-sim.visual-threshold-profile@1` using exact JSON ingestion and JCS
SHA-256. Unknown fields, duplicate keys, unsupported versions, unsafe counts,
non-finite values, bad hashes, missing cells, and zero denominators fail.

An evaluation input binds the metric world and visual layer, render-scene and
provider configuration, complete asset/use closure, exact per-camera calibrated
K bodies and hashes, calibration bundle, capture recipe/pass policy, ordered
sample times and pose/dynamic-state hashes, AOI, seed/action tape, and all
sample-selection, metric, confidence, aggregation, and threshold-policy
versions. It cannot contain a report digest or report-containing resolved hash.
Attaching a report may therefore change a later full resolved identity while
preserving evaluation-input, world, visual-layer, simulation-semantic, and
episode hashes when capture inputs are unchanged.

Reports bind the evaluation-input and threshold-profile hashes, exact captured
input/output artifact digests, validator/build identity, runtime, GPU, driver,
and decoder provenance. Metric cells cover every required camera, AOI region,
and distance band for depth residual, silhouette/reprojection error,
semantic/instance alignment, joint coverage, and photometric difference. Each
cell records expected, jointly valid, missing visual/analytic, and low-confidence
counts plus aggregate and worst-region values. Admission recomputes coverage and
threshold results and ignores the submitted `declaredPassed` value.

Diagnostic admission can generate or inspect bounded reports without prior
correspondence evidence after current asset-validation, capability, and rights checks, but its
result is never managed-eligible. Managed admission requires exact report
bytes, a production profile from an external approved registry, current asset,
rights, and capability decisions, and a matching trusted local-validation record kept
outside report JSON. Imported reports are diagnostic only. The repository ships
one synthetic boundary fixture and no approved production profile. Queue,
worker, recovery, and real evaluator integration remain VIS-16b work.

## Materials and assets

The initial profile accepts static GLB/glTF meshes and PNG, JPEG, or KTX2
textures. It supports glTF metallic-roughness and explicit unlit captured
radiance, with these extensions:

- `KHR_materials_unlit`
- `KHR_materials_clearcoat`
- `KHR_materials_sheen`
- `KHR_materials_specular`
- `KHR_materials_emissive_strength`
- `KHR_texture_transform`
- `KHR_texture_basisu`

Surfaces may use `OPAQUE` or `MASK` alpha modes and may be double-sided.
Alpha blending, transmission, volume, animation, skins, morph targets, and
all unlisted extensions are unsupported. A captured-radiance material must be
unlit because its beauty pixels already include illumination. Standard glTF
color, factor, strength, and alpha-cutoff ranges are validated by the pure
descriptor helper. Intrinsic PBR
channels belong to the optional estimation track.

Material meaning follows the
[glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
and its [Khronos extensions](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos).
The restricted profile is stricter than a general glTF loader: asset
validation rejects every extension outside the allowlist and every uncontrolled
network or filesystem dependency before decoding.

## Camera and product contract

New camera authoring uses:

```json
{
  "render": {
    "provider": { "id": "canonical-analytic", "version": 1 },
    "productProfile": { "id": "measured-rgba-analytic-oracle", "version": 1 }
  }
}
```

Existing pre-VIS-02 cameras may omit `render`; absence aliases to
`canonical-analytic@1` only during resolution. `pbr-mesh@1` may be authored,
resolved, exported, and inspected when structurally valid, but it remains
unavailable for execution and never falls back to analytic.
`canonical-analytic@2` remains unavailable.

Existing product flags select products within that profile. Measured RGBA and
matching CameraInfo are required for PBR camera support. Analytic depth,
semantic IDs, and instance IDs are optional products and must be advertised by
the selected backend or rejected before preparation. Bake G-buffers are
internal evaluation products. They never enter measured policy observations.

The image origin is top-left and integer coordinates denote pixel centers.
Renderers must use authored `fx`, `fy`, `cx`, and `cy`, including unequal focal
lengths and off-center principal points, with explicit near/far clipping. The
coordinate and optical-frame conventions remain those in
[run manifests](run-manifests.md).

VIS-06a implements these rules in the Three/DOM-free
`app/3d/environment/visual/VisualCapturePipeline.js`. For near plane `n`, the
authored intrinsics produce the exact asymmetric frustum:

```text
left   = -(cx + 0.5) n / fx
right  =  (width - cx - 0.5) n / fx
top    =  (cy + 0.5) n / fy
bottom = -(height - cy - 0.5) n / fy
```

Matrices use column-major OpenGL/Three layout. Capture poses use intrinsic XYZ
rotation, REP-103 camera-link/optical conversion, and non-negative integer
nanosecond timestamps. A `cev-sim.visual-capture-input@1` freezes calibration,
projection, camera pose/view matrices, scene role/generation, and capture time
before asynchronous submission.

Supported distortion is `none`, five-coefficient Brown-Conrady
`[k1,k2,p1,p2,k3]`, or eight-coefficient rational Brown-Conrady
`[k1,k2,p1,p2,k3,k4,k5,k6]`. Output generation inverse-maps destination
pixels with a bounded iteration count. Nonconvergence and samples outside the
source image are invalid. Beauty uses linear interpolation; all numeric, ID,
confidence, and validity products use nearest sampling to preserve
discontinuities.

The strict corrected path rejects unsupported coefficient counts/models,
non-finite coefficients, singular rational denominators, and non-convergent
inverse mappings. Outside-image samples are zero with a shared Uint8 validity
mask. The historical distortion helper names remain re-exported by
`CameraRenderProducts.js` for legacy callers.

| Product | Representation |
| --- | --- |
| Measured image | RGBA8, sRGB transfer, top-left rows |
| Visual/analytic depth | little-endian Float32 axial optical depth in meters |
| Geometric normal | little-endian Float32 XYZ in world coordinates |
| World position | little-endian Float32 XYZ in world meters |
| Confidence | little-endian Float32 |
| Object/material/semantic/instance IDs | little-endian Uint32 |
| Invalid/no hit | zero values plus an explicit validity mask |

`cev-sim.visual-capture-pass-set@1` has two disjoint families. The
`visual-appearance` family contains beauty, axial depth, primitive geometric
normal, object/material IDs, world position, confidence, and validity. The
`analytic-oracle` family contains axial depth, semantic/instance IDs, and
validity. Both families carry separate VIS-06a capture inputs with identical
calibration, optical pose, capture timestamp, distortion, and top-left output
rows. Their scene roles and handles remain distinct.

Visual bindings name verified descriptor renderables, descriptor object keys,
and material-slot keys. Truth bindings name verified analytic renderables and
their semantic/instance IDs. Imported `extras`, object names, and mutable
`userData` are never consulted. Object and material catalogs assign `1..N` by
UTF-8-sorted descriptor identifiers; `0` is unknown/unbound. Visible unbound
surfaces still occlude and have validity `1`, zero IDs, and confidence `0`.
Exact bindings have confidence `1`. Selection masks are computed from the
frontmost object-ID product, so non-target surfaces remain occluders.

Geometric normals come from transformed primitive geometry in simulator world
coordinates, do not sample normal maps, and are not flipped toward the view.
Beauty and visual proxies share geometry, visibility, sidedness, and the exact
base-alpha/alpha-map textures, transforms, opacity factor, and cutoff. The
corrected path accepts only the existing OPAQUE/MASK profile; blend,
transmission, volume, lines, points, sprites, skinning, morphing, displacement,
custom shaders/hooks, and other surface-order-changing content fail before
rendering. Analytic oracle passes use explicit immutable truth twins.

Every visual pass set carries canonical source-use hashes. Measured capture
requires `display` and `machine-interpretation`; bake capture additionally
requires `derivatives`. A trusted closure validator rechecks all uses before
render/readback. Failure, cancellation, or context loss publishes no partial
family, restores renderer/camera/scene state, and disposes temporary proxy and
target resources.

Owned capture handles have only `measured-appearance`, `analytic-truth`, or
`bake-snapshot` roles and a positive generation. Corrected camera capture
rejects display/preview scenes. `BakeView`, `ManifestCamera` /
`CameraRenderProducts`, and `PooledGpuRenderer` expose explicit
`calibrated-projection@1` adapters: Three receives the shared projection
matrix, headless Chromium receives the frozen view-projection input, corrected
readbacks use top-left rows, and corrected bake projection/unprojection uses
the same calibration. Their default path remains `legacy-fov@1`, including
the old FOV projection, framebuffer orientation, request shapes, and bake
behavior.

This foundation does not activate a render provider or backend. Only
`canonical-analytic@1` and GPU backend v1 are available. VIS-07 adopted
aligned capture for in-memory version-1 bake jobs using local
`captured-appearance@1`; it does not persist artifacts or promote environment
references. VIS-08 writes deterministic projected captured-radiance PNG/GLB
assets, verifies the complete closure, and atomically promotes descriptor/access
references. VIS-10a defaults new persistent jobs to per-chunk atlas PNG/GLB
pages with `KHR_materials_unlit` captured-radiance materials, hashed
construction policy, and contribution assets pinned on a durable bake-reuse
root. VIS-10b construction v2 is optional and accepts only a complete,
job-bound `cev-sim.bake-material-proposal-set@1`. Supplied and inferred
sources carry algorithm/provider/model/weights revisions, nondeterminism scope,
source-use hashes, and exact little-endian Float32/Uint8 output digests.
Per-channel source priority defaults to supplied before inferred, then fusion
ranks combined capture/proposal confidence, camera facing, distance, UTF-8
source/unit IDs, and source pixel. Unknown candidates remain unknown: the
declared rendering default is written with zero confidence and a zero known
mask.

Intrinsic output is base-color (linear-sRGB reflectance), tangent-space normal,
glTF perceptual roughness, metallic fraction, relative linear-sRGB emissive,
and ambient accessibility. Alpha remains geometry/material policy. The writer
emits sRGB base-color and emissive PNGs, a tangent-normal PNG, a glTF-packed
metallic-roughness PNG, an occlusion PNG, and separate confidence/known-mask
PNGs for every logical channel. Captured beauty never enters those intrinsic
textures. Artifact-set v3 binds the separately stored proposal hash; the
proposal document, confidence maps, access records, reuse records, and
promotion receipt remain outside `visualLayerHash`, `worldHash`, semantic
identity, and episode identity. VIS-14 and VIS-15
own resolved-provider browser/headless routing.

`app/3d/environment/visual/BakeRunCatalog.js` is Three/DOM-free. Version-1 jobs
hash `recipeHash` (pixel-affecting config), `snapshotHash` (frozen world,
revision, generation, appearance, and resource closure), `planHash` (canonical
views and samples), `requestHash` (provider options plus exact captured-buffer
digests), and `responseHash` (output digests and provenance). Job IDs,
timestamps, progress, logs, and failures never enter those hashes. The default
provider is local `captured-appearance@1`: no model capability, no network, and
identity references to aligned capture products. `intrinsic-material-model@1`
is registered lazily and is probed only when selected. It requires construction
v2 `intrinsic-pbr-proposed`, all six intrinsic channels, a common source
resolution, and pinned model/algorithm/weights identity. Provider-response
outputs remain acknowledgements of the captured inputs; model pixels live in
`cev-sim.bake-model-output-set@1` and the resulting VIS-10b proposal set.
External upload reauthorizes machine-interpretation, derivatives, ML, worker
access, and transient caching, plus persistent-cache and retention for
`reuse-request`. Detached
`bake-snapshot` scenes clone transforms/materials/visibility/lighting, share
geometry and textures only through read-only leases, and never wrap the live
preview root. The editor `b` key runs `BakeHarness.runPersistentPromotion()`:
reserve a generation, compare per-unit dependency keys, capture only
invalidated units (beauty, world position, geometric normal, confidence, and
validity for atlas jobs), convert captures to sparse contributions, rebuild
dirty atlas chunks, commit a new layer or a revision-free no-op, and
rematerialize preview. Legacy `BakeHarness.start()` remains only for explicit
`legacyBake=1` / `createLegacyCompatibleBakeRunConfig`.

Proposal output digests participate in per-unit dependency keys, so changing
one unit invalidates only its contribution and affected chunks. Construction-v1
contributions are never reinterpreted as intrinsic data. Proposal, contribution,
and multi-channel fusion allocations use the bake memory ledger and fail before
upload on incomplete evidence or budget exhaustion; there is no captured-
radiance fallback. VIS-11 caches raw model outputs atomically by exact
`requestHash` only for `reuse-request`. Cached inference can skip model execution;
artifact reuse still compares proposal-unit digests. Fresh and cached fake
outputs must produce identical proposal, atlas, contribution, artifact,
descriptor, and access hashes. Missing or malformed channels, cancellation, and
stale generations fail without captured-radiance fallback. No real-model
quality claim is made until separate measured evidence exists.

Promotion recovery, environment reads, and environment mutations share the
same per-environment transaction lane. Recovery recognizes publication only
when the exact intended revision and complete manifest, including access and
reuse references, match. Journals and roots are durably ordered; ambiguous or
corrupt journals retain protective roots and fail explicitly. Commit retries
are bound to their original request. A cancellation that loses the commit race
adopts the returned receipt. A committed promotion whose preview reload fails
keeps its receipt and reports `BAKE_PREVIEW_RELOAD_FAILED`; retry reloads only
the materialization. Legacy model uploads require every request to return
`true` before completion or success telemetry.

VIS-05a materializes owned preview geometry in the display scene only.
`VisualLayerMaterializer` verifies descriptor/access hashes, world bindings,
asset closure, and current `display` rights before decoding. Assets are fetched
only through selected use hashes. glTF resource URIs resolve through an exact
`sha256:<digest>` map; relative, network, file, and unrecognized URIs are
rejected before a request. KTX2 uses the pinned Basis transcoder path
`/vendor/basis/`. VIS-05b selects per-instance LODs from hashed
`cev-sim.visual-lod-policy@1` distance bands `[0, 80, 200]` meters and streams
chunks inside a 100 m required / 120 m prefetch radius (128-chunk cap).
Hardware profiles share that policy and must not coarsen LOD to relieve
memory pressure. Required chunks load exactly or fail; camera-movement budget
pressure keeps the last committed AOI and reports
`VISUAL_PREVIEW_BUDGET_EXCEEDED`. Primitive material names must be unique NFC
identifiers that bijection-match the instance `materialIds`. Descriptor-driven
`MeshPhysicalMaterial` or unlit `MeshBasicMaterial` replaces embedded runtime
materials. Instance matrices are applied without extra numeric rounding.
Complete chunk groups are committed only after every instance in the group
succeeds. Imported `userData` is overwritten with namespaced preview metadata.
Preview objects are non-selectable and excluded from environment registry,
perception truth, collision, LiDAR, and measured camera scans. `truthEntityId`
stays in the materializer binding table. Failed initial or environment-switch
loads dispose staged resources and leave an empty preview, not another world's
visuals. `pbr-mesh@1` remains unavailable to this preview/runtime path.

## Conditional PBR run resources

VIS-12b introduces optional manifest `renderRecipe` as strict
`cev-sim.pbr-render-recipe@1`. Omission preserves legacy analytic manifest
shape. On stored-manifest update, omission also preserves an existing explicit
recipe; explicit `null` resets it. Save, duplication, resolution, and JSON
import/export preserve an explicit recipe.

Normalization freezes the complete pixel contract: opaque black background;
white unit ambient light; exposure 1; linear-sRGB working and sRGB output; no
environment map, shadows, tone mapping, antialiasing, or dithering; OPAQUE/MASK
alpha; glTF-declared or linear-repeat sampler defaults; UTF-8-stable ordering;
material-driven double-sided culling; less-equal depth; high precision; and
top-left RGBA8 readback. It reuses the static glTF/KTX2 profile, pinned decoder
and transcoder policy, and `cev-sim.visual-lod-policy@1` bands `[0, 80, 200]`.
Unsupported overrides fail rather than becoming host-dependent choices.
Environment-map and actor mesh inputs are `{ asset, useHash }` pairs. Every
resolved actor receives a versioned canonical-primitive appearance unless a
recipe entry keyed by that actor ID provides a CAS-backed mesh/material and
visual-to-actor transform. Unknown actor IDs and mutable model URLs fail.

All enabled cameras must select the same `pbr-mesh@1` provider and product
profile. The resolver validates original and effective environment, scenario,
script, binding, and embedded locks before touching a visual store. It then
requires the effective environment's exact descriptor/access sidecar, matching
`sourceWorldHash` and truth bindings, and complete source-bound coverage.
Every selected root is traversed through its immutable use graph, including
all declared LODs, mesh buffers/textures, appearance dependencies, actor
overrides, and background/IBL. Resolution rehashes actual CAS bytes and sizes
and re-evaluates both `display` and `machine-interpretation` against the trusted
operator registry through every source ancestry. Shared content bytes remain
separate uses for rights evaluation. State-only, LiDAR-only, analytic, and
disabled-PBR runs perform no visual descriptor/access/CAS acquisition.

The resolved snapshot contains exact `visualLayer` and `renderScene` resources
with matching dependency hashes. The PBR scene binds world, layer, product
profile, normalized pixel recipe, full content-deduplicated asset closure,
actor appearance/transforms, and an independently hashed analytic truth
resource. Visual meshes never become truth or LiDAR geometry. Source-bound
access, roots, complete use records, policy operations/source IDs/obligations,
and optional correspondence attachment live separately in
`cev-sim.visual-run-evidence@1`. Correspondence is only
`{ reportHash, status: "unverified-reference" }`; its presence neither proves a
report nor grants managed eligibility.

Recipe, scene, closure, and evidence hashes use exact canonical JSON and reject
invalid Unicode/numbers, negative zero, duplicate keys, ordering/version drift,
and recomputed-outer-hash attacks on inner resources. Authoring-only recipe
uses and evidence are excluded from semantic identity; the pixel recipe and
content closure in the render resource carry selected appearance meaning.
Evidence/access/report-only changes may therefore change `resolvedHash` without
changing world, render, simulation-semantic, or episode identity.

Integrity-only bundle verification validates these resources and
cross-references without local asset bytes or a renderer. Offline inspection
states that it does not prove current rights, asset availability, or
correspondence validity. Executable verification remains mandatory for browser,
CLI run, supervisor, and worker preparation, all of which reject PBR before
environment/sensor mutation. Provider-aware JavaScript/Python episode defaults
select only routed GPU backend v2 for PBR and reject missing or older support.
No asset bytes are installed by JSON import. VIS-13a `cev-sim.run-package@1`
authoring export/import transfers the closed visual-asset bytes. VIS-13b adds
protocol 1.4 same-host admission for configured Unix-socket supervisors,
exact-byte batch binding, pinned digest-scoped access, and CLI/Python package
flows. PBR execution remains unavailable until the renderer milestones.

## Identity projection and compatibility

VIS-12a activates `resolved.identityProfile = { id: "world-bound",
version: 2 }`. Its resolver validates locks before producing a JSON snapshot,
then projects a clone. The implemented identity rules are:

1. Validate all top-level and nested environment, scenario, script, and
   embedded dependency locks against the full authoring snapshot.
2. Replace authoring-only environment identity throughout the semantic
   projection with the corresponding metric `worldHash`.
3. Recompute scenario semantic dependencies from projected scenario behavior,
   retaining routes, scripts, controls, rewards, seeds, and other behavioral
   inputs.
4. Apply the same projection to browser observation and reward profile config
   hashes.
5. Preserve conditional analytic-camera and LiDAR resources. Explicit camera
   render selections are dispatched by VIS-02; omitted selections alias only
   to `canonical-analytic@1`. Selected `pbr-mesh@1` resources resolve through
   VIS-12b, while runtime-unavailable providers cannot execute.
6. Include selected render resources, calibration, product policy, and
   semantic backend configuration. Exclude evidence, logging, artifact and
   resource policy, wall pacing, host paths, admissions, and replay evidence.

Compatibility is evaluated separately at each boundary:

| Input | Byte/hash verification | Authoring import | Execution |
| --- | --- | --- | --- |
| Bundle v1 / resolved v10 | Preserve received bytes and existing algorithms | Supported | Existing analytic path remains supported |
| Older authored manifests | N/A unless a historical bundle verifier exists | Normalize and re-resolve | Only through a newly resolved supported bundle |
| Bundle v1 / manifest v11 / `world-bound@2` | New version-dispatched algorithms | Supported | Protocol 1.3 and advertised identity profile required |
| Bundle v1 / manifest v11 / selected `pbr-mesh@1` | Exact inner render/closure/evidence verification | Supported when local authoring dependencies exist | Rejected until PBR renderer and GPU backend v2 are available |
| Earlier immutable bundles | Retain legacy import verification where its algorithm applies | Verify before normalizing | Explicit re-resolution required |
| Unknown versions or identities | Explicit compatibility error | Rejected | Rejected |

Verification never normalizes or rewrites received immutable bundle bytes.
Authoring import is not proof of executable compatibility.

`verifyRunBundleIntegrity` checks received envelope hashes before authoring
import; `verifyRunBundle` additionally requires executable resolved v10 or
v11 and the existing resource/backend contracts. Historical resolved v1–v9
can use the existing legacy import verifier only where their hashes match its
algorithm; otherwise they fail explicitly. No historical verifier is inferred.

New resolutions always produce v11, including resolutions of imported older
authoring documents. v10 bundles without an identity selector keep semantic
and episode v1 algorithms. Missing/unknown v11 selectors and selectors on
legacy bundles fail. `SIMULATION_HASH_VERSION`, metric-world, legacy analytic
provider, backend/profile presets, and trajectory algorithms remain unchanged.
The normalized resolved hash keeps its historical metadata and six-decimal
rules; the v11 envelope and semantic/episode v2 domains intentionally change
new run identities. Evidence exclusions apply at named envelope/dependency
locations, not inside arbitrary script inputs.

`verifyRunBundleBytes(bytes, { expectedBundleBytesHash, execution })` preserves
received bytes and optionally verifies an external exact digest before parsing.
It rejects invalid UTF-8, BOMs, duplicate keys, non-finite values, and invalid
Unicode. v11 counters use safe numeric integers; large headless uint64 values
continue to use their existing string representation. `runBundleBytes` returns
retained received bytes, or an explicit serialization for an object input.
`canonicalRunBundleStringify` preserves the historical serializer for v10 and
uses exact JCS for v11. Canonical wire bytes and original pretty-printed file
bytes can have different digests without changing normalized run identity.
Neither byte digest is inserted into its own bundle.

Python discovers capabilities with protocol 1.2, then negotiates up to 1.4.
Legacy bundles still work with 1.2 supervisors. A v11 request requires both
protocol 1.3 and `world-bound@2` before batch creation; the JavaScript
supervisor remains the authoritative semantic verifier. No protobuf field
numbers or EpisodeSpec fields changed in VIS-12a or VIS-13b.

For environment v3, a display-only rename retains a visual binding only if the
recomputed world hash is equal. Duplication, environment-ID changes, and
conflict-renamed imports create a new descriptor bound to the new world;
compatible bytes may be shared, but correspondence evidence is invalidated.
Conflicting imports rebind only when the referenced descriptor is already in
the local descriptor store; otherwise import fails explicitly. Every v3 full
write requires `{ manifest, expectedRevision }`. Missing or stale revisions
return HTTP 409 with `ENVIRONMENT_REVISION_CONFLICT` and `currentRevision`.
Optional `detachStaleVisual: true` is required to save a metric edit that
changes `worldHash` while a visual layer is bound: the server retains the last
trusted bake-reuse candidate, then clears `visualLayer` and evidence. Without
the flag the write fails closed with `VISUAL_LAYER_WORLD_MISMATCH`. Environment
`visualLayer` may include additive `accessHash` and `bakeReuseManifestHash`
pointers; neither enters `worldHash` or the descriptor's `visualLayerHash`.
VIS-10b material-proposal hashes are stored in artifact-set v3 and durable bake
promotion receipts, not in the environment manifest or correspondence evidence.
VIS-11 model-output-set, provider, weights, and raw-cache identities likewise
stay out of `visualLayerHash`, world, semantic, and episode identity.
`sourceWorldHash` binds the promoted layer to the current metric world and does
not enter per-unit reuse keys. An older client cannot erase visual fields by omitting them, and cannot use
`clientRevision` as a concurrency token.
Explicit server `null` visual/evidence fields do clear local references. Client
autosave tracks edit generations independently from request generations, so an
edit made during a save remains dirty. Suspension blocks debounce, manual,
hide, and unload entry points, drains the current request, and explicitly
resumes pending work. Strict promotion flushes retain any joined autosave
failure, and responses or receipts from another environment or an older
revision are never adopted.

## Source policy

Rights are evaluated from a trusted local operator registry injected into
`evaluateVisualSourcePolicy`. Asset or package metadata cannot self-attest
ownership. Callers also inject the evaluation time, keeping the evaluator
deterministic and free of wall-clock access. Each selected source and every ancestor must be active, within its
validity window, and explicitly allow each requested operation:

- display and live preview display
- transient and persistent cache
- derivatives and machine interpretation
- ML processing and worker access
- redistribution/export
- retention and attribution

Permissions intersect across ancestry. Deduplication, repackaging, and cached
derivatives do not remove an ancestor restriction. The evaluator returns
stable denial codes plus combined attribution, retention, and other
obligations.

Unknown, missing, expired, revoked, or insufficient records fail closed.
Google-derived sources deny sensor use, baking, persistence, machine
interpretation, ML, worker access, and export unless the trusted registry
contains a reviewed operation-specific grant. Live human preview remains a
separate permission. VIS-04 enforces these rules at visual-asset upload,
content access, closure validation, and internal root/pin acquisition.
Enforcement at bake and promotion lands in their owning later milestones.
VIS-13b re-evaluates admission rights and byte integrity at admission, batch
pin acquisition, and worker recovery. VIS-13a re-evaluates `export` on package
export and `persistent-cache`, `machine-interpretation`, and `retention` on
authoring-store package import.

## Deterministic run packages

`cev-sim.run-package@1` is an uncompressed USTAR archive. VIS-13a implements
the codec, hostile verification, and authoring-store export/import. Entries are:

1. `manifest.json`
2. Exact received `bundle.json` bytes
3. `assets/sha256/<digest>` entries in UTF-8 digest order

The canonical package manifest is exact JCS without a trailing newline:

- `{ kind: "cev-sim.run-package", version: 1 }`
- `bundle: { sha256, sizeBytes }` for the archived `bundle.json` bytes
- digest-sorted `assets: [{ sha256, mediaType, sizeBytes, role }]`

The asset list is the complete selected render-scene closure, cross-checked
against source-use evidence. Descriptor and evidence documents travel inside
`bundle.json`, not as extra archive entries. The USTAR profile permits regular
files only, mode `0644`, UID/GID and mtime zero, empty owner/group names,
canonical numeric fields, zero padding, and exactly two terminal zero blocks.
It rejects compression, additional or duplicate entries, alternate/PAX/GNU
headers, absolute/parent/encoded traversal, backslashes, case/Unicode
collisions, links, devices, sparse entries, oversized entries, excessive
counts, truncation, expansion attempts, and trailing content. Verification
streams into an untrusted generated staging directory and never uses archive
paths as extraction destinations.

Hard ceilings are 8 GiB per archive, 1 GiB per asset, 32 MiB per bundle,
4 MiB per package manifest, and 16,384 assets. Static asset validation also
limits graph depth to 64, nodes to 100,000 per mesh, triangles to 4,000,000 per
mesh, texture dimensions to 8192, and mip levels to 14. Deployments may set
lower limits. VIS-13a also bounds temporary bytes, staging inodes, concurrent
verifications, and verification time.

`packageManifestHash` and the final `archiveHash` are external to the manifest
to avoid self-reference. These exact digests are distinct from normalized
`resolvedHash` and `simulationSemanticHash`. Received legacy or pretty bundle
bytes are preserved; the parsed document is verified separately without
rewriting archived bytes.

Authoring export requires current `export` permission and holds an export pin
for the lifetime of its returned archive stream; production export never
retains complete archive or asset buffers.
Authoring import requires current `persistent-cache`, `machine-interpretation`,
and `retention` permissions. The authoring document and durable package root
are published only after every archive entry succeeds. Immutable unreferenced
CAS bytes may remain after a late failure because published deletion stays
disabled. Package import is storage/authoring functionality only.

Protocol 1.4 admission implements this same-host flow:

1. CLI or Python publishes a package under an opaque staging ID into a
   configured supervisor inbox using temp-file, file fsync, atomic rename, and
   directory fsync ordering.
2. The supervisor atomically consumes a regular single-link inbox file and
   independently verifies archive profile/hash, source permissions, exact
   bundle bytes, full closure, known provider/profile, static assets, and limits.
3. It returns an opaque `AssetAdmissionRef { handle, bundle_bytes_hash }` and
   pins the read-only digest view.
4. `CreateBatch` requires handle, archived exact-byte digest, and canonical
   wire JSON to agree. The canonical wire digest is not compared to the exact
   archived-byte digest. Paths, handles, and roots remain operational and
   outside episode identity.
5. Workers receive scoped digest access. Reset candidates, queued work,
   renderer restart, and replay retain pins until access has ended.

CLI `inspect`, `validate`, `run`, and supervisor-backed `replay` accept package
inputs. Python exposes `load_run_package`, context-managed `AssetAdmission`,
and same-host stage/admit/release while retaining ordinary JSON bundle use.
Older, TCP, and non-admission supervisors fail before Python staging. JSON-only
commands remain supported. Rights-valid PBR packages may be admitted, but
`CreateBatch` rejects their unavailable renderer before worker creation.

Durable roots include environments, promoted descriptors, retained package
imports, queued bundles, retained results/replays/baselines, bake inputs and
outputs, and evidence reports. Active workers, reset candidates, validation,
bakes, promotions, and exports hold pins. New roots are durable before old
roots are released. Startup reconciles durable roots, pins, admissions, and
abandoned staging. Published asset deletion stays disabled until the complete
root/pin protocol and its races are implemented and tested.

The installed runtime must eventually contain renderer pages, workers, shared
helpers, decoder/transcoder JavaScript and WASM, and license notices for
offline execution. Scene and model data remain in run packages or other
verified artifacts, not in the runtime tarball. VIS-15c owns the final delivery
choice and size ceiling.
