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
compatibility mode.
VIS-16a adds strict visual-evaluation, correspondence-report, threshold-profile,
and admission contracts with synthetic boundary fixtures. It does not run a
validator or activate managed visual execution.
Photoreal `pbr-mesh@1` rendering,
corrected GPU backend v2, measured PBR cameras, and package admission remain
unavailable.

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
| PBR scene | `pbr-mesh@1` | VIS-02 known/unavailable; runtime VIS-05/VIS-14/VIS-15 |
| Corrected GPU sensor backend | `chromium-webgl2-rendered-sensors@2` | VIS-14/VIS-15 |
| Visual camera calibration | `cev-sim.visual-camera-calibration@1` | VIS-06a internal opt-in; provider activation VIS-14/VIS-15 |
| Immutable visual capture input | `cev-sim.visual-capture-input@1` | VIS-06a internal opt-in |
| Aligned capture pass set | `cev-sim.visual-capture-pass-set@1` | VIS-06b internal opt-in; VIS-07 version-1 bake jobs |
| Bake run config | `cev-sim.bake-run-config@1` / `@2` | VIS-07 catalog; VIS-08/VIS-10a persistent no-model jobs |
| Bake source snapshot | `cev-sim.bake-source-snapshot@1` | VIS-07 `static-snapshot@1` |
| Bake capture plan | `cev-sim.bake-capture-plan@1` | VIS-07 |
| Bake provider request | `cev-sim.bake-provider-request@1` | VIS-07 |
| Bake provider response | `cev-sim.bake-provider-response@1` | VIS-07 local `captured-appearance@1` |
| Bake job status | `cev-sim.bake-job-status@1` | VIS-07 mutable status |
| Bake construction | `cev-sim.bake-construction@1` | VIS-10a hashed atlas/projected policy |
| Bake artifact set | `cev-sim.bake-artifact-set@1` / `@2` | VIS-08 projected records; VIS-10a chunk/page records |
| Bake atlas manifest | `cev-sim.bake-atlas-manifest@1` | VIS-10a appearance-dependency buffer |
| Bake atlas contribution | `cev-sim.bake-atlas-contribution@1` | VIS-10a sparse reuse codec |
| Bake reuse manifest | `cev-sim.bake-reuse-manifest@1` / `@2` | VIS-09 fragments; VIS-10a contributions and chunk hashes |
| Bake reuse report | `cev-sim.bake-reuse-report@1` | VIS-09 audit evidence only |
| Visual evaluation input | `cev-sim.visual-evaluation-input@1` | VIS-16a contract only |
| Visual correspondence report | `cev-sim.visual-correspondence-report@1` | VIS-16a diagnostic/synthetic evidence only |
| Visual threshold profile | `cev-sim.visual-threshold-profile@1` | VIS-16a synthetic profiles; production registry empty |
| Visual evidence admission | contract-level checker | VIS-16a; managed execution integration VIS-16b |
| Identity negotiation | Protocol 1.3 | VIS-12a |
| Environment schema | 3 | VIS-03 |
| Package admission | Protocol 1.4 | VIS-13b |

The current runtime advertises protocol 1.3 and `identity_profiles: ["world-bound@2"]`.
Package admission remains inactive: `asset_admission_profiles` is empty and
the protocol 1.4 RPCs remain unimplemented. Unknown required versions, profiles,
providers, products, or extensions fail explicitly.

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
whole staged preview. Archive extraction and USTAR admission remain unavailable
until VIS-13a supplies their separate hostile-input gate.

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
`canonical-analytic@1` only during resolution. `canonical-analytic@2` and
`pbr-mesh@1` may be authored when structurally valid, but they remain
unavailable and never fall back to analytic.

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
root. VIS-14 and VIS-15
own resolved-provider browser/headless routing.

