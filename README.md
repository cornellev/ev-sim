# ev-sim

<div align="center">
  <a href="https://github.com/cornellev/ev-sim/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/cornellev/ev-sim/actions/workflows/ci.yml/badge.svg">
  </a>
</div>

---

**ev-sim** is Cornell Electric Vehicles' autonomous-driving simulation platform, built for reproducible development and testing across interactive and headless workloads.
- Deterministic simulation: a shared fixed-step kernel powers browser and headless execution with seeded resets, reproducible state, and trajectory hashing.
- Parallel autonomy/RL: isolated headless environments run through a gRPC supervisor with Python Gymnasium / Stable-Baselines3 integration and shared-memory sensor transport.
- Vehicle & sensor simulation: LiDAR, camera, IMU/GNSS/odometry, physics, telemetry, binary logging/replay, scenario authoring, and ROS-oriented integration.

> [!NOTE]
> This is currently in alpha. The API is not stable, and the documentation is incomplete. Please reach out to the maintainers if you want to contribute or use this project.

---

## Quick start

### Prerequisites

You need Node.js 20 or later - download it from [nodejs.org](https://nodejs.org/en/download/).

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/cornellev/ev-sim/main/install.sh | bash
```

The installer writes the clone to `./ev-sim`.
To start up the app, run these commands:

```bash
cd ev-sim
npm run dev
```

The app uses port 3000 when `PORT` is unset.
Open `http://localhost:3000` in a browser.

This command installs ev-sim into a chosen directory.
The `--start` flag runs the app when that command finishes.

```bash
curl -fsSL https://raw.githubusercontent.com/cornellev/ev-sim/main/install.sh | bash -s -- --dir ~/ev-sim --start
```

If ev-sim is already on this computer, run these commands:

```bash
npm install
npm run dev
```

## Workspaces

The app opens on Simulation.
Press Escape to open the workspace switcher.

### Build and run

- Simulation. Run vehicles, sensors, and scenarios.
- Environment Editor. Edit environments and scenes.
- Vehicle Editor. Create and inspect vehicle manifests.
- Run Configuration. Edit simulation manifests.
- Scenarios. Create test scenarios.
- Experiment Suite. Experiment with scenarios.
- Headless Runs. Queue and monitor server runs.

### Logic

- Scripting Canvas. Build simulation logic with blocks.
- Bindings. Bind scripts to signals.

### Inspect

- Replay. Inspect recorded simulations.
- Analysis. Graph live data.
- Logs. Organize recorded simulations.

The switcher also has a Plugins pane.
Use that pane to install a simulator package.

### Environment Editor

![Environment Editor](docs/screenshots/environment.png)

### Scripting Canvas

![Scripting Canvas](docs/screenshots/canvas.png)

### Analysis

The Analysis workspace graphs signals from a live run or a recorded log.

![Analysis](docs/screenshots/logging.png)

### Vehicle Editor

![Vehicle Editor](docs/screenshots/vehicle.png)

## Headless runner

The headless runner includes a CLI and a worker.
The Python package is a client of that runner.
This repository builds both as internal artifacts.
This repository does not publish them on npm or on PyPI.

```bash
npm run dist:headless
```

That command writes an npm tarball, a Python wheel, a Python sdist, a compatibility manifest, and SHA-256 checksums.

You can download the `Internal headless candidate` artifact from the manual workflow.
Install that artifact when you do not need the app.
Release rules are in [Headless release and CI gates](docs/headless-release.md).
Jetson steps are in [Jetson deployment](docs/jetson-headless.md).

In this repository the runner command is `./bin/cev-sim.js`.
Command details are in [Headless CLI](docs/headless-cli.md).
The Headless Runs workspace queues server runs.
The same workspace monitors those runs.

The Python package is a Gymnasium client and a Stable-Baselines3 client for the JavaScript supervisor.
Adapter details are in [Python adapter](docs/python-headless.md).

## Agent plugin

This repository is a Cursor [Agent Plugin](https://cursor.com/docs/plugins.md).
The plugin files are [`plugin.json`](plugin.json), [`mcp.json`](mcp.json), and [`skills/cev-sim/`](skills/cev-sim/).
An import gives the agent the cev-sim skill.
Cursor invokes that skill automatically.
An import also registers the MCP endpoint `http://localhost:3000/mcp`.
The transport is Streamable HTTP.

Import does not run the app.
Run `npm run dev` or `npm start` before MCP discovery.
The server id is `cev-sim`.

Load the plugin in one of these ways:

- Import the Git URL of this repository in Cursor.
- From the Cursor CLI, run `agent --plugin-dir /path/to/this/repo`.
- Copy or symlink this repository into `~/.cursor/plugins/local/cev-sim`. Reload the Cursor window.

MCP setup without the plugin is in [MCP Server](docs/mcp.md).

Run the bundle validator:

```bash
node skills/cev-sim/scripts/validate.mjs
```

## Simulator packages

A simulator package is not the agent plugin.
Each package has its own `plugin.json`.
Open the Plugins pane to install a package.
You can also run `cev-sim-plugin`.
The package contract is in [Plugin API](docs/plugin-api.md).

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Development workflow](docs/development.md)
- [Environment editor](docs/environment-editor.md)
- [Earth import](docs/earth-import.md)
- [Simulation](docs/simulation.md)
- [Visual scripting](docs/scripting/README.md)
- [Script bindings](docs/script-bindings.md)
- [Vehicle manifests](docs/vehicle-manifests.md)
- [Run manifests](docs/run-manifests.md)
- [Headless CLI](docs/headless-cli.md)
- [Python adapter](docs/python-headless.md)
- [Headless release and CI gates](docs/headless-release.md)
- [Jetson headless deployment](docs/jetson-headless.md)
- [Plugin API](docs/plugin-api.md)
- [Telemetry, logging, replay, and analysis](docs/telemetry-logging.md)
- [ROS integration](docs/ros-integration.md)
- [MCP Server](docs/mcp.md)
- [Assets](docs/assets.md)
- [Troubleshooting](docs/troubleshooting.md)

## CommonRoad scenarios

CommonRoad scenarios are not in this repository.
Download them from `https://gitlab.lrz.de/tum-cps/commonroad-scenarios`.
Put the `scenarios` folder in `public/`.
The local path is `public/scenarios`.

Example browser path:

```text
/scenarios/recorded/NGSIM/Peachtree/USA_Peach-1_1_T-1.xml
```

Asset rules are in [Assets](docs/assets.md).

## License

The [Apache License 2.0](LICENSE) covers this repository.
It also covers the headless npm artifact and the Python package.

## References

[M. Althoff, M. Koschi, and S. Manzinger, "CommonRoad: Composable Benchmarks for Motion Planning on Roads," in Proc. of the IEEE Intelligent Vehicles Symposium, 2017, pp. 719-726.](http://mediatum.ub.tum.de/doc/1379638/776321.pdf)
