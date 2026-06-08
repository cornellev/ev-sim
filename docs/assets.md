# Assets

Static files served to the browser live under `public/`.

## CommonRoad Scenarios

CommonRoad scenarios are external data and should not be committed to this repo. Download them from `https://gitlab.lrz.de/tum-cps/commonroad-scenarios` and place the `scenarios` folder under `public/`.

Example browser path:

```text
/scenarios/recorded/NGSIM/Peachtree/USA_Peach-1_1_T-1.xml
```

Matching local path:

```text
public/scenarios/recorded/NGSIM/Peachtree/USA_Peach-1_1_T-1.xml
```

`app/3d/traffic/TrafficScenario.js` loads these files by browser path.

## Message Definitions

`public/messages/` contains fallback `.msg` files used by the browser client when the external orchestrator Types API is unavailable.

The canonical custom message definitions should live in `/Users/jgrimminck/Coding/py/orchestrator/custom_types/`. Keep the browser fallback copies synchronized when message shapes change.

## Models

`public/shell.gltf` is used by optimizer experiments in `app/3d/Scene.js`.

For new models:

- Keep filenames stable if code references them directly.
- Prefer documenting scale and coordinate assumptions in the code that loads the model.
- Do not commit large generated model variants unless they are required for the app to function.

## Large Or Generated Files

Before committing new assets, check whether they are:

- Downloadable from a public source.
- Generated from source data.
- Large enough to slow down clone/build workflows.

If so, document the setup path here instead of committing the files.
