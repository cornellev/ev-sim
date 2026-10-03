# Changelog

All notable changes to cev-sim / ev-sim are documented here. The product remains
**Alpha** while the SemVer line is `0.x`.

## [0.2.0] — 2026-10-03 (Alpha)

### Guarantees

- Coordinated product version `0.2.0` across npm (`cev-sim`), Python (`cev-sim`),
  agent `plugin.json`, MCP advertisement, and `app/version.js`.
- Headless protocol **1.4**, run manifest **v11**, run bundle **v1**, SFLog **v1**,
  and byte-stable PR 1 characterization fixture (unchanged from 0.1.0 contracts).
- Deterministic shared kernel for browser and headless; analytic rendering remains
  the default.
- Internal artifacts: `cev-sim-0.2.0.tgz`, `cev_sim-0.2.0-py3-none-any.whl`,
  `cev_sim-0.2.0.tar.gz`, `release-manifest.json`, `SHA256SUMS`.
- Registry publication to npm/PyPI remains **disabled**.

### Added

- Central `CEV_SIM_VERSION` authority in `app/version.js` with `release:check`
  enforcement.
- `--version` on `cev-sim`, `cev-sim-plugin`, and `cev-mkt` / `cev-sim-marketplace`.
- Installer `--ref` for reproducible tag/branch/commit installs (`--branch` kept
  as a compatibility alias).
- CI environment-editor fixture drift gate.
- Internal-candidate production-browser Playwright UI and a11y job.
- `defaultCevSimEngineRange()` helper for 0.x next-minor scaffold and marketplace
  host defaults.

### Changed

- Plugin hosts, recording/run provenance, experiment baselines, and MCP now
  default to `CEV_SIM_VERSION` instead of hardcoded `0.1.0`.
- Startup warns for every major-zero build, not only `0.1.0`.
- Release-manifest `manifestVersion` tracks `RUN_MANIFEST_VERSION` (11).
- Bundled plugin/marketplace fixtures that must load on both 0.1 and 0.2 use
  `engines.cevSim` / `compatibility.cevSim` of `>=0.1.0 <0.3.0` (intentional
  package/runtime/resolved hash updates; `worldHash` and `uiHash` unchanged).
- New plugin scaffolds on a 0.x host emit `>=x.y.z <0.(y+1).0` instead of
  incorrectly spanning to `<1.0.0`.

### Preview (not production release claims)

- **Marketplace** workspace remains available with kill switch
  `CEV_SIM_MARKETPLACE_ENABLED=0`. MKT-15 scale/ops and full MKT-16 candidate
  acceptance are not claimed.
- **PBR / visual runtime** (`pbr-mesh@1`) remains configuration-gated. VIS-15a
  AGX, VIS-15b managed hardware, VIS-15c/16b/17 release evidence are not claimed.

### Migration

1. Install from tag `v0.2.0` once published, or from internal candidate artifacts:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/cornellev/ev-sim/v0.2.0/install.sh \
     | bash -s -- --ref v0.2.0
   ```
2. Update plugin `engines.cevSim` from `>=0.1.0 <0.2.0` to at least
   `>=0.1.0 <0.3.0` (or `>=0.2.0 <0.3.0` for 0.2-only packages). Simulator
   `0.2.0` **rejects** packages that still declare `<0.2.0`.
3. Rebuild marketplace publication drafts that relied on the old host default
   range; new non-plugin defaults follow the host next-minor range.

### Explicit non-goals

- Public npm/PyPI publish, headless PR 13, distributed scheduling, TLS/auth,
  native WebGPU dependency, Python simulation kernel, deterministic branch
  replay, MKT-15, GOOG/GS tracks, cross-GPU pixel parity.

### Candidate evidence still required before GitHub prerelease

- Hosted macOS/Linux semantic parity aggregation
- Full 1/8/16/32 soak and benchmark on the candidate workflow
- Dedicated x64 NVIDIA and Jetson ARM64 rendered-sensor reports
- Internal-candidate production-browser Playwright UI/a11y job on main

## [0.1.0] — 2026-08-31 (Alpha)

Initial coordinated alpha packaging for the headless CLI/worker and Python
Gymnasium adapter, with protocol 1.4 admission, internal distribution artifacts,
and PR 12 release gates. Hosted/hardware candidate evidence remained outstanding
at that tag line.
