# Vehicle manifests

Custom vehicles are defined by saved `cev-sim.vehicle` documents. Version 2 is the default writer. Version 1 documents still load and migrate to version 2, including the permissive actuator defaults used by recorded replays. Version 3 is an explicit authoring migration. Built-in projections stay version 2. A blank created through publication is version 3. Each manifest is a single human-editable JSON file stored at `server/data/vehicles/<id>.json`, and the vehicle's 3D model lives next to it under `server/data/vehicle-assets/<id>/`. Staged uploads, publication journals, receipts, marketplace intake, and the pre-migration snapshot live outside those two directories. The manifest id doubles as the vehicle `type` string used by run manifests, so a run's initial state can reference custom vehicles the same way it references `big-car`, `igvc-car`, or `scenario-car`.

## Authoring workflow

Open **Vehicle Editor** from the workspace switcher (3D group). The page supports catalog create, duplicate, delete, bundle import/export, a live 3D viewport with gizmo editing, structured field editing, and raw JSON editing with validation. Saves use optimistic revisions, matching run manifests.

Editing areas:

- **Model**: upload a `.glb`/`.gltf`, then place it in the vehicle frame with scale, rotation, and offset. "Fit to size" rescales the model so its footprint matches a target length and width in meters.
- **LiDAR zone**: generates the reduced-polygon collision mesh that LiDAR and other GPU sensors raycast against. Generation runs the voxel-clustering simplifier (`TriangleOptimizer`) over the placed model and bakes the resulting vertex and triangle arrays into the manifest. Larger voxel sizes produce fewer triangles.
- **Sensors**: 3D LiDAR, camera, and catalog plugin range-image templates with vehicle-local poses and per-type configuration. Plugin sensors are authoring templates and previews; they do not execute from the vehicle document. A run configuration can opt in, from its Sensors tab, to inherit these mounts. Inherited pose and vehicle calibration stay locked to this document. Rate, noise, topics, and other run settings stay editable on the run.
- **Wheels**: wheel positions, radius, width, and steerable flags. The bicycle-model wheelbase is derived from steerable vs. fixed wheel placement unless overridden.
- **Body**: the bounding box (drives the physics AABB via `collisionDimensions`) and the ego center marker.

## Document shape

```json
{
    "kind": "cev-sim.vehicle",
    "version": 2,
    "id": "my-truck",
    "name": "My Truck",
    "description": "",
    "model": {
        "asset": "model.glb",
        "scale": 0.0015,
        "rotation": { "x": -1.5708, "y": 0, "z": 3.1416, "order": "XYZ" },
        "offset": { "x": 0, "y": 0.15, "z": 0 }
    },
    "boundingBox": {
        "size": { "x": 2.7, "y": 1.4, "z": 1.25 },
        "center": { "x": 0, "y": 0.7, "z": 0 }
    },
    "egoCenter": { "x": 0, "y": 0.5, "z": 0 },
    "wheels": [
        { "id": "front-left", "position": { "x": 0.75, "y": 0.25, "z": 0.55 }, "radius": 0.25, "width": 0.15, "steerable": true }
    ],
    "kinematics": { "wheelbase": 1.5, "maxSteeringAngle": 0.6 },
    "sensors": [
        {
            "id": "roof-lidar",
            "type": "lidar3d",
            "pose": { "position": { "x": 0.35, "y": 0.8, "z": 0 }, "rotation": { "x": 0, "y": 0, "z": 0, "order": "XYZ" } },
            "config": { "range": 20, "thetaStep": 2, "thetaRange": [-180, 180], "phiStep": 1, "phiRange": [-20, 20] }
        }
    ],
    "lidarZone": {
        "params": { "voxelSize": 0.2 },
        "vertices": [[0.1, 0.2, 0.3]],
        "triangles": [[0, 1, 2]]
    }
}
```

Conventions: all lengths are meters and angles radians, in the vehicle-local frame (`+X` forward, `+Y` up, `+Z` left, matching the built-in cars). `model.asset` is a file name resolved against `/api/storage/vehicle-assets/<vehicleId>/`. `lidarZone.vertices` is an array of `[x, y, z]` triples and `lidarZone.triangles` indexes into it; both are baked by the editor and regenerable from `params`.

## Versions

Version 1 and version 2 normalize to the version 2 shape above. That shape has no `model.dependencies`, `model.hiddenNodeIndices`, wheel `axle`, wheel `side`, or wheel `visual`. Built-in projections of `big-car`, `igvc-car`, and `scenario-car` are pinned to version 2, so opening, duplicating, or displaying them does not add axle roles or change their resolved hashes. `createDefaultVehicleManifest()` stays version 2. A blank created through publication uses `createBlankVehicleManifest()`, which is version 3 with empty dependency and hidden-node lists and unclassified wheels. Its definition hash is `54025fcb83fb359f6e60cb8c86c7107f717274b4d36afddf36e7c7767b05a47e`.

Version 3 adds:

- `model.dependencies`: sorted unique sibling filenames for the canonical model closure. Empty when `model.asset` is null. A canonical closure names the model `<sha256>.glb` and each image `<sha256>.png`, `<sha256>.jpg`, or `<sha256>.ktx2`. Those image filenames are the URIs inside the GLB. Geometry buffers are packed into the GLB BIN chunk. The editor's legacy single-file upload remains until the studio publishes through a stage.
- `model.hiddenNodeIndices`: sorted unique source node indices whose subtrees are hidden. Empty on a model-free vehicle.
- Optional wheel `axle` (`front` or `rear`) and `side` (`left` or `right`, with `+Z` left). Both are omitted on an unclassified wheel.
- Optional wheel `visual: { kind: "model-node", nodeIndex }` when that wheel is bound to a source node. The display name comes from the model, not from a second stored name.

