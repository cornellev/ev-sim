# IGVC Overview

The repo includes IGVC-oriented scene setup and mini scenario files under `app/3d/igvc/`.

## Key Files

- `app/3d/igvc/IGVCScene.js`: default IGVC scene setup, including roads, intersections, stop signs, and barrels.
- `app/3d/igvc/mini/q1.js`: qualification lane keeping.
- `app/3d/igvc/mini/q2.js`: line detection.
- `app/3d/igvc/mini/q3.js`: left turn.
- `app/3d/igvc/mini/q4.js`: right turn.
- `app/3d/igvc/mini/fi1.js`: static pedestrian detection.
- `app/3d/igvc/mini/fi2.js`: tire detection.
- `app/3d/igvc/mini/fii1.js`: stop sign detection.
- `app/3d/igvc/mini/fiii1.js`, `fiii2.js`, `fiii3.js`: higher-level function scenarios.

## Current Scene Behavior

`app/3d/Scene.js` imports the mini scenarios and defines the `?mini=` mapping, but that mini scenario startup path is currently commented out. The active default setup calls `setupIGVC`.

## Working On IGVC Features

When adding or changing IGVC behavior:

- Keep the domain rule reference separate from implementation notes.
- Update this page when a mini scenario becomes active or changes query parameters.
- Link behavior back to the source file that sets up the scene.
- Keep visual detection output requirements visible in scenario-specific docs or comments.

## Domain Reference

The competition-rule reference is preserved at the repo root in `rules.md` and linked from [Competition Rules](competition-rules.md).