`app/3d/environment/visual/BakeRunCatalog.js` is Three/DOM-free. Version-1 jobs
hash `recipeHash` (pixel-affecting config), `snapshotHash` (frozen world,
revision, generation, appearance, and resource closure), `planHash` (canonical
views and samples), `requestHash` (provider options plus exact captured-buffer
digests), and `responseHash` (output digests and provenance). Job IDs,
timestamps, progress, logs, and failures never enter those hashes. The default
provider is local `captured-appearance@1`: no model capability, no network, and
identity references to aligned capture products. External providers are
injectable but unavailable unless a later adapter registers them. Detached
`bake-snapshot` scenes clone transforms/materials/visibility/lighting, share
geometry and textures only through read-only leases, and never wrap the live
preview root. The editor `b` key runs `BakeHarness.runPersistentPromotion()`:
reserve a generation, compare per-unit dependency keys, capture only
invalidated units (beauty, world position, geometric normal, confidence, and
validity for atlas jobs), convert captures to sparse contributions, rebuild
dirty atlas chunks, commit a new layer or a revision-free no-op, and
rematerialize preview. Legacy `BakeHarness.start()` remains only for explicit
`legacyBake=1` / `createLegacyCompatibleBakeRunConfig`.

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
visuals. `pbr-mesh@1` remains unavailable.

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
   to `canonical-analytic@1`. Selected visual resource resolution belongs to
   VIS-12b. Unavailable providers may be stored but cannot resolve or execute.
6. Include selected render resources, calibration, product policy, and
   semantic backend configuration. Exclude evidence, logging, artifact and
   resource policy, wall pacing, host paths, admissions, and replay evidence.

Compatibility is evaluated separately at each boundary:

| Input | Byte/hash verification | Authoring import | Execution |
| --- | --- | --- | --- |
| Bundle v1 / resolved v10 | Preserve received bytes and existing algorithms | Supported | Existing analytic path remains supported |
| Older authored manifests | N/A unless a historical bundle verifier exists | Normalize and re-resolve | Only through a newly resolved supported bundle |
| Bundle v1 / manifest v11 / `world-bound@2` | New version-dispatched algorithms | Supported | Protocol 1.3 and advertised identity profile required |
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

Python discovers capabilities with protocol 1.2, then negotiates up to 1.3.
Legacy bundles still work with 1.2 supervisors. A v11 request requires both
protocol 1.3 and `world-bound@2` before batch creation; the JavaScript
supervisor remains the authoritative semantic verifier. No protobuf field
numbers or EpisodeSpec fields changed in VIS-12a.

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
Enforcement at import, bake, promotion, package, admission, and worker recovery
lands in the owning later milestones.

## Deterministic run packages

`cev-sim.run-package@1` is an uncompressed USTAR archive. Entries are:

1. `manifest.json`
2. Exact received `bundle.json` bytes
3. `assets/sha256/<digest>` entries in UTF-8 digest order

The asset list includes the complete selected scene closure and referenced
descriptor/evidence objects. The USTAR profile permits regular files only,
mode `0644`, UID/GID and mtime zero, empty owner/group names, zero padding,
and exactly two terminal zero blocks. It rejects compression, additional or
duplicate entries, alternate headers, absolute/parent/encoded traversal,
noncanonical separators, name collisions, links, devices, sparse entries,
and trailing content.

Hard ceilings are 8 GiB per archive, 1 GiB per asset, 32 MiB per bundle,
4 MiB per package manifest, and 16,384 assets. Static asset validation also
limits graph depth to 64, nodes to 100,000 per mesh, triangles to 4,000,000 per
mesh, texture dimensions to 8192, and mip levels to 14. Deployments may set
lower limits. Later implementations must additionally bound aggregate
decoded CPU/GPU memory, concurrency, temporary bytes, and validation time.

The package manifest records `bundleBytesHash` and every asset digest. Its own
`packageManifestHash` and the final `archiveHash` are external to the manifest
to avoid self-reference. These exact digests are distinct from normalized
`resolvedHash` and `simulationSemanticHash`.

Protocol 1.4 admission follows this same-host flow:

1. CLI or Python publishes a package under an opaque staging ID into a
   configured supervisor inbox using temp-file, file fsync, atomic rename, and
   directory fsync ordering.
2. The supervisor independently verifies archive profile, source permissions,
   exact bytes, full closure, provider support, and resource limits.
3. It returns an opaque `AssetAdmissionRef { handle, bundle_bytes_hash }` and
   pins the read-only digest view.
4. `CreateBatch` binds that admission to matching canonical bundle JSON. Paths,
   handles, and roots remain operational and outside episode identity.
5. Workers receive scoped digest access. Reset candidates, queued work,
   renderer restart, and replay retain pins until access has ended.

CLI `inspect`, `validate`, `run`, and supervisor-backed `replay` will accept
package inputs after VIS-13b. Python will expose same-host stage/admit/release
helpers while retaining ordinary JSON bundle use. Older supervisors return an
explicit compatibility error for package inputs. JSON-only commands remain
supported.

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
