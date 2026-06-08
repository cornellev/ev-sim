# Getting Started

sensor-fusion is a browser-based autonomous vehicle and sensor-fusion workbench. It uses Next.js and React for the UI, Three.js for the 3D simulator, a visual scripting canvas for node programs, and an external Python orchestrator process for ROS-style topic integration.

## Requirements

- Node.js and npm.
- Python 3.9+ only if you plan to run the external orchestrator.
- Optional ROS 2 environment if you want the orchestrator to bridge real ROS 2 topics.

## Install

```bash
npm install
```

## Run The App

```bash
npm run dev
```

Open the local URL printed by Next. The default app state is the visual scripting canvas. Press `Escape` to open the app menu and switch between the scripting canvas and the 3D scene.

For a production-style local run:

```bash
npm run build
npm run start
```

`npm run start` launches `server/App.js`, which serves Next through Express on `PORT` or `3000`.

## Useful Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
npm test
```

`npm test` runs the Node built-in test runner against `tests/*.test.js`.

## Optional Orchestrator

Live ROS-style topics are served by a separate repository:

```bash
cd /Users/jgrimminck/Coding/py/orchestrator
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

By default sensor-fusion expects:

- WebSocket topics at `ws://localhost:8080`.
- Message type sync at `http://localhost:8090`.

To enable the orchestrator's ROS 2 bridge, run it from a ROS 2 environment:

```bash
ROS_ENABLED=true python main.py
```

See [ROS Integration](ros-integration.md) for the integration boundary and current topic usage.

## Optional Scenario Assets

CommonRoad scenarios are not committed to this repo. Download them from `https://gitlab.lrz.de/tum-cps/commonroad-scenarios` and place the `scenarios` folder under `public/`, creating paths like:

```text
public/scenarios/recorded/NGSIM/Peachtree/USA_Peach-1_1_T-1.xml
```

See [Assets](assets.md) before adding large or generated files.
