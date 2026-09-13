# Earth creation and road import

ED-08 supports three environment creation sources: Blank, Google Earth, and
GLTF Tile. Google Earth sources stream Google Photorealistic 3D Tiles as a live
environment backdrop and can import editable OpenStreetMap roads through
Overpass. GLTF Tiles pin an immutable editor-asset revision and use the same
placement, projection, metric snapshot, and revision-update machinery as asset
instances.

The ED-08 UI is enabled with `NEXT_PUBLIC_CEV_SIM_ED08=1`. Source readers,
validation, and writer downgrade protection are active regardless of that
flag.

## Configuration

Google tiles require a Maps API key with Map Tiles API access:

```bash
# .env.local
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_key_here
NEXT_PUBLIC_CEV_SIM_ED08=1
```

Restart the development server after changing either value. OSM road fetching
uses `https://overpass-api.de/api/interpreter`; the public service requires no
key and can be retried independently of the tile session.

## Create an environment

Open the environment switcher and choose **New environment**.

- **Blank** creates empty road, building, feature, and object domains plus the
  Skybox.
- **Google Earth** accepts a rectangle no larger than 5 km per edge, selected
  highway classes, a roads toggle, and tile quality. Preview loads tiles and
  builds a detached road draft. A failed road request offers **Retry roads** or
  **Continue with tiles only**.
- **GLTF Tile** selects an immutable catalog revision or uploads a GLTF/GLB
  package, then records position, yaw, and positive scale in a `tile@2` object.

Creation prepares the complete schema-v4 manifest before sending one
`POST /api/storage/environments` request with `initialManifest`. Storage
validates the document, source contract, object graph, asset pins, and metric
snapshots under the environment write lock and commits revision 1 atomically.
The active environment changes only after that request succeeds. The proposed
ID remains stable across retries, and a lost response is reconciled with GET
before another POST.

## Import into an existing environment

Choose **Earth import** in the editor top bar. The hierarchy, inspector, and
asset panes remain mounted during the draft.

1. Draw or enter a valid rectangle and select highway classes.
2. Choose **Add roads** or **Replace roads**.
3. Preview the Google session and detached OSM road draft.
4. Resolve any issues or continue with tiles only.
5. Apply once. The source change and optional road change enter history as one
   `CommandBus` command.

**Add roads** namespaces incoming IDs by the import ID, retains existing road
nodes, edges, and turn rules, and does not connect new roads by coordinate
proximity. Adding geometry-v2 roads upgrades legacy road geometry inside the
same history entry. **Replace roads** replaces nodes, edges, and turn rules
together while retaining buildings, features, groups, and assets. Replacing
existing roads with an empty draft requires explicit confirmation. A
tiles-only Apply leaves the road domain untouched.

Changing source options, cancelling, or switching environments aborts pending
work. Async results are accepted only when both the session generation and
environment ID still match. Cancellation does not change the document version,
undo history, or autosave state.

## Georegistration correction

Legacy Earth records retain their historical Web Mercator coordinates until
the user chooses **Correct georegistration**. The preview offers:

- **Roads only**: reprojects the complete road domain. Curves are compiled with
  the committed road policy and stored as explicit polylines.
- **Whole environment**: also reprojects building footprints, features,
  asset-backed objects, and group pivots. Locked or unsupported transform
  records block the whole operation with object-specific issues.

Both scopes use one undoable command. Authored elevation, widths, building
heights, positive asset scales, IDs, and route-proof invalidation semantics are
preserved. The migration writes `document.geoFrame`, upgrades the Earth source
to v2, and retains a write-once pre-georegistration manifest on the server.

## Persisted contracts

New geographic documents use one authoritative frame:

```js
document.geoFrame = {
  version: 1,
  projection: "wgs84-local-tangent",
  axes: "east-up-south",
  origin: { lat, lng, height }
}
```

The local axes are `x = east`, `y = ellipsoid up`, and `z = south`. Missing
`geoFrame` means legacy coordinate behavior; loading an old environment never
adds one.

New Google sources use:

```js
document.earth = {
  version: 2,
  tileProvider: "google-photorealistic",
  bounds: { north, south, east, west },
  quality: {
    maxScreenSpaceError: 1,
    maxCachedTiles: 2000,
    maxCacheBytes: 1073741824
  },
  roadProvider: "overpass", // null when roads were not requested
  roadFilters: { highwayClasses: [] },
  importedLayerIds: [],
  importedAt
}
```

