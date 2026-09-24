# Camera clips

Headless Runs can render one camera from a saved run manifest to paired RGB
and depth. This is maintenance on the completed headless roadmap. It does not
change `headless.proto`.

## Request

`POST /api/headless/clips/preflight` and `POST /api/headless/clips` take:

```json
{
  "profile": "environment",
  "manifestId": "untitled-run-3",
  "expectedManifestRevision": 4,
  "camera": { "kind": "manifest", "cameraId": "front-camera" },
  "renderer": "pbr",
  "durationNs": 4000000000,
  "width": 1280,
  "height": 720,
  "actionTape": null
}
```

`profile: "environment"` defaults to 4 seconds, 1280×720, the camera's
authored rate, and `pbr-mesh@1`. `profile: "cosmos-nano"` locks the Cosmos
contract: `stepNs` 11111111, 363 steps, 1280×720, 30 Hz, 121 frames, zero
camera noise and distortion, and RGB, depth, and CameraInfo only.

A viewport camera uses `kind: "viewport"`. `attachment: "map"` is fixed in the
world. `attachment: "vehicle"` also requires `parentId` and follows that
vehicle. The editor environment must be the manifest environment.

`GET /api/headless/clips/preflight` and `POST /api/headless/clips` with `{}`
remain the analytic corridor described in [cosmos-clip.md](cosmos-clip.md).

## Control

Reference manifests keep their scenario controller. Candidate manifests
require a `cev-sim.headless.policy-action-tape` version 1 tape with exactly
the derived episode's actions and no `episodeSpec`. The server stores the
tape hash in `status.json` and does not store the tape.

A stale `expectedManifestRevision`, an active GPU job, or another clip
returns 409.

## Products

`cev-sim.camera-clip` version 1 writes `rgb.mp4`, a near-white to far-black
`depth.mp4`, metric little-endian `depth.f32`, `camera_info.json`,
`frames.jsonl`, and `clip.json`. MP4 timing is constant frame rate at the
authored nominal rate. `frames.jsonl` keeps the simulation timestamps. A
scenario may finish before the requested duration; the clip records both.

`cev-sim.cosmos-clip` version 2 uses the same media checks as version 1.
Analytic rendering requires GPU backend v1. PBR requires `pbr-mesh@1` and
routed GPU backend v2. Cosmos depth video keeps the existing Nano mapping.

PBR uses the resolved visual layer and a run package admitted for that clip.
It does not fall back to analytic rendering.
