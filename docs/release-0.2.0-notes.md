# 0.2.0 Alpha release checklist

Use this checklist after the software packages land on `main`. Do **not** create
the `v0.2.0` tag or GitHub prerelease until every mandatory evidence item below
is green. Registry publication stays disabled.

## Software packages (implemented)

- [x] PKG-01 runtime version authority (`app/version.js`, release-coupled defaults)
- [x] PKG-02 plugin/marketplace engine-range migration
- [x] PKG-03 coordinated `0.2.0` artifacts and tag-capable `install.sh --ref`
- [x] PKG-04 CI editor fixture + internal-candidate Playwright jobs
- [x] CHANGELOG, README, getting-started, headless-release, plugin-api, python-headless

## Mandatory candidate evidence (still required)

- [ ] Hosted macOS/Linux parity aggregation on CI for the release commit
- [ ] Manual **Internal headless candidate** workflow on `main` (soak, benchmark,
      dist verify, versioned artifact upload)
- [ ] Internal-candidate **production-browser** job (`test:ui`, `test:a11y`)
- [ ] Dedicated x64 NVIDIA rendered-sensor report
- [ ] Dedicated Jetson ARM64 rendered-sensor report
- [ ] Record digests/runner identities in `docs/headless-release.md` and the
      headless decision log

## Local evidence already recorded (2026-10-03, macOS ARM64)

- All-language parity (`artifacts/parity-local-020.json`)
- Quick soak (`artifacts/headless-soak-quick-020.json`) — not full 1/8/16/32
- `dist:headless` → `cev-sim-0.2.0` npm/Python artifacts + manifest v11
- `release:check --dist` and `artifacts:install --verify-only`
- Lint zero errors; characterization and editor fixtures regenerates clean

## Publish steps (after evidence)

```bash
# from the exact release commit
npm run lint && npm test && npm run release:check
npm run dist:headless -- --output artifacts/headless
npm run release:check -- --dist artifacts/headless
npm run dist:verify -- --dist artifacts/headless   # requires Node >=22.22.2

git tag -a v0.2.0 -m "cev-sim 0.2.0 Alpha"
git push origin v0.2.0

gh release create v0.2.0 \
  --prerelease \
  --title "0.2.0 Alpha" \
  --notes-file CHANGELOG.md \
  artifacts/headless/cev-sim-0.2.0.tgz \
  artifacts/headless/cev_sim-0.2.0-py3-none-any.whl \
  artifacts/headless/cev_sim-0.2.0.tar.gz \
  artifacts/headless/release-manifest.json \
  artifacts/headless/SHA256SUMS
```

Installers should use `--ref v0.2.0`, not moving `main`.
