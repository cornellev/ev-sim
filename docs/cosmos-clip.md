# Cosmos clip

The original Cosmos transfer clip is still the fixed analytic corridor. Camera
clips of a saved manifest are documented in [camera-clips.md](camera-clips.md).

## Corridor contract

`cev-sim.cosmos-clip` version 1 is unchanged:

- Manifest `cosmos-nano-clip`, camera `front-camera`, environment `corridor-acceptance`.
- 1280×720, 121 frames, 30 fps.
- Simulation step 11111111 ns, 363 steps, first capture at 33333333 ns.
- Analytic renderer `canonical-analytic` version 1 and GPU backend v1.
- Depth video mapping: invalid or non-positive samples are 0; otherwise
  `1 + round(254 * clamp(depth / 200, 0, 1))`.

`GET /api/headless/clips/preflight` and `POST /api/headless/clips` with an
empty body still run this corridor. The Headless Runs profile **Analytic
corridor** is that request.

## Selected manifests

`profile: "cosmos-nano"` derives the same resolution, timing, products, and
frame count from a saved manifest. The checker accepts that document as
`cev-sim.cosmos-clip` version 2. Analytic clips still require GPU backend v1.
PBR clips require `pbr-mesh@1` and routed GPU backend v2. Version 1 still
rejects a PBR renderer.

```bash
python3 -m cev_sim.cosmos_clip export --run-output <run> --output-root <clips>
python3 -m cev_sim.cosmos_clip check <clip-directory>
python3 -m cev_sim.clip export --contract cosmos-v2 --run-output <run> --output-root <clips>
```

The version 1 exporter remains `python3 -m cev_sim.cosmos_clip`. Generic
saved-environment clips use `python3 -m cev_sim.clip`.
