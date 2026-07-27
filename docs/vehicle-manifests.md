# Vehicle manifests

Custom vehicles are defined by saved `cev-sim.vehicle` version 1 documents. Each manifest is a single human-editable JSON file stored at `server/data/vehicles/<id>.json`, and the vehicle's 3D model (a self-contained `.glb` or `.gltf`) lives next to it under `server/data/vehicle-assets/<id>/`. The manifest id doubles as the vehicle `type` string used by run manifests, so a run's initial state can reference custom vehicles the same way it references `big-car`, `igvc-car`, or `scenario-car`.

## Authoring workflow

Open **Vehicle Editor** from the workspace switcher (3D group). The page supports catalog create, duplicate, delete, bundle import/export, a live 3D viewport with gizmo editing, structured field editing, and raw JSON editing with validation. Saves use optimistic revisions, matching run manifests.

Editing areas:

- **Model**: upload a `.glb`/`.gltf`, then place it in the vehicle frame with scale, rotation, and offset. "Fit to size" rescales the model so its footprint matches a target length and width in meters.
- **LiDAR zone**: generates the reduced-polygon collision mesh that LiDAR and other GPU sensors raycast against. Generation runs the voxel-clustering simplifier (`TriangleOptimizer`) over the placed model and bakes the resulting vertex and triangle arrays into the manifest. Larger voxel sizes produce fewer triangles.
- **Sensors**: 3D LiDAR and camera sensors with vehicle-local poses and per-type configuration.
- **Wheels**: wheel positions, radius, width, and steerable flags. The bicycle-model wheelbase is derived from steerable vs. fixed wheel placement unless overridden.
- **Body**: the bounding box (drives the physics AABB via `collisionDimensions`) and the ego center marker.

## Document shape

```json
{
    "kind": "cev-sim.vehicle",
    "version": 1,
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

## Runtime behavior

`VehicleDatabase.configureFromManifest` spawns any non-built-in `type` as a `ManifestVehicle` by loading the matching vehicle manifest from storage. A `ManifestVehicle`:

- loads and places the GLTF model (or renders a placeholder body when no asset is set),
- renders wheels as cylinders, with steerable wheels visually tracking the steering angle,
- drives planar bicycle kinematics from `kinematics.wheelbase`, like `BigCar`,
- exposes `collisionDimensions` from `boundingBox.size` so the physics engine sweeps the correct AABB,
- instantiates the manifest sensors as devices,
- registers `lidarZone` triangles in the GPU object database and rewrites their texture slots whenever the vehicle pose changes, so the collidable zone follows the vehicle.

## HTTP API

Under `/api/storage`:

- `GET|POST /vehicles`
- `GET|PUT|DELETE /vehicles/:id`
- `POST /vehicles/:id/duplicate`
- `POST /vehicles/:id/validate`
- `GET /vehicles/:id/export`
- `POST /vehicles/import`
- `GET|PUT|DELETE /vehicle-assets/:id/:file` (raw binary model assets)

`PUT /vehicles/:id` accepts `{ manifest, expectedRevision }` with the same optimistic-revision conflict behavior as run manifests. Export produces a `cev-sim.vehicle-bundle` version 1 document embedding the manifest and its model assets as base64; import restores both, suffixing the id when it collides with an existing vehicle.
