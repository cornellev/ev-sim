# Development

This repo is a Next.js application with ES modules in the app code and Node's built-in test runner for runtime tests.

## Commands

```bash
npm install
npm run dev
npm run build
npm run start
npm run lint
npm test
```

- `npm run dev` runs the Express server in `server/App.js` with Next in development mode (hot reload). It also hosts the storage API, so saving works in dev.
- `npm run build` builds the app.
- `npm run start` runs `server/App.js` on `PORT` or `3000`.
- `npm run lint` runs ESLint.
- `npm test` runs `node --experimental-default-type=module --test tests/*.test.js`.

Test files are grouped by area: `visual-script-runtime.test.js`, `editor-core.test.js`, `editor-map-mode.test.js`, `earth-import-mode.test.js`, `bake-*.test.js`, and `storage-service.test.js`.

## Storage backend

Environment edits, scripts, and bindings are persisted on the server rather than in the browser. The backend is deliberately simple - no database, just JSON files with an in-memory cache:

- `server/storage/JsonFileStore.js` - one file's worth of JSON: reads are cached in memory, writes are atomic (temp file + rename).
- `server/storage/StorageService.js` - owns the on-disk layout under `server/data/` (`environments/<id>.json`, `scripts/<id>.json`, `bindings.json`, `settings.json`) and environment catalog operations.
- `server/routes/storageRouter.js` - the Express router mounted at `/api/storage`; a thin HTTP-to-service translation layer.
- `app/client/storageClient.js` - the browser's single fetch wrapper for that API.
- `app/3d/environment/EnvironmentCatalogClient.js` - list/create/duplicate/rename/delete and active-environment settings.
- `app/3d/environment/EnvironmentLoader.js` - the sole manifest/template-to-runtime application path.
- `app/3d/environment/EnvironmentPersistence.js` - debounced manifest saving only.

The `server/data/` directory is git-ignored; it is created on first write.

## Code Layout

- `app/page.js`: browser entry and mode switch.
- `app/3d/`: Three.js scene, vehicles, devices, city objects, overlays, and IGVC scenarios.
- `app/3d/editor/`: environment editor state, tools, chunks, and document model.
- `app/3d/earth/`: Earth Import (tiles, roads, geospatial transforms).
- `app/client/`: orchestrator WebSocket and message encoding client.
- `app/physics/`: physics engine wrapper.
- `app/scripting/`: visual node editor, block classes, runtime compiler, and runner.
- `app/simulation/`: simulation loop.
- `app/util/`: shared utilities.
- `public/`: static assets served by Next.
- `tests/`: Node tests.

## Import Style

The app uses `@/` imports for repo-root app paths in many modules. Keep new imports consistent with the surrounding file.

## Before Opening A PR

Run the focused check for the area you touched:

```bash
npm test
npm run lint
```

For visual or simulation changes, also run `npm run dev` and manually verify:

- The scripting canvas still loads.
- The `Escape` menu switches between scripting, simulation, and the environment editor.
- The 3D scene starts without console errors.
- If orchestrator integration changed, the app behaves both with and without the orchestrator running.

For environment editor or earth import changes, also verify:

- Scene, map, and earth-import modes enter and exit cleanly.
- Earth Import preview and apply work with a valid `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` in `.env.local`.
- `npm test` passes for `tests/editor-*.test.js` and `tests/earth-import-mode.test.js`.

## Conventions

- Keep visual scripting block UI and backend `UnitBlock` behavior in sync.
- Register compileable blocks in both the block registry path and `UnitCatalog.js`.
- Keep message definitions in `public/messages/` synchronized with the orchestrator repo when they are used as browser fallbacks - this will be edited soon to be synchronized.
- Do not commit downloaded CommonRoad scenario folders or other large generated assets.

## Environment Variables

| Variable | Required for | Notes |
|----------|--------------|-------|
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Earth Import tile preview | Map Tiles API (Photorealistic 3D Tiles). Set in `.env.local`, not committed. |

See [Earth Import](earth-import.md) for setup and troubleshooting.
