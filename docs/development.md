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

- `npm run dev` starts Next development mode.
- `npm run build` builds the app.
- `npm run start` runs `server/App.js` on `PORT` or `3000`.
- `npm run lint` runs ESLint.
- `npm test` runs `node --experimental-default-type=module --test tests/*.test.js`.

## Code Layout

- `app/page.js`: browser entry and mode switch.
- `app/3d/`: Three.js scene, vehicles, devices, city objects, overlays, and IGVC scenarios.
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
- The `Escape` menu switches to the 3D scene.
- The 3D scene starts without console errors.
- If orchestrator integration changed, the app behaves both with and without the orchestrator running.

## Conventions

- Keep visual scripting block UI and backend `UnitBlock` behavior in sync.
- Register compileable blocks in both the block registry path and the add menu path.
- Keep message definitions in `public/messages/` synchronized with the orchestrator repo when they are used as browser fallbacks - this will be edited soon to be synchronized.
- Do not commit downloaded CommonRoad scenario folders or other large generated assets.

