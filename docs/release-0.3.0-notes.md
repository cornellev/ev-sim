# 0.3.0 Alpha release checklist

Use this checklist after the software packages land on `main`. Do **not** create
the `v0.3.0` tag or GitHub prerelease until every mandatory evidence item below
is green. Registry publication stays disabled.

## Software packages (implemented)

- [x] Coordinated `0.3.0` across `app/version.js`, npm, Python, and agent `plugin.json`
- [x] In-repo simulator plugin engine-range migration (`<0.4.0`)
- [x] Plugin-enabled identity vectors refreshed; characterization tapes unchanged
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

## Publish steps (after evidence)

```bash
# from the exact release commit
npm run lint && npm test && npm run release:check
npm run dist:headless -- --output artifacts/headless
npm run release:check -- --dist artifacts/headless
npm run dist:verify -- --dist artifacts/headless   # requires Node >=22.22.2

git tag -a v0.3.0 -m "cev-sim 0.3.0 Alpha"
git push origin v0.3.0

gh release create v0.3.0 \
  --prerelease \
  --title "0.3.0 Alpha" \
  --notes-file CHANGELOG.md \
  artifacts/headless/cev-sim-0.3.0.tgz \
  artifacts/headless/cev_sim-0.3.0-py3-none-any.whl \
  artifacts/headless/cev_sim-0.3.0.tar.gz \
  artifacts/headless/release-manifest.json \
  artifacts/headless/SHA256SUMS
```

Installers should use `--ref v0.3.0`, not moving `main`.
