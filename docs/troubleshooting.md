# Troubleshooting

## The App Starts On The Scripting Canvas

This is expected. `app/page.js` defaults to `scripting`. Press `Escape` to open the app menu and switch to the 3D scene.

## CommonRoad Scenario Fails To Load

Make sure the scenario XML exists under `public/scenarios/` and that code references it with a browser path starting with `/scenarios/`.

See [Assets](assets.md).

## Orchestrator Type Sync Fails

`app/3d/managers/ClientManager.js` first tries `http://localhost:8090/api/types`. If the orchestrator is not running, it logs a warning and falls back to message files under `public/messages/`.

Start the orchestrator with:

```bash
cd /Users/jgrimminck/Coding/py/orchestrator
source .venv/bin/activate
python main.py
```

## No Live Topic Updates Arrive

Check that the orchestrator WebSocket is available on `ws://localhost:8080`. For ROS 2-backed topics, also check that the orchestrator was started with `ROS_ENABLED=true` inside the right ROS 2 environment.

## Visual Script Is Invalid

Common causes:

- Required inputs are not connected.
- Output and input port types do not match.
- Program input or output labels are duplicated.
- A block was added to `AddMenu.js` but not registered in `registerBuiltInBlocks.js`.
- A dynamic port changed type and existing connections were removed.

See [Scripting Troubleshooting](scripting/troubleshooting.md).

## Compiled Program Fails To Import Or Run

Compiled artifacts must have `kind: "sensor-fusion.visual-script.program"` and `version: 2`. The runtime also requires every block type in the artifact to be registered before import or run.

See [Artifact Schema v2](scripting/artifact-schema-v2.md).

## Deleting Nodes Or Connections Behaves Strangely

Deletion support exists in the current UI, but it is still a high-risk path compared with creating and connecting blocks. If graph state looks inconsistent, refresh and rebuild the small section of the graph.
