# Cosmos 3 Nano transfer clip

A finalized headless analytic run can be exported to one clip directory for a
later Cosmos 3 Nano transfer. The simulator writes paired RGB and depth
frames. Encoding and validation happen after the episode is finalized.

## Handoff files

`rgb.mp4` is the reference video.

`depth.mp4` is the Nano depth `control_path`.

`depth.f32` is the metric axial depth. The MP4 is only a visualization.

The geometry is 1280×720, 121 frames, at 30 fps.

A future JSON caption is supplied separately. This repository does not create
that caption.

Generation runs on a separate workstation or datacenter GPU through Cosmos
Framework or vLLM-Omni. This repository does not run a Cosmos command, NIM
client, prompt processor, or generated-output importer.

## Export

```text
python -m cev_sim.cosmos_clip export \
  --run-output <headless-output-directory> \
  --camera-id front-camera \
  --window-index 0 \
  --output-root <clips-directory>
```

```text
python -m cev_sim.cosmos_clip check <clip-directory>
```

The reference run is manifest `cosmos-nano-clip` in environment
`corridor-acceptance`. It uses one analytic front camera, a 2 m/s verified
straight route, and a lead vehicle about 13 m ahead.
