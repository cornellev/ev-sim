# Visual layer contracts

This document freezes the VIS-01 contracts. It describes interfaces that
later VIS milestones implement. VIS-12a activates the identity contracts below;
VIS-02 dispatches exact camera render provider ID/version. Photoreal rendering,
the asset store, and package admission remain unavailable.

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
| Identity negotiation | Protocol 1.3 | VIS-12a |
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
closed asset set. Dependencies discovered inside GLB/glTF are checked against
the same set during later bounded asset validation. URLs and filesystem paths
are not resource identities. Chunks and instances bind each other explicitly. A visual-to-truth
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
The restricted profile is stricter than a general glTF loader: later asset
validation must reject every unknown required extension and every uncontrolled
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

Supported distortion is `none`, five-coefficient Brown-Conrady
`[k1,k2,p1,p2,k3]`, or eight-coefficient rational Brown-Conrady
`[k1,k2,p1,p2,k3,k4,k5,k6]`. Output generation inverse-maps destination
pixels with a bounded iteration count. Nonconvergence and samples outside the
source image are invalid. RGB uses linear interpolation; depth, validity, and
integer labels use nearest sampling to preserve discontinuities.

| Product | Representation |
| --- | --- |
| Measured image | RGBA8, sRGB transfer, top-left rows |
| Visual/analytic depth | little-endian Float32 axial optical depth in meters |
| Geometric normal | little-endian Float32 XYZ in world coordinates |
| World position | little-endian Float32 XYZ in world meters |
| Confidence | little-endian Float32 |
| Semantic/material/instance IDs | little-endian Uint32 |
| Invalid/no hit | zero values plus an explicit validity mask |

Geometric G-buffer normals remain separate from shading normals. Beauty and
visual G-buffers use identical geometry, visibility, alpha cutoff, calibration,
and sample time. Analytic oracle passes use immutable truth twins. Preview,
measured appearance, analytic truth, and frozen bake snapshots have separate
scene ownership; imported `extras` or `userData` never register truth.

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
Every v3 full write and visual promotion requires an expected server revision.
An older client cannot erase visual fields by omitting them.

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
separate permission. Enforcement at import, bake, promotion, package,
admission, and worker recovery lands in the owning later milestones.

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