Unversioned Earth records remain readable without normalization. V2 obtains its
origin only from `geoFrame`; API keys, renderer objects, connection state,
attribution responses, abort controllers, and loaded tiles are runtime state.
Road nodes and edges may carry a `source` record with provider/import IDs, OSM
way/node identity, layer/bridge/tunnel tags, and boundary-intersection identity.
Provenance survives split, save/load, and undo/redo but stays outside metric
road, world, and route identities.

Full-document writers that introduce or overwrite `geoFrame`, Earth v2, road
provenance, or `tile@2` must send
`supportedEditorSourceVersions: [1]`. Storage returns structured HTTP 409
`ENVIRONMENT_SOURCE_DOWNGRADE` when an older writer would drop those fields.

## Road import rules

`RoadImportService` is a pure fetch/clip/draft service; it never receives the
active `EnvironmentDocument`.

- Overpass filters come from the supported highway allowlist and requests carry
  an `AbortSignal`.
- Every segment is clipped in longitude/latitude before simplification,
  including outside-to-outside crossings and exit/re-entry paths.
- Boundary identities bind source way, source segment, and intersection
  fraction. Exact clipped endpoints and genuine shared OSM references are
  protected during simplification.
- Coordinate proximity never connects roads. Bridge, tunnel, and layer
  crossings stay separate unless the source has a genuine shared node.
- Interior bends are geometry-v2 polyline knots. Closed loops split
  deterministically into legal edges.
- `oneway=yes`, `oneway=-1`, total lanes, and directional lane counts compile
  through the existing lane model. Ambiguous tags and junctions above the
  four-edge editor limit remain visible preview issues.
- Missing provider IDs, incomplete way geometry, invalid rectangles,
  antimeridian crossings, and unsupported providers fail before document
  mutation.

## Tile session lifetime and isolation

`EnvironmentTileHost` owns the live provider session beside the environment's
asset runtime. `SceneProjector` reconciles Earth-source, frame, visibility, and
quality changes; `EnvironmentLoader` performs full-load synchronization.
Applying a preview transfers the prepared session to the host without disposing
it. Scene/Map switches, asset tabs, and editor/simulation workspace changes
retain the session; hidden views suspend traversal. Sessions dispose on source
replacement/removal, environment replacement, or runtime teardown.

Each display update uses the current camera and actual drawing-buffer size in
this order: controls, camera matrices, tile-root matrix, resolution, tile
traversal, render. `TileAoiPlugin` prunes provably disjoint region, box, and
sphere subtrees before they can load. Runtime cache pressure evicts unused
detail before fallback coverage and raises effective screen-space error without
changing the saved setting. Diagnostics expose effective quality, resident
count/bytes, and degraded/error state.

Google roots remain outside registry geometry, placement raycasts, collisions,
LiDAR, bake snapshots, measured cameras, asset assemblies, and package roots.
The bounds outline uses its configured height and owned geometry. The scene
viewport displays current tile credits and Google Maps attribution after Apply;
tile responses use ordinary browser HTTP caching and no persistent Google
content store.

## Main implementation and tests

- `app/geography/GeoFrame.js` and `app/3d/earth/GeoFrame.js`: shared pure frame
  implementation and browser Earth export.
- `app/3d/earth/roads/RoadImportService.js`: clipped deterministic drafts.
- `app/3d/editor/commands/importCommands.js` and
  `georegistrationCommands.js`: atomic import and migration commands.
- `app/3d/earth/EnvironmentTileHost.js`, `EarthTilesManager.js`, and
  `TileAoiPlugin.js`: environment-owned streaming.
- `app/3d/overlay/workspace/EnvironmentCreationDialog.js`: creation workflow.
- `tests/geo-frame.test.js`, `georegistration-commands.test.js`,
  `road-import-service.test.js`, `environment-import-commands.test.js`,
  `environment-tile-host.test.js`, `earth-tiles-streaming.test.js`,
  `environment-creation.test.js`, `gltf-tile.test.js`, and
  `tests/ui/environment-creation.spec.js`: focused and browser coverage.