Version 3 geometric scalars — model placement, body bounds, wheel position, radius, width, wheelbase, and maximum steering angle — are stored at six decimal places. Actuator speed, acceleration, jerk, steering rate, and delay keep the existing coercion. A standard axle is one left/right pair with shared X, Y, radius, width, and steerability, and mirrored Z. Front wheels steer and rear wheels are fixed. A complete front and rear layout, with no unclassified wheels, must store `kinematics.wheelbase` as the distance between the axle X positions. Normalization does not average a pair or overwrite that wheelbase; validation reports the mismatch instead. A partial layout or any unclassified wheel keeps the authored wheelbase.

`planVehicleMigration()` proposes a version 3 draft, an asset plan, diagnostics, and the field changes. It does not write the vehicle. A layout whose derived wheelbase differs from the stored value, such as BigCar's 1.2446 m wheels at ±0.75 m (derived 1.5 m), stays blocked until that motion change is acknowledged. External model URLs stay blocked until a local package is selected. Saving a version 2 document over a stored version 3 document is rejected so a legacy writer cannot drop the version 3 fields. `POST /vehicles/:id/migrate` publishes an already validated candidate. The pre-migration snapshot is written once to `vehicle-migrations/<id>.pre-v3.json` only after that manifest write is durable. The snapshot is the manifest plus sha256 hex of the asset files and is not part of the vehicle hash. Superseded asset files remain in the vehicle asset directory, so a committed migration's resolved hash includes both the new closure and those older files.

## URDF

`planUrdfImport()` reads a local URDF package and does not write a vehicle. `acceptUrdfImport()` copies the baked model, body box, and wheel geometry only when `acceptAdjustments` is true. The rest pose is stored as a canonical GLB in the vehicle frame. Collision bounds define the body box when the URDF has them. A complete front and rear pair sets `kinematics.wheelbase`. Steering joints that do not already share one positive symmetric limit stay blocked until the caller supplies `maxSteeringAngle`. Accepted geometry uses the existing version 3 model, wheel, and kinematics fields; URDF provenance is not stored and does not enter the vehicle hash. Export writes an articulated URDF. Bound wheels become their own links, unbound wheels become cylinders, and revolute `effort` and `velocity` are `0` placeholders. Inertia, sensors, the LiDAR zone, plugin locks, and `dynamics.plant` are omitted from that file and listed in the export report.

`POST /api/storage/vehicle-urdf/github/inspect` and `fetch` resolve a public GitHub repository, tree, blob, or raw URL to one commit and return the same package shape. Fetch file bytes are canonical base64. Those routes do not create a vehicle or publish assets. The returned `source` records the repository, commit SHA, tree SHA, and license for review. That provenance is not part of the vehicle hash.

## Runtime behavior

`VehicleDatabase.configureFromManifest` spawns any non-built-in `type` as a `ManifestVehicle` by loading the matching vehicle manifest from storage. A `ManifestVehicle`:

- loads and places the GLTF model (or renders a placeholder body when no asset is set),
- renders a version 3 wheel bound to a model node on a pivot at the accepted wheel center, keeping the source mesh's placed pose; unbound wheels stay cylinders. A complete version 3 front axle uses the ideal inner and outer yaw for its two wheels. Every other steerable pivot, including version 2 and an unclassified or singular layout, tracks the shared steering angle. The plant still integrates `kinematics.wheelbase`,
- measures wheel assignment from the decoded canonical GLB before hiding or reparenting any node; publication repeats that measurement and rejects a binding that is outside pair tolerance or does not reproduce the measured proposal,
- drives planar bicycle kinematics from `kinematics.wheelbase`, like `BigCar`, then drapes pose Y/pitch onto the paved road surface,
- exposes `collisionDimensions` from `boundingBox.size` so the physics engine sweeps the correct AABB,
- instantiates the manifest sensors as devices,
- registers `lidarZone` triangles in the GPU object database and rewrites their texture slots whenever the vehicle pose changes, so the collidable zone follows the vehicle.

## HTTP API

Under `/api/storage`:

- `GET|POST /vehicles`
- `GET|PUT|DELETE /vehicles/:id`
- `POST /vehicles/:id/duplicate`
- `POST /vehicles/:id/migrate`
- `POST /vehicles/:id/validate`
- `GET /vehicles/:id/export`
- `POST /vehicles/import`
- `POST /vehicle-stages`, `POST /vehicle-stages/:id/renew`, `DELETE /vehicle-stages/:id`
- `GET|PUT /vehicle-stages/:id/members/:name` (raw bytes; the response reports the server digest)
- `GET|PUT|DELETE /vehicle-assets/:id/:file` (raw binary model assets)

`POST /vehicles` and `PUT /vehicles/:id` accept an optional `stageId` and a 64-hex `operationId`. Import, duplicate, and migrate accept `operationId` the same way. Those ids, stage leases, publication journals, and receipts are not part of the vehicle or run hash. A repeated `operationId` returns the first committed manifest. A failed publication removes only asset files that publication introduced.

`PUT /vehicles/:id` accepts `{ manifest, expectedRevision }` with the same optimistic-revision conflict behavior as run manifests. Optional `pluginLocks` pin `{ pluginId, version, packageHash, runtimeHash, sensorTypes[], plants[]? }` and are omitted when empty. Empty `plants` is omitted. Optional `dynamics: { plant }` selects a plugin plant; omitted dynamics keep the built-in JavaScript bicycle. Export produces a `cev-sim.vehicle-bundle` version 1 document embedding the manifest, model assets as base64, and—when locks exist—sorted exact `pluginPackages`. Legacy bundles without `pluginPackages` keep their existing hash projection. Import verifies embedded packages into CAS without adding library membership, suffixing the id when it collides with an existing vehicle.
